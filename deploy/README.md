# Running mindcraft on a homelab box

## 1. Set it up for headless

**Put per-machine config in `settings.local.json`, never in `settings.js`.**
That file is gitignored; `settings.js` is tracked, so editing it directly both
commits your private network config and makes every `git pull` a conflict on
your own settings.

```bash
cp settings.local.example.json settings.local.json
$EDITOR settings.local.json
```

```json
{
    "host": "192.168.x.x",
    "port": 25565,
    "auto_open_ui": false,
    "use_cognition": true
}
```

Precedence is `settings.js` defaults < `settings.local.json` < `SETTINGS_JSON`
env var. On boot it prints which keys it overrode; if the JSON is malformed it
says so loudly and falls back to the defaults rather than starting against the
wrong server silently.

Then confirm the box is ready:

```bash
node tools/preflight.mjs        # 0 blockers before you go further
```

## 2. Run it under systemd

```bash
sudo cp deploy/mindcraft.service /etc/systemd/system/
sudoedit /etc/systemd/system/mindcraft.service   # fix User, WorkingDirectory, node path
sudo systemctl daemon-reload
sudo systemctl enable --now mindcraft
```

```bash
systemctl status mindcraft
journalctl -u mindcraft -f        # live logs, including the hourly [economics] line
journalctl -u mindcraft --since "1 hour ago" | grep -i "prompt caching\|economics"
```

`which node` first — systemd does not read your shell profile, so a bare `node`
will not resolve under nvm.

**`KillSignal=SIGINT` is load-bearing.** The agent's clean-shutdown path listens
for SIGINT and flushes history, cognition state, learned skills and social state
before exiting. Switch it to SIGKILL and every restart silently discards a run's
accumulated state.

## 3. Reach the dashboard from your laptop

The dashboard defaults to localhost on port 8080. Choose either direct access
on a trusted LAN or an SSH tunnel.

### Direct LAN access

Merge these values into your existing `settings.local.json`:

```json
{
    "mindserver_host": "0.0.0.0",
    "mindserver_port": 8080,
    "mindserver_allowed_origins": ["http://192.168.x.x:8080"]
}
```

Replace `192.168.x.x` with this server's LAN address. `0.0.0.0` listens on all
IPv4 interfaces and preserves localhost access for the agent processes.
Origins must match the browser's scheme, hostname/IP, and port exactly, with no
trailing slash. Add another origin if you use a DNS name. Localhost browser
origins remain allowed; unrelated browser origins are rejected.

```bash
sudo systemctl restart mindcraft.service
systemctl is-active mindcraft.service
curl -I http://192.168.x.x:8080/
```

Open `http://192.168.x.x:8080` from another device on the LAN. If a host firewall
is enabled, allow TCP port 8080 from the intended LAN subnet. A page that loads
but cannot connect may indicate a missing browser origin. Changes to the bind
address, port, or origin list require a restart; they are server startup settings.
The optional bot 3D viewers use separate ports and localhost iframe URLs; this
configuration enables the main dashboard, not remote 3D viewers.

**There is no login.** Anyone who can reach the dashboard can control agents,
change profiles, inject chat, and shut down the app. The origin list is a browser
connection check, not authentication. This mode is for a trusted LAN; do not
port-forward it to the public internet.

### SSH tunnel (default localhost configuration)

Leave `mindserver_host` unset or set it to `localhost`, then run on your laptop:

```bash
ssh -N -L 8080:localhost:8080 tgorup@mindcraft-server
# browse to http://localhost:8080
```

`-N` means no remote command, just forwarding. Leave it running while using the
app. The tunnel provides SSH encryption and authentication.

### Optional limited restart permission

To allow the service account to restart only this service without a sudo password,
run `sudo visudo -f /etc/sudoers.d/mindcraft-restart` and add:

```sudoers
tgorup ALL=(root) NOPASSWD: /usr/bin/systemctl restart mindcraft.service
```

Adjust the username and confirm the binary path with `command -v systemctl`.
The allowed command is `sudo -n /usr/bin/systemctl restart mindcraft.service`.

## 4. Keeping an eye on it

| what | where |
|---|---|
| cost and call rate over time | Sim tab, Trends chart, 1h/3h/24h/7d |
| prompt cache health | Sim tab, "Prompt cache" tile — 0% on a paid model is urgent |
| hourly cost summary | `journalctl -u mindcraft \| grep economics` |
| whether a tier has wedged | Sim tab; the scheduler warns after 180s |

The trends history lives in the mindserver's memory, so `systemctl restart`
clears it. The `runs/` archive on disk is the durable record.
