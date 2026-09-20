# Ghost-Prime

A local AI agent for Chrome OS / Crostini that **chats, runs terminal commands, reads/writes
files, searches the web, drives a real browser, listens and talks, and remembers across
sessions** — wrapped in a Higgsfield-generated cinematic intro.

> **Status: feature-complete.** Cinematic intro → streaming chat with a real Claude brain →
> autonomous tools (terminal / files / web / browser) → voice in & out → persistent memory &
> chat history. Installed as a Chrome OS launcher app.

---

## What it does

- **Real Claude brain, free** — runs on the **Claude Agent SDK** using your **Claude Code login**
  (no API key). Uses Claude Pro's ~$20/mo Agent-SDK credit; with usage credits off it simply
  pauses when spent and **never charges** (~$0.0018/message on `haiku`).
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
- **Voice** — push-to-talk speech input (local **Whisper**) and spoken replies (**espeak-ng**, or
  **Piper** neural voice if installed). Fully offline, no keys, no cost.
- **Memory** — the agent calls `memory_save` / `memory_recall` to remember facts and preferences
  **across sessions** (SQLite-backed); the most important memories are auto-injected each turn.
- **Chat history** — every conversation is saved; reopen past chats from the sidebar (**Ctrl+N**
  for a new one).
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
> sonnet|opus|haiku` picks the Claude model. `openrouter` is **not** a chat brain.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Launch in dev (Vite HMR + Electron). |
| `npm run build` | Build to `out/`, then **auto-commit + push** the current branch (see below). |
| `npm run rebuild` | Rebuild `better-sqlite3` against Electron's ABI (also on `postinstall`). |
| `npx electron scripts/smoke-db.cjs` | Integration test for persistence + memory (temp DB, no LLM, no cost). |
| `node scripts/smoke-claude-agent.mjs` | Headless check that the Claude brain streams. |
| `node scripts/smoke-claude-agent-tools.mjs` | Exercise the agent's tools (honours `GHOST_TEST_PERMISSION`). |
| `GHOST_BROWSER_BACKEND=playwright GHOST_BROWSER_HEADLESS=true node scripts/smoke-claude-agent-browser.mjs` | Drive the Playwright browser through the agent (spends Pro allotment). |
| `GHOST_BROWSER_BACKEND=playwright GHOST_BROWSER_HEADLESS=true GHOST_BROWSER_CHANNEL=chromium GHOST_BROWSER_PROFILE=isolated node scripts/smoke-browser-click.mjs` | browser_click edge cases (hidden duplicates, iframes, selectors) — no LLM. |
| `node scripts/smoke-browser-control.mjs` | Browser control layer end to end (refs, annotated screenshots, popups, dialogs, downloads) — no LLM. Prefix with `GHOST_BROWSER_HEADLESS=true GHOST_BROWSER_CHANNEL= GHOST_BROWSER_PROFILE=/tmp/ghost-pw GHOST_BROWSER_BACKEND=playwright`. |
| `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-brain-router.mjs` | Which brain each kind of message routes to (no LLM). |
| `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-gemini-agent.mjs` | Gemini brain + Jarvis tools end to end (free tier). |
| `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-gemini-browser-vision.mjs` | Proves the Gemini brain can see browser screenshots (free tier, same env prefix as above). |

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
│   ├── index.js             # app lifecycle, BrowserWindow, Crostini GPU/Wayland flags
│   ├── ipc.js               # chat:* / db:* / voice:* handlers (+ streaming events)
│   ├── agent/provider.js    # per-turn brain router: gemini (tools/index.js) | claude (Agent SDK)
│   │                        #   + in-process MCP servers (shell, browser, memory, files, reminders…)
│   ├── tools/               # browser.js (Playwright, persistent+visible), terminal.js
│   ├── voice/index.js       # arecord -> Whisper, and Piper/espeak-ng -> aplay
│   └── memory/db.js         # better-sqlite3: sessions, messages, memories
├── preload/index.js         # contextBridge -> window.ghost (typed IPC only)
└── renderer/                # React UI
    ├── screens/             # Intro.jsx (video), Main.jsx (3-column Mission Control: sidebar · chat · activity)
    └── components/          # chat/ (ChatInput, MessageList, Message, Markdown), tools/, SessionSidebar, ActivityPanel
scripts/voice-transcribe.mjs # Whisper STT (Transformers.js), spawned per utterance
migrations/                  # 001_init.sql (sessions/memories/preferences), 002_messages.sql
```

The agent loop runs in **main**; the renderer is pure UI. Streamed tokens and tool events flow
main → renderer over IPC (`chat:delta` / `chat:tool` / `chat:done` / `chat:error`).

## Crostini notes & gotchas

- **GPU:** hardware acceleration is **on by default** (`GHOST_GPU=on`, needed for the three.js
  core). If the window black-screens or the GPU process crash-loops on launch (`exit_code=8704` —
  Wayland's GBM stack can't allocate scanout buffers), set `GHOST_GPU=off` in `.env` to fall back to
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
