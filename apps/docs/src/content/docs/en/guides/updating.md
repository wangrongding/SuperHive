---
title: Updating SuperHive
description: One-click updates for npm browser installations, Agent handover, manual upgrades, and desktop in-app updates.
---

## npm installation: update in the browser

An instance installed with `npm install -g superhive` and managed in the background by `hive start` shows an update entry in its bottom status bar when a newer version is available. Open it to review versions and release notes. **Only the local owner, browsing on the computer running Hive, can choose Update and restart.** Guests have no update action. Remote owner devices see a contact-owner notice, even if they have approved host-management access.

1. Install the confirmed npm version in a staging directory. Check its version, Server and web files, and native SQLite dependency. The old Server keeps running.
2. Replace the global package only after verification, then restart with the same data directory and listener configuration.
3. The page reconnects and reloads automatically, showing the new version. Closing the dialog does not cancel the update; reloading the page restores progress.

The Server process must be replaced: refreshing the browser alone cannot load new Server code. **When handover is supported, local Agent processes stay alive and running tasks continue.** If handover is unavailable and Agents are busy, the owner must choose to wait for tasks to finish (recommended) or update immediately and interrupt them.

Installation failures do not replace the old package or stop the old Server. If the new Server fails to restart, Hive restores the old package and attempts to restart it. If recovery also fails, the UI reports the failure rather than claiming recovery. Check `web-update.log` and `server.log` in the data directory. Update state persists in `web-update.json`; duplicate clicks cannot start concurrent installs.

Version checks are cached for one hour, including offline results. Offline checks are silent. Release summaries come from the project's GitHub Release; a full-release link remains available when the summary cannot be loaded.

## Installations requiring manual updates

| Installation                                                 | Why one-click updating is unavailable                                                | What to do                                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source / `pnpm dev` / link                                   | Not a replaceable npm global package                                                 | Pull code, rebuild, and restart using the original development workflow                                                                                             |
| Temporary `npx` cache                                        | No stable global installation directory                                              | `npx superhive@latest restart --data-dir <original-data-directory>`                                                                                                 |
| Unwritable npm global prefix                                 | Cannot safely replace or roll back the package                                       | Configure a prefix you own, then use the displayed command; do not use sudo                                                                                         |
| pnpm / bun / yarn global install                             | Browser staging and rollback support npm only                                        | Run `hive update --data-dir <original-data-directory>` in the original terminal                                                                                     |
| `--foreground`, systemd, launchd, or another process manager | The external manager owns the lifecycle; a new CLI background service would conflict | Stop the original service, upgrade its package, and start it using the original manager; see [cloud deployment](/en/guides/cloud-deployment/#7-back-up-and-upgrade) |
| Desktop application                                          | Separate application update mechanism                                                | Use the desktop update entry                                                                                                                                        |

A normal CLI-managed background instance can still use:

```bash
hive update --check
hive update --data-dir /path/to/hive-data
```

`--data-dir` retains that instance's state and does not restart another Hive in the default directory. Upgrades do not clear rooms or messages, but backups are still recommended. Handover is not a guarantee against power loss, crashes, or incompatible database changes.

## Desktop application

The desktop application uses its own in-app updater and does not show the npm update action. Open the update entry for release notes, download and verify in the background, then restart to update. You can keep using the app and apply the update on its next exit or launch as indicated by the client. When in-app installation is unavailable, the client explains why and offers the installer download instead.

Opening a desktop Server in a browser does not grant desktop application installation permissions.
