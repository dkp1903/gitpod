/**
 * Copyright (c) 2021 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import { WorkspaceDB } from "@gitpod/gitpod-db/lib/workspace-db";
import { HeadlessLogUrls } from "@gitpod/gitpod-protocol/lib/headless-workspace-log";
import { inject, injectable } from "inversify";
import * as url from "url";
import { Status, StatusServiceClient } from '@gitpod/supervisor-api-grpcweb/lib/status_pb_service'
import { TasksStatusRequest, TasksStatusResponse, TaskState, TaskStatus } from "@gitpod/supervisor-api-grpcweb/lib/status_pb";
import { ResponseStream, TerminalServiceClient } from "@gitpod/supervisor-api-grpcweb/lib/terminal_pb_service";
import { ListenTerminalRequest, ListenTerminalResponse } from "@gitpod/supervisor-api-grpcweb/lib/terminal_pb";
import { WorkspaceInstance } from "@gitpod/gitpod-protocol";
import * as grpc from '@grpc/grpc-js';
import { Config } from "../config";
import * as browserHeaders from "browser-headers";
import { log } from '@gitpod/gitpod-protocol/lib/util/logging';
import { TextDecoder } from "util";
import { WebsocketTransport } from "../util/grpc-web-ws-transport";
import { Deferred } from "@gitpod/gitpod-protocol/lib/util/deferred";
import { ListLogsRequest, ListLogsResponse, LogDownloadURLRequest, LogDownloadURLResponse } from '@gitpod/content-service/lib/headless-log_pb';
import { HEADLESS_LOG_DOWNLOAD_PATH_PREFIX } from "./headless-log-controller";
import { CachingHeadlessLogServiceClientProvider } from "@gitpod/content-service/lib/sugar";

export type WorkspaceInstanceEndpoint = {
    instanceId: string,
    url: string,
    ownerToken?: string,
    headers?: { [key: string]: string },
};
export namespace WorkspaceInstanceEndpoint {
    export function authHeaders(wsiEndpoint: WorkspaceInstanceEndpoint): browserHeaders.BrowserHeaders | undefined {
        const headers = new browserHeaders.BrowserHeaders(wsiEndpoint.headers);
        if (wsiEndpoint.ownerToken) {
            headers.set("x-gitpod-owner-token", wsiEndpoint.ownerToken);
        }

        if (Object.keys(headers.headersMap).length === 0) {
            log.warn({ instanceId: wsiEndpoint.instanceId }, "workspace logs: no ownerToken nor headers!");
            return undefined;
        }

        return headers;
    }
    export function fromWithOwnerToken(wsi: WorkspaceInstance): WorkspaceInstanceEndpoint {
        return {
            instanceId: wsi.id,
            url: wsi.ideUrl,
            ownerToken: wsi.status.ownerToken,
        }
    }
}

@injectable()
export class HeadlessLogService {
    static readonly SUPERVISOR_API_PATH = "/_supervisor/v1";

    @inject(WorkspaceDB) protected readonly db: WorkspaceDB;
    @inject(Config) protected readonly config: Config;
    @inject(CachingHeadlessLogServiceClientProvider) protected readonly headlessLogClientProvider: CachingHeadlessLogServiceClientProvider;

    public async getHeadlessLogURLs(wsi: WorkspaceInstance, ownerId: string, maxTimeoutSecs: number = 30): Promise<HeadlessLogUrls | undefined> {
        if (isSupervisorAvailableSoon(wsi)) {
            const wsiEndpoint = WorkspaceInstanceEndpoint.fromWithOwnerToken(wsi);
            const aborted = new Deferred<boolean>();
            setTimeout(() => aborted.resolve(true), maxTimeoutSecs * 1000);
            const streamIds = await this.retryWhileInstanceIsRunning(wsiEndpoint, () => this.supervisorListHeadlessLogs(wsiEndpoint), "list headless log streams", aborted);
            if (streamIds !== undefined) {
                return streamIds;
            }
        }

        // we were unable to get a repsonse from supervisor - let's try content service next
        return await this.contentServiceListLogs(wsi, ownerId);
    }

    protected async contentServiceListLogs(wsiEndpoint: WorkspaceInstance, ownerId: string): Promise<HeadlessLogUrls | undefined> {
        const req = new ListLogsRequest();
        req.setOwnerId(ownerId);
        req.setWorkspaceId(wsiEndpoint.workspaceId);
        req.setInstanceId(wsiEndpoint.id);
        const response = await new Promise<ListLogsResponse>((resolve, reject) => {
            const client = this.headlessLogClientProvider.getDefault();
            client.listLogs(req, (err: grpc.ServiceError | null, response: ListLogsResponse) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(response);
                }
            });
        });

        // send client to proxy with plugin, which in turn calls getHeadlessLogDownloadUrl below and redirects to that Url
        const streams: { [id: string]: string } = {};
        for (const taskId of response.getTaskIdList()) {
            streams[taskId] = this.config.hostUrl.with({
                pathname: `${HEADLESS_LOG_DOWNLOAD_PATH_PREFIX}/${wsiEndpoint.id}/${taskId}`,
            }).toString();
        }
        return {
            streams
        };
    }

    protected async supervisorListHeadlessLogs(wsiEndpoint: WorkspaceInstanceEndpoint): Promise<HeadlessLogUrls | undefined> {
        const tasks = await this.supervisorListTasks(wsiEndpoint);
        return this.renderTasksHeadlessLogUrls(wsiEndpoint.instanceId, tasks);
    }

    protected async supervisorListTasks(wsiEndpoint: WorkspaceInstanceEndpoint): Promise<TaskStatus[]> {
        if (wsiEndpoint.url === "") {
            // if ideUrl is not yet set we're too early and we deem the workspace not ready yet: retry later!
            throw new Error(`instance's ${wsiEndpoint.instanceId} has no ideUrl, yet`);
        }

        const tasks = await new Promise<TaskStatus[]>((resolve, reject) => {
            const client = new StatusServiceClient(toSupervisorURL(wsiEndpoint.url), {
                transport: WebsocketTransport(),
            });

            const req = new TasksStatusRequest();   // Note: Don't set observe here at all, else it won't work!
            const stream = client.tasksStatus(req, WorkspaceInstanceEndpoint.authHeaders(wsiEndpoint));
            stream.on('data', (resp: TasksStatusResponse) => {
                resolve(resp.getTasksList());
                stream.cancel();
            });
            stream.on('end', (status?: Status) => {
                if (status && status.code !== grpc.status.OK) {
                    const err = new Error(`upstream ended with status code: ${status.code}`);
                    (err as any).status = status;
                    reject(err);
                }
            });
        });
        return tasks;
    }

    protected renderTasksHeadlessLogUrls(instanceId: string, tasks: TaskStatus[]): HeadlessLogUrls {
        // render URLs that point to server's /headless-logs/ endpoint which forwards calls to the running workspaces's supervisor
        const streams: { [id: string]: string } = {};
        for (const task of tasks) {
            const taskId = task.getId();
            const terminalId = task.getTerminal();
            if (task.getState() === TaskState.OPENING) {
                // this might be the case when there is no terminal for this task, yet.
                // if we find any such case, we deem the workspace not ready yet, and try to reconnect later,
                // to be sure to get hold of all terminals created.
                throw new Error(`instance's ${instanceId} task ${task.getId()} has no terminal yet`);
            }
            if (task.getState() === TaskState.CLOSED) {
                // if a task has already been closed we can no longer access it's terminal, and have to skip it.
                continue;
            }
            streams[taskId] = this.config.hostUrl.with({
                pathname: `/headless-logs/${instanceId}/${terminalId}`,
            }).toString();
        }
        return {
            streams
        };
    }

    /**
     * Retrieves a download URL for the headless log from content-service
     *
     * @param userId
     * @param wsiEndpoint
     * @param ownerId
     * @param taskId
     * @returns
     */
    async getHeadlessLogDownloadUrl(userId: string, wsiEndpoint: WorkspaceInstance, ownerId: string, taskId: string): Promise<string | undefined> {
        try {
            return await new Promise<string>((resolve, reject) => {
                const req = new LogDownloadURLRequest();
                req.setOwnerId(ownerId);
                req.setWorkspaceId(wsiEndpoint.workspaceId);
                req.setInstanceId(wsiEndpoint.id);
                req.setTaskId(taskId);
                const client = this.headlessLogClientProvider.getDefault();
                client.logDownloadURL(req, (err: grpc.ServiceError | null, response: LogDownloadURLResponse) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(response.getUrl());
                    }
                });
            });
        } catch (err) {
            log.debug({ userId, workspaceId: wsiEndpoint.workspaceId, instanceId: wsiEndpoint.id }, "an error occurred retrieving a headless log download URL", err, { taskId });
            return undefined;
        }
    }

    /**
     * For now, simply stream the supervisor data
     *
     * @param workspace
     * @param terminalID
     */
    async streamWorkspaceLog(wsiEndpoint: WorkspaceInstanceEndpoint, terminalID: string, sink: (chunk: string) => Promise<void>, aborted: Deferred<boolean>): Promise<void> {
        const client = new TerminalServiceClient(toSupervisorURL(wsiEndpoint.url), {
            transport: WebsocketTransport(),    // necessary because HTTPTransport causes caching issues
        });
        const req = new ListenTerminalRequest();
        req.setAlias(terminalID);

        let receivedDataYet = false;
        let stream: ResponseStream<ListenTerminalResponse> | undefined = undefined;
        aborted.promise.then(() => stream?.cancel());
        const doStream = (cancelRetry: () => void) => new Promise<void>((resolve, reject) => {
            // [gpl] this is the very reason we cannot redirect the frontend to the supervisor URL: currently we only have ownerTokens for authentication
            const decoder = new TextDecoder('utf-8')
            stream = client.listen(req, WorkspaceInstanceEndpoint.authHeaders(wsiEndpoint));
            stream.on('data', (resp: ListenTerminalResponse) => {
                receivedDataYet = true;

                const raw = resp.getData();
                const data: string = typeof raw === 'string' ? raw : decoder.decode(raw);
                sink(data)
                    .catch((err) => {
                        stream?.cancel();    // If downstream reports an error: cancel connection to upstream
                        log.debug({ instanceId: wsiEndpoint.instanceId }, "stream cancelled", err);
                    });
            });
            stream.on('end', (status?: Status) => {
                if (!status || status.code === grpc.status.OK) {
                    resolve();
                    return;
                }

                const err = new Error(`upstream ended with status code: ${status.code}`);
                (err as any).status = status;
                if (!receivedDataYet && status.code === grpc.status.UNAVAILABLE) {
                    log.debug("stream headless workspace log", err);
                    reject(err);
                    return;
                }

                cancelRetry();
                reject(err);
            });
        });
        await this.retryWhileInstanceIsRunning(wsiEndpoint, doStream, "stream workspace logs", aborted);
    }

    /**
     * Retries op while the passed WorkspaceInstance is still starting. Retries are stopped if either:
     *  - `op` calls `cancel()` and an err is thrown, it is re-thrown by this method
     *  - `aborted` resolves to `true`: `undefined` is returned
     *  - if the instance enters the either STOPPING/STOPPED phases, we stop retrying, and return `undefined`
     * @param wsiEndpoint
     * @param op
     * @param description
     * @param aborted
     * @returns
     */
    protected async retryWhileInstanceIsRunning<T>(wsiEndpoint: WorkspaceInstanceEndpoint, op: (cancel: () => void) => Promise<T>, description: string, aborted: Deferred<boolean>): Promise<T | undefined> {
        let cancelled = false;
        const cancel = () => { cancelled = true; };

        while (!cancelled && !(aborted.isResolved && (await aborted.promise)) ) {
            try {
                return await op(cancel);
            } catch (err) {
                if (cancelled) {
                    throw err;
                }

                log.debug(`unable to ${description}`, err);
                const maybeInstance = await this.db.findInstanceById(wsiEndpoint.instanceId);
                if (!maybeInstance) {
                    return undefined;
                }

                if (!this.shouldRetry(maybeInstance)) {
                    return undefined;
                }
                log.debug(`re-trying ${description}...`);
                await new Promise((resolve) => setTimeout(resolve, 2000));
                continue;
            }
        }
        return undefined;
    }

    protected shouldRetry(wsi: WorkspaceInstance): boolean {
        return isSupervisorAvailableSoon(wsi);
    }
}

function isSupervisorAvailableSoon(wsi: WorkspaceInstance): boolean {
    switch (wsi.status.phase) {
        case "creating":
        case "preparing":
        case "initializing":
        case "pending":
        case "running":
            return true;
        default:
            return false;
    }
}

function toSupervisorURL(ideUrl: string): string {
    const u = new url.URL(ideUrl);
    u.pathname = HeadlessLogService.SUPERVISOR_API_PATH;
    return u.toString();
}
