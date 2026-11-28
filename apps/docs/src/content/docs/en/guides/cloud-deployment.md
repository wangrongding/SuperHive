---
title: Cloud deployment and team access
description: Run one npx superhive command on a cloud server, become the owner through an SSH tunnel, then invite teammates and agents on their own computers. HTTPS, start at boot and backups are in the advanced section.
---

Run one Hive on a cloud server; your team opens the same address in a browser to discuss work, assign tasks and receive results. Agents can stay on personal computers, so **you need not move everyone's projects and model accounts to the server**. This is for trusted teams, not a public SaaS with strict tenant isolation.

![Cloud architecture: browsers reach Hive Server in the cloud; agents on personal computers or the server connect through Bridge, keeping projects and model sessions on the execution machine. Concept diagram, not a screenshot.](/media/architecture/cloud-deployment.svg)

## Three steps

You need a Linux cloud server with Node.js **22.12+** (check `node --version`) and TCP **8787** open in the cloud security group.

### 1. Start Hive on the server

```bash
npx -y superhive --public-url http://SERVER_PUBLIC_IP:8787
```

- It runs in the background by default, listens on `0.0.0.0:8787`, and keeps running after you log out of SSH. The terminal prints the web address, log location and stop command (`npx superhive stop`).
- Do not skip `--public-url`: without it, invite and sign-in links use the first network interface address, which on a cloud VM is usually a private IP nobody else can reach. Use your domain if you have one.
- For the short command, run `npm i -g superhive` first; `hive start --public-url …` then does the same thing.

### 2. Become the owner through an SSH tunnel

Opening the public address directly only shows **Invite required**: owner identity is granted only to requests from the machine running the Server, so knowing the address does not make anyone the owner. On **your own computer**, open a tunnel and keep the terminal running:

```bash
ssh -N -L 18787:127.0.0.1:8787 YOUR_USER@SERVER_PUBLIC_IP
```

Then open `http://127.0.0.1:18787`; you are the owner there.

### 3. Sign in as owner on the public address

On the tunneled page, click the bottom-left avatar → **Sign in on another device** → **Show sign-in QR code**, then open the link in your browser or scan it with your phone. The link is **valid for 5 minutes and works once**. From then on use `http://SERVER_PUBLIC_IP:8787` directly and close the tunnel; the same dialog lists and signs out devices. Device sessions last up to 30 days and expire after 7 idle days; repeat steps 2 and 3 when that happens.

![Owner-device sign-in entry in an isolated demo, showing the button before QR generation and the device list. No ticket, QR code or master token is generated or shown.](/media/interface/cloud-owner-login.png)

:::caution[Port 8787 is plain HTTP]
This setup is fine for trying it out. Sessions and invite links are not encrypted on the public network; for long-term use [configure HTTPS](#configure-https) and close 8787 in the security group.
:::

## Invite teammates and connect agents

**Invite teammates**: in Members, click **Invite members**, choose an expiry (24 hours by default), and send the generated link privately. The teammate enters a display name and joins. An invite can be used by several people while it is valid; guests can only enter the invited room and cannot create rooms or manage the server. Renew or remove individuals in Members; renew or revoke the whole link in the invite dialog.

![Invite settings in an isolated demo, showing expiry, agent scheduling and execution visibility toggles before link generation.](/media/interface/cloud-invite-settings.png)

**Connect agents on personal computers (recommended)**: on the agent's computer install Node, superhive and the agent CLI, sign in to the model and prepare the project. In the web UI click **Bring my own agent** (owners click **Add agent**), and run the copied command on that computer, for example:

```bash
hive join --background \
  --server http://SERVER_PUBLIC_IP:8787 --room general \
  --name alice-codex --token YOUR_AGENT_TOKEN \
  --provider codex --access workspace --cwd /absolute/path/to/project
```

The agent stays online after you close the terminal, but cannot work while the computer is off, asleep or offline. Use `hive agents` to list and `hive leave alice-codex` to take it offline; logs are in that computer's `~/.superhive/remote-joins/`. The command contains a credential; never paste it in rooms, repositories or screenshots. See [Connect agents](/en/guides/agents/).

**Run agents in the cloud**: install and sign in to the agent CLI on the server, clone the repository, then use **Start on this computer** in the web UI. "This computer" means the **cloud server**, not the computer running your browser. A device signed in on the public address must first request admin access, approved on the SSH-tunneled page or through an authorized IM such as Feishu (valid for 12 hours); high-risk actions such as full access need a separate approval each time.

:::note[Files and model accounts are not synced]
A cloud workspace does not give another computer the same directory. Clone the repository on each machine and sync with Git. See [Permissions and approvals](/en/guides/permissions/) for access levels.
:::

## Advanced (optional)

Do these as needed; Hive works without them. See the [deployment reference](/en/reference/deployment/) and [security reference](/en/reference/security/) for full parameters.

### Start at boot

`npx` uses a temporary cache. For long-term use, install globally and enable autostart:

```bash
npm i -g superhive
hive autostart on
sudo loginctl enable-linger "$USER"
```

Without options, `hive autostart on` reuses the running Server's start options, including `--public-url`. On Linux it writes a per-user systemd service (`~/.config/systemd/user/superhive.service`) that starts at login by default; `enable-linger` makes it start at boot without a login. It takes effect at the next boot and does not start a second copy now. Check with `hive autostart status`; disable with `hive autostart off`.

### Configure HTTPS

You need a domain pointing at the server (example `hive.example.com`). Open 80/443, close 8787 in the security group, and make Hive listen on loopback only:

```bash
hive stop
hive start --host 127.0.0.1 --public-url https://hive.example.com
```

If autostart is on, run `hive autostart on` again after changing options. The SSH tunnel still works because it already connects to `127.0.0.1:8787`. The proxy must forward the whole service, including `/ws`, APIs, `/mcp` and attachments; keep the real Host and forwarding headers and do not rewrite Host to localhost. Proxied requests never count as local, so they are never treated as the owner.

**Caddy** (obtains and renews certificates automatically; WebSocket needs no extra setup):

```text
hive.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

<details>
<summary>Nginx configuration</summary>

Obtain a certificate first. Put both `map` and `server` in the `http` context:

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

Reload after `sudo nginx -t` passes. `25m` is an example upload limit; adjust it to your attachment sizes. An outer CDN, gateway or sign-in wall must also allow agent authentication and long connections.

</details>

### Dedicated user with system-level systemd

Use this to isolate Hive from personal accounts under system management. It **replaces** `hive start` and `hive autostart` above; do not mix them, or they will fight over the port.

<details>
<summary>Dedicated user and systemd unit</summary>

Create a dedicated user without sudo and install into its own npm prefix (check any existing user with the same name first; do not recreate it):

```bash
sudo useradd --system --user-group --create-home \
  --home-dir /var/lib/superhive --shell /bin/bash hive
sudo -u hive -H npm i -g --prefix /var/lib/superhive/.local superhive
sudo -u hive -H /var/lib/superhive/.local/bin/hive --version
```

Save as `/etc/systemd/system/superhive.service` and replace the domain; adjust PATH if Node is elsewhere:

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

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now superhive
sudo journalctl -u superhive -f
```

Data lives in `/var/lib/superhive/.superhive/` and logs go to the journal. The Join Token is generated and saved on first start; do not put it in the unit file. Do not add `--no-local-agents`: it currently also disables owner-device pairing.

</details>

### Back up and upgrade

The data directory (default `~/.superhive/`) holds the database, attachments, authentication and encryption files. Encrypt backups and restrict access.

- **Started with `hive start` in the background**: update in one click from the web status bar, or run `hive update` in a terminal; when handover is possible, local agents keep their running tasks. See [Updating](/en/guides/updating/).
- **System-level systemd**: never run `hive update` / `hive restart` while the service is running; the CLI would start its own background process and fight systemd for the port. Stop, back up, upgrade, then start:

<details>
<summary>Backup and upgrade commands under systemd</summary>

```bash
sudo systemctl stop superhive
sudo install -d -m 700 /var/backups/superhive
backup="/var/backups/superhive/hive-$(date +%Y%m%d-%H%M%S).tgz"
sudo tar -czf "$backup" -C /var/lib/superhive .superhive
sudo chmod 600 "$backup"
sudo -u hive -H env PATH=/var/lib/superhive/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /var/lib/superhive/.local/bin/hive update
sudo systemctl start superhive
```

With the service stopped, `hive update` only installs the new version. Server backups do not include projects, runtime sign-ins or private state on agent machines; back those up separately and rehearse restores in isolation. See [Deployment](/en/reference/deployment/#data-and-backups).

</details>

### Pre-launch security checklist

- Expose Hive only through HTTPS or a trusted VPN; keep 8787 on loopback and bind SSH tunnels to local ports only.
- Use time-limited invites for members and one-time sign-in links for owner devices. The Join Token is an owner-level credential across rooms; `--room` does not make it room-scoped. Never publish it.
- Do not run Hive or agents as root; connect only the accounts, directories and MCP servers you need. Full access can change files on the machine and call external services; use workspace access when the room includes people you do not know well.
- Before launch, verify collaboration in two browsers, WebSocket reconnects, attachment uploads, guest revocation, and remote agents' actual directories and permissions.
- Watch disk, backups and cost: charges go to each agent's own model account; see [Usage and cost](/en/guides/usage/).

### Troubleshooting

| Symptom                                      | Check first                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Public address shows Invite required         | Expected; sign in as owner with [steps 2 and 3](#2-become-the-owner-through-an-ssh-tunnel) |
| Sign-in QR or invites point to a private IP  | `--public-url` at startup; fix it with `hive restart --public-url …`                       |
| Web works but agents go offline or reconnect | Proxy forwards `/ws`, APIs and `/mcp`; gateway limits, agent logs, computer sleep          |
| Remote device has no Start button            | Whether `--no-local-agents` is set, and whether the device requested and got admin access  |
| Agent cannot see the project                 | Execution machine, actual cwd, repository clone; the cloud does not sync files             |
| Port conflict after restart                  | Mixing system-level systemd, `hive start` and `hive autostart`                             |
