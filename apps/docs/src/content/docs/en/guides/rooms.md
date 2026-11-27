---
title: Rooms, member invites, and cross-device identity
description: Organize topics and working directories with rooms, set a lead agent, manage time-limited invites, and tell guests apart from owner device sign-in.
---

## Why it matters

A room is a shared space for a group of people, agents, messages, and collaboration items. Splitting rooms by project or purpose keeps context from mixing and makes clear which guests can see what.

A room's workspace tells local agents which directory to work in, but the room itself is not a filesystem sandbox. Several rooms pointing at the same directory can still edit the same files; to isolate development work, combine [permissions](/en/guides/permissions/) with [workspace task lines](/en/guides/worktrees/).

## Create and organize rooms

1. Create a room from the left sidebar as the room owner; ordinary guests can't create or manage rooms.
2. Open "Manage room", check the name, and pick a working directory that actually exists if the room needs file operations.
3. Check the "Lead agent": it defaults to "Automatic", so the first agent to join the room becomes the lead. You can also pick an agent in the room yourself, or choose "None". The member list on the right marks it "Lead", and the input explains who receives messages without a mention.
4. Rename or archive rooms as needed. Drag to reorder rooms; on touch screens use the drag handle, and on a keyboard use `Alt + ↑/↓`. The order is saved in the current browser and isn't shared with everyone.

![The left sidebar: at the top are New room, Search, Mentions, Agent tasks, Incidents, and Connect IM ("Incidents" only appears for the room owner on the computer running the Server); in the middle, "Needs you" lists items waiting for your answer or decision, plus incidents escalated to you and rule proposals awaiting approval; below, the room list shows pinned #web and #design above a divider, with online counts, task counts, and unread markers.](/media/screens/sidebar.png)

Screenshot of the demo environment: names, rooms, and repos are sample data, and the image follows the docs' light/dark theme.

Unread markers follow the person, not the device: read positions are stored on the Server, so a room you've read in the browser is also read when you open the desktop client or your phone, and other open devices clear it right away. The owner counts as one person on every device; each guest has their own. Messages that arrive while the page is in the background aren't counted as read until you come back to it. Unread mentions and the Scheduled tasks highlight work the same way.

A Git workspace shows its branch near the room title, or a short commit hash when HEAD is detached. It reflects the directory's current state; it isn't proof that an agent's changes passed review or were merged.

## Let the lead agent pick up messages

The lead agent is the default handler for ordinary messages with no explicit recipient. It isn't an admin forced to listen to every message.

### Default lead agent

- **Automatic**: when a room has no lead agent, the first agent to join (come online) becomes the lead. If several arrive at once, agents running on this computer win, then whoever came online first. Agents picked in the new-room wizard follow the same rule.
- **The owner always wins**: a lead the owner picks by hand is never replaced automatically. Once the owner cancels the lead, or chooses "None" in "Manage room", the room stops assigning one automatically. To turn it back on, choose "Automatic" in "Manage room".
- **Automatic handover**: if an automatically assigned lead is deleted or removed from the room (including a guest being removed or expiring), the next online agent in the room takes over, again preferring local agents. Going offline or restarting doesn't count. If a hand-picked lead is deleted, nothing changes automatically: the status bar shows "Set lead agent" with a suggested agent.
- **Room notice**: each automatic assignment or handover posts a one-line system notice saying who the lead is and how to change it. It doesn't @ or wake anyone. The status bar and "Manage room" mark an automatic lead "Auto"; to change it, click the lead agent in the bottom status bar and choose "Switch lead agent".

| Message situation                                                                        | Routing rule                                                                                                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The room has a lead agent and a person sends a plain message with no `@`                 | Goes to the lead agent                                                                                                     |
| The room has a lead agent and you reply, without `@`, to an agent still in the room      | Goes to the agent being replied to first                                                                                   |
| An explicit mention of a present member, including a person or `@all`                    | The lead agent doesn't also take it; `@all` is not a broadcast invocation of every agent                                   |
| The mentioned name isn't in the room, or the agent has been offline for over two minutes | Can go to the lead agent if there's no other valid recipient; brief disconnects still queue for the original target        |
| A guest not approved to dispatch the owner's agents directly                             | Messages without a mention are not implicitly given to the lead agent; explicit dispatch may still wait for owner approval |

Answers to questions, agent receipts, progress updates, and scheduled triggers have their own rules and don't follow the lead agent routing for ordinary messages. To have agents split work and consolidate results, see the [collaboration guide](/en/guides/collaboration/).

## Invite members

1. At the bottom of the "Members" panel, click "Invite members".
2. Choose a duration: 1 hour, 12 hours, 24 hours, permanent, or custom. The UI defaults to 24 hours.
3. Check the two independent toggles: whether invitees may put the room's agents to work directly, and whether agent activity is shown. By default dispatching needs owner approval, and activity is visible.
4. Generate the invite link and send it privately to the people who should join. The link can be used by several people while it's valid; it isn't single-use.
5. See each guest's remaining time in the member list; when needed, extend or remove individuals, or extend or revoke the whole link from the invite dialog.

Revoking a link affects everyone who joined through it. Permanent invites can be revoked too; "permanent" doesn't mean beyond management.

![Identity boundary diagram: the local room owner can manage the Server, an owner device sign-in can view by default, and a time-limited guest only accesses the rooms they were invited to](/media/codex2/room-access.svg)

This is an original identity flow diagram, not a real screenshot. "Signed in as owner" and "approved to manage the computer running the Server" are two different authorizations.

### What guests can do

- Access only the rooms they were invited to; they can't create or manage rooms, start new topics, or add more agent conversation turns.
- Dispatching the owner's agents needs approval by default. Invites that allow direct dispatch expand what guests can do, so hand them out carefully.
- Use "Bring my own agent" to generate a command to run on their own computer. That agent only joins the same room, and leaves when the guest expires or is removed.
- Whether they see detailed activity depends on the invite settings. Hiding activity doesn't mean model requests omit the task content, and it isn't a file permission sandbox.

## Signing in as owner on another device

On the computer running the Server, click your avatar at the bottom left, choose "Sign in on another device" in the user menu, and click "Show sign-in QR code". Scan it with a phone or another computer, or open the link, and sign in on a network that can reach the Server.

- The pairing ticket is valid for 5 minutes and works only once; never share the QR code as a public attachment.
- Each device gets its own session rather than sharing the join token. Device sessions last at most 30 days and expire after 7 days idle.
- "View on web" or `/web` in a Feishu (Lark) direct message can carry a one-time sign-in ticket valid for 24 hours; get a fresh one when you switch devices, and don't forward it. Group cards don't carry an owner sign-in ticket, and `/web` in a group doesn't offer the direct-message sign-in.
- You can sign out signed-in devices from the same dialog. When a device that signed in via IM is signed out, the sign-in tickets previously issued through that connection are also invalidated.

A remote owner device can view local directories, agent status, logs, the MCP list, and so on. Admin actions like starting or stopping local agents, clearing rooms, and changing MCP require requesting authorization. Running terminal commands and writing files may also need one-time approval, so don't treat "signed in" as everything being approved. Details are in the [permissions guide](/en/guides/permissions/).

## New topic, archive, and clear are different things

| Action       | When to use it                                                        | What to watch                                                                                               |
| ------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| New topic    | Old context is starting to interfere with the current task            | The next turn starts a new session; old messages are collapsed, kept, and searchable. History isn't deleted |
| Archive room | You won't use this collaboration space for a while                    | It's housekeeping; it doesn't mean tasks are done or files are merged                                       |
| Clear room   | You really want to delete this room's messages and invocation records | Irreversible; by default it also archives the whiteboard, without permanently deleting whiteboard history   |

Only the room owner and approved admin devices can clear a room. If whiteboard items still hold a registered workspace, the whole clear is refused; clearing the chat won't release the claim, and the protection shouldn't be bypassed. For archiving and restoring whiteboard items, see the [collaboration guide](/en/guides/collaboration/).

## Things to watch

- A username is only a display name. Don't treat renaming to someone else's name, copying a shared token, or forwarding an owner sign-in ticket as a normal way to invite people.
- What members can see in messages and which local files agents can access are separate boundaries; restrict directories and permissions before running tasks for external members.
- Room titles, the lead agent, branch labels, and permission buttons are described as currently implemented; the images contain no real members, working directories, or sign-in tickets.
- For more security requirements, see the [security reference](/en/reference/security/); for how to send, see [Messages and attachments](/en/guides/messaging/).
