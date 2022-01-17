/**
 * Copyright (c) 2022 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License-AGPL.txt in the project root for license information.
 */

import moment from "moment";
import { Link } from "react-router-dom";
import { Project } from "@gitpod/gitpod-protocol";
import Prebuilds from "../projects/Prebuilds"
import Property from "./Property";

export default function ProjectDetail(props: { project: Project, owner: string | undefined }) {
    return <>
        <div className="flex">
            <div className="flex-1">
                <div className="flex"><h3>{props.project.name}</h3><span className="my-auto ml-3"></span></div>
                <p>{props.project.cloneUrl}</p>
            </div>
        </div>
        <div className="flex mt-6">
            <div className="flex flex-col w-full">
                <div className="flex w-full mt-6">
                    <Property name="Created">{moment(props.project.creationTime).format('MMM D, YYYY')}</Property>
                    <Property name="Repository"><a className="text-blue-400 dark:text-blue-600 hover:text-blue-600 dark:hover:text-blue-400" href={props.project.cloneUrl}>{props.project.name}</a></Property>
                    <Property name="Marked Deleted" >{props.project.markedDeleted ? "Yes" : "No"}</Property>
                </div>
                <div className="flex w-full mt-6">
                    <Property name="User"><Link className="text-blue-400 dark:text-blue-600 hover:text-blue-600 dark:hover:text-blue-400" to={"/admin/users/" + props.project.userId}>{props.project.userId ? props.owner : ""}</Link></Property>
                    <Property name="Team">{props.project.teamId && props.owner ? props.owner : ""}</Property>
                    <Property name="Incremental Prebuilds">{props.project.settings?.useIncrementalPrebuilds ? "Yes" : "No"}</Property>
                </div>
            </div>
        </div>
        <div className="mt-6">
            <Prebuilds project={props.project} isAdminDashboard={true} />
        </div>
    </>;
}
