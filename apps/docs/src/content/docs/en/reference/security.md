---
title: "Security reference: identity, credentials, and public deployment"
description: Learn Hive's shared owner identity, time-limited guests, device authorization, credential storage, and local-request boundaries before deploying publicly.
---

## Understand Hive's trust model first

Hive is a shared collaboration system where you control the Server, the data directory, and the agents' computers. People, messages, attachments, and tool results in a room become agent context, while the actual commands, file changes, and external requests are executed by each agent's runtime.

**The shared Join Token is a high-trust, owner-level credential, not an ordinary chat invite code.** Owners and agents that hold it can reach the corresponding APIs across multiple rooms. Don't treat Hive as a public SaaS with strict tenant isolation, and never give this master token to anyone you don't trust.

The existing permission mechanisms reduce the risk of mistakes, but that doesn't mean every runtime, MCP server, web page, or public network environment has been independently verified as safe. For connecting agents and configuring permissions, see the [Agents guide](/en/guides/agents/) and [Permissions and approvals](/en/guides/permissions/); for deployment steps, see the [deployment reference](/en/reference/deployment/).

## Three identities that are not interchangeable

| Identity or link                               | Purpose                                                                     | Watch out for                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Owner's shared Join Token                      | Owner-level room access and connecting trusted agents                       | Not a single-room, single-device, or time-limited guest credential; keep it out of public commands, screenshots, and repositories  |
| Guest invitation and guest session             | Join a specific room with a set duration and permissions                    | Several people can redeem an invitation while it's valid; it is not a one-time owner sign-in link; guests can't access other rooms |
| Owner device sign-in ticket and device session | The owner signs in on another device; each device can be revoked separately | Doesn't hand over the master token; device sign-in doesn't automatically grant admin rights over the Server's computer             |

### Guests and their agents

The owner can set an invitation's duration, whether guests may bring agents, and whether Activity is visible. An agent brought by a guest uses its own session identity and follows its inviter's expiry, renewal, or revocation; it does not become an owner agent just because it has a similar name.

Anyone who has an invitation link can use it while it's valid, so send it only to intended participants and keep the duration limited. Revoking an invitation affects the guests who joined with it and their agents; closing a browser tab does not revoke an invitation.

### Owner devices and admin approval

A local pairing ticket is valid for **5 minutes** by default and can be redeemed once. A Feishu (Lark) sign-in ticket is valid for **24 hours** by default, can be redeemed once, and is tied to the IM connection that issued it. A device session lasts at most **30 days**, expires after **7 days** idle, and the owner can sign out each device individually.

These durations limit sign-in identity, not tool authorization. To start or stop local agents, a device must obtain admin authorization separately, and high-risk actions such as starting with full access also need a single-use approval bound to the device and the operation's parameters.

Admin / high-risk approval requests are kept only in memory; pending requests are discarded when the Server restarts. This is a different flow from [tool approvals during a run](/en/guides/permissions/), and one device approval can't stand in for every task's authorization indefinitely.

## What must be treated as secret

Protect at least the following:

- Join Tokens, guest invitations, guest and device sessions, pairing tickets, and IM sign-in tickets.
- Connect commands, URLs, request headers, browser storage, process arguments, or log snippets that contain credentials.
- The Server database, attachments, IM encryption key and backups, plus agents' local sessions and state files.
- Sign-in data for MCP servers and model runtimes, external accounts, business-system authorizations, and generated private files.

### The database is not a fully encrypted store

In the current implementation, the Join Token is stored in the database, and invitation tokens are also stored in plaintext so the owner can copy invitation links again. Tokens used to verify guest and owner device sessions are stored as hashes, **but that does not mean the whole database contains only irreversible hashes**.

IM credentials are encrypted with AES-256-GCM using a separate key. If the database and the key leak together, those credentials are no longer protected; and this mechanism does not mean chats, attachments, the Join Token, or all runtime state are encrypted.

The CLI service's data directory is usually `~/.superhive`, and agent state is usually in `~/.superhive/agents/`; explicit configuration or running from source may use other locations. Confirm the actual directory, then restrict system-account and backup access. Never expose the data or attachment directory as public static assets.

Store backups as secrets. You can't guarantee a consistent backup of a running SQLite database by casually copying one file; see the [deployment reference](/en/reference/deployment/) for backup and restore. Manage the key file, database, and attachments according to your actual restore needs; keeping only some of them doesn't let you promise a complete restore.

### If you suspect a credential leak

1. Limit the exposed entry points first, record the scope of the leak and the impact on existing tasks, and don't paste the secret into a room again.
2. Revoke invitations, guests, and device sessions through their respective admin entries; revoke or rotate external MCP / model accounts on their own platforms.
3. If the master token leaked, update it in the controlled Server configuration, restart, and reconnect authorized agents.
4. **Updating the Join Token does not revoke separate guest, device, or external account credentials**; check existing identities and connections individually.
5. Check files, commits, and external systems. Revoking tokens, stopping, or restarting does not roll back actions that already happened.

## Why the local admin entry can't simply become a public entry

Local request verification checks the connection source, Host, Origin, and registered port together. Accessing `localhost` or the local IP directly on the Server's computer can pass; a proxy "also running on the same computer" does not make a remote visitor the local owner.

Requests carrying proxy source markers such as `Forwarded` or `X-Forwarded-For` are never treated as local. Don't strip source information, forge Host / Origin, or inject local credentials into all remote requests just to make the "Start on this computer" button appear.

For remote administration, use owner device sign-in and the approval flow. The shared Join Token cannot replace the admin credential that local endpoints require.

If you don't manage local agents from the web UI, you can choose `--no-local-agents` in the startup configuration. This turns off the corresponding managed entry; it does not stop agents already running on other computers, revoke room identities, or restrict their external tools.

## LAN, public internet, and reverse proxies

The CLI listens on `0.0.0.0:8787` by default, not just the loopback address. If only local access is needed, choose `--host 127.0.0.1` explicitly; to serve LAN participants, configure the actual network interface, firewall, and network isolation.

The desktop app's built-in server also listens on all interfaces by default (“Allow devices on your network” under Settings → Devices is on). If you only use this computer, turn it off; the server then listens on `127.0.0.1` only, and the choice is remembered.

A plain HTTP LAN connection is still not encrypted. On shared Wi-Fi, guest networks, or untrusted networks, don't relax credential protection just because it's "the internal network".

A public deployment needs at least:

1. **HTTPS and WSS**: valid TLS from a reverse proxy or gateway that forwards normal HTTP, WebSocket, and the required MCP requests.
2. **Outer access control**: choose a VPN, gateway authentication, or other access restrictions based on your team's risk, and limit direct exposure of the raw Server port.
3. **The correct public URL**: set the actual address, such as `--public-url https://hive.example.com`, and check the generated web, WebSocket, invitation, and MCP URLs. This option only configures addresses; **it does not create TLS, authentication, or firewall rules**.
4. **Preserve identity and source boundaries**: don't drop the required Authorization, WebSocket upgrade, or MCP identity information, and don't disguise external sources as local.
5. **Protect logs and caches**: don't log or publish bearer credentials, sign-in tickets, links containing credentials, request bodies, or private attachments; authorized responses and attachments must not be shared by public caches.

If the proxy's authentication page redirects agent / MCP requests to an HTML sign-in page, connections or the protocol may fail. Configure a controlled, compatible access method instead of disabling Hive's identity checks; see the [troubleshooting reference](/en/reference/troubleshooting/).

## MCP, elevated permissions, and untrusted content

Hive's `/mcp` calls require a valid bearer credential plus an online agent identity matching `X-Hive-Room` and `X-Hive-Agent-Name`. A guest agent's credential must match its own room and name, and a guest human's credential cannot impersonate an agent to call tools. Having an MCP URL alone doesn't mean an agent is connected or has tool permissions.

Additional MCP servers may access browsers, business systems, or external accounts. Enable only trusted, necessary servers and check their accounts and scopes; **a Read-only file label does not guarantee that every MCP server is free of external side effects**.

The Workspace tier is implemented differently across runtimes: ordinary omp writes are not fully confined to the cwd, Copilot's tool policy is not equivalent to the Codex sandbox, and OpenClaw permissions must also be configured in the agent / Gateway. Full access has no Hive sandbox; when sensitive data or production accounts are involved, prefer a separate system account, environment, and external permission limits.

Chats, attachments, web pages, and tool output are all untrusted content; a line like "ignore the rules" must not escalate permissions, leak secrets, or expand the original task. When approving, check the exact command, paths, accounts, and impact; if you want to add conditions, deny first and then revise the task.

HTML attachment previews use short-lived URLs and an isolated browser origin, but that doesn't mean "every attachment is safe code". Previews can still run scripts, access the network, submit forms, or prompt downloads; never enter credentials in an untrusted preview. Source code, files, and images can also contain malicious instructions, and reading them does not authorize executing them.

Worktrees and Whiteboard claims are for task coordination only, not a security sandbox. Cleanup must go through the [checked worktree entry](/en/guides/worktrees/); never force-delete directories or branches just to release a claim.

## Checklist before publishing a service or docs

- Confirm the running version, exposed network interfaces, the real HTTPS domain, reverse-proxy forwarding of WebSocket / MCP, and outer access restrictions.
- In an isolated demo environment, verify that unauthorized requests, wrong rooms, revoked identities, and remote requests to local admin endpoints are rejected as expected; "the page loads" is not enough to sign off on permissions.
- Check invitation durations, device sign-in, and admin authorization, and distinguish ordinary questions, tool approvals, and device approvals; don't assume everyone can approve.
- Keep data, attachments, backups, keys, runtime state, and logs out of the public site and repository artifacts.
- Use only synthetic data or placeholders in docs, screenshots, SVGs, examples, and patches; remove real chats, personal information in working paths, credentials, and sign-in QR codes.
- Check the public build output and static assets, not just the Markdown sources; for deploying the docs site separately, see [Deploying the docs site](/en/reference/documentation/).
- Keep controlled procedures for stopping, revoking, backup and restore, and credential rotation; state risks and unverified items clearly, and don't present "configuration done" as "security review passed".

This page describes boundaries based on a static reading of the implementation at repository commit `c2f68dd`. It is not a vulnerability scan, penetration test, or public-internet security certification, and it has not been verified against every third-party runtime version. If something looks wrong, follow the [troubleshooting steps](/en/reference/troubleshooting/) first and save redacted evidence.
