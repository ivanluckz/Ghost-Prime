# Scheduled routines

Make Ghost-Prime do things on a schedule (a morning briefing, a nightly summary, an hourly check).
Each routine is a systemd **user timer** that runs `scripts/run-task.mjs "…"`, which POSTs the task
to the app's `/task` endpoint — launching the app first if it's closed. Reuses the same channel as
the wake daemon, so nothing new is needed in the app.

## The included example: a daily 8am briefing

```sh
cp daemon/routines/ghost-briefing.service ~/.config/systemd/user/
cp daemon/routines/ghost-briefing.timer   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ghost-briefing.timer
loginctl enable-linger "$USER"   # so it fires even if no Linux app is open
```

- Edit the prompt in `ghost-briefing.service`. With **spoken replies on** (the 🔊 toggle or
  `/voice on`), the briefing is read aloud via Gemini.
- Change the time in `ghost-briefing.timer` (`OnCalendar=`). Examples:
  `*-*-* 08:00:00` daily 8am · `Mon..Fri 09:00` weekday mornings · `hourly` every hour.
- Test it now without waiting: `systemctl --user start ghost-briefing.service`
  (or directly: `node scripts/run-task.mjs "what's on my calendar today?"`).

## More routines

Copy the pair, rename (`ghost-<name>.service` / `.timer`), edit the prompt + `OnCalendar`, and
`enable --now` the new timer. List them with `systemctl --user list-timers`.

Requires Node on PATH (the app already uses Electron's Node; `/usr/bin/env node` must resolve —
if not, point ExecStart at your node binary).
