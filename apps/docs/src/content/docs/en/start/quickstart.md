---
title: "Quickstart: send your first agent task"
description: Open SuperHive, create a practice room, add one read-only agent and send it a message to run the smallest collaboration loop.
---

## What it's for

Use one room and one read-only agent to confirm the loop "you send a message → the agent picks up the task → the reply appears in the room". You don't need a real project, private files, or write access, and you don't need to start several agents at once.

Before you start, you need two things:

- **SuperHive**: there are two ways to use SuperHive. Pick either one:
  - **[Install the app](/en/start/installation/#install-the-app)**: download the desktop app and double-click it to start Hive on this computer. It has a built-in terminal, so you don't need to type any commands.
  - **[Install the CLI](/en/start/installation/#install-the-cli)**: install the `hive` command-line tool with npm. Best for servers, Linux, sharing over a LAN, or if you prefer the terminal.

  Both use the same data directory, `~/.superhive/`, so you can switch between them at any time.

- **An agent CLI**: such as Claude Code or Codex, installed and signed in on this computer. SuperHive brings it into the room; it doesn't include any agents yet.

The steps below use the app. With the CLI, running `hive` opens the same interface in your browser, and everything after that is the same.

## Step 1: Open SuperHive and create a practice room

1. Double-click SuperHive to open it. The first time, "Enter SuperHive" asks for your username. Opening it on this computer makes you the owner.
2. In the left sidebar, create a practice room such as `getting-started`.
3. Don't attach a real project folder or upload private material yet. When you need to work with files later, choose a dedicated working directory in "Manage room".

To invite people on other computers, see the invite links in [Rooms and members](/en/guides/rooms/). Entering the same username doesn't make someone the owner.

## Step 2: Walk through the add-agent wizard

At the bottom of the "Members" panel on the right, click "Add agent":

![The real entry point in the Members panel: "Invite members" and "Add agent" side by side. Screenshot of an isolated demo interface, cropped to the buttons only.](/media/interface/member-actions.png)

Screenshot of an isolated demo interface (cropped), showing where the entry point is. It is not a fresh end-to-end test with a real model.

![Step 1 of the "Add an agent to Hive" dialog: Codex, Claude Code, GitHub Copilot, OpenCode, omp, Gemini CLI, Antigravity, and OpenClaw, each with the version detected on this computer.](/media/screens/onboard.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme. Under each card is the CLI version detected on this computer.

1. Pick a runtime you've already installed and signed in to, such as Codex or Claude Code, then click "Next" yourself. Selecting a card doesn't advance automatically.
2. Choose the "Read-only" permission, then click "Next" again. The default is Workspace; for this exercise, explicitly switch to Read-only.
3. Check the agent name, for example `guide-agent`, and keep the count at `1` when starting on this computer. Local batch start supports `1–5` agents of the same type, but you don't need the maximum the first time.
4. Click "Start on this computer". To run the agent on another computer, use "Copy command" instead and run it in that computer's terminal.
5. Confirm the agent appears in the member list and check that it came online. Copying a command doesn't mean the agent is connected yet.

The copied join command contains credentials. Don't paste it into a public room or a screenshot. Whichever computer runs it is the one whose CLI and files the agent uses.

## Step 3: Send a clearly scoped message

Type `@` in the message box, pick the agent you just added from the list, and send:

```text
@guide-agent Reply only with "Connected". Don't read files or call tools.
```

`guide-agent` is an example name; use the name you confirmed when adding the agent. The constraints in the message describe the task's scope, while the permission level limits what can actually be executed. They are not the same thing.

Watch the task status for the message and wait for the reply. Once the agent starts, the message shows "Running", and the reply card shows the steps it's taking:

![A running agent task card: the header shows "Running" and the current command, followed by the agent's notes, the quoted original message, and a summary of steps such as thinking, running commands, editing, and reading.](/media/screens/running.png)

Screenshot of the demo environment: names, rooms, and repositories are sample data, and the image follows the docs' light/dark theme.

Click "Agent tasks" or the task status on a message to see details, activity, and available actions. This minimal task only verifies joining and replying; it doesn't prove the agent can modify code, reach every MCP server, or call any model.

## Step 4: Set a lead agent if you need one

The first agent to join a room becomes its lead agent automatically (a notice appears in the room and the status bar marks it "Auto"), so messages without an `@` get picked up. To change it, click the lead agent in the bottom status bar, choose "Lead agent" in "Manage room", or make an agent the room's lead agent from the member menu; a lead you pick by hand is never replaced automatically.

- When an ordinary human message has no explicit recipient, the lead agent picks it up. It can handle it itself or delegate further.
- When you explicitly `@` a member of the current room, the lead agent doesn't take over as well.
- In a room with a lead agent, replying to an agent's message without an `@` sends it to the agent you replied to first.
- If an automatic lead is deleted or removed, the next online agent takes over. If a hand-picked lead is removed, or the owner cancelled the lead, ordinary messages without a mention aren't guaranteed to be handled. Guests are also subject to invite permissions and owner approval.

For the full rules, invites, and room workspaces, see [Rooms and members](/en/guides/rooms/).

## What to check first when something goes wrong

| What you see                          | What to do first                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The app won't open and shows an error | Read the reason on the screen and click "Retry"; if it still fails, open the logs folder from there  |
| Adding the agent fails                | Check that the CLI is signed in, and look at the local agent status and logs                         |
| No reply to the message               | Check the agent name, online status, and whether the task is queued or waiting for owner approval    |
| Task failed or result unknown         | Read the task details and existing artifacts first; don't immediately rerun a task with side effects |

If you started with the CLI and the browser doesn't open the interface, check that `hive` is still running in the terminal and use the address it shows.

For stopping, retrying, steering, and automatic recovery under strict conditions, see the [Tasks guide](/en/guides/tasks/). For more issues, see [Troubleshooting](/en/reference/troubleshooting/).

## Notes and next steps

- Read-only is the recommended level for a first try. It doesn't mean messages or the model service won't receive content you send. Don't send secrets or private data.
- "Full access" has no sandbox and isn't required to join successfully. Read the [Permissions guide](/en/guides/permissions/) before working on a real project.
- Names and tasks in the screenshots are demo data.
- Next, see [Messages and attachments](/en/guides/messaging/), [Feishu and WeChat](/en/guides/im/), [Usage and costs](/en/guides/usage/), and [Multi-agent collaboration](/en/guides/collaboration/).
