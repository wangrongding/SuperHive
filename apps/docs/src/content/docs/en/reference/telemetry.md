---
title: "Usage statistics: what we collect, what we don't, how to turn it off"
description: "SuperHive records anonymous, coarse usage statistics by default: every field and event, how to preview and turn them off, retention, and what we never collect."
---

SuperHive records anonymous usage statistics by default: only coarse numbers such as the version, the operating system, which features were used and whether updates worked, so we can decide what to fix and build first. **No messages, paths, names or keys**, and you can turn it off at any time. The approach follows Next.js and Homebrew: on by default, you are told the first time, and one switch or one environment variable turns it off.

:::note[This version sends nothing]
The statistics service isn't live yet and the built-in endpoint is empty: data is only recorded on this computer, you can preview it at any time, and nothing is sent. When a service is connected, the release notes will say so.
:::

## Turn it off

Any one of these works:

- In the web UI, open **Settings → This computer → Anonymous usage statistics** and switch it off. Only the owner on the computer running the Server can change it; other devices can only view it.
- The first time you start SuperHive, a card in the bottom-right corner explains this. Click **Turn off**. The card is shown only once.
- In a terminal, run `hive telemetry off`. Turn it back on with `hive telemetry on`; check the current state with `hive telemetry status`.
- Set `SUPERHIVE_TELEMETRY=0` (`false` and `off` work too) or the general `DO_NOT_TRACK=1` before starting.

Nothing is recorded in these cases, without any action from you: CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `JENKINS_URL` and so on), sandbox previews (`HIVE_SANDBOX=1`) and test runs (`NODE_ENV=test`, `VITEST`).

Once turned off, nothing more is recorded and **anything not yet sent is deleted right away**. When an environment variable turns it off, no local files are created at all.

## Preview what would be sent

- In the web UI, open **Settings → This computer → Anonymous usage statistics** and click **View data to be sent**. It shows the raw JSON of the next upload.
- In a terminal, run `hive telemetry preview`. It prints the same content.

An upload body looks like this:

```json
{
  "schema": 1,
  "installId": "8d0f3c1e-2a4b-4c6d-8e9f-0a1b2c3d4e5f",
  "events": [
    {
      "event": "heartbeat",
      "time": "2026-11-28T04:00:00.000Z",
      "context": {
        "version": "0.4.9",
        "runMode": "npm",
        "os": "darwin",
        "arch": "arm64",
        "locale": "zh-CN"
      },
      "props": { "agents": { "claude": 2, "codex": 1 }, "rooms": "2-5" }
    }
  ]
}
```

## Common fields

| Field             | Content                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schema`          | Data format version, currently `1`                                                                                               |
| `installId`       | A random ID generated on first start, unrelated to your computer or account; reset it in Settings or with `hive telemetry reset` |
| `time`            | When the event happened, rounded down to the hour (UTC)                                                                          |
| `context.version` | SuperHive version, such as `0.4.9`                                                                                               |
| `context.runMode` | How it runs: `npm` (global npm install), `desktop` (desktop app) or `source` (from source)                                       |
| `context.os`      | Operating system: `darwin`, `win32`, `linux` or `other`                                                                          |
| `context.arch`    | CPU architecture: `x64`, `arm64` or `other`                                                                                      |
| `context.locale`  | Interface language: `zh-CN`, `en` or `other`                                                                                     |

## Events

Every field can only take the values listed below. Unknown fields and values outside the list are dropped before anything is recorded, and an event missing a required field is dropped entirely.

### `heartbeat`: once a day

| Field    | Content                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents` | Number of local agents per CLI type. The only types are `codex`, `claude`, `copilot`, `opencode`, `omp`, `openclaw`, `gemini` and `agy`; each count stops at 99 |
| `rooms`  | The range the room count falls in: `0`, `1`, `2-5`, `6-20` or `21+`                                                                                             |

### `feature_first_used`: the first use of a key feature

Recorded once per feature per computer. Values of `feature`:

| Value             | Recorded when                                                   |
| ----------------- | --------------------------------------------------------------- |
| `room_create`     | The first room is created                                       |
| `agent_join`      | An agent joins for the first time                               |
| `invite_member`   | The first guest invite is created                               |
| `im_connect`      | Feishu (Lark), WeChat or another IM connects for the first time |
| `mcp_install`     | An MCP server is installed for an agent for the first time      |
| `artifacts_panel` | The artifacts panel is opened for the first time                |
| `code_panel`      | The code panel is opened for the first time                     |

### `update_result`: how an update went

| Field     | Content                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`    | What was updated: `desktop` (in-app update of the desktop app), `npm` (`hive update`) or `agent_cli` (installing or upgrading an agent CLI in Settings) |
| `outcome` | `success` or `failure`                                                                                                                                  |
| `reason`  | Failure category, only on failure; see the table below                                                                                                  |
| `target`  | Only for `agent_cli`: which CLI, using the same types as `heartbeat.agents`                                                                             |
| `action`  | Only for `agent_cli`: `install` or `upgrade`                                                                                                            |

Failure categories (`reason`):

| Update      | Values                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `desktop`   | `no_package`, `not_installed`, `translocated`, `read_only`, `not_writable`, `network`, `checksum`, `bad_package` |
| `npm`       | `install_failed`, `package_mismatch`, `verify_failed`, `busy_agents`, `restart_failed`, `not_managed`            |
| `agent_cli` | `timeout`, `stalled`, `exit_code`, `spawn_failed`, `version_unknown`, `version_unchanged`, `install_broken`      |
| Any         | `unknown` (doesn't fit the categories above)                                                                     |

### `incident_counts`: incidents counted by category

Recorded together with the daily `heartbeat`, and only when there were incidents since the last one. `counts` maps "origin.source" to a number of occurrences; each count stops at 9999:

- Origin: `internal` (a problem in SuperHive itself), `external` (models, network and other outside causes) or `unknown`
- Source: `invocation` (an agent turn failed), `server` (a Server exception), `protocol` (a received event failed validation) or `web` (a web page error)

For example `{ "external.invocation": 2, "internal.server": 1 }`.

## What we promise never to collect

- The content of messages, attachments, questions, boards and tasks
- File paths, working directories, repository names and URLs
- Room names, room IDs, people's names, agent names and usernames
- Hostnames and IP addresses (the Server neither records nor forwards them; the statistics service sees the IP of the request but does not store it)
- Tokens, keys, passwords or any other credentials
- Raw error messages, logs and command-line arguments

This doesn't rely on being careful about what to send. Only a whitelist is accepted: each field can only take the values in the tables above, so free text can't get in.

## Uploads and retention

- Only the Hive Server sends anything. The web UI, the desktop app and the `hive` command only hand events to the local Server or write them to the local queue.
- Data is sent once an hour, or earlier once 50 events have built up. A failed upload is dropped: no retries, no pile-up, and no effect on any feature.
- At most 200 unsent events are kept locally; when full, the oldest are dropped.
- Data received by the statistics service is kept for 90 days and then deleted.
- The endpoint is empty by default. To send to your own statistics service, set `SUPERHIVE_TELEMETRY_URL=https://your-endpoint` before starting (only http and https are accepted).
- The install ID, the switch and unsent data live in `~/.superhive/telemetry/`. Use `SUPERHIVE_TELEMETRY_DIR` to move them.
