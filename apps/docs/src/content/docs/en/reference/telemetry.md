---
title: "Usage statistics: what we collect, what we don't, how to turn it off"
description: "SuperHive records anonymous, coarse usage statistics by default: every field and event, how to preview and turn them off, retention, and what we never collect."
---

SuperHive records anonymous usage statistics by default: only coarse numbers such as the version, the operating system, whether anyone used it each day, which features were used and whether updates worked, sent at most once a day, so we can decide what to fix and build first. **No messages, paths, names or keys**, and you can turn it off at any time. The approach follows Next.js and Homebrew: on by default, you are told the first time, and one switch or one environment variable turns it off.

The first time you use SuperHive (after you send your first message, or once the page has been open for a minute), a note in the bottom-right corner explains this. It is shown only once; **Turn off in Settings** takes you straight to the switch in Settings, and **Learn more** opens this page.

:::note[Where it goes]
npm installs and the desktop app send to the project's self-hosted [Umami](https://umami.is) at `https://60.205.92.58` by default. Running from source (`pnpm dev` in the repository, your own build, or an unpackaged desktop app) sends nothing by default and only records on this computer; to send, set `SUPERHIVE_TELEMETRY_URL` explicitly, see [Uploads and retention](#uploads-and-retention).
:::

## Turn it off

Any one of these works:

- In the web UI, open **Settings → This computer → Anonymous usage statistics** and switch it off. Only the owner on the computer running the Server can change it; other devices can only view it.
- In a terminal, run `hive telemetry off`. Turn it back on with `hive telemetry on`; check the current state with `hive telemetry status`.
- Set `SUPERHIVE_TELEMETRY=0` (`false` and `off` work too) or the general `DO_NOT_TRACK=1` before starting.

Nothing is recorded in these cases, without any action from you: CI environments (`CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `JENKINS_URL` and so on), sandbox previews (`HIVE_SANDBOX=1`) and test runs (`NODE_ENV=test`, `VITEST`).

Once turned off, nothing more is recorded and **anything not yet sent is deleted right away**. When an environment variable turns it off, no local files are created at all.

## Preview what would be sent

- In the web UI, open **Settings → This computer → Anonymous usage statistics** and click **View data to be sent**. It shows the raw JSON waiting to be sent to the statistics service, including today's `heartbeat` if it hasn't gone out yet.
- In a terminal, run `hive telemetry preview`. It prints the same content.

The statistics service is a self-hosted [Umami](https://umami.is), and each event is one Umami `event`. An upload body looks like this (an array with everything waiting to be sent):

```json
[
  {
    "type": "event",
    "payload": {
      "website": "b2d13ec6-3fa6-47bf-9cbd-7317357517fc",
      "hostname": "superhive.app",
      "url": "/heartbeat",
      "name": "heartbeat",
      "language": "zh-CN",
      "timestamp": 1795838400,
      "id": "8d0f3c1e-2a4b-4c6d-8e9f-0a1b2c3d4e5f",
      "data": {
        "schema": 1,
        "version": "0.4.9",
        "runMode": "npm",
        "os": "darwin",
        "arch": "arm64",
        "locale": "zh-CN",
        "agents_claude": 2,
        "agents_codex": 1,
        "rooms": "2-5",
        "active": "yes"
      }
    }
  }
]
```

The only request headers are `Content-Type: application/json` and `User-Agent: SuperHive/0.4.9 (darwin; arm64)` (version, operating system, CPU architecture). No cookies and no other identifiers.

## Common fields

Every event carries these:

| Field               | Content                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `payload.id`        | The install ID: random, generated on first start, unrelated to your computer or account; reset it in Settings or with `hive telemetry reset` |
| `payload.timestamp` | When the event happened (Unix seconds), rounded down to the hour (UTC)                                                                       |
| `payload.name`      | The event name, see "Events" below; `payload.url` is `/` followed by the event name                                                          |
| `payload.language`  | Interface language: `zh-CN` or `en`; left out for other languages                                                                            |
| `payload.website`   | Fixed: the ID of the SuperHive site in the statistics service; `payload.hostname` is always `superhive.app` as well                          |
| `data.schema`       | Data format version, currently `1`                                                                                                           |
| `data.version`      | SuperHive version, such as `0.4.9`                                                                                                           |
| `data.runMode`      | How it runs: `npm` (global npm install), `desktop` (desktop app) or `source` (from source)                                                   |
| `data.os`           | Operating system: `darwin`, `win32`, `linux` or `other`                                                                                      |
| `data.arch`         | CPU architecture: `x64`, `arm64` or `other`                                                                                                  |
| `data.locale`       | Interface language: `zh-CN`, `en` or `other`                                                                                                 |

## Events

Each event's own fields go into `data` too, in a single level; count fields are flattened to "field_category", such as `agents_claude`. Every field can only take the values listed below. Unknown fields and values outside the list are dropped before anything is recorded, and an event missing a required field is dropped entirely.

### `heartbeat`: once a day

One per day (UTC), to count how many computers run SuperHive each day and how many of them are actually used. It is recorded the first time someone sends a message that day (`active` is `yes`) and sent right away. If SuperHive runs all day without anyone sending a message, that day gets `active` set to `no` and is sent the next day (or the next time it starts). Days when SuperHive isn't running have none.

| Field    | Content                                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents` | Number of local agents per CLI type, flattened to `agents_type`. The only types are `codex`, `claude`, `copilot`, `opencode`, `omp`, `openclaw`, `gemini` and `agy`; types with no agents are left out, and each count stops at 99                                         |
| `rooms`  | The range the room count falls in: `0`, `1`, `2-5`, `6-20` or `21+`                                                                                                                                                                                                        |
| `active` | Whether anyone sent a message in any room that day: `yes` or `no`. Messages from the owner, members and guests count (including ones coming in from Feishu (Lark) and other IMs); messages from agents and scheduled tasks don't. Only yes or no, never a count or content |

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

## What we promise never to collect

- The content of messages, attachments, questions, boards and tasks
- File paths, working directories, repository names and URLs
- Room names, room IDs, people's names, agent names and usernames
- Hostnames and IP addresses (the Server neither records nor forwards them. The statistics service is the project's self-hosted Umami: it does not store IP addresses and only uses the IP to roughly work out the country and region; the city derived from the IP is cleared within an hour)
- Tokens, keys, passwords or any other credentials
- Raw error messages, logs and command-line arguments

This doesn't rely on being careful about what to send. Only a whitelist is accepted: each field can only take the values in the tables above, so free text can't get in.

## Uploads and retention

- Only the Hive Server sends anything. The web UI, the desktop app and the `hive` command only hand events to the local Server or write them to the local queue.
- Data is sent at most once a day (UTC), together with the `heartbeat`: everything waiting (first uses of features, update results) goes out in that one request and is never sent on its own.
- When the network is down or the statistics service has an error, unsent events stay on this computer and go out with the next upload (the next day); there is no retry on the same day. Events the service explicitly rejects are dropped. Upload errors never affect any feature.
- At most 200 unsent events are kept locally; when full, the oldest are dropped.
- Data received by the statistics service is kept for 90 days and then deleted.
- npm installs and the desktop app send to `https://60.205.92.58` by default (the project's self-hosted Umami, uploads go to its `/api/batch`); running from source sends nothing by default.
- To send to your own Umami, set `SUPERHIVE_TELEMETRY_URL=https://your-umami-address` before starting (only http and https are accepted; uploads go to its `/api/batch`), and put your site's websiteId in `SUPERHIVE_TELEMETRY_SITE`. This also works when running from source; if it isn't an http(s) address, nothing is sent and the default endpoint is not used instead.
- The install ID, the switch and unsent data live in `~/.superhive/telemetry/`. Use `SUPERHIVE_TELEMETRY_DIR` to move them.
