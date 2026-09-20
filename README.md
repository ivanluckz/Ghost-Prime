# Ghost-Prime

A local AI agent for Chrome OS / Crostini that **chats, runs terminal commands, reads/writes
files, searches the web, drives a real browser, listens and talks, and remembers across
sessions** — wrapped in a Higgsfield-generated cinematic intro.

> **Status: feature-complete.** Cinematic intro → streaming chat routed between a Gemini and a
> Claude brain → autonomous tools (terminal / files / web / browser) → voice in & out → persistent
> memory & chat history → Discord remote control. Installed as a Chrome OS launcher app.

---

## What it does

- **Two brains, both free** — every turn is routed (`GHOST_BRAIN_MODE=auto`) between **Gemini**
  (free AI Studio key; plain chat, dropped images, Jarvis controls) and **Claude** (the **Claude
  Agent SDK** on your **Claude Code login**, no API key; hard/long tasks and computer-control
  turns). Claude uses Claude Pro's Agent-SDK allotment; with usage credits off it simply pauses when
  spent and **never charges**. See [Switching the brain](#switching-the-brain-env).
- **Streaming chat** with **Markdown** rendering (code blocks, lists, links), stop/abort mid-stream.
- **Autonomy modes — Shift+Tab** to cycle (like Claude Code): **PLAN** (read-only) → **AUTO**
  (each action approved) → **FULL** (no checks). Shown in the top bar.
- **Tools the agent can use:** live persistent terminals (`shell_run` — there is no `Bash` tool; shell
  work runs in terminals you can watch), `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`,
  `WebSearch`, reversible file ops + undo, reminders, clipboard, plus a **persistent, visible browser**
  (navigate / read / click / fill / screenshot). The Gemini brain gets the equivalent set from
  `src/main/tools` (plus the Jarvis one-shots: volume, brightness, battery, weather, YouTube).
- **Live tool feed** — each tool call shows a typed glyph, args, elapsed time, collapsible output,
  and **inline screenshots** from the browser.
- **Mission Control layout** — a right-hand **Activity** panel shows live browser status, the running
  task with a timer, the queue, and a streaming tool feed; toggle it from the top bar (**◨**).
- **Voice** — push-to-talk speech input and spoken replies. With a `GEMINI_API_KEY` set it uses
  Gemini's free-tier STT/TTS by default; `GHOST_VOICE_PROVIDER=local` (or no key) runs fully
  offline on **Whisper** + **espeak-ng** / **Piper**. Instant spoken acknowledgements either way.
- **Memory** — the agent calls `memory_save` / `memory_recall` to remember facts and preferences
  **across sessions** (SQLite-backed); the most important memories are auto-injected each turn.
- **Chat history** — every conversation is saved; reopen past chats from the sidebar (**Ctrl+N**
  for a new one).
- **Present, not just reactive** — a morning briefing and idle check-ins (`GHOST_PROACTIVE`),
  reminders, chats auto-distilled into memories when you leave them (`GHOST_AUTO_SUMMARIZE`), and a
  global wake-up hotkey (`Ctrl+Shift+G`, recordable in Settings).
- **Discord remote control** — DM the bot (or @mention it / use `DISCORD_CHANNEL_ID`) from your
  phone and it acts on your machine; `!mode`, `!brain`, `!stop`, `!status`. Locked to
  `DISCORD_ALLOWED_USER_IDS`.
- **Scheduled tasks** — `node scripts/run-task.mjs "…"` fires a prompt at the running app (launching
  it if needed) from cron / a systemd timer.
- **Installed app** — appears in the Chrome OS launcher as **Ghost-Prime**.

## Quick start

```bash
npm install            # deps + rebuilds better-sqlite3 for Electron (postinstall)
npm run build          # build main/preload/renderer to out/

# install the `ghost-prime` terminal command (one-time):
ln -sf "$PWD/bin/ghost-prime" ~/.local/bin/ghost-prime

ghost-prime            # start from any terminal  (also: stop | status | -f for foreground)
# or: ./ghost-prime.sh  ·  or search "Ghost-Prime" in the Chrome OS launcher
npm run dev            # dev mode with HMR
```

Out of the box you need **both** a free `GEMINI_API_KEY` (plain chat / vision turns) and the
**`claude` CLI installed and logged in** (hard and computer-control turns) — no paid API key. Pin a
single brain with `GHOST_BRAIN_MODE` if you only have one (see below).

### Voice setup (local, free)

This is the `GHOST_VOICE_PROVIDER=local` path — the default whenever no `GEMINI_API_KEY` is set.
(With a key, voice goes through Gemini's free tier unless you pin `local`; models/voice are
`GEMINI_STT_MODEL`, `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE`.)

- **Speech-to-text** is automatic: the first voice command downloads `whisper-tiny.en` (~40 MB,
  cached under `vendor/transformers-cache/`). Bump accuracy with `GHOST_WHISPER_MODEL=Xenova/whisper-base.en`.
- **Text-to-speech** uses **espeak-ng**: `sudo apt-get install -y espeak-ng`.
- **Better voice (optional):** drop the **Piper** binary at `vendor/piper/piper` and a voice at
  `vendor/piper/voices/en_US-amy-medium.onnx` — Ghost-Prime auto-prefers it over espeak-ng.

### Switching the brain (`.env`)

Ghost-Prime routes **every chat turn between two brains**: **Gemini** (free AI Studio key — plain
chat, dropped images, Jarvis controls) and **Claude** (`claude` CLI login — hard/long tasks and
computer-control turns). **Both brains have tool use** (terminal, browser, files, memory). If one
brain is unavailable (rate limit / auth) the turn falls over to the other.

```dotenv
GHOST_BRAIN_MODE=auto                # auto | gemini | claude — auto = per-turn heuristic
GHOST_CONTROL_BRAIN=claude           # claude | gemini — where browser/terminal/file/app turns go
CLAUDE_AGENT_MODEL=sonnet            # sonnet | opus | haiku for the Claude brain
GEMINI_API_KEY=                      # https://aistudio.google.com/apikey (free tier)
GEMINI_MODEL=gemini-2.5-flash

# Background work ONLY (session auto-summaries, proactive check-ins) — never chat:
GHOST_PROVIDER=gemini                # claude-agent | gemini | openrouter
GHOST_FALLBACK_PROVIDER=gemini       # backup for those calls when GHOST_PROVIDER=claude-agent
OPENROUTER_API_KEY=                  # only used when GHOST_PROVIDER/GHOST_FALLBACK_PROVIDER=openrouter
OPENROUTER_MODEL=openai/gpt-oss-120b:free
```

> In chat, `/brain auto|gemini|claude` overrides the routing for the session and `/model
> sonnet|opus|haiku` picks the Claude model. `openrouter` is **not** a chat brain — `OPENROUTER_*`
> only matter for the background calls above. `GHOST_MODEL` overrides the model for those
> background calls on any OpenAI-compatible provider; `CLAUDE_AGENT_EFFORT=low` (medium | high |
> xhigh | max) and `CLAUDE_AGENT_THINKING=0` tune the Claude brain's speed.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Launch in dev (Vite HMR + Electron). |
| `npm run build` | Build to `out/`, then **auto-commit + push** the current branch (see below). Use `npx electron-vite build` for a build with no git side effects. |
| `npm start` | `electron-vite preview` — run the last build without HMR. |
| `npm run rebuild` | Rebuild `better-sqlite3` + `node-pty` against Electron's ABI (also on `postinstall`). |
| `npm run ext:deploy` | Copy `extension/` to `GHOST_EXT_DEPLOY` (a Chrome OS shared folder) so host Chrome can load it. Chrome loads the **deployed** copy — re-run + reload at `chrome://extensions` after extension edits. |
| `npm run jarvis:setup` | Create `jarvis/.venv` and install the Jarvis (volume/brightness/battery/weather) Python deps. |
| `node scripts/run-task.mjs "…"` | Send a prompt to the running app's `/task` endpoint (cron / timers); launches the app via `bin/ghost-prime` if it is down. |
| `npm run bridge:smoke` | Multi-device bridge end to end with a simulated phone connector, on a private port — no Electron, no LLM. |
| `node scripts/smoke-bridge.mjs` | Browser-bridge transport (poll / result / token / `/task` / extension live-reload) with a fake extension, on a private port — no Chrome, no LLM. |
| `PHONE_PORT=8731 PHONE_TOKEN=… node scripts/fake-phone.mjs` | Attach a simulated phone to a **live** app to exercise the phone tools. |
| `npx electron scripts/smoke-db.cjs` | Integration test for persistence + memory (temp DB, no LLM, no cost). |
| `npx electron scripts/smoke-summary.cjs` | Auto-summary DB layer (migration, summary state, session-attributed memories) — no LLM. |
| `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-brain-router.mjs` | Which brain each kind of message routes to (no LLM). |
| `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-env-bool.mjs` | Boolean env-flag parsing (`envBool`): every accepted spelling + defaults (no LLM). |
| `node scripts/smoke-proactive.mjs` | Proactive engine's morning-briefing bookkeeping (delivered-once-per-day, bounded retries) — in-memory stubs, no LLM, no DB, no Electron. |
| `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-gemini-agent.mjs` | Gemini brain + Jarvis tools end to end (free tier). |
| `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-gemini-browser-vision.mjs` | Proves the Gemini brain can see browser screenshots (free tier, same browser env prefix as below). |
| `node scripts/smoke-claude-agent.mjs` | Headless check that the Claude brain streams (spends Pro allotment). |
| `node scripts/smoke-claude-agent-tools.mjs` | Exercise the Claude brain's tools (honours `GHOST_TEST_PERMISSION`; spends Pro allotment). |
| `GHOST_BROWSER_BACKEND=playwright GHOST_BROWSER_HEADLESS=1 node scripts/smoke-claude-agent-browser.mjs` | Drive the Playwright browser through the Claude brain (spends Pro allotment). |
| `GHOST_BROWSER_BACKEND=playwright GHOST_BROWSER_HEADLESS=1 GHOST_BROWSER_CHANNEL=chromium GHOST_BROWSER_PROFILE=isolated node scripts/smoke-browser-click.mjs` | browser_click edge cases (hidden duplicates, iframes, selectors) — no LLM. |
| `node scripts/smoke-browser-control.mjs` | Browser control layer end to end (refs, annotated screenshots, popups, dialogs, downloads) — no LLM. Prefix with `GHOST_BROWSER_HEADLESS=1 GHOST_BROWSER_CHANNEL= GHOST_BROWSER_PROFILE=/tmp/ghost-pw GHOST_BROWSER_BACKEND=playwright`. |
| `node scripts/smoke-tools.mjs` | Bare terminal + Playwright sanity check (no app code, no LLM). |
| `node scripts/smoke-openrouter.mjs [openrouter\|gemini]` | One-shot chat through an OpenAI-compatible provider — checks the key/model used for background summaries. |
| `node scripts/probe-gemini.mjs` · `node scripts/find-free-model.mjs` | List / probe free OpenRouter models (needs `OPENROUTER_API_KEY`). |
| `node scripts/voice-transcribe.mjs` | The Whisper STT worker the app spawns per utterance (not run by hand). |

The Playwright-backed smokes need the bundled browser once: `npx playwright install chromium`.

### Browser control

The agent sees the page as a numbered list (`browser_get_page` → `[12] "Log In"`) and acts by number
(`browser_click { ref: 12 }`), or takes `browser_screenshot { annotate: true }` to get those numbers
drawn on the image. Every action reports where it landed, whether the page changed, and any dialog,
download or new tab it caused. Related `.env` switches:

```dotenv
GHOST_BROWSER_BACKEND=playwright     # auto | extension | playwright (school blocks dev-mode extensions → playwright)
GHOST_CONTROL_BRAIN=claude           # computer-control turns (browser/terminal/files/apps) → claude; set gemini to keep them free
GHOST_BROWSER_DIALOGS=accept         # accept | dismiss — how confirm()/prompt() dialogs are answered (always reported)
```

### Configuration reference (`.env`)

Every switch the app reads, with its **code default** (what you get when the line is absent).
Every on/off flag takes the same spelling: `1` / `0` is canonical, and `true`/`on`/`yes` and
`false`/`off`/`no` are accepted aliases (`src/main/env.js` → `envBool`). Unset or empty = the default.

**Brains & models**

| Variable | Default | Meaning |
|---|---|---|
| `GHOST_BRAIN_MODE` | `auto` | `auto` \| `gemini` \| `claude` — chat routing; `auto` picks per turn. `/brain` overrides for the session. |
| `GHOST_CONTROL_BRAIN` | `claude` | `claude` \| `gemini` — brain for browser / terminal / file / app-control turns. |
| `GEMINI_API_KEY` | — | Free AI Studio key. Needed for the Gemini brain, Gemini voice and vision. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini chat model. |
| `CLAUDE_AGENT_MODEL` | `sonnet` | `sonnet` \| `opus` \| `haiku` — Claude brain model (`/model` in chat). |
| `CLAUDE_AGENT_EFFORT` | `low` | `low` \| `medium` \| `high` \| `xhigh` \| `max` (ignored on haiku). |
| `CLAUDE_AGENT_THINKING` | `1` | `0` disables extended thinking for the fastest first token (`/thinking off` in chat does the same per session). |
| `GHOST_PROVIDER` | `gemini` | `claude-agent` \| `gemini` \| `openrouter` — **background only** (auto-summaries, proactive lines). |
| `GHOST_FALLBACK_PROVIDER` | `gemini` | Backup for those background calls when `GHOST_PROVIDER=claude-agent` is unavailable. |
| `GHOST_MODEL` | — | Overrides the model for background calls on any OpenAI-compatible provider. |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | — / `openai/gpt-oss-120b:free` | Only used when a background provider is `openrouter`. |
| `GHOST_CANVA` | `1` | `0` skips spawning the Canva MCP server for the Claude brain (saves tokens; needs Node ≥ 22 when on). |
| `GHOST_SCREEN_TOOLS` | `0` | `1` enables the experimental `screen_screenshot` desktop tool (limited on Crostini). |

**Behaviour**

| Variable | Default | Meaning |
|---|---|---|
| `GHOST_PROACTIVE` | `1` | `0` turns off the morning briefing and idle check-ins. |
| `GHOST_PROACTIVE_IDLE_MIN` | `25` | Minutes of silence before a check-in (never more often than every 90 min, 08:00–22:00 only). |
| `GHOST_AUTO_SUMMARIZE` | `1` | `0` stops distilling a chat into memories when you leave it. |
| `GHOST_HOTKEY` | `CommandOrControl+Shift+G` | Default global wake-up accelerator; a combo recorded in Settings wins. |
| `GHOST_PAGE_CONTEXT` | `1` | `0` stops feeding the current browser tab's page into the prompt. |
| `GHOST_DEBUG` | `0` | `1` prints background-call failures (auto-summary / proactive) to the console. |

**Voice**

| Variable | Default | Meaning |
|---|---|---|
| `GHOST_VOICE_PROVIDER` | `gemini` if `GEMINI_API_KEY` is set, else `local` | `gemini` \| `local` (Whisper + espeak-ng/Piper). |
| `GEMINI_STT_MODEL` | `gemini-2.5-flash` | Gemini speech-to-text model. |
| `GEMINI_TTS_MODEL` / `GEMINI_TTS_VOICE` | `gemini-2.5-flash-preview-tts` / `Kore` | Gemini text-to-speech model and voice. |
| `GHOST_WHISPER_MODEL` | `Xenova/whisper-tiny.en` | Local Whisper model (e.g. `Xenova/whisper-base.en`). |
| `JARVIS_PYTHON` | `jarvis/.venv` python, else `python3` | Interpreter for the Jarvis one-shots. |

**Browser**

| Variable | Default | Meaning |
|---|---|---|
| `GHOST_BROWSER_BACKEND` | `auto` | `auto` \| `extension` \| `playwright`. |
| `GHOST_BROWSER_AUTOLAUNCH` | `1` | `0` stops auto-launching Chrome for the extension backend. |
| `GHOST_CHROME_BIN` | — | Chrome binary to launch (else `google-chrome` / `chromium` on PATH). |
| `GHOST_BROWSER_ACTIVE_TAB` | `1` | `0` pins the agent to its own tab instead of the one you are looking at. |
| `GHOST_BROWSER_FOCUS` | `0` | `1` brings the agent's tab to the foreground while it acts. |
| `GHOST_BROWSER_CHANNEL` | `chrome` | Playwright channel; empty string = bundled Chromium. |
| `GHOST_BROWSER_HEADLESS` | `0` | `1` hides the Playwright browser. |
| `GHOST_BROWSER_PROFILE` | `~/.config/google-chrome` | Playwright user-data dir: your real Chrome profile (close Chrome first), `isolated` (a separate `~/.config/ghost-prime/browser-profile`, log in once), or any path. |
| `GHOST_BROWSER_NO_SANDBOX` | `0` | `1` passes `--no-sandbox` to the Playwright browser. |
| `GHOST_BROWSER_DIALOGS` | `accept` | `accept` \| `dismiss` — how confirm()/prompt() dialogs are answered. |

**Bridge (extension / phone / scripts)**

| Variable | Default | Meaning |
|---|---|---|
| `GHOST_BRIDGE_PORT` | `8731` | Local HTTP bridge port. |
| `GHOST_BRIDGE_TOKEN` | `ghost-local` | Shared secret; **set a private one** (same value in the extension / phone app). |
| `GHOST_BRIDGE_HOST` | `127.0.0.1` | `0.0.0.0` lets a phone / host browser reach it — refused (downgraded to loopback) while the token is still the default. |
| `GHOST_BRIDGE_URL` | `http://127.0.0.1:8731` | Where `scripts/run-task.mjs` posts tasks. |
| `GHOST_LAUNCH_CMD` | `bin/ghost-prime`, else `gtk-launch ghost-prime` | How `run-task.mjs` starts the app when it is down; `GHOST_LAUNCH_WAIT_S` (`90`) caps the wait. |
| `GHOST_EXT_AUTORELOAD` | `0` | `1` watches `extension/` and reloads it in Chrome on change (mirroring to `GHOST_EXT_DEPLOY` first). |
| `GHOST_EXT_DEPLOY` | — | Shared folder the extension is mirrored to (`npm run ext:deploy`). |

**Discord**

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_BOT_TOKEN` | — | Unset = the bot never starts. |
| `DISCORD_ALLOWED_USER_IDS` | — | Comma-separated user ids allowed to command the bot (everyone else is refused). |
| `DISCORD_CHANNEL_ID` | — | Server channel the bot answers in without an @mention. DMs always work. |
| `DISCORD_MODE` | `auto` | `plan` \| `auto` \| `full` — default autonomy for Discord sessions (`!mode`). |

**Window / platform**

| Variable | Default | Meaning |
|---|---|---|
| `GHOST_GPU` | `1` | `0` forces software rendering (see gotchas). |
| `GHOST_OZONE` | unset (Electron's own x11) | `x11` \| `wayland` \| `auto` — Linux Ozone backend. The `ghost-prime` launcher injects `wayland`; `npm run dev` / bare `npx electron .` pin/keep x11. |
| `GHOST_NATIVE_FRAME` | `0` | `1` uses the OS title bar (escape hatch for lost clicks on Wayland). |
| `GHOST_SINGLE_INSTANCE` | `1` | `0` allows a second instance (the `GHOST_CAPTURE` flow skips the lock too). |
| `GHOST_CAPTURE` | — | Path: boot headless, skip the intro, screenshot the UI there and quit (verification). |
| `GHOST_PUSH_MSG` | — | One-off commit message for the `postbuild` push. |
| `GHOST_TEST_PERMISSION` | `bypassPermissions` | Permission mode for `smoke-claude-agent-tools.mjs` only. |

`HIGGSFIELD_API_KEY_ID` / `HIGGSFIELD_API_KEY_SECRET` in `.env` are **not read by the app** (the
intro video was generated offline) — safe to delete.

### Pushing & commit messages

Every `npm run build` runs a `postbuild` hook (`scripts/push-after-build.mjs`) that commits any
pending changes and pushes the current branch — so the latest build is always backed up on GitHub.
The commit message is **"what you changed"**, resolved in this order:

1. **`GHOST_PUSH_MSG`** env var — one-off: `GHOST_PUSH_MSG="reworked the sidebar" npm run build`
2. **`COMMIT_MSG.txt`** (repo root) — type a summary into this file, then `npm run build`. The first
   line becomes the commit title; the file is **cleared after each push**. It's gitignored, so it
   never lands in the repo.
3. Otherwise a default `build: v<version> · <stamp>` stamp.

The hook never fails the build — if there's nothing to commit or no remote, it just prints a note.

## Architecture

```
src/
├── main/                    # Electron main process (Node)
│   ├── index.js             # app lifecycle, BrowserWindow, Crostini GPU/Wayland flags, bridge + hotkey boot
│   ├── ipc.js               # chat:* / db:* / voice:* handlers (+ streaming events)
│   ├── agent/provider.js    # per-turn brain router: gemini (tools/index.js) | claude (Agent SDK)
│   │                        #   + in-process MCP servers (shell, browser, memory, files, reminders…)
│   ├── tools/               # index.js (Gemini tool specs), browser.js + browser-bridge.js (Playwright /
│   │                        #   extension / phone), shell-sessions.js + terminal.js, files.js + file-undo.js,
│   │                        #   web.js, reminders.js, jarvis.js, screen.js (experimental), site-policy.js
│   ├── discord/index.js     # Discord bot: DM / channel → agent, live-edited replies, !commands
│   ├── proactive.js         # morning briefing + idle check-ins
│   ├── hotkey.js            # global wake-up shortcut (recordable in Settings)
│   ├── voice/index.js       # Gemini STT/TTS, or arecord -> Whisper and Piper/espeak-ng -> aplay
│   └── memory/              # db.js (better-sqlite3: sessions, messages, memories), auto-summary.js
├── preload/index.js         # contextBridge -> window.ghost (typed IPC only)
└── renderer/                # React UI
    ├── screens/             # Intro.jsx (video), Main.jsx (3-column Mission Control: sidebar · chat · activity)
    └── components/          # chat/ (ChatInput, MessageList, Message, Markdown), tools/, GhostCore (three.js gem),
                             #   SessionSidebar, ActivityPanel, SettingsPanel, TerminalPanel (xterm dock)
extension/                   # Chrome extension backend for the browser tools (talks to the local bridge)
jarvis/                      # Python one-shots (volume, brightness, battery, weather)
scripts/voice-transcribe.mjs # Whisper STT (Transformers.js), spawned per utterance
migrations/                  # 001_init.sql (sessions/memories/preferences), 002_messages.sql, 003_reminders_and_attachments.sql
```

The agent loop runs in **main**; the renderer is pure UI. Streamed tokens and tool events flow
main → renderer over IPC (`chat:delta` / `chat:tool` / `chat:done` / `chat:error`).

## Crostini notes & gotchas

- **GPU:** hardware acceleration is **on by default** (`GHOST_GPU=1`, needed for the three.js
  core). If the window black-screens or the GPU process crash-loops on launch (`exit_code=8704` —
  Wayland's GBM stack can't allocate scanout buffers), set `GHOST_GPU=0` in `.env` to fall back to
  software rendering. Re-`npm run build` after main-process changes.
- **Native modules** must match Electron's ABI — `better-sqlite3` **and `node-pty`** are rebuilt on
  `postinstall` (`npm run rebuild` does it again by hand). The Whisper transcriber runs as a
  separate Node process (`ELECTRON_RUN_AS_NODE=1`) so its `onnxruntime-node` stays out of Electron.
- **Voice provider:** `GHOST_VOICE_PROVIDER=local|gemini` — defaults to `gemini` when a
  `GEMINI_API_KEY` is set (free-tier STT/TTS), otherwise `local` (Whisper + espeak-ng/Piper).
- **OS-level screen/desktop control is not viable here** — ChromeOS's compositor lacks
  `wlr-screencopy`, and `/dev/uinput` is root-only. The agent's "hands" are the Playwright browser
  and the terminal, not global mouse/keyboard. (So, no, it can't play an FPS.)
- **Voice works** — the Crostini VirtIO sound card exposes both capture and playback.
- **Mic/voice** capture needs Chrome OS's "Allow Linux to access your microphone" setting on.

## Roadmap (post-completion ideas)

- Semantic memory (local embeddings) instead of keyword recall.
- A memories viewer/editor panel.
- `.deb` packaging via electron-builder for true distribution.
- Tighten CSP for packaged builds.
