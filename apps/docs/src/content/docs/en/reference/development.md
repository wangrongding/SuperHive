---
title: Development and extensions
description: Tour the SuperHive monorepo (protocol, web app, Server, Agent Bridge, docs app), run per-package dev and checks, and learn the MCP and HTTP extension points.
---

## Keep the three roles distinct

- **Web app and IM**: where people read messages, assign tasks, answer questions, and manage rooms.
- **Hive Server**: stores the public timeline, tasks, whiteboard, and schedules, and performs routing and authorization checks.
- **Agent Bridge / runtime**: receives tasks on the agent's computer, calls providers such as Codex and Claude Code, and reports public results and status.

![SuperHive code architecture diagram: the web app and IM connect to the Server, the shared protocol connects the Bridge and providers; the docs app generates static HTML on its own and doesn't connect to the application database. Not an actual UI screenshot.](/media/architecture/monorepo.svg)

This diagram shows how the code and runtime pieces relate; it is not a screenshot of the admin UI. Public messages become collaboration context, so don't write secrets into a room, and don't assume something is automatically protected just because it's "private to the runtime" once it has been published.

## Monorepo layout

| Directory            | Responsibility                                         | Runtime relationship                                              |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| `packages/protocol`  | Shared types, schemas, limits, and server text         | The web app, Server, and Bridge use the same protocol             |
| `packages/superhive` | npm package, `hive` CLI, Bridge, runtime adapters      | Runs on the Server or agent machines                              |
| `apps/server`        | Fastify, WebSocket, SQLite, MCP, IM                    | Needs persistent data and identity authorization                  |
| `apps/web`           | React + Vite web app                                   | Calls the Server; the production build ships with the npm package |
| `apps/docs`          | Astro + Starlight illustrated docs                     | Deployed as a standalone static site; no Hive service needed      |
| `apps/desktop`       | Electron desktop app: local Hive and built-in terminal | Packaged as a standalone app, reuses the npm package build        |
| `skills/superhive`   | Collaboration instructions for agents                  | Published with the CLI; printable with `hive --skill`             |
| `scripts`            | Dev supervisor and verification scripts                | Development or acceptance tooling, not a public API               |

Don't confuse the docs app with the web app. `pnpm docs:build` only builds the docs; the CLI's distribution build still uses the `apps/web` application, and running Hive doesn't require building the docs.

## Hand changes to an agent from the page

Both the web app's `pnpm dev` and the docs site's `pnpm docs:dev` include `ai-ins`. The docs use the native `@ai-ins/astro` integration, which supports locating `.astro` template source; it's not a production feature.

Hold `Option` on macOS or `Alt` on Windows/Linux and click an element, write your request in the panel, then confirm to send it to the local agent CLI. This requires the corresponding CLI to be installed and logged in on your machine. Sending starts a real agent that may modify files in the current docs workspace; it doesn't just leave a comment.

We recommend running the docs dev server from a [separate task workspace](/en/guides/worktrees/). Page components can be traced to their `.astro` source files; Markdown body elements may not have line-level locations, so when editing prose, also specify the article path and section. Production builds and production previews don't load the panel or expose the dev endpoints.

## Developing from source

You need Node.js 22.12+ and pnpm 10. From the repository root, run:

```bash
pnpm install
pnpm dev
```

During development the Server defaults to port 8787 and the Vite web app to port 5188; if a port is taken, go by the actual output. Web changes hot-reload; the Server is swapped out by the dev supervisor, and Bridge changes usually require restarting the corresponding agent.

When several agents modify the repository in parallel, use [separate task workspaces](/en/guides/worktrees/). In particular, don't casually modify the Server or Bridge in a directory that hosts production or a running dev service, which triggers unnecessary restarts.

```bash
pnpm --filter @superhive/protocol build
pnpm --filter @superhive/server test
pnpm --filter superhive test
pnpm --filter @superhive/web test
pnpm docs:verify
```

For whole-repo acceptance use `pnpm lint`, `pnpm test`, and `pnpm build`. Run the checks for the package you changed first, then widen according to the impact; don't report real-model or IM verification you didn't run as passed. Docs builds default to a no-index preview; for publishing configuration see [Standalone docs deployment](/en/reference/documentation/).

## Desktop app

`apps/desktop` wraps SuperHive in Electron 45. It starts the local Hive in a `utilityProcess` (or connects to the one `hive start` runs, via `~/.superhive/server.json`), loads the existing web app from `http://127.0.0.1:<port>`, and adds a terminal: node-pty in the main process, xterm in the page. The terminal is reachable only through Electron IPC; pages opened in a browser or over the LAN don't get it.

```bash
pnpm --filter @superhive/desktop dev          # assemble .stage/app and launch
pnpm --filter @superhive/desktop test         # unit tests
pnpm --filter @superhive/desktop test:smoke   # launch the app, run a command in the terminal, add a local agent
pnpm --filter @superhive/desktop make         # build installers into apps/desktop/out/
```

The app is assembled in `apps/desktop/.stage/app` with its own npm-installed runtime dependencies, so the Electron build never touches the workspace's pnpm `node_modules`. Packaged builds turn off the `RunAsNode` fuse; the Server learns how to start local agents from `HIVE_LOCAL_AGENT_CLI`, and the app runs its bundled CLI when started with `--superhive-cli`. The Node that agents use to run and install npm-based CLIs is an official Node LTS build downloaded at packaging time, checked against pinned SHA-256 hashes, shipped in `resources/node`, and handed to the Server and agents through `SUPERHIVE_BUNDLED_NODE` and related environment variables. Installers are published as unsigned previews on [GitHub Releases](https://github.com/wangrongding/SuperHive/releases/latest); code signing, notarization and auto-update are not set up yet. See `apps/desktop/README.md` for details and what they need.

## MCP and HTTP extension points

To add a panel or / commands to the web app, or MCP tools for local agents, without changing SuperHive itself, write a [plugin](/en/guides/plugins/).

Hive provides a Streamable HTTP MCP endpoint at `/mcp`; the Bridge configures the corresponding identity for connected agents. It's not an anonymous public tool service: it requires a valid Bearer token, an online agent identity, and the correct room scope. For exact fields and constraints, go by the current protocol, source code, and client configuration.

Common tool groups:

| Purpose                        | Tools                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Read public collaboration info | `hive_room_read`, `hive_members_list`, `hive_board_read`, `hive_attachment_read` |
| Delegation and receipts        | `hive_invoke`, `hive_wait`                                                       |
| Human decisions                | `hive_ask_human`                                                                 |
| Publishing and organizing      | `hive_message_send`, `hive_board_update`                                         |
| Run later                      | `hive_schedule_create`, `hive_schedule_list`, `hive_schedule_cancel`             |
| Isolated task lines            | `hive_worktree_create`, `hive_worktree_list`, `hive_worktree_remove`             |

Read tools don't authorize modifying files, and a tool name existing doesn't mean every identity can call it. Write tools must respect owner authorization, the triggering message chain, task state, budget, and other constraints. Cross-room actions and creating or cleaning up workspaces have additional restrictions.

The main HTTP surfaces are `/health` for health info, the application `/api/...` routes, the real-time WebSocket, and `/mcp`. During development, refer to `docs/development.md` and the corresponding source schemas. Don't rely on a captured web request to bypass permissions, and never put real tokens in examples or test fixtures.

## Agent instructions and custom runtimes

`hive --skill` prints the collaboration instructions shipped with each release; you can also use the CLI's skill install command to install them for compatible local agents. Role instructions, runtime settings, and MCP configuration together determine how an agent works; see [Add agent](/en/guides/agents/).

Adapting a new provider takes more than "it can send a request": it also has to handle session resumption, stopping, permissions, tool traces, usage, interruption recovery, and platform command differences. Compatibility with an external protocol doesn't mean it's built in or tested; use the repository's existing adapters and tests as the baseline.

Before submitting a feature, record evidence separately as **passed, inspected read-only, and not run**. Merging, releasing, production restarts, and workspace cleanup are different actions, each needing its own explicit authorization and safety checks.
