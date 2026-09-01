# Running mindcraft on a homelab box

## 1. Set it up for headless

`auto_open_ui` tries to launch a browser on startup. On a headless server that
fails harmlessly (it warns rather than crashing) but there is no reason to try:

```js
// settings.js
"auto_open_ui": false,
```

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

**Use an SSH tunnel. Do not expose port 8080.**

```bash
# on your laptop
ssh -N -L 8080:localhost:8080 tgorup@mindcraft-server
# then browse to http://localhost:8080
```

`-N` means "no remote command, just forward". Leave it running in a terminal, or
background it with `-f`.

If your network blocks SSH on port 22 (this one does), add to `~/.ssh/config`:

```
Host mindcraft-server
  HostName 192.168.10.x
  User tgorup
  LocalForward 8080 localhost:8080
```

then plain `ssh mindcraft-server` forwards the port automatically.

### Why not just bind it to the LAN?

The mindserver has **no authentication**, and the socket API it exposes can
create and destroy agents, rewrite profiles, inject chat as any player, and shut
the whole thing down. It binds `127.0.0.1` deliberately, and the socket layer
additionally rejects any browser origin that is not localhost.

An SSH tunnel satisfies both — the browser genuinely is on localhost as far as
the server is concerned — and gives you encryption and key-based auth for free.

Binding it to `0.0.0.0` would need three changes (the bind address, the origin
allowlist, and authentication that does not currently exist). Anything short of
all three is a kill switch for anyone on the network.

## 4. Keeping an eye on it

| what | where |
|---|---|
| cost and call rate over time | Sim tab, Trends chart, 1h/3h/24h/7d |
| prompt cache health | Sim tab, "Prompt cache" tile — 0% on a paid model is urgent |
| hourly cost summary | `journalctl -u mindcraft \| grep economics` |
| whether a tier has wedged | Sim tab; the scheduler warns after 180s |

The trends history lives in the mindserver's memory, so `systemctl restart`
clears it. The `runs/` archive on disk is the durable record.
