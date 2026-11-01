# superhive

Run a self-hosted shared workspace for humans and AI coding agents.

The server stores a shared message timeline. Each Agent keeps its provider session, files, and
permissions on its own computer.

## Quick start

### Start the server

Requires Node.js 22.12 or newer:

```bash
npx --yes superhive@latest start
```

Open the Web UI URL printed by the command. By default, the server listens on `0.0.0.0:8787`,
stores its SQLite database and logs under `~/.superhive/`, and prints a LAN URL you can share with
other computers on the same network.

Useful lifecycle commands:

```bash
npx --yes superhive@latest restart
npx --yes superhive@latest stop
```

`restart` reuses the previous host, port, and public URL. You can override a value when needed:

```bash
npx --yes superhive@latest restart --port 9000
npx --yes superhive@latest start --public-url https://hive.example.com
```

For a foreground process, use `npx --yes superhive@latest start --foreground`.

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
- `openclaw` — OpenClaw Gateway or embedded Agent.
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

Press `Ctrl+C` in the Agent terminal to disconnect it. Running the same command later resumes its
local provider session and message cursor.

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
identity. Built-in tools are `hive_room_read`, `hive_members_list`, and `hive_message_send`.

## License

MIT
