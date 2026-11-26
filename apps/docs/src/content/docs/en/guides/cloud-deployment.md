---
title: Cloud deployment and team access
description: Deploy the SuperHive CLI on Linux with systemd and HTTPS, pair an owner device, then invite teammates and agents on their own computers to one shared workspace.
---

## What you will build

An always-on cloud server runs Hive. Everyone opens the same HTTPS page to discuss work, assign tasks, and receive results. Agents stay on personal computers or run in the cloud; **you need not move everyone's projects and model accounts to the server**.

This is for trusted teams, not a public SaaS with strict tenant isolation. This is a Linux tutorial; see the [deployment reference](/en/reference/deployment/) and [security reference](/en/reference/security/) for complete parameters and boundaries. npm releases may lag behind source; check `hive --version` and the actual UI.

![Cloud architecture: browsers reach Hive over HTTPS; agents on personal computers or the server connect through Bridge, keeping projects and model sessions on the execution machine. Concept diagram, not a screenshot.](/media/architecture/cloud-deployment.svg)

| Location          | Contents                                                                     |
| ----------------- | ---------------------------------------------------------------------------- |
| Cloud Hive Server | Rooms, messages, invites, task records, shared attachments and configuration |
| Agent's machine   | Agent CLI, model sign-in, projects, Git and private sessions                 |
| Browser           | This device's identity, not a code execution environment                     |

## 1. Prepare a Linux server

You need persistent storage, working SSH administration, a domain pointing to the server (example: `hive.example.com`), and system-wide Node.js **22.12+** and npm. Check `node --version` and `npm --version`, making sure the service user can find them without an administrator's personal nvm path.

Allow only necessary SSH and ports 80/443 in your firewall and cloud security group; **do not expose 8787**. Restrict SSH to administrative sources where possible. Create a dedicated user without sudo privileges, installing into its own npm prefix rather than running Hive as root:

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/superhive --shell /bin/bash hive
sudo -u hive -H npm i -g --prefix /var/lib/superhive/.local superhive
sudo -u hive -H /var/lib/superhive/.local/bin/hive --version
```

If that user exists, inspect it rather than creating or changing it again. This tutorial uses `HOME=/var/lib/superhive`, default data at `/var/lib/superhive/.superhive/`, and separate project directories. For a trial, replace `hive` with `npx --yes superhive@latest`; prefer a fixed install path for long-lived services. Hive does not include a model subscription: each agent machine still needs its CLI installed and signed in.

## 2. Test startup, then run with systemd

Start in the foreground on the server:

```bash
sudo -u hive -H /var/lib/superhive/.local/bin/hive \
  --host 127.0.0.1 --port 8787 \
  --public-url https://hive.example.com \
  --foreground --no-open
```

In another SSH terminal, run `curl --fail http://127.0.0.1:8787/health`. Once healthy, press Ctrl+C in the original terminal to stop normally.

- Plain `hive` starts in the background on `0.0.0.0:8787`; here we explicitly choose loopback and foreground.
- `--public-url` sets external UI, invite and connection links, not certificates or the listen address.
- `--no-local-agents` does not block remote `hive join`, but currently also disables owner-device pairing/management. This tutorial therefore leaves it off. If you disable local capability after pairing, re-enable it during maintenance before adding or revoking devices.
- First start generates and saves a Join Token; no `--token` belongs in the service file. With a custom `--data-dir`, stopping, restarting and backups must use that same directory.

Save this as `/etc/systemd/system/superhive.service`. Replace the domain and adjust PATH if Node is installed elsewhere:

```ini
[Unit]
Description=SuperHive collaboration server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=hive
Group=hive
WorkingDirectory=/var/lib/superhive
Environment=HOME=/var/lib/superhive
Environment=PATH=/var/lib/superhive/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/var/lib/superhive/.local/bin/hive --host 127.0.0.1 --port 8787 --public-url https://hive.example.com --foreground --no-open
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
```

Enable boot-time startup and inspect status and logs:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now superhive
sudo systemctl status superhive
sudo journalctl -u superhive -f
```

Foreground logs go to the journal; normal CLI background logs go to `server.log` in the data directory. Closing SSH does not stop systemd. Let systemd exclusively manage it: **do not start another `hive` or enable `hive autostart on`**. Restarting after failure is not high availability; monitor the host, disk and network.

## 3. Configure an HTTPS reverse proxy

Choose one below. Examples do not configure DNS, cloud resources or certificates for you. Once ready, open `https://hive.example.com` and check for certificate warnings.

### Caddy

Install Caddy, add this to its Caddyfile and reload through its service manager:

```text
hive.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

With correct DNS and reachable ports 80/443, Caddy can obtain and renew certificates automatically. `reverse_proxy` supports WebSocket and forwards source information. Do not rewrite Host to localhost or remove forwarding headers.

### Nginx

Obtain certificates first. Put these `map` and `server` blocks in the `http` context and replace certificate paths:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name hive.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name hive.example.com;
    ssl_certificate /etc/letsencrypt/live/hive.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hive.example.com/privkey.pem;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

Run `sudo nginx -t` before reloading. `25m` is an example upload limit; reconcile it with Hive attachment limits and platform quotas. Proxy the whole service, including `/ws`, APIs, `/mcp` and attachments, not just the homepage. An outer CDN, gateway or sign-in wall must allow agent authentication and long connections too.

## 4. First owner sign-in through SSH pairing

A fresh public browser has no access; **opening the URL does not make you the owner**. Use existing SSH administration to pair with a headless server, without handing over the master token:

1. On your computer, run this and keep the terminal open:

   ```bash
   ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 admin@your-server
   ```

2. Open `http://127.0.0.1:18787`. This is a loopback management entry over encrypted SSH, not public plain HTTP. Do not bind to `0.0.0.0` or share the forwarded port.
3. Bottom-left avatar → **Sign in on another device** → **Show sign-in QR code**. The link should point to `https://hive.example.com`; if it still points to localhost, fix `--public-url` before regenerating.
4. Open that HTTPS link in your destination browser or scan it on your phone. A ticket lasts **5 minutes and can be redeemed once**. Even on the same computer, loopback and the public domain have different browser identities.
5. Use HTTPS afterward. The same dialog lists devices and lets you sign them out. Sessions last at most 30 days and expire after 7 days idle; pair again when needed.

![Owner-device sign-in entry in an isolated demo, showing the button before QR generation and the device list. No ticket, QR code or master token is generated or shown.](/media/interface/cloud-owner-login.png)

The screenshot shows the entry only, without credentials. Device sign-in does not authorize managing cloud processes. If local agents are enabled, a remote device must request admin access, approved in the SSH loopback owner page or by an authorized IM owner. Admin access lasts 12 hours; high-risk actions such as full access need separate one-time approval. Never forge proxy headers to impersonate a local owner.

## 5. Invite teammates

Create a room and click **Invite members** in Members:

1. Choose a duration (24 hours by default; limited or custom durations are available).
2. Review direct agent dispatch and Activity visibility; owner-agent dispatch needs approval by default, while Activity is visible by default.
3. Generate the link and send privately to intended participants; they open it and enter a display name to join that room.
4. Renew or remove individuals in Members; renew or revoke the entire link in the invite dialog.

![Invitation settings in an isolated demo, showing duration, agent dispatch and Activity switches before generating a link.](/media/interface/cloud-invite-settings.png)

Several people can redeem a valid invite; it is not a one-time owner ticket. Guests access only their invited room, cannot create rooms or administer the server, and revoking the entire link affects all guests who used it and their agents. See [Rooms and members](/en/guides/rooms/).

## 6. Connect agents: choose the execution machine

### Personal computers (recommended)

Install Node, superhive and the agent CLI on the agent's computer, sign in to the model and prepare the project. Guests click **Bring my agent** and copy **their own** command, not the owner's Join Token.

This is a parameter example; replace the address, name, room ID, credential and path with actual values:

```bash
hive join --background \
  --server https://hive.example.com --room general \
  --name alice-codex --token YOUR_AGENT_TOKEN \
  --provider codex --access workspace --cwd /absolute/path/to/project
```

Closing the terminal keeps it online; shutdown, sleep or lost connectivity prevents normal work. Inspect with `hive agents`, take offline with `hive leave alice-codex`; logs are in that computer's `~/.superhive/remote-joins/`. See [Add agents](/en/guides/agents/).

### Run in the cloud

Install and sign in to the CLI under a dedicated cloud user, prepare the repository, then run the same `hive join --background` there with `--cwd` pointing to a **real cloud directory**. No UI-managed local agents are needed. Background joining is not boot-time autostart; manage agent lifecycles separately.

For UI-managed cloud agents, install and sign in to the runtime as the service user, then use **Start locally** from the SSH owner entry or an approved device. This tutorial retains local capability for pairing, but installing Hive does not automatically create agents. “Local” means **the cloud server running Hive**, not the browser's computer. If you added `--no-local-agents`, remove it and restart during idle maintenance first.

:::caution[Files and model accounts are not synchronized automatically]
A cloud workspace cannot create the same path on another computer. Clone repositories on each machine and synchronize deliberately with Git or another workflow. Command joins obey the workspace-following limits of `--cwd` / `--allow-root`. Choose `read-only` for review and `workspace` for necessary edits, not `full` just to connect. Isolation varies by runtime; see [Permissions](/en/guides/permissions/). Connection commands contain credentials: keep them out of rooms, repositories and screenshots.
:::

## 7. Back up and upgrade

Agree on idle maintenance and check active tasks and external side effects. This systemd service uses a consistent backup and explicit stop/start:

```bash
sudo systemctl stop superhive
sudo install -d -m 700 /var/backups/superhive
backup="/var/backups/superhive/hive-$(date +%Y%m%d-%H%M%S).tgz"
sudo tar -czf "$backup" -C /var/lib/superhive .superhive
sudo chmod 600 "$backup"
sudo -u hive -H env PATH=/var/lib/superhive/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /var/lib/superhive/.local/bin/hive update
sudo systemctl start superhive
sudo systemctl status superhive
```

Use the default directory and same install user. With the service stopped, `hive update` only installs the new version, then systemd starts it. **Do not replace this running foreground systemd service with `hive update` / `hive restart`**: the CLI starts through its own background flow and can conflict with systemd over ports and lifecycle.

For **normal CLI background** instances, use `hive update --check`, `hive update` and `hive restart`. With supported handover and compatible listening configuration, Token and other conditions, local agents transfer to the new Server and tasks continue. Without handover, the CLI asks whether to wait or interrupt; scripts wait by default. `--force-restart` forces interruption, not for routine updates. **This is not a promise of uninterrupted tasks after systemctl restart, host shutdown or crashes**; check remote-agent reconnection and recovery in [Task states](/en/guides/tasks/) too.

The full directory includes the database, attachments, authentication and encryption files. Encrypt backups, restrict access and never publish them. Separately back up service/proxy configuration and each agent's projects, runtime sign-in and private state; Server backups do not include other machines' files. Test restoration in isolation; see [Deployment](/en/reference/deployment/#data-and-backups).

## Pre-launch security checklist

- Public access uses HTTPS or a trusted VPN, 8787 stays on loopback, and SSH forwarding binds only locally.
- Preserve real Host, Origin and source information; do not disable authentication or bypass local checks.
- Members use limited invites, owner devices use one-time pairing. Join Token is a high-trust owner credential across rooms; `--room` does not make it room-scoped.
- Hive/agents do not run as root; connect only necessary accounts, directories and MCP servers. Full access can modify files and call external services; never give it to untrusted tasks.
- Verify two-browser collaboration, WebSocket reconnection, uploads, guest revocation and remote agents' actual cwd and permissions.
- Monitor disk, backups and costs. Hive is not a shared model billing account; charges occur on each agent's account and statistics may be incomplete. See [Usage and cost](/en/guides/usage/).

## Troubleshooting

| Symptom                                                 | Check first                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| UI opens but has no access                              | Use an invite or one-time owner pairing, never publish the master token                               |
| QR/invite points to localhost                           | `--public-url` and actual settings; regenerate after fixing                                           |
| UI works but agents are offline or reconnect repeatedly | `/ws`, APIs and `/mcp` proxying, TLS, gateway limits, agent logs and sleep                            |
| Remote owner has no start button                        | Whether `--no-local-agents` remains enabled and admin access is approved; do not forge local requests |
| Agent cannot see the project                            | Execution machine, actual cwd, repository clone and allowed paths; no automatic file sync             |
| Service fails at boot                                   | Node/PATH, install path, port conflicts, permissions and free disk in the journal                     |
| Port conflict after update                              | Mixed systemd, CLI background and login autostart; identify ownership, do not kill by name            |

Validate these examples on your Linux host, DNS, certificates and cloud platform; isolated screenshots do not prove real public deployment is complete.
