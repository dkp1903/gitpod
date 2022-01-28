// Copyright (c) 2022 Gitpod GmbH. All rights reserved.
// Licensed under the GNU Affero General Public License (AGPL).
// See License-AGPL.txt in the project root for license information.

package cmd

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"io/ioutil"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	log "github.com/sirupsen/logrus"
	"github.com/spf13/cobra"
	"google.golang.org/grpc"

	supervisor "github.com/gitpod-io/gitpod/supervisor/api"
)

var credentialHelper = &cobra.Command{
	Use:    "credential-helper get",
	Short:  "Gitpod Credential Helper for Git",
	Long:   "Supports reading of credentials per host.",
	Args:   cobra.MinimumNArgs(1),
	Hidden: true,
	Run: func(cmd *cobra.Command, args []string) {
		action := args[0]
		log.SetOutput(io.Discard)
		f, err := os.OpenFile(os.TempDir()+"/gitpod-git-credential-helper.log", os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
		if err == nil {
			defer f.Close()
			log.SetOutput(f)
		}
		if action != "get" {
			return
		}

		var user, token string
		defer func() {
			// token was not found, thus we return just a dummy to satisfy the git protocol
			if user == "" {
				user = "oauth2"
			}
			if token == "" {
				token = "no"
			}
			fmt.Printf("username=%s\npassword=%s\n", user, token)
		}()

		host := parseHostFromStdin()
		if len(host) == 0 {
			log.Fatal("'host' is missing")
		}

		ctx, cancel := context.WithTimeout(context.Background(), 1*time.Minute)
		defer cancel()
		supervisorAddr := os.Getenv("SUPERVISOR_ADDR")
		if supervisorAddr == "" {
			supervisorAddr = "localhost:22999"
		}
		supervisorConn, err := grpc.Dial(supervisorAddr, grpc.WithInsecure())
		if err != nil {
			log.WithError(err).Print("error connecting to supervisor")
			return
		}
		resp, err := supervisor.NewTokenServiceClient(supervisorConn).GetToken(ctx, &supervisor.GetTokenRequest{
			Host: host,
			Kind: "git",
		})
		if err != nil {
			log.WithError(err).Print("error getting token from supervisior")
			return
		}
		user = resp.User
		token = resp.Token

		gitCmdInfo := &gitCommandInfo{}
		err = walkProcessTree(os.Getpid(), func(pid int) bool {
			cmdLine, err := readProc(pid, "cmdline")
			if err != nil {
				log.WithError(err).Print("error reading proc cmdline")
				return true
			}

			cmdLineString := strings.ReplaceAll(cmdLine, string(byte(0)), " ")
			gitCmdInfo.parseGitCommandAndOriginRemote(cmdLineString)

			return gitCmdInfo.GitCommand != "" && gitCmdInfo.RepoUrl != ""
		})
		if err != nil {
			log.WithError(err).Print("error walking process tree")
			return
		}
		if gitCmdInfo.RepoUrl == "" {
			log.Info("empty repo url, not need execute tracker-command and token-validator")
			return
		}
		if gitCmdInfo.GitCommand == "" {
			// if not detection the special git command, it may be called by other programs, such as npm
			gitCmdInfo.GitCommand = "clone"
		}

		// Starts another process which tracks the executed git event
		gitCommandTracker := exec.Command("/proc/self/exe", "git-track-command", "--gitCommand", gitCmdInfo.GitCommand)
		_, err = gitCommandTracker.CombinedOutput()
		if err != nil {
			log.WithError(err).Print("error spawning tracker")
		}

		validator := exec.Command("/proc/self/exe", "git-token-validator",
			"--user", resp.User, "--token", resp.Token, "--scopes", strings.Join(resp.Scope, ","),
			"--host", host, "--repoURL", gitCmdInfo.RepoUrl, "--gitCommand", gitCmdInfo.GitCommand)
		err = validator.Start()
		if err != nil {
			log.WithError(err).Print("error spawning validator")
			return
		}
		err = validator.Process.Release()
		if err != nil {
			log.WithError(err).Print("error releasing validator")
			return
		}
	},
}

func parseHostFromStdin() string {
	host := ""
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if len(line) > 0 {
			tuple := strings.Split(line, "=")
			if len(tuple) == 2 {
				if strings.TrimSpace(tuple[0]) == "host" {
					host = strings.TrimSpace(tuple[1])
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		log.Println(err)
	}
	return host
}

type gitCommandInfo struct {
	RepoUrl    string
	GitCommand string
}

var gitCommandRegExp = regexp.MustCompile(`git(,\d+\s+|\s+)(push|clone|fetch|pull|diff)`)
var repoUrlRegExp = regexp.MustCompile(`remote-https?\s([^\s]+)\s+(https?:[^\s]+)\s`)

// This method needs to be called multiple times to fill all the required info
// from different git commands
// For example from first command below the `RepoUrl` will be parsed and from
// the second command the `GitCommand` will be parsed
// `/usr/lib/git-core/git-remote-https origin https://github.com/jeanp413/test-gp-bug.git`
// `/usr/lib/git-core/git push`
func (g *gitCommandInfo) parseGitCommandAndOriginRemote(cmdLineString string) {
	matchCommand := gitCommandRegExp.FindStringSubmatch(cmdLineString)
	if len(matchCommand) == 3 {
		g.GitCommand = matchCommand[2]
	}

	matchRepo := repoUrlRegExp.FindStringSubmatch(cmdLineString)
	if len(matchRepo) == 3 {
		g.RepoUrl = matchRepo[2]
		if !strings.HasSuffix(g.RepoUrl, ".git") {
			g.RepoUrl = g.RepoUrl + ".git"
		}
	}
}

type pidCallbackFn func(int) bool

func walkProcessTree(pid int, fn pidCallbackFn) error {
	for {
		stop := fn(pid)
		if stop {
			return nil
		}

		ppid, err := getProcesParentId(pid)
		if err != nil {
			return err
		}
		if ppid == pid || ppid == 1 /* supervisor pid*/ {
			return nil
		}
		pid = ppid
	}
}

var procStatPidRegExp = regexp.MustCompile(`\d+\ \(.+?\)\ .+?\ (\d+)`)

func getProcesParentId(pid int) (ppid int, err error) {
	statsString, err := readProc(pid, "stat")
	if err != nil {
		return
	}

	match := procStatPidRegExp.FindStringSubmatch(statsString)
	if len(match) != 2 {
		err = fmt.Errorf("CredentialHelper error cannot parse stats string: %s", statsString)
		return
	}

	parentId, err := strconv.Atoi(match[1])
	if err != nil {
		err = fmt.Errorf("CredentialHelper error cannot parse ppid: %s", match[1])
		return
	}

	ppid = parentId
	return
}

func readProc(pid int, file string) (data string, err error) {
	procFile := fmt.Sprintf("/proc/%d/%s", pid, file)
	// read file not using os.Stat
	// see https://github.com/prometheus/procfs/blob/5162bec877a860b5ff140b5d13db31ebb0643dd3/internal/util/readfile.go#L27
	const maxBufferSize = 1024 * 512
	f, err := os.Open(procFile)
	if err != nil {
		err = fmt.Errorf("CredentialHelper error opening proc file: %v", err)
		return
	}
	defer f.Close()
	reader := io.LimitReader(f, maxBufferSize)
	buffer, err := ioutil.ReadAll(reader)
	if err != nil {
		err = fmt.Errorf("CredentialHelper error reading proc file: %v", err)
		return
	}

	data = string(buffer)
	return
}

func init() {
	rootCmd.AddCommand(credentialHelper)
}
