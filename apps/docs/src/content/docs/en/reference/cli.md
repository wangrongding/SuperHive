---
title: CLI and Hive MCP tools reference
description: Source-verified reference for Hive server, agent, model, MCP list and skill commands, plus how local MCP config differs from authenticated Hive room tools.
---

## What it's for

The CLI manages Hive Server from a terminal or connects a local agent to a room. Hive MCP tools are used by connected agents during a task to read the room, delegate, ask questions and update collaboration state. They are not the same set of shell commands.

This page was checked against the command dispatch and argument parsing in repo commit `c2f68dd`; it makes no guarantees about future versions of external runtimes. Start with [Installation and startup](/en/start/installation/). If you're not familiar with authentication and permissions, use the [web setup wizard](/en/guides/agents/) to generate commands.

## Version and help

We recommend installing the `superhive` npm package globally (`npm i -g superhive`) and then using `hive`. Without a global install, replace `hive` with `npx superhive` (use `npx superhive@latest` for the newest version); npx may download the package on first run. `hive update` isn't available when running through npx.

```bash
hive --version
hive --help
hive start --help
hive join --help
hive mcp list --help
hive models --help
```

Whether a subcommand accepts `--help` depends on its own parser. `skill install` and `skill uninstall` don't use the shared option parser, so don't assume they accept the same arguments; their usage is listed in the top-level help.

## Managing Hive Server

| Command                 | What it does                                                   | Notes                                                                          |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `hive start`            | Starts the server and web UI, in the background by default     | Listens on `0.0.0.0:8787` by default and tries to open a local browser         |
| `hive stop`             | Stops the service started by Hive                              | With a custom data directory, pass the same `--data-dir`                       |
| `hive restart`          | Restarts with the original config; local Agents stay online    | Restarts the current version only; doesn't download updates                    |
| `hive update`           | Updates to the latest version; a running server restarts on it | Installs globally with the original package manager; doesn't update agent CLIs |
| `hive update --check`   | Only checks whether a new version exists                       | Doesn't install or restart                                                     |
| `hive autostart on`     | Starts Hive when the current user logs in                      | Changes local autostart config; install globally first for long-term use       |
| `hive autostart status` | Shows whether autostart is enabled                             | Not a server health check or task status query                                 |
| `hive autostart off`    | Removes Hive's autostart config                                | Turning off autostart doesn't delete chat data                                 |

A startup example for a local, read-only demo:

```bash
hive start --host 127.0.0.1 --port 8787 --no-open
```

This only allows access from the same computer. To use Hive on a LAN or behind a reverse proxy, configure it per the [Deployment reference](/en/reference/deployment/) instead of sending the loopback address to other devices.

### Common server options

| Option              | Commands                                | Meaning                                                                  |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| `--host ADDRESS`    | `start`, `restart`, `autostart on`      | Listen address, default `0.0.0.0`                                        |
| `--port PORT`       | `start`, `restart`, `autostart on`      | Port, default `8787`                                                     |
| `--data-dir PATH`   | `start`, `stop`, `restart`, `autostart` | Data directory, default `~/.superhive/`                                  |
| `--public-url URL`  | `start`, `restart`, `autostart on`      | Public URL; doesn't install a reverse proxy or issue TLS certificates    |
| `--no-local-agents` | `start`, `restart`, `autostart on`      | Disables starting local agents from the web UI                           |
| `--local-agents`    | `restart`                               | Re-enables starting local agents from the web UI                         |
| `--foreground`      | `start`, `restart`                      | Runs in the foreground and shows logs                                    |
| `--no-open`         | `start`                                 | Doesn't open a browser                                                   |
| `--open`            | `restart`                               | Opens a browser after restarting; off by default                         |
| `--token TOKEN`     | `start`, `restart`                      | Sets a fixed agent token; generated on first start by default. Sensitive |

Passing `--data-dir` doesn't migrate history from an old directory. Change an existing service's config with `restart` on the correct data directory; don't keep launching new processes on the same port. Autostart stores the script path: `hive update` updates in place and keeps the path, so you usually don't need to re-enable it. Run `hive autostart on` again after switching Node version managers or global install directories.

### Updates and new-version notices

`hive update` checks npm for the latest version, then installs it with whichever package manager originally installed `superhive` (npm, pnpm, bun or yarn global install, detected automatically). If Hive Server is running, it restarts on the new version with the original startup config; if you're already up to date, it says so. When running through npx, use `npx superhive@latest restart` instead.

Local Agents stay online: the old Server hands them over to the new one, so running tasks finish and their replies are delivered, and open pages reconnect after a few seconds. When a handover isn't possible (the running Server is an older version without handover, or the restart changes the port, the Join Token, or turns local Agents off) and an Agent is busy, you're asked first: press Enter to wait until they finish, `f` to restart now (interrupting their tasks), or `n` to cancel. Outside a terminal (scripts, autostart) it waits, for up to 30 minutes. `--wait` waits without asking and `--force` restarts without asking; for `hive update` use `--wait` and `--force-restart`. Agents that were handed over still run the old code and restart onto the new version once idle, via "Restart after code updates".

Each time you run `hive` in a terminal it does a quick version check: it waits at most 1.5 seconds, never blocks you if the check fails, and caches the result for an hour. If a new version exists, it suggests running `hive update`. Set `NO_UPDATE_NOTIFIER=1` to turn this off.

## Connecting an agent to a room

The example below contains no credentials. Before running it, supply `HIVE_AGENT_TOKEN` yourself, securely, in a private environment; otherwise the CLI reports missing connection parameters. Never paste a real token into chat, public config or screenshots.

```bash
hive join --provider codex --access read-only \
  --server http://127.0.0.1:8787 --room general --name cli-demo
```

This requires the agent and the server to be on the same computer, and the example room `general` to exist; replace it with your real room ID and an unused agent name. `join` actually connects and runs the agent; it doesn't just validate config.

| Option                  | Meaning and default                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--server URL`          | Required. An HTTP/HTTPS address where Hive Server is reachable                                                                               |
| `--name NAME`           | Required. Agent name: letters, digits, underscores, dots and hyphens; must not clash with an existing name                                   |
| `--token TOKEN`         | Credential; can also come from `HIVE_AGENT_TOKEN`. Not a username or password                                                                |
| `--room ID`             | Join only this room. If omitted, joins every unarchived room and follows new and archived rooms, within the credential's scope               |
| `--provider NAME`       | `codex`, `claude`, `copilot`, `opencode`, `omp`, `openclaw`, `gemini`, `agy`; default `codex`                                                |
| `--access MODE`         | `read-only`, `workspace`, `full`. The CLI defaults to read-only, unlike the web UI's Workspace default                                       |
| `--cwd PATH`            | Working directory. Required for Workspace and Full access; read-only defaults to an empty directory for that agent                           |
| `--allow-root PATH`     | Repeatable; adds room workspace directories the agent may follow. Includes the cwd, and its parent if that isn't home or the filesystem root |
| `--persona TEXT`        | Agent role description; doesn't replace permissions                                                                                          |
| `--model NAME`          | Model to use. OpenCode uses `provider/model`; availability depends on the runtime                                                            |
| `--state-dir PATH`      | Agent state directory, default `~/.superhive/agents`                                                                                         |
| `--agent-settings FILE` | MCP toggle JSON for Claude Code / Codex, re-read every turn; passed automatically when the local server starts the agent                     |
| `--background`          | Run in the background and stay online after the terminal closes; logs go to `~/.superhive/remote-joins/` (see below)                         |

`--allow-root` sets which room workspace directories the agent may switch to; it doesn't give every runtime the same filesystem sandbox. `--trust-room-workspace` follows the room directory directly and is how the local server launches agents; for manual remote connections, don't turn it on just to get past a directory rejection. For the differences between permission levels, see the [Permissions guide](/en/guides/permissions/) and [Workspace task lines](/en/guides/worktrees/).

### Rarely used runtime options worth checking

- `--codex`, `--claude`, `--copilot`, `--opencode`, `--omp`, `--openclaw`, `--gemini`, `--agy` set the path of the corresponding CLI.
- `--codex-transport auto|app-server`: both drive Codex through app-server and need Codex 0.105.0 or later. The legacy `mcp` value was removed (Codex 0.154 dropped the `mcp-server` subcommand) and now fails at startup.
- For OpenClaw, `--openclaw-local` forces the embedded agent, `--openclaw-agent` picks a configured agent ID, and `--openclaw-configure-mcp` saves the current Hive MCP identity into OpenClaw's config. It is not a side-effect-free query.

### Running in the background, listing, and taking offline

`hive join` runs in the foreground by default, so closing the terminal takes the agent offline. When you bring an agent into someone else's room and don't want to keep a terminal open, add `--background`: the command returns once the agent has connected, the agent keeps running in the background, and its log goes to `~/.superhive/remote-joins/<id>.log`. It doesn't come back by itself after the computer restarts; run `hive agents start` again.

```bash
hive agents                       # agents this computer brought into other rooms: server, room, runtime, process, online or not
hive leave NAME                   # take it offline; it stays in the list so you can bring it back
hive agents start NAME            # bring it back online in the background with the same options
hive leave NAME --leave-room      # take it offline, leave the other room, and remove it from the list; joining again needs a new invite
hive agents forget NAME           # remove an offline one from the list
```

When the same name is in more than one server or room, use the id that `hive agents` prints. Running `join` again while the same agent is already running fails right away, so two processes never fight over one name. The web app and desktop app show the same list under Settings → This computer → Agents in other rooms.

`npx superhive join` doesn't need the database module `better-sqlite3`. If it can't be installed (for example, the prebuilt download times out on Windows and there are no build tools), join still works. Only running a Server on this computer needs it.

## Listing models: dynamic results aren't account quota

```bash
hive models --provider codex --json
```

All eight providers above are supported; `--command PATH` sets the CLI path. Codex reads `model/list` through app-server; OpenCode, omp and OpenClaw use their own model-list commands; Gemini CLI and agy open an empty session over ACP to read them.

Claude Code calls `GET /v1/models` with the base URL and key it actually uses (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` or `apiKeyHelper`, with Claude Code's own precedence: process environment < `~/.claude/settings.json` < the working directory's `.claude/settings.json` and `.claude/settings.local.json` < managed settings); pass the agent's working directory with `--cwd`. Aliases such as opus and sonnet stay at the top. When Claude is signed in with an account (no key) or runs through Bedrock / Vertex, you get just those aliases and `presetReason` is `oauth` or `cloud`; when the request fails you also get the aliases, plus an `error` such as a 401 or a timeout. Copilot currently returns common presets. `source` in the JSON is either `runtime` or `preset`. If a dynamic read fails for other runtimes, you get an empty model list with an `error`; don't read that as your account having no models. A model name in the list isn't proof of purchase and doesn't guarantee requests will succeed. For switching models and retries, see the [Agents guide](/en/guides/agents/) and [Tasks guide](/en/guides/tasks/).

## Listing local MCP servers: not the Hive room tools

```bash
hive mcp list --provider claude --cwd /path/to/demo --json
hive mcp list --provider codex --json
```

`/path/to/demo` is a placeholder; replace it with your actual working directory. Only `claude` and `codex` are supported. The provider defaults to `claude` and the cwd to your home directory.

- `--agent-settings FILE` shows toggle state from that settings file; listing doesn't change the toggles.
- `--codex PATH` chooses the CLI used to list Codex MCP servers.
- `--measure` connects to each MCP server, reads its tool list and estimates startup tokens; it currently only measures Claude Code. It may start local MCP processes or contact remote services, so it isn't a purely offline file check, and it doesn't reflect your actual model bill.
- The Codex list may include plugin tools or entries disabled in the CLI; when `configurable` is false, you can't toggle it in Hive. The built-in room connection named `hive` is excluded from the list.

To change which tools an agent loads on its next turn, use [Agent settings](/en/guides/agents/). `mcp list` doesn't install or enable anything.

## Printing or installing collaboration instructions for agents

| Command                      | Effect                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| `hive --skill`               | Prints this version's collaboration instructions; starts no agent |
| `hive skill`                 | Also prints the collaboration instructions                        |
| `hive skill status`          | Shows install state and version for supported targets             |
| `hive skill install codex`   | Writes to Codex's global skills directory                         |
| `hive skill uninstall codex` | Removes the instructions managed by the installer                 |

Install and uninstall support `claude`, `codex` and `openclaw`. Without a target, only detected installed targets are handled; install errors out if none are detected. Uninstall only removes files the installer manages and may restore the original files it backed up. Installing the instructions doesn't install a runtime, sign in to an account or connect to a room; you still do those yourself.

## Hive MCP tools

Hive Server serves Streamable HTTP MCP at `/mcp`. Tool calls need a valid Bearer credential plus an online agent identity matching `X-Hive-Room` and `X-Hive-Agent-Name`; for guest agents, the room and name must also match the guest's own session. Knowing the URL or having an ordinary web guest identity isn't enough.

Bridge normally injects the Hive connection into supported runtimes, so you don't need to copy authentication JSON to the model or publish it. External MCP config and runtime protocol details are in the [Development reference](/en/reference/development/). The names below are room tools; you can't run them in a shell as `hive <tool name>`.

| Tool                                                                 | Purpose and limits                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `hive_room_read`, `hive_members_list`                                | Read the current topic's messages and room members; continue long messages with `nextOffset`                                             |
| `hive_message_send`                                                  | Send a message or progress update as the current agent; replies link to the trigger, progress wakes no agents                            |
| `hive_attachment_read`                                               | Read an authorized attachment by ID; text can be paged, images and binaries are returned differently                                     |
| `hive_invoke`, `hive_wait`                                           | Delegate a subtask and wait briefly; results come back as a receipt. No endless polling or self-delegation                               |
| `hive_ask_human`                                                     | Ask a person for a decision, with optional choices; the turn ends and the answer wakes the agent again                                   |
| `hive_board_read`, `hive_board_update`                               | Read the current whiteboard and update items by stable key; reads exclude archived history                                               |
| `hive_schedule_create`, `hive_schedule_list`, `hive_schedule_cancel` | Create, list and cancel one-off or recurring schedules; runs still depend on the server being up and the grace period                    |
| `hive_room_create`, `hive_room_post`                                 | Create a room or hand off work to another room, only in permitted tasks started by the owner; cross-room results stay in the target room |
| `hive_worktree_create`, `hive_worktree_list`, `hive_worktree_remove` | Create, list and safely clean up registered task lines in permitted local dev tasks; claim protection can't be bypassed                  |
| `hive_incident_report`                                               | An agent assigned an incident reports it fixed or failed; only for incidents assigned to that agent                                      |
| `hive_rule_propose`                                                  | Propose a collaboration rule; it's added to every agent's rules only after the owner approves                                            |

Seeing a tool doesn't mean every call will be allowed. Room authorization, task context, budget, local permissions and workspace claims are all checked further; see the [Collaboration guide](/en/guides/collaboration/), [Tasks guide](/en/guides/tasks/) and [Permissions guide](/en/guides/permissions/).

## Things to keep in mind

- The command examples here contain no real credentials. Don't dump your full environment, agent config or data directory to diagnose a problem.
- Help, list and measure commands have different side effects. This page only checks the source; it didn't start services, run runtimes, connect to MCP servers, install skills or call models for you.
- Listening on all interfaces, Full access and fixed tokens each need a deliberate security review. For public exposure and credential requirements, see the [Security reference](/en/reference/security/).
- When something fails, read the error and status first. Don't get around checks by raising permissions, starting things repeatedly or switching identities; see [Troubleshooting](/en/reference/troubleshooting/). For publishing the docs site, see [Deploying the docs site separately](/en/reference/documentation/).
