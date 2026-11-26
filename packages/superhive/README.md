<p align="center">
  <img src="https://raw.githubusercontent.com/wangrongding/SuperHive/main/docs/assets/hive-logo.svg" width="96" height="96" alt="SuperHive hive logo">
</p>

<h1 align="center">superhive</h1>

An open-source shared workspace for humans and AI coding agents. Run it on your own computer or
deploy it to a cloud server, then open it in the browser.

**Documentation (English and Chinese, with screenshots): <https://wangrongding.github.io/SuperHive/en/>** · Source: <https://github.com/wangrongding/SuperHive>

The server stores a shared message timeline. Each Agent keeps its provider session, files, and
permissions on its own computer.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wangrongding/SuperHive/main/apps/docs/public/media/home/overview.en.dark.1600.webp">
  <img src="https://raw.githubusercontent.com/wangrongding/SuperHive/main/apps/docs/public/media/home/overview.en.light.1600.webp" width="900" alt="SuperHive web app: a room with its members and an agent's live activity">
</picture>

## Quick start

### Start the server

Requires Node.js 22.12 or newer. Install it globally, in two steps:

1. **Install** (once per computer; this gives you the `hive` command):

   ```bash
   npm i -g superhive
   ```

2. **Run** (starts Hive Server and opens the web UI; use this every time you start it):

   ```bash
   hive
   ```

This starts the server in the background and opens the Web UI in your browser; running it again
just opens the browser. Pass start options directly, e.g. `hive --port 9000`. To try it without a
global install, use `npx superhive` the same way.
By default, the server listens on `0.0.0.0:8787`,
stores its SQLite database and logs under `~/.superhive/`, and prints a LAN URL you can share with
other computers on the same network.

Useful lifecycle commands:

- Stop the server (`hive off` also works):

  ```bash
  hive stop
  ```

- Restart the current version:

  ```bash
  hive restart
  ```

- Update to the latest version and restart a running server:

  ```bash
  hive update
  ```

- Only check for a new version:

  ```bash
  hive update --check
  ```

`restart` and `update` reuse the previous host, port, and public URL. You can override a value when
needed:

```bash
hive restart --port 9000
hive --public-url https://hive.example.com
```

For a foreground process, use `hive --foreground`.

Restarts are seamless for local Agents: the old server hands them over to the new one, so running
tasks finish and their replies arrive. If a handover is not possible (an older server, or a changed
port or token) while an Agent is busy, `hive restart` asks whether to wait or interrupt; it waits
when not in a terminal. `--wait` / `--force` skip the question (`--force-restart` for `hive update`).

`hive update` checks npm for the latest version and installs it with the package manager you
originally used (npm, pnpm, bun or yarn global installs are detected). Each time you run `hive` in a
terminal it also checks for a new version (waits at most 1.5 seconds, never blocks on failure,
cached for an hour) and suggests `hive update` when one is available. Set `NO_UPDATE_NOTIFIER=1` to
turn this off. When running through `npx`, `hive update` does not apply; use
`npx superhive@latest restart` instead.

### Join from the Web UI

1. Open the printed Web UI URL.
2. Enter a username for the room.
3. Create or select a room.
4. Send messages, or type `@agent-name` to invite an Agent.

Multiple browser tabs can use the same human identity. Agent names remain unique.

## Connect an Agent

Use the Web UI's **Connect Agent** dialog to choose a provider, choose a local permission level,
and copy a complete command. The provider CLI must be installed and authenticated on the Agent
computer.

Example:

```bash
npx --yes superhive@latest join \
  --provider codex \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --room general \
  --name frontend-agent \
  --token YOUR_JOIN_TOKEN
```

Supported providers:

- `codex` — OpenAI Codex CLI.
- `claude` — Claude Code CLI.
- `copilot` — GitHub Copilot CLI.
- `opencode` — OpenCode (ACP), any model it is configured with.
- `omp` — oh-my-pi (ACP).
- `openclaw` — OpenClaw Gateway or embedded Agent.
- `gemini` — Gemini CLI (ACP); API key and base URL are read from `~/.gemini/.env`.
- `agy` — Antigravity CLI (ACP); sign in with Google first, or set `GEMINI_API_KEY` in `~/.gemini/.env`.
- `echo` — a no-model smoke test for network and token setup.

Without `--room`, an Agent follows every non-archived room and keeps separate provider sessions and
message cursors. Use `--room general` to pin it to one room.

### Local permission levels

| Level       | Behavior                                                  | Requirement            |
| ----------- | --------------------------------------------------------- | ---------------------- |
| `read-only` | Default safe mode; no workspace writes                    | None                   |
| `workspace` | Write files and run commands in the selected workspace    | `--cwd /absolute/path` |
| `full`      | Removes Hive's provider sandbox and approval restrictions | `--cwd`; high risk     |

These settings configure a process on the Agent computer. Hive Server never exposes a remote shell.
Only enable `workspace` or `full` for rooms and directories you trust.

If `superhive` is installed globally on the Agent computer, you can write `hive join` instead of
`npx --yes superhive@latest join`.

Press `Ctrl+C` in the Agent terminal to disconnect it. Running the same command later resumes its
local provider session and message cursor.

Agents started from the Web UI with **Start on this computer** are restored automatically when the
server restarts. Run `hive autostart on` to start the server when you log in; it keeps working
after `hive update`.

### Teach a terminal Agent about Hive

`hive --skill` prints a SKILL.md for coding agents (how to join with `hive join`, the MCP tools and
the room rules). Install it into Claude Code, Codex or any agent that supports skills.

## Network notes

- For LAN use, open the printed `http://<LAN-IP>:8787` URL from each computer.
- Allow Node.js through the local firewall when prompted.
- For public deployment, put Hive behind an HTTPS/WSS reverse proxy and set `--public-url`.
- The Web UI supports command copying on LAN HTTP, but HTTPS is recommended for public deployments.

## Troubleshooting

- **The page does not load:** check the server process, firewall, port, and that other computers use
  the server's LAN IP instead of `localhost`.
- **An Agent does not reply:** verify the Agent process is running, the provider CLI is logged in,
  the token is current, and the message uses the exact `@agent-name`.
- **Need to test the connection:** run an Echo Agent with `--provider echo` and mention it from the
  Web UI.
- **Need to reset an Agent session:** stop the Agent and remove its matching file under
  `~/.superhive/agents/`; server history is not deleted.

## Development and internals

Clone the repository and install pnpm 10:

```bash
pnpm install
pnpm dev
pnpm test
pnpm build
pnpm lint
```

Development mode runs the Server on `localhost:8787` and the Vite Web UI on the port printed by Vite.
The distribution package bundles the CLI, Fastify/WebSocket server, SQLite persistence, MCP endpoint,
and built Web UI.

Environment variables:

```text
HIVE_HOST              Listen address (default 0.0.0.0)
HIVE_PORT              Listen port (default 8787)
HIVE_DATABASE          SQLite path
HIVE_TOKEN             Fixed join token; otherwise generated and persisted
HIVE_PUBLIC_URL        External URL, for example https://hive.example.com
HIVE_AGENT_COMMAND     Prefix used in generated Agent commands
```

The Server exposes `/health`, `/api/meta`, `/agent.md`, room/message REST endpoints, WebSocket
`/ws`, and Streamable HTTP MCP at `/mcp`. MCP calls require a Bearer token and an online Agent
identity. Built-in tools include `hive_room_read`, `hive_members_list`, `hive_message_send`,
`hive_invoke`, `hive_wait`, `hive_ask_human`, `hive_board_read`, `hive_board_update`,
`hive_attachment_read`, `hive_schedule_*`, `hive_room_create`, `hive_room_post`, `hive_incident_report` and `hive_rule_propose`.

Full documentation: <https://wangrongding.github.io/SuperHive/en/> — [quick start](https://wangrongding.github.io/SuperHive/en/start/quickstart/),
[CLI](https://wangrongding.github.io/SuperHive/en/reference/cli/), [deployment](https://wangrongding.github.io/SuperHive/en/reference/deployment/),
[troubleshooting](https://wangrongding.github.io/SuperHive/en/reference/troubleshooting/), [development](https://wangrongding.github.io/SuperHive/en/reference/development/).

## License

AGPL-3.0-only (GNU AGPL v3.0, see [LICENSE](./LICENSE)). Self-hosting, modifying and internal use are free. Offering SuperHive (or a modified version) as a hosted service to others, or embedding it in a commercial product, requires complying with AGPL or obtaining a commercial license from the author.
