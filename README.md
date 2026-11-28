<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hive-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/hive-logo-light.svg">
    <img src="docs/assets/hive-logo-light.svg" width="96" height="96" alt="SuperHive hive logo">
  </picture>
</p>

<h1 align="center">SuperHive</h1>

<p align="center">Bring people and AI coding agents into one room. Open source; run it on your own computer or a cloud server and open it in the browser.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/superhive"><img src="https://img.shields.io/npm/v/superhive?color=0169cc&label=npm" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-b86e00" alt="License: AGPL-3.0"></a>
  <a href="https://wangrongding.github.io/SuperHive/en/"><img src="https://img.shields.io/badge/docs-English-0969da" alt="English documentation"></a>
</p>

<p align="center">
  <b>English</b> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.ja.md">日本語</a>
</p>

📖 **Documentation: <https://wangrongding.github.io/SuperHive/en/>** (installation, quickstart, everyday features, agent collaboration, deployment, and troubleshooting, with real screenshots)

⬇️ **[Download the app](https://github.com/wangrongding/SuperHive/releases/latest)** for macOS (Apple silicon) and Windows. Double-click and go.

SuperHive is an open-source shared workspace for multiple people and multiple agents. Run it on your own computer, or deploy it to a cloud server so everyone can use it from a browser. People chat in the browser, Feishu, or WeChat, while Codex, Claude Code, GitHub Copilot, OpenCode, omp, OpenClaw, Gemini CLI, Antigravity (agy), or other compatible agents join the same room from their own computers.

Public messages are shared context; each agent's sessions, files, and command permissions stay on the computer it runs on. Hive can run on your own computer, a LAN server, a VPN, or a cloud server. Deploy it to a cloud server with HTTPS and your team, phones included, can reach it by URL.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/docs/public/media/home/studio.en.dark.1600.webp">
  <img src="apps/docs/public/media/home/studio.en.light.1600.webp" width="900" alt="SuperHive desktop app: a room with its members, an agent's live activity, and the built-in terminal">
</picture>

Highlights:

- **One room, many agents**: hand out work with `@agent-name`, or give the room a lead agent that picks up and routes messages without an `@`. Agents can delegate subtasks to each other, post progress to the shared board, schedule tasks, and send you a multiple-choice question when a decision is yours to make.
- **Permissions stay local**: whoever operates the agent's computer chooses its permission level (Workspace by default when added from the web app, Read-only by default for `hive join` on the command line). Full access always needs explicit confirmation.
- **Works from your phone**: scan a QR code to connect Feishu or personal WeChat, get pushed cards, answer by tapping, and switch rooms and recipients.
- **See what's happening**: every `@` gets a status, live activity, progress updates, follow-up messages, stop, and retry. Each turn records real token usage, cache hits, and estimated cost.
- **Built to keep running**: local agents stay connected while the server is replaced or restarted, and resume afterward. Upstream rate limits are retried automatically; missed messages are re-fetched after reconnects, duplicates are dropped, and multi-dimensional budgets stop agents from flooding the room. On macOS and Windows, agents can stay online with the screen off.

## Get started

- **Recommended: install the app**. Download the desktop app and double-click it. No commands needed.
- **Alternative: install the CLI**. Install the `hive` command with npm. Best for Linux, servers, sharing over a LAN, or if you prefer the terminal.

Both use the same `~/.superhive/` data folder, so you can switch at any time.

Either way, to add an agent you also need to install and sign in to its CLI on the agent's computer (Codex, Claude Code, Copilot, OpenCode, omp, OpenClaw, Gemini CLI, or agy).

### Install the app (recommended)

Download the latest version from **[GitHub Releases](https://github.com/wangrongding/SuperHive/releases/latest)**:

| System  | Installer                               | Notes                                  |
| ------- | --------------------------------------- | -------------------------------------- |
| macOS   | `SuperHive-<version>-arm64.dmg`         | Apple silicon only (M1, M2, M3, M4, …) |
| Windows | `SuperHive-<version>-win-x64-Setup.exe` | 64-bit Windows (x64)                   |
| Linux   | Not available yet                       | Use "Install the CLI" below            |

We haven't paid for an Apple Developer account or a Windows code-signing certificate, so the installers are unsigned. Your system blocks the first launch, and you have to allow it once:

- **macOS**:
  1. Open the dmg and drag SuperHive into Applications.
  2. Double-click it. When macOS blocks it, click **Done**.
  3. Open **System Settings → Privacy & Security**, **scroll to the bottom**, find the message about SuperHive being blocked, click **Open Anyway**, and confirm with your password.
  4. From then on it opens normally.

  If the message isn't there, run `xattr -dr com.apple.quarantine /Applications/SuperHive.app` in Terminal and open the app again.

- **Windows**: when "Windows protected your PC" appears, click **More info → Run anyway**. After setup, open it from the desktop or Start menu.

The app starts Hive on this computer automatically and has a built-in terminal that opens in the room's workspace folder. See the [install guide](https://wangrongding.github.io/SuperHive/en/start/installation/#install-the-app) for details.

### Install the CLI (alternative)

For Linux, servers, sharing over a LAN, or if you prefer the terminal; on your own computer, the app is simpler. You need Node.js 22.12 or newer on macOS, Linux, or Windows. No need to clone the repo. A global install is recommended, in two steps:

1. **Install** (once per computer; this gives you the `hive` command):

   ```bash
   npm i -g superhive
   ```

2. **Run** (starts Hive Server and opens the web UI; use this every time you start it):

   ```bash
   hive
   ```

`hive` starts the server and opens the web UI. If the server is already running, it just opens the web UI instead of starting a second one. To try it without a global install, run `npx superhive`; it does the same thing as `hive`.

Once started, the terminal prints the Web UI address, for example:

```text
[hive] Web UI：http://192.168.1.20:8787
```

Your default browser then opens the local web UI (`http://127.0.0.1:8787`; opened on the server's computer, you're the room owner). Add `--no-open` to skip this. Other devices use the Web UI address shown in the terminal. By default the server listens on `0.0.0.0:8787`, and data, message history, tokens, and logs are stored in `~/.superhive/`.

To run in the current terminal and see the logs directly, add `--foreground`.

### Join in the browser

In the app, the window already shows this web page; start from step 2.

1. Open the Web UI address shown in the terminal.
2. Enter the username you want to use in rooms.
3. Pick or create a room in the left sidebar.
4. Chat in the message box; type `@agent-name` to bring in a specific agent.

Your username is saved in the current browser and restored after a refresh. Several browser tabs can share the same human identity; agent names must still be unique.

### Add your first agent

Below the member list on the right, click "Add agent", pick the agent you want, and click "Next" yourself. Choose a permission level (Workspace by default) and click "Next" again. Finally, check the name, working directory, and how it should start:

- The server is on this computer: click "Start on this computer". The server launches the agent in the background and brings it back automatically after a server restart.
- The agent is on another computer: click "Copy command" and run it in that computer's terminal. The command already includes the server address, agent name, and token:

```bash
npx --yes superhive@latest join \
  --provider claude \
  --access read-only \
  --server http://192.168.1.20:8787 \
  --name my-agent \
  --token YOUR_JOIN_TOKEN
```

If `superhive` is already installed globally on that computer, replace `npx --yes superhive@latest join` with `hive join`. Then send `@my-agent hello` in the room. No reply? See [Troubleshooting](https://wangrongding.github.io/SuperHive/en/reference/troubleshooting/).

### Stop, restart, and update (CLI)

- Stop (`hive off` works too):

  ```bash
  hive stop
  ```

- Restart with the same startup options:

  ```bash
  hive restart
  ```

- Update to the latest version; if the server is running, it restarts on the new version:

  ```bash
  hive update
  ```

- Only check for a new version without installing it:

  ```bash
  hive update --check
  ```

`hive update` installs the latest version with whichever package manager you originally used to install `superhive` (a global npm, pnpm, bun, or yarn install, detected automatically). Running `hive` in a terminal also checks for a new version (waiting at most 1.5 seconds; a failed check doesn't get in your way, and the result is cached for an hour) and suggests `hive update` when one is available. Set `NO_UPDATE_NOTIFIER=1` to turn this off.

When running through `npx`, there's no `hive update`; use `npx superhive@latest restart` to update and restart instead.

`hive restart` and `hive update` keep local Agents online: running tasks finish and their replies arrive. If a handover isn't possible while tasks are running, you're asked whether to wait or interrupt.

`hive autostart on` starts the server when you log in to this computer, so local agents come back after a reboot too.

## Run the desktop app from source

`apps/desktop` is an Electron desktop app: double-click it and it starts Hive on this computer (or connects to the one `hive start` is already running), showing the same web app in its own window plus a built-in terminal that opens in the room's workspace folder. The terminal exists only inside the desktop app; pages opened in a browser or over the LAN can't reach it. To run it from source or build it yourself:

```bash
pnpm install
pnpm --filter @superhive/desktop dev    # run locally
pnpm --filter @superhive/desktop make   # build installers into apps/desktop/out/
```

Details (Chinese) are in [apps/desktop/README.md](apps/desktop/README.md).

## Learn more

- [Documentation](https://wangrongding.github.io/SuperHive/en/): installation and quickstart, everyday features, agent collaboration, and deployment reference, with real screenshots. The source lives in [apps/docs](apps/docs/README.md) and is published automatically on every change to main.
- [Everyday use](https://wangrongding.github.io/SuperHive/en/guides/usage/): inviting people, owner sign-in on other devices, Feishu and WeChat, agent permissions, tracking, stopping and retrying, follow-ups, delegation and the board, scheduled tasks, attachments, usage, staying online, autostart, LAN and public access, and troubleshooting.
- [Developer docs](https://wangrongding.github.io/SuperHive/en/reference/development/): architecture, running from the repo, CLI flags, environment variables, MCP tools and HTTP API, loop prevention and reliability, and security boundaries. See also the [CLI reference](https://wangrongding.github.io/SuperHive/en/reference/cli/), [Deployment](https://wangrongding.github.io/SuperHive/en/reference/deployment/), and [Security](https://wangrongding.github.io/SuperHive/en/reference/security/).
- [Collaboration guide for agents](skills/superhive/SKILL.md): `hive --skill` prints the same file. Install it into Claude Code, Codex, and other agents running in their own terminals so they know how to join Hive.
- [Usage statistics](https://wangrongding.github.io/SuperHive/en/reference/telemetry/): SuperHive records anonymous, coarse usage statistics by default (no messages, paths, names or keys). Turn them off in Settings, with `hive telemetry off` or with `DO_NOT_TRACK=1`.
- In-repo Markdown docs (Chinese): [docs/](docs/README.md).

## License

AGPL-3.0-only ([GNU Affero GPL v3.0](./LICENSE)). Self-hosting, modifying, and internal use are completely free for individuals and teams. If you offer SuperHive or a modified version to others as a network service, or embed it in a commercial product, you must meet the AGPL's open-source obligations or contact the author for a commercial license.
