---
title: Building plugins
description: Build a SuperHive plugin that adds a sidebar panel, / commands, and MCP tools for local agents. Plugins start with no permissions until the owner approves them.
---

A plugin is a folder with a `superhive-plugin.json` manifest at its root. In this first phase a plugin can do three things:

- **Sidebar panel**: a web page that runs in a sandboxed iframe with no same-origin access. It can only ask SuperHive for data through `postMessage`.
- **Slash commands**: typing `/command args` in the message box hands the command to the plugin's panel. Results only go into the message box, and you decide whether to send them.
- **MCP tools**: stdio MCP servers for local agents. They're added to a runtime's config only after the owner confirms each one.

The Hive Server never runs plugin code. Panel code runs in the browser sandbox, and MCP servers are started by the agent runtime (Claude Code, Codex, and so on) from its config.

## Install and approve

1. Put the plugin folder in Hive's plugin folder. By default that's `plugins/` in the data folder, next to `hive.sqlite`. The folder name must match the manifest `id`. Set `HIVE_PLUGINS_DIR` to use a different location, or `HIVE_PLUGINS=0` to turn plugins off.
2. On **the computer running the Server**, open the web app and go to **Settings · Plugins**. Click **Refresh** to see the plugin and an explanation of every permission it asks for.
3. Click **Approve**. Its panel shows up in the **Plugins** tab of the right sidebar, and its / commands start working.
4. If the plugin has MCP servers, check the runtimes each one should go into on the same page, then click **Confirm**.

Only the owner on the Server's computer can approve or revoke plugins. The owner's other devices, guests, and agents can't.

**Revoking** takes effect immediately. Open panels close right away, panel URLs that were already handed out stop serving files, / commands stop working, and any MCP entries the plugin added to runtime configs are removed.

**Upgrading**: replace the folder. If the new version doesn't ask for more permissions, it keeps working. If it does, the whole plugin is turned off and the settings page marks the new permissions; it comes back once the owner approves it again. MCP servers whose command or arguments changed also need to be confirmed again.

## Example: dice

`examples/plugins/dice` in the repo is a complete example: a sidebar panel that rolls dice, a `/roll 2d6` command, and a `roll_dice` MCP tool for agents. Copy it into the plugin folder to try it:

```bash
cp -r examples/plugins/dice ~/path/to/data/plugins/dice
```

## Manifest

```json
{
  "id": "dice",
  "name": "Dice",
  "version": "0.1.0",
  "description": "Roll dice in the sidebar and put the result in the message box",
  "engines": { "superhive": ">=0.4.0" },
  "permissions": ["members:read", "composer:write"],
  "guests": false,
  "contributes": {
    "panels": [{ "id": "main", "title": "Dice", "entry": "panel.html" }],
    "commands": [{ "name": "roll", "description": "Roll dice, e.g. /roll 2d6", "panel": "main" }],
    "mcpServers": [
      {
        "name": "dice",
        "command": "node",
        "args": ["./mcp.mjs"],
        "description": "Gives agents a roll_dice tool"
      }
    ]
  }
}
```

| Field                    | Meaning                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | Lowercase letters, digits, dots, and hyphens, 3–64 characters. Must match the folder name                                                                                                                         |
| `version`                | `x.y.z`                                                                                                                                                                                                           |
| `engines.superhive`      | Compatible SuperHive versions. Supports `*`, `x.y.z`, `>=`, `<`, `^`, and `~`; separate parts with spaces to require all of them. Ranges it doesn't understand count as incompatible, and the plugin isn't loaded |
| `permissions`            | Requested permissions, listed below. Leave it out for no permissions                                                                                                                                              |
| `guests`                 | Whether guests (people who joined by invite) can see the panels and commands. Defaults to `false`                                                                                                                 |
| `contributes.panels`     | Up to 4. `entry` is a relative path to an `.html` file in the plugin folder                                                                                                                                       |
| `contributes.commands`   | Up to 16. `name` has no slash; `panel` is the panel that handles it                                                                                                                                               |
| `contributes.mcpServers` | Up to 4, stdio only                                                                                                                                                                                               |

If the manifest is wrong, the settings page shows **Can't load** and the reason.

## Permissions

| Permission       | What it allows                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `room:read`      | While the panel is open, read up to the 50 most recent messages the viewer can see in this room |
| `members:read`   | Read room members: names, whether each is a person or an agent, and who's online                |
| `composer:write` | Fill in the message box. Plugins can't send messages for anyone                                 |

Any permission not in this table is rejected. Calling a method without its permission returns `PERMISSION_DENIED`.

## Panels

A panel is an ordinary web page with these limits:

- The iframe doesn't get `allow-same-origin`, so the panel has an opaque origin. It can't read SuperHive's localStorage or cookies, and it can't call Hive's API with the viewer's login.
- The response carries a CSP with `connect-src 'none'`, so it can't use the network (fetch and WebSocket are blocked). Scripts, styles, and images can only come from the plugin's own folder.
- Only these file types are served: `.html`, `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.png`, `.jpg`, `.webp`, `.woff2`.

`postMessage` is the only way to talk to SuperHive. `sdk.js` in the example is a minimal wrapper you can copy:

```js
// Call a method; returns a Promise
const members = await superhive.call("room.members");
await superhive.call("composer.insert", { text: "🎲 2d6: 3 + 5 = 8" });

// Receive / commands
superhive.on("command", ({ name, args }) => {
  /* For /roll 2d6, name = "roll" and args = "2d6" */
});

// Theme and language changes
superhive.on("context", ({ theme, locale }) => {
  document.documentElement.dataset.theme = theme;
});
```

| Method            | Permission       | Returns                                                                                     |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `context.get`     | None             | `{ roomId, locale, theme, viewer }`, where `viewer` is `owner` or `guest`                   |
| `room.messages`   | `room:read`      | `[{ seq, sender, content, createdAt }]`. Takes `{ limit }`, up to 50                        |
| `room.members`    | `members:read`   | `[{ name, type, online }]`                                                                  |
| `composer.insert` | `composer:write` | Takes `{ text }` (1–4000 characters) and appends it after what's already in the message box |

The raw messages: the plugin sends `{ superhive: 1, kind: "request", id, method, params }`. SuperHive replies with `{ superhive: 1, kind: "result", id, result }` or `{ superhive: 1, kind: "error", id, code, message }`. Events look like `{ superhive: 1, kind: "event", event, data }`. Error codes are `PERMISSION_DENIED`, `UNKNOWN_METHOD`, `BAD_PARAMS`, and `FAILED`.

## Slash commands

When you type `/roll 2d6` and send it, and an approved plugin in the current room declares `roll`, the text isn't posted to the room. SuperHive opens the **Plugins** tab in the right sidebar, switches to that panel, and sends it `{ name: "roll", args: "2d6" }`. If the panel is still loading, the command waits until it's ready.

A `/something` that no plugin claims is sent as a normal message. Messages with attachments are never treated as commands.

## MCP tools

`command` and `args` in the manifest are resolved against the plugin folder:

- Values starting with `./` are files in the plugin. They're written to the config as absolute paths and can't point outside the plugin folder.
- Anything else (`node`, `python3`, `uvx`, and so on) is written as a program name looked up on PATH.
- There's no shell, so pipes, variables, and other shell syntax don't work. A command with a path that doesn't start with `./` is rejected.

Once the owner confirms, SuperHive writes the server into the selected runtimes' global MCP config the same way the **Agent runtimes** settings page does (with a backup and an atomic replace), named `plugin-<id>-<name>`. Agents can use it starting with their next session.

An MCP server runs as a local program with the same access as the agent, which is why the owner confirms each one separately. Revoking the plugin, or unchecking a runtime on the settings page, removes the config entry.

## Security boundaries

- Plugins start with no permissions; the manifest only asks for them.
- Panels never see login credentials, can't use the network, and can't send messages for anyone.
- Guests can't see plugins by default. For a plugin with `guests: true`, guests only get the permissions the owner approved.
- Approvals are stored in `.grants.json` in the plugin folder. Deleting it revokes everything at once and panel URLs stop serving files, but panels already open in the web app only disappear after a refresh, and MCP entries already written to runtime configs have to be removed on the settings page or by hand. Use the settings page for normal revocation.

For the design reasoning, see `docs/research/plugin-system.md` in the repo.
