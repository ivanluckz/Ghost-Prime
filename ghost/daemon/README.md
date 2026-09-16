# Ghost-Prime wake-word daemon

Always-listening, hands-free. Runs as a **systemd user service that starts with Crostini** — not
tied to the app. Say **"hey ghost, &lt;command&gt;"** (or just "hey ghost", then your command) and it
wakes Ghost-Prime and runs it.

Fully offline + free: on-device speech via **Vosk** (no API key, no cloud, your audio never leaves
the machine). The wake phrase is plain text, so you can change it to anything.

## How it works

```
mic ──▶ wake.py (Vosk) ──hears "ghost <cmd>"──▶ POST /task to the app's local bridge
                                                  └─ if the app is down, it launches it first
                                               app focuses + runs the command
```

It reuses the same `/task` channel as the right-click "Ask Ghost" feature, so no app changes are
needed — the daemon just needs the app's bridge token (defaults match `.env`).

## Install (once)

```sh
bash daemon/install.sh
```

That installs the Python deps, downloads the Vosk model into `daemon/model/`, and enables the
systemd user service (with linger, so it's up right after Crostini boots).

It installs into a self-contained **venv** (`daemon/.venv/`) — Crostini's Python is "externally
managed", so the daemon never touches system packages.

**Prerequisites:** `sudo apt install -y python3-venv python3-full curl unzip libportaudio2`, and
**microphone access enabled for Linux** in Chrome OS Settings. (`python3-full` provides the
`ensurepip` that venv needs; `libportaudio2` is what `sounddevice` needs to open the mic.)

## Configure (optional — env, or in `~/.config/systemd/user/ghost-wake.service`)

| Var | Default | Meaning |
|---|---|---|
| `GHOST_WAKE_PHRASE` | `ghost` | wake words (e.g. `okay ghost`) |
| `GHOST_BRIDGE_TOKEN` | `ghost-local` | must match the app's `.env` |
| `GHOST_LAUNCH_CMD` | `gtk-launch ghost-prime` | how to start the app if it's closed |
| `GHOST_VOSK_MODEL` | `daemon/model` | a larger model = better accuracy |

After editing the service file: `systemctl --user daemon-reload && systemctl --user restart ghost-wake`.

## Manage

```sh
systemctl --user status ghost-wake        # is it running?
journalctl --user -u ghost-wake -f         # live logs (see what it heard)
systemctl --user restart ghost-wake        # restart
systemctl --user disable --now ghost-wake  # turn it off
```

## Notes / limits

- Vosk's small model is fast but not perfect; it's fine for short commands. Swap in a bigger model
  for better accuracy.
- One wake phrase, matched in the transcript — pick something distinctive to avoid false triggers.
- The daemon only sends a command; everything else (browser/terminal/etc.) runs in the app as usual.
