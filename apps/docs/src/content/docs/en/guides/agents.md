---
title: "Add agents: runtimes, startup, and sessions"
description: Add an agent from the web app step by step, compare eight runtimes, start 1–5 at once locally or join remotely, and choose MCP servers and room sessions.
---

## What agents are for

An agent is a collaborator running on a computer. Hive hands room messages to it; it uses its own runtime to read code, answer questions, or run approved tasks, then posts the results back to the room. Hive doesn't install model CLIs for you, and it doesn't turn room members into remote shell users.

Haven't opened a room yet? Start with the [Quickstart](/en/start/quickstart/). Pick a [permission level](/en/guides/permissions/) before starting, and if several people will change code, agree on [task lines and worktrees](/en/guides/worktrees/) first.

## Choose a runtime

| Agent in the web app | Provider in commands | Prepare on the agent's computer        | Typical use                                                                  |
| -------------------- | -------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| Codex                | `codex`              | Install and sign in to Codex CLI       | Code analysis, implementation, debugging                                     |
| Claude Code          | `claude`             | Install and sign in to Claude Code CLI | Code analysis, implementation, and tool collaboration                        |
| GitHub Copilot       | `copilot`            | Install and sign in to Copilot CLI     | Development in the GitHub ecosystem                                          |
| OpenCode             | `opencode`           | Install OpenCode and configure a model | Use your own configured models and tools                                     |
| omp                  | `omp`                | Install oh-my-pi and configure a model | Terminal tools and models of your choice; note folder permission differences |
| OpenClaw             | `openclaw`           | Configure a Gateway or embedded agent  | Use existing agents and tool policies                                        |
| Gemini CLI           | `gemini`             | Install Gemini CLI and set an API key  | Gemini models, or other models through a proxy                               |
| Antigravity          | `agy`                | Install agy and sign in with Google    | Google's next-generation terminal agent                                      |
| Echo (command join)  | `echo`               | No model CLI needed                    | Verify networking, identity, and the message path; no real tasks             |

These are Hive's existing adapters. They don't mean every CLI version, model, account, or third-party plugin has been verified as compatible. The runtime must be installed on **the computer the agent actually runs on**; when joining by copied command, it doesn't need to be on the Server.

### Gemini CLI and agy: sign-in and API keys

Both join through ACP (`gemini --acp`, `agy acp`), using the same implementation as OpenCode and omp. Tested with Gemini CLI 0.70 and agy 1.5.14.

- **Gemini CLI**: on the agent's computer, put `GEMINI_API_KEY` in `~/.gemini/.env`, plus `GOOGLE_GEMINI_BASE_URL` if you use your own endpoint or a local proxy. When Hive starts Gemini CLI it reads this file and passes the variables along; a variable already set in the environment wins. Gemini CLI only reads `.env` in trusted folders, and a project's own `.env` would be found first, so Hive passes them explicitly.
- **Trusted folder**: Hive starts Gemini CLI with `--skip-trust`, which trusts the working folder for that session only and doesn't write `trustedFolders.json`. Once trusted, Gemini CLI loads project config in that folder such as `.gemini/settings.json` and `GEMINI.md`, so only point it at folders you trust.
- **agy**: run `agy` once in a terminal on the agent's computer and sign in with your Google account. To skip the Google account, set `GEMINI_API_KEY` (and `GOOGLE_GEMINI_BASE_URL`) in `~/.gemini/.env`: when agy isn't signed in, Hive signs it in with that API key. With neither, the agent replies in the room that agy isn't signed in and what to do; it doesn't hang or retry on its own.
- **Models**: `hive models --provider gemini` or `--provider agy` opens an empty session to read the available models; the model picker in the web app uses the same list. A model switch applies to the current session.
- **Continue a session in a terminal**: `gemini --resume <session ID>` for Gemini CLI, `agy --conversation <session ID>` for agy.

## Add an agent from the web app in three steps

Click "Add agent" below the member list. Making a selection only changes what's selected; it **doesn't advance to the next step automatically**.

1. **Choose an agent**: compare runtimes, then click "Next". You can't continue without a selection.
2. **Choose a local permission**: the default is "Workspace". Pick Read-only or Workspace, then click "Next". Full access requires confirming the risk first and isn't carried over the next time you open the dialog.
3. **Confirm how to start**: check the name, folder, and MCP servers, then start on this computer, or expand "Or copy the command and run it elsewhere".

![Diagram of adding an agent: manually choose a runtime and permission, then start it on the Server computer or copy a command to run on another computer. Not a real screenshot.](/media/codex4/agent-startup.svg)

This is an original diagram, not a product screenshot. Available buttons and entry points depend on the current page and your signed-in identity.

![The real first step of the add-agent dialog: one card for each of the eight runtimes, showing the provider and the version detected on this computer. Click "Next" after choosing.](/media/screens/onboard.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme.

### Start on this computer: 1–5 at a time

![The count control in the local start form: the name is Alice-codex and the count is 3, so it will start Alice-codex, Alice-codex2, and Alice-codex3. Screenshot of an isolated demo interface, cropped to remove the local working directory.](/media/interface/agent-count.png)

Screenshot of an isolated demo interface (cropped). Adjust the count with "− / +". The sample names aren't real members, and the screenshot doesn't prove these three agents were actually started.

In the start form:

1. Enter a name that's easy to tell apart, such as `frontend-agent`. Two agents can't use the same name at the same time.
2. Use "Count" to choose **1–5**. A batch shares the same runtime, permission, folder, and MCP settings; the form shows the names it will start in order.
3. For Workspace or Full access, check the "Working directory". It defaults to the directory Hive was started from; you can also enter an absolute path or `~/project`, or click "Browse…".
4. For Codex and Claude Code, expand "Local MCP servers" to choose what loads. Only enable trusted servers this task actually needs.
5. Click "Start on this computer", wait for each agent's result, then confirm they're online in the member list.

Batch creation happens one at a time. If one fails, the rest are not created, and **agents already started are not rolled back**. Check which names are online before trying again rather than starting another batch. The count isn't a task concurrency quota, and it doesn't guarantee that the agents finish initializing at the same time.

Batch names are numbered automatically and skip names already in the room; go by the "Will start" list below the form before starting. The count control supports the arrow keys, and Home / End jump to the minimum or maximum.

Starting locally is done by the computer running Hive Server, not by the browser installing a CLI on your current device. You can manage it when you open the page directly on the Server computer via `localhost` or a local IP. When the owner signs in from another device, they must request management authorization as the page prompts, and high-risk actions may also need one-time approval. Regular guests don't gain process management rights on the Server this way.

### Copy a command: have another computer join

In step 3, expand the copy-command entry and run the generated command in **the terminal of the agent's computer**. The example below only shows the flags; don't copy its server address or placeholder credential:

```bash
npx --yes superhive@latest join \
  --provider codex \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --room general \
  --name frontend-agent \
  --token YOUR_JOIN_TOKEN
```

- If `superhive` is already installed globally on that computer, you can replace `npx --yes superhive@latest join` with `hive join`; the flags stay the same.
- Use the real connection details generated by the web app; a remote computer can't use the Server's `localhost` address.
- The copied command contains a join credential. **Don't paste it into public chats, screenshots, repositories, or logs.** Guests should use their own invite identity rather than borrowing the owner's credential.
- A command join is a long-running foreground process. `Ctrl+C` in the terminal takes it offline; running the same connection settings again reuses the session and message cursor saved on that machine.
- To modify code, explicitly choose `--access workspace` and `--cwd /absolute/path/to/project`. Don't upgrade to Full access just for convenience.

For more flags, see the [CLI reference](/en/reference/cli/).

## Offline, removed, and reconnecting

When the owner opens the member list on the Server computer, local agents have two distinct states:

- **Offline**: The local configuration still exists, but its process is stopped. Click **Start** to use that configuration without setting up another agent.
- **Removed**: The local configuration was deleted, while the member record remains for historical messages. **Reconnect** prefills the original name, runtime, and known working directory. Confirm permissions and the directory again before creating the local agent with its original name.

Reconnection reuses the member identity, preserving messages, name-derived avatars, and whiteboard attribution. The original name is fixed and never automatically numbered. If it is taken, creation is rejected. Previous Full access is not restored automatically; it must be explicitly selected and confirmed again.

**Hide from list** hides only the removed member's list entry, not its messages or whiteboard entries. You can still right-click its name in a historical message to reconnect. Rejoining with the same name makes the member visible again.

Remote members, guests, and offline agents on other computers do not get these host recovery buttons. Configuration deleted by an older version cannot be recovered from nothing: a registered local task worktree can establish local ownership and recover its repository directory. Without trusted local records, the member stays Offline rather than being assumed to be local.

## Rooms, folders, and sessions are different things

| Setting or action                     | Actual effect                                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| No `--room`                           | Follows the server's unarchived rooms, keeping a separate session and message cursor per room                                           |
| `--room general`                      | Limited to that room                                                                                                                    |
| Setting a room workspace              | Local agents work in the room workspace; command joins still require it to be within the folders they may follow                        |
| `--allow-root PATH` on a command join | Expands the folders it may follow, can be repeated; it doesn't grant arbitrary write access to the whole tree                           |
| Creating a worktree task line         | The managed Bridge creates a new runtime session for the matching cwd through the handoff flow, rather than moving the old session over |

By default, a command join follows the room workspace within `--cwd` and its parent. Agents started locally from the web app can follow the room workspace configured by the owner, but remain bound by runtime permissions.

Read-only agents work in the room workspace too: they can read the files there, and writes are still blocked by the read-only mode (OpenClaw's permissions come from its own config, so a read-only OpenClaw agent doesn't follow). If the workspace doesn't exist on the agent's computer, or is outside the folders it may follow, the agent stays in its own folder and its rules say why. In the member list, hover the "Folder" badge next to an agent's name to see its actual working directory in this room. After the room workspace changes, the agent switches once its current work is done; until then the badge reads "Workspace pending", and "No workspace" means it isn't using the room workspace.

Sessions and cursors are stored in `~/.superhive/agents/` on the agent's computer, keyed by Server address, room, and name. Resuming a session doesn't mean the last run succeeded, and interrupted tasks aren't all rerun automatically; see [Tasks and recovery](/en/guides/tasks/).

### Conversations follow the task

An agent doesn't keep just one conversation per room:

- **The room conversation**: direct @-mentions from people, lead-agent pickups, and scheduled tasks all go here.
- **One per subtask**: a subtask another agent sends with `hive_invoke` starts its own conversation with only the task brief, without carrying the room conversation along. Rework or follow-ups the same requester sends for the same piece of work, receipts and reply wake-ups, and people replying directly to the subtask's delivery all continue that conversation. Moving into a task directory and back also picks up by "folder + conversation".
- **The room conversation renews itself**: between tasks (not a receipt, an answer to a question, or a resumed run, and with no subtasks still waiting for a receipt), once the room conversation reaches about 200k tokens (capped at 0.6 of the auto-compact threshold), or it sat idle past its cache lifetime while above 100k tokens, the agent starts a new one. The new conversation opens with a handoff summary built from the room record: what was recently asked of it, what people said, its own recent replies, subtasks still waiting for a receipt, and how to read further back. Task details show that it started a fresh conversation.
- **Each turn's chat context has a budget**: about 24k tokens by default. The trigger's reply chain, messages that mention or answer the agent, and its own messages are always included; the rest fill from newest to oldest. Very long messages and ones that don't fit get a one-line index, and anything older is summarised as a range to read with `hive_room_read`. Each subtask result is capped at 16k characters with a pointer to the rest.

Environment variables: `HIVE_TASK_LANES=0` turns off lanes and renewal and goes back to a single conversation; `HIVE_LANE_RENEW=0` turns off only renewal; `HIVE_LANE_RENEW_TOKENS` and `HIVE_LANE_RENEW_IDLE_TOKENS` set the renewal thresholds; `HIVE_PROMPT_BUDGET_TOKENS` sets the per-turn chat context budget. Subtask lanes need an updated server; until then everything stays in the room conversation.

## Do a quick check once it's online

1. Check the exact name in the member list and confirm it isn't still starting or already offline.
2. Send a low-risk request, such as "Summarize the scope of your task; don't change any files yet." In a room with a lead agent, it can also pick up human messages that mention no one.
3. Watch whether the message goes from queued to running. If not, open the task details and the local agent logs.
4. When assigning real work, spell out the goal, writable folders, deliverables, how to verify, and whether committing, pushing, or sending anything externally is allowed.

If the agent doesn't reply, check networking, CLI sign-in, the name, and message routing first; see [Common issues](/en/reference/troubleshooting/). Don't expose credentials or restart the model endlessly while troubleshooting.

## What you can adjust in local settings

In local agent settings you can view logs; stop, start, or restart the process; and adjust the model, reasoning effort, Claude's context and cache, supported MCP servers, and the "Auto-steer messages from people" switch. Auto-steer is off by default; read [the difference between steering and stopping](/en/guides/tasks/) before turning it on.

### Model and reasoning effort

The model and reasoning effort are set per agent and apply from the next reply, with no restart and no change to the CLI's global config on this computer. Reasoning effort defaults to "Follow CLI config": nothing is passed, the same as before this setting existed.

| Runtime     | How it reaches the CLI                 | Levels                                                         |
| ----------- | -------------------------------------- | -------------------------------------------------------------- |
| Claude Code | `--effort` on every turn               | low, medium, high, xhigh, max                                  |
| Codex       | `effort` on every `turn/start`         | Listed per model (`model/list`), with the default marked       |
| Copilot     | `--reasoning-effort` on every turn     | none to max; which ones work depends on the model              |
| omp         | The Thinking option of the ACP session | Listed per model (`omp models --json`); follows model switches |

OpenCode and Gemini CLI ACP sessions don't offer this option and OpenClaw isn't wired up yet, so their settings don't show reasoning effort. If the chosen level isn't supported by the current model, the settings say so; omp runs that turn at its previous effort and the run status explains why. When retrying a failed task with "Retry with another model", you can change only the effort, or the model and the effort together, for that one retry. The effort each turn actually used appears under "Usage this turn" in the task details.

### Claude context and cache

Claude Code agents have an extra "Context and cache" block in their settings. It also applies from the next reply, with no restart:

- **Auto-compact**: when the conversation grows past this size, Claude summarizes the earlier part, so each later turn stays fast and its cost stays steady, but older details survive only as a summary. The default is 400k tokens (agents added before this setting existed get 400k too); you can pick 200k, 600k, 800k or a custom size (100k to 2M). If the model's context is smaller than the threshold (a 200k model, say), Claude Code uses the model's limit and compacts as it nears it; "Usage this turn" in the task details says which limit applied. "No limit, let Claude Code decide" passes nothing, and Claude Code compacts only near the model's context limit.
- **Cache duration**: defaults to "Follow Claude Code". The room's lead agent uses 1 hour: its turns are often more than 5 minutes apart (waiting on subtasks or people), and a 5-minute cache would expire and have to be rewritten in full; when the lead changes, the next turn follows the new role. For other agents Claude Code picks automatically: usually 1 hour within subscription limits, 5 minutes beyond them or with an API key. You can pin it to 5 minutes or 1 hour. One-hour cache writes cost 2× the input price (5 minutes costs 1.25×); that's usually cheaper and faster when turns are often more than 5 minutes apart, but costs more in rooms that only chat now and then.

When the context is auto-compacted, the run status says "Context was auto-compacted (before → after tokens)" and "Usage this turn" in the task details shows it too. In the member list, a Claude agent's name shows its context at the end of the last turn against the threshold that applies (such as `121k/400k`) and about how many minutes of cache are left (counted from the last model request); hover for details. The cache part is hidden when its duration wasn't observed, and everything clears on a new topic.

When the cache lasts an hour (picked in the settings, the lead agent following Claude Code, or written that way while following Claude Code), the Claude process also stays for 55 minutes after a turn, so the cache isn't wasted; otherwise it stays 10 minutes. All agents on one computer keep at most 8 idle Claude processes in total; past that, the least recently used one is closed, and its next turn resumes the same session. The first compaction of an already large session has to read it all and write a summary: in a test with a 700k-token session, the first token of that turn took about 1.5 minutes, then the first token of later turns came in about 4 seconds instead of tens of seconds.

Extra MCP servers for Codex and Claude Code are optional; `hive` always loads. MCP sizes and new-session startup tokens are estimates, not an exact bill. Setting changes apply from later turns, and unchecking a server doesn't undo a tool call already running; use the restart option on the page to restart the agent.

### Agent runtimes: install, update, and CLI configuration

When you open the web app on the computer running Hive Server, "Settings" gains an "Agent runtimes" category that other devices don't see:

- **Installed agent CLIs**: lists each CLI's version, latest version, install location, and install method. Clicking "Update" or "Install" first shows the full command to be run; it runs only after you confirm, one at a time.
- **Runtime base URLs and keys**: view and change the base URL and key in each CLI's global configuration, masked by default. This edits the CLI's own config file, so the same CLI in your terminal is affected too.

![Installed agent CLIs under "Agent runtimes": one row each for Claude Code, Codex, GitHub Copilot CLI, OpenCode, Oh My Pi, OpenClaw, Gemini CLI, and Antigravity CLI, showing the current version, whether an update is available, the install path, and the source (npm, bun, or the official installer). Rows with an update have an "Update to x" button; Antigravity CLI, whose latest version can't be looked up, has "Try updating".](/media/screens/clis.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme. The user directory in paths is shown as `~`.

To teach agents in standalone terminals how to collaborate in Hive, see `hive --skill` or `hive skill install`; usage is in the [CLI reference](/en/reference/cli/). Installing the collaboration instructions doesn't join a room automatically or grant file or tool permissions.
