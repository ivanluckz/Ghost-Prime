# Ghost-Prime: showcase facts (the source of truth)

**Every slide, poster, script and demo plan must follow this file.** If this file does not mark
something as **WORKING**, present it as "in progress" or "next", or leave it out. If you think a
claim is missing, test it first and then add it here with the evidence. Do not stretch a claim to
fill a gap.

- Event: Rwanda Innovation Showcase, **29 September 2026** (school event).
- Presenter: **[YOUR NAME]**, **[YOUR CLASS]**, **[SCHOOL]**. Use these placeholders exactly. Never
  invent a name, class or school.
- Pitch angle: accessibility & education. "A free-to-run voice assistant that lets anyone use a
  computer and phone just by talking; built on a school Chromebook and a cheap Android phone."
  **Read §4 before you say "free".**
- Facts checked on **25 Sep 2026** against commit `51d8839` (branch `ghost-prime`). Every test
  quoted below was run on that day unless the row says otherwise.

---

## 1. What it is (plain English)

Ghost-Prime is an AI assistant that lives on a school Chromebook. You can talk to it or type to it,
and it does the task instead of only telling you how. It can open websites, read them and click and
type on them. It can run commands, find, create, move and tidy files, look things up, remember
things about you from one day to the next, set reminders, and read its answers aloud. Its "thinking"
comes from two AI models. **Claude**, by Anthropic, runs on the student's existing Claude
subscription, so there is no pay-per-use bill. **Google Gemini** runs on Google's free tier and
handles speech and quick questions. The student also built an Android companion app so Ghost-Prime
can see and tap a phone screen. That part is built but **not yet tested on a real phone**. It runs
entirely on low-cost school hardware, with no gaming PC and no paid cloud servers.

---

## 2. Capabilities and honest status

Status key:
- **WORKING**: tested. The row names the test or how it was checked.
- **WORKING (manual)**: used in the real app during development according to the commit history,
  but no automated test covers it and it was not re-checked on 25 Sep. **Try it live before the
  showcase** and move it to WORKING if it works.
- **BUILT, NOT TESTED ON REAL DEVICE**: the code exists and passes tests against a simulator or a
  headless browser, but has never worked end to end on the real hardware.
- **PLANNED**: not built yet.

| Capability | What the user says / does | How it works (one line) | STATUS |
|---|---|---|---|
| Chat with an AI that streams its answer | Types a question, gets a reply word by word | Electron app streams tokens from the chosen brain to the React UI | **WORKING**. Claude brain streaming check `smoke-claude-agent.mjs` passed 25 Sep ("GHOST ONLINE"). Gemini brain `smoke-gemini-agent.mjs` passed 25 Sep (first attempt hit a transient Google API error, second attempt passed). |
| Two brains, picked automatically per message | Nothing. It just answers. Can force one with `/brain claude\|gemini\|auto` | Zero-cost keyword router: images and simple chat go to Gemini; hard, long or computer-control tasks go to Claude; falls back to the other brain if one is unavailable | **WORKING**. `smoke-brain-router.mjs` passed **35/35** checks on 25 Sep. ⚠ The live `.env` is currently pinned to `GHOST_BRAIN_MODE=claude`, so every chat turn goes to Claude. Switch back to `auto` if the demo should show routing. |
| Voice input (speech to text) | Clicks the mic button, speaks, clicks again | `arecord` records a WAV; Gemini (free tier) transcribes it. With no key or on error it falls back to offline Whisper (`whisper-tiny.en`, cached locally) | **WORKING (manual)**. Voice built and fixed in commits `98098d6`, `e505cf7`; mic hardware present (`arecord -l` shows the VirtIO capture device); the offline Whisper model is cached. No automated voice test. |
| Voice output (reads answers aloud) | Turns voice on (`/voice on`) | Gemini text-to-speech (free tier) through `aplay`; offline fallback uses `espeak-ng` (installed). Piper is **not** installed | **WORKING (manual)**. Same evidence as voice input. "Instant spoken acknowledgements" (`98098d6`). Overnight 25 Sep: `smoke-voice.mjs` **16/16** (fake audio devices + mocked Gemini) covers the logic after fixes: if Gemini's voice fails part-way or returns no audio, the offline voice reads the rest (it used to go silent); links are read as words; lists item by item; nothing is spoken while the mic records, and recording stops Ghost talking; "[BLANK_AUDIO]"-style noise is no longer sent as a message. Real audio is still manual only. |
| Hands-free wake word ("hey ghost") | Says "hey ghost, …" | `daemon/wake.py` (offline Vosk) posts to the app | **BUILT, NOT INSTALLED**. Code is in `daemon/` from June, but the service is not installed on this Chromebook (no `daemon/.venv`, no model, `systemctl` reports inactive). **Do not claim it.** The app's own trigger is the mic button plus the global hotkey **Ctrl+Shift+G**. |
| Drive a web browser (the app's own Playwright Chromium) | "Go to Wikipedia and find…", "click Log In", "fill in the form" | Numbers every button/link/field on the page (`[12] "Log In"`), clicks by number, annotated screenshots, follows popups, answers dialogs, saves downloads | **WORKING**. On 25 Sep: `smoke-browser-control.mjs` **38/38**, `smoke-browser-click.mjs` **11/11**, `smoke-browser-backend.mjs` **18/18** (headless Chromium, local test pages, no AI). Overnight 25 Sep: if the Linux Google Chrome it normally drives is missing, it now falls back to Playwright's bundled Chromium (`smoke-browser-fallback.mjs` **2/2**). Also fixed overnight (`smoke-browser-refs.mjs` **11/11**): an element keeps its number between `browser_get_page` and an annotated screenshot (before, a number from one could hit a different element in the other); "fill" on a link or button now refuses instead of clicking it; on a slow site, Enter submits a form **once** (it used to press Enter again after 4 s) and a slow link is no longer reported as "not found". A tab that crashes ("Aw, Snap!", often low memory) is now replaced by a fresh one on the next action instead of breaking every later browser step (`smoke-browser-crash.mjs` **4/4**). Opening a file link (CSV, PDF) is now reported as "Download saved to …" instead of a raw error, and browser errors reach the model without terminal colour codes (`smoke-browser-download.mjs` **4/4**). The AI driving it was last run in `smoke-claude-agent-browser.mjs` (commit `56b4f24`, 20 Sep), not re-run 25 Sep. |
| Control the student's own signed-in Chrome (Chrome extension) | Same requests, but in their real Chrome tabs | Unpacked MV3 extension long-polls the local bridge and runs commands in the active tab | **BUILT, NOT TESTED ON REAL DEVICE**. `smoke-extension-e2e.mjs` **30/30** on 25 Sep, but that loads the extension into a throwaway **headless** Chromium, not the student's Chrome. It has not been verified end to end in the real signed-in Chrome, and project notes say **the school has disabled developer-mode extensions** on this Chromebook. ⚠ The live `.env` has `GHOST_BROWSER_BACKEND=extension`. For the demo, use `playwright` unless the extension is confirmed first. |
| Chrome side panel that mirrors the chat | Opens the extension's side panel | Extension panel polls the bridge `/chat` endpoint | **BUILT, NOT TESTED ON REAL DEVICE**. Same limits as the extension row. |
| Control an Android phone (Galaxy A05) | "Open WhatsApp on my phone", "tap Send", "scroll down" | Android connector app (Accessibility service + screen capture) long-polls the bridge over Wi-Fi; `phone_*` tools see the screen as a numbered UI list and tap, swipe, type or open apps | **BUILT, NOT TESTED ON REAL DEVICE**. `smoke-phone-tools.mjs` **13/13** and `bridge-smoke.mjs` **6/6** on 25 Sep, both against a **simulated** phone (`scripts/fake-phone.mjs`). The debug APK builds (`app-debug.apk`, 7.3 MB, built 25 Sep, v1.1). Never run on a real phone. ⚠ **That APK can't connect:** it lacks `usesCleartextTraffic`, so Android 9+ refuses its plain-HTTP polls. Fixed in the source overnight 25 Sep (plus small fixes, see `android-connector/README.md`) but not compiled there: **rebuild the APK before trying the phone.** |
| Pair the phone by QR code | "Pair my phone", then scans the QR with the phone camera | App shows a QR code `ghostprime://pair?host&port&token`; the connector app configures itself | **BUILT, NOT TESTED ON REAL DEVICE** (commit `074420c`). |
| Run terminal commands in a live terminal you can watch | "Install this", "run the tests", "what's in this folder" | Persistent `node-pty` terminals shown in a dock; the agent's shell tool types into them | **WORKING**. `smoke-terminal.mjs` **24/24** (added overnight 25 Sep: real node-pty + bash; output, exit codes, cd/vars persist, `df -h`, timeouts, background runs, read/kill, plus 10 regressions fixed that night — see below). `smoke-shell-rc.mjs` **10/10** covers the terminal's startup-file safety. The live-terminal UI (`0b5bea9`) is manual only. Fixed overnight: Claude's shell_run opened a **new terminal for every command** (so `cd` never stuck); an unclosed quote hung it for 120 s; multi-line commands lost all but the first line; git/man could hang in a pager; `~` as a folder gave a dead terminal. |
| Files: read, write, create, move, delete, **with undo** | "Move my screenshots into a folder", "undo that" | Reversible file tools keep an undo stack (`file-undo.js`) | **WORKING**. `smoke-file-undo.mjs` **29/29** (added overnight 25 Sep: Demo 2's create-in-a-new-folder → undo, delete → undo, move → undo, overwrite → undo, undo order, refusals; plus fixes that night: undo no longer deletes a file that was edited after it was created, and "move into ~/NewFolder/" works). |
| Web search and page fetch | "Look up…", "what does this page say" | Claude: built-in WebSearch/WebFetch. Gemini: DuckDuckGo HTML search + fetch | **WORKING** for fetch (ad-hoc check fetched example.com on 25 Sep). Search: **WORKING (manual)**; the live DuckDuckGo page was not re-checked 25 Sep. Fixed overnight 25 Sep (`smoke-web-search.mjs` **9/9**, a saved-style DuckDuckGo page): each snippet now stays with its own link (one result without a snippet used to shift all the later ones), links with %25 aren't decoded twice, and fetching a page that needs JavaScript says so instead of returning nothing. |
| Remembers you across sessions | "Remember I'm in [YOUR CLASS]", "what do you know about me?" | SQLite memory with tags and expiry; the top 8 memories are added to every prompt; chats are auto-summarised into memories when you leave them | **WORKING**. `smoke-db.cjs` and `smoke-summary.cjs` pass and `smoke-persistence.cjs` **28/28**, re-run overnight 25 Sep under real Electron (Xvfb, with better-sqlite3's official Electron prebuilt; `scripts/electron-db-smokes.sh`). First passed 20 Sep (`56b4f24`). Fixed overnight: deleting a chat that had saved a memory, or "Delete all chats" with any memory present, failed with a database foreign-key error (the booth privacy sweep would have failed). |
| Chat history | Reopen past chats from the sidebar; Ctrl+N for a new one | Messages saved in SQLite | **WORKING**. Same DB tests as the memory row (re-run 25 Sep). |
| Reminders | "Remind me at 5 to revise chemistry" | DB-backed scheduler that survives restart; desktop notification and spoken alert | **WORKING**. `smoke-persistence.cjs` 28/28 re-run 25 Sep (fires exactly once, survives the schema upgrade, Discord-origin stamping). Fixed overnight 25 Sep (`smoke-reminders` 5/5): if the database fails to open, "remind me" now says it can't save instead of claiming success; a Discord reminder already due at startup now reaches Discord. |
| Morning briefing and idle check-ins | Nothing. It greets you once a day | `proactive.js` uses the cheap Gemini model | **WORKING** for the bookkeeping: `smoke-proactive.mjs` **12/12** on 25 Sep. The spoken/visible briefing itself is manual only. |
| Understands pictures | Drags an image into the chat | Gemini reads images directly; Claude opens them from a temp file | **WORKING** for Gemini (live-API check in `a2c3ec0`, 19 Sep: read a word drawn only as pixels). Claude image path (`5543493`) manual only. Not re-run 25 Sep. |
| Quick PC controls (volume, brightness, battery, weather, play YouTube) | "What's my battery?", "turn the volume down", "weather in Kigali" | "Jarvis" one-shot tools (adapted from the third-party MARK LIII project; see §7) | **WORKING** for battery: on 25 Sep Gemini called `system_power` and reported the real battery level. Weather: `smoke-weather.mjs` **10/10** against a mocked wttr.in (added overnight 25 Sep; fixed "undefined°C" for unknown places and a raw parser error); the live service was not re-checked. The others are manual only. Volume/brightness depend on what ChromeOS lets the Linux container change. Fixed overnight 25 Sep (`smoke-jarvis-fixes.mjs` **10/10**, fake `pactl`/`xdg-open`): volume up/down never goes past 100% (it could reach 150%), and YouTube search works for titles with an apostrophe ("Don't Stop Me Now" was refused). |
| Clipboard and desktop notifications | "Copy this", "notify me when done" | Electron clipboard and Notification | **WORKING (manual)**. No test. |
| Message it from Discord (remote control from a phone) | DMs the bot; `!mode`, `!brain`, `!stop`, `!status` | discord.js bot inside the app (online only while the app runs), locked to an allow-list of user IDs | **WORKING (manual)**. Commits `19e1089`, `e2c96d7`, `09c8480`. `smoke-run-slot.mjs` **33/33** on 25 Sep proves Discord and desktop runs queue safely without clashing. The bot itself has no automated test. |
| Autonomy modes (Shift+Tab) | Cycles PLAN → AUTO → FULL AUTO | PLAN blocks state-changing tools on both brains; AUTO/FULL differ per brain (see §5) | **WORKING (manual) + automated test 25 Sep** (`smoke-plan-mode`, 29 checks, SDK stubbed). ⚠ The Claude-brain PLAN gate was **fixed overnight 25 Sep** (§5): re-run Demo 7 live the day before. |
| Presenter (big-text) mode for a projector | Starts with `bin/ghost-showcase`, or type `/showcase` | Bar, conversation and composer scaled ~1.45× (more on wide screens), simpler bar, chat history hidden, starts in AUTO; the mic shows a big "Listening…" / "Turning your speech into text…" pill and a plain-English note when voice fails | **BUILT, NOT TRIED ON THE CHROMEBOOK** (added overnight 25 Sep). Checked in the design preview at 1366×768, 1280×800 and half-screen 683×768, and in the built Electron app under Xvfb (flag reaches the UI, badge says AUTO). Try it on the real projector before the 29th. |
| Scheduled tasks and "Ask Ghost" from outside the app | `node scripts/run-task.mjs "…"` from cron | POST to the bridge's `/task` endpoint | **WORKING**. `smoke-bridge.mjs` **6/6** on 25 Sep covers `/task` and token enforcement. |
| Canva design tools | "Make a poster in Canva" | Canva's MCP server wired into the Claude brain | **BUILT, NOT VERIFIED** (`0d1b3c6`). Needs Canva sign-in. **Do not claim.** |
| Control any desktop app (mouse/keyboard outside the browser) | n/a | n/a | **NOT POSSIBLE on ChromeOS** (no screen-capture protocol; `/dev/uinput` is root-only). An experimental `screen_*` toolset exists but is **off by default**. **Do not claim.** |
| Discord image messages → vision | n/a | n/a | **PLANNED**. |
| Smarter "meaning-based" memory search (embeddings) | n/a | n/a | **PLANNED** (README roadmap). Memory search today is keyword-based. |
| Confirmation pop-up before irreversible actions | n/a | n/a | **PLANNED** (listed as deferred in project notes). **Today nothing asks a human "are you sure?"** (see §5). |
| Installable package (.deb) for other schools | n/a | n/a | **PLANNED** (README roadmap). Today it is installed from source on this Chromebook and shows up in the ChromeOS launcher. |

---

## 3. Architecture (how the parts talk)

1. **Ghost-Prime app** is an Electron desktop app (Node main process + React UI) running inside the
   Chromebook's Linux container (Crostini). The UI only displays things. All agent work happens in
   the main process, and events reach the UI over IPC (`chat:delta` / `chat:tool` / `chat:done`).
2. **Brain router** (`src/main/agent/provider.js`) picks a brain for each message and runs one task
   at a time in a first-in, first-out queue shared by the desktop and Discord.
3. **Claude brain**: the Claude Agent SDK on the student's Claude Code login (no API key). Tools are
   provided by 8 in-process MCP servers plus 7 SDK built-ins.
4. **Gemini brain**: Google's OpenAI-compatible endpoint (free AI Studio key) with a function-calling
   loop over `src/main/tools` (up to 30 tool round-trips per message).
5. **Tools** (`src/main/tools/`) cover the Playwright browser, live terminals, reversible files, web,
   reminders, Jarvis one-shots, phone and site policy. SQLite (`better-sqlite3`) stores chats,
   memories and reminders.
6. **Voice** (`src/main/voice/`): mic → `arecord` → Gemini speech-to-text (or offline Whisper);
   reply → Gemini text-to-speech (or espeak-ng) → `aplay`.
7. **Local bridge** (`browser-bridge.js`) is a small HTTP server on port 8731, gated by a token.
   Devices long-poll `/poll` for commands and post answers to `/result`. Several named devices can
   connect at once (`kind = browser | phone`).
8. **Chrome extension** (`extension/`) is one bridge device. It drives tabs in the user's own Chrome.
9. **Android connector app** (`android-connector/`, Kotlin) is another bridge device. It reaches the
   bridge over Wi-Fi and uses the Accessibility service plus MediaProjection screenshots.
10. **Discord bot** (`src/main/discord/`) is a second way in. It feeds messages into the same router
    and queue.

---

## 4. Costs and requirements (honest version)

| Item | Cost | Notes |
|---|---|---|
| Claude (main brain for hard and computer-control tasks) | **Paid subscription the student already has** (Claude Pro) | Uses the subscription's Agent SDK allowance. No API key and no per-message bill. With usage credits turned off it **pauses when the allowance runs out; it never charges extra**. |
| Google Gemini (speech, quick chat, images, background summaries) | **Free tier** (AI Studio key) | Rate-limited. The model in `.env` has a small daily quota, and "429 too many requests" errors have happened during testing. A transient API error happened on 25 Sep too. |
| Everything else (Electron, Playwright/Chromium, SQLite, Whisper, espeak-ng, Discord bot, Android app) | **Free / open source**, runs locally | Web search via DuckDuckGo, weather via wttr.in: both free, no key. |
| Hardware | **School Chromebook** + a **low-cost Android phone (Galaxy A05)** | The measured Chromebook is a 12th-gen Intel Core i3-1215U; the Linux container sees 6 CPUs and ~6.3 GB RAM (`nproc`, `free -m`, 25 Sep). The phone is not used in any verified feature yet. |
| Setup needed | ChromeOS Linux turned on; "Allow Linux to use the microphone" on; `claude` CLI logged in; Gemini key in `.env` | Chrome extension needs developer mode (**blocked by the school on this device**). The phone needs the APK sideloaded plus Accessibility and screen-capture permission. |

**What "free to run" means, truthfully:**
- Running it adds **no new cost** for the student: no API bill and no servers. But the Claude brain
  needs a Claude subscription, and that subscription is not free.
- The app **can** run with **no subscription at all** in Gemini-only mode (`GHOST_BRAIN_MODE=gemini`,
  `GHOST_CONTROL_BRAIN=gemini`). The Gemini brain has all 59 tools. It is less capable at long
  multi-step tasks, and Gemini-only mode was **not** separately tested end to end for the showcase.
- Safe phrasing: **"No pay-per-use bills: it runs on free Google AI plus a Claude subscription I
  already had, and it can run on the free tier alone."**

---

## 5. Safety and privacy facts

**Autonomy modes (Shift+Tab in the app, `!mode` on Discord):**
- **PLAN** is read-only. Both brains use one read-only list (`src/main/agent/plan-gate.js`): reading
  pages, files, memory, weather, battery, volume level. Anything else is skipped with a notice.
  **Fixed overnight 25 Sep:** before, the Claude brain only had the SDK's `plan` mode, which blocks its
  built-in Write/Edit but still ran every always-allowed Ghost tool (file_delete, shell_run, …), so
  PLAN relied on the model choosing not to act. Now, in PLAN mode, those tools are removed, the rest
  are checked per call, and the prompt says PLAN is on. Tested offline with the SDK stubbed
  (`smoke-plan-mode`, 29 checks). **Not yet run against live Claude:** do Demo 7 once the day before.
  Reading the battery in PLAN mode now works on the Gemini brain too (it was wrongly skipped).
- **AUTO**: on the Claude brain, the SDK's automatic permission classifier decides for each action.
  On the Gemini brain, AUTO runs tools **without asking**, exactly like FULL.
- **FULL AUTO** runs everything with no checks.
- ⚠ **The desktop app starts in FULL AUTO by default** (`Main.jsx`). Discord defaults to AUTO.
  **Exception (added 25 Sep, overnight):** launched with `bin/ghost-showcase` (`GHOST_SHOWCASE=1`) it
  starts in **AUTO**, in big-text presenter mode with the chat history hidden. Checked by launching
  the built app under Xvfb with and without `GHOST_SHOWCASE=1` and reading the badge: AUTO vs FULL
  AUTO. Not yet tried on the Chromebook itself.
- ⚠ **No mode shows a human "are you sure?" prompt.** A real confirmation gate for irreversible
  actions is PLANNED. Never say "it always asks before doing anything".
- Browser pop-up dialogs (`confirm()`/`prompt()`) are **auto-accepted** by default
  (`GHOST_BROWSER_DIALOGS=accept`) and always reported back in the result.

**Other safeguards:**
- **Site allow/block list** (Settings → Site access or `/site`). "open" mode allows every site except
  blocked ones; "strict" mode allows only allow-listed sites. It is enforced in the app for every
  browser action and inside the extension. `smoke-site-policy.mjs` **18/18** (added overnight 25 Sep):
  the DEMO.md setup (strict + wikipedia.org + example.com) allows Wikipedia subdomains, refuses
  google.com and look-alike hosts, and browser_navigate refuses before any page opens. **Also fixed
  overnight 25 Sep** (`smoke-site-gaps.mjs` **12/12**): four ways around it are closed. A trailing dot
  ("facebook.com.") no longer slips past the block list. Gemini's web_fetch and the Claude brain's
  built-in WebFetch now obey the list (they ignored it). browser_read_pages no longer returns a
  forbidden page that a redirect led to. ⚠ The Chromebook's
  real policy is currently **open, with nothing blocked**.
- **Local bridge is token-gated**: constant-time token comparison, and web-page origins are
  refused. It listens only on `127.0.0.1` unless a **private** token is set. With the default token
  it refuses to open to the network. `smoke-bridge.mjs` checks token enforcement (25 Sep).
- **Discord** obeys only user IDs on `DISCORD_ALLOWED_USER_IDS`. With no allow-list it refuses
  everyone.
- **Reversible file tools and undo** for moves, deletes, creates and rewrites.
- **Phone**: Android's own permission prompts (Accessibility, screen capture). Turning off the
  Accessibility toggle revokes control instantly. It connects only over the local Wi-Fi to the
  Chromebook, with the token.
- **The Claude brain is isolated.** It does not load any other Claude Code settings, plugins or
  instruction files (`settingSources: []`, `strictMcpConfig: true`).
- The app window never navigates away and opens links externally. Chat links are limited to
  http(s)/mailto.

**What data leaves the Chromebook:**
- **To Anthropic (Claude)**, on Claude turns: the conversation, the top 8 saved memories, any
  browser or phone screenshots and page text the agent reads, and the current tab's text (up to 4,000
  characters) when "act on the tab I'm on" is on and the message refers to the page.
- **To Google (Gemini)**, on Gemini turns: the same kinds of content. Also **every voice
  recording** (for transcription), **every spoken reply's text** (for speech), and the background
  chat summaries. Unless you switch voice to the offline `local` mode, the audio goes to Google.
  On Google's **free** tier, Google's terms allow it to use submitted content to improve its
  products. **Don't say private things to it.**
- **To Discord**, only if you use the Discord relay: those messages and replies.
- **To DuckDuckGo / wttr.in / YouTube / any website the agent visits**: normal web requests.
- **Stays on the device**: the chat database, memories, reminders, files, terminal sessions, and
  the bridge (local network only).
- Security housekeeping (not for the slides): secrets were once committed to the private GitHub
  repo and were removed in `e505cf7`. **Rotating those keys is still an open task.** Never show
  `.env` on screen.

---

## 6. True, impressive numbers (with how each was measured)

| Number | Value | How measured (25 Sep 2026) |
|---|---|---|
| Tools the Claude brain can use | **64** | 7 SDK built-ins (`Read Write Edit Glob Grep WebFetch WebSearch`) + 57 Ghost-Prime tools in 8 in-process MCP servers: browser 23, phone 8, Jarvis 7, files+undo 6, shell 5, reminders 3, system 3, memory 2. Counted from the tool-name lists and `allowedTools` in `src/main/agent/provider.js`. Excludes Canva (external) and 5 experimental screen tools (off by default). |
| Tools the Gemini brain can use | **59** | `getToolSpecs().length` from `src/main/tools/index.js`, run under the Electron stub. |
| Automated test scripts | **23** | `git ls-files scripts \| grep smoke` (2,046 lines of test code). |
| Checks passed on 25 Sep, 0 failures | **244** checks in **13** offline test scripts | brain-router 35, browser-control 38, run-slot 33, extension-e2e 30, env-bool 19, browser-backend 18, phone-tools 13, attachment-cap 13, proactive 12, browser-click 11, shell-rc 10, bridge 6, bridge-smoke 6. Plus 2 live AI checks (Claude streaming, Gemini tool call), both passed. |
| Lines of code written for Ghost-Prime | **~22,000** (21,986) | `git ls-files src extension android-connector \| grep -E '\.(js\|jsx\|mjs\|cjs\|css\|html\|kt\|kts\|gradle\|xml)$' \| xargs wc -l`: app main process 9,233 · UI 8,962 · preload 208 · Chrome extension 2,572 · Android app 1,011. Excludes tests, docs and the third-party `jarvis/` folder. (The raw `git ls-files … \| xargs wc -l` gives 23,025, but that includes a binary .jar/.png and JSON/Markdown. Don't quote it.) The UI files have uncommitted design edits, so the exact number moves a little. |
| Commits | **58** | `git rev-list --count HEAD`. First commit 17 Jun 2026, latest 25 Sep 2026 (~3 months). |
| Bugs fixed in one audit | **127** | Commit `e505cf7` (20 Sep 2026), "127 verified fixes". |
| Parts that talk to each other | **4 device types** | Chromebook app, Chrome extension, Android app, Discord bot. Only the app and Discord are verified on real devices (§2). |

---

## 7. Credits and authorship (be upfront; judges may ask)

- **All 58 commits carry a `Co-Authored-By: Claude` trailer.** The code was written with **Claude
  Code**, an AI coding assistant, directed by the student. Say so plainly, for example: "I designed
  it, decided what it should do, tested it, and used an AI coding assistant to write much of the
  code." Adjust this to what [YOUR NAME] actually did. Do not overstate or understate it.
- **`jarvis/` is third-party code**: "MARK LIII (53) — JARVIS" by FatihMakes, licensed
  **CC BY-NC 4.0** (non-commercial, attribution required). Credit it on any slide that mentions the
  volume, brightness, battery, weather or YouTube tools. It is not counted in the line numbers.
- The **cinematic intro video** was AI-generated with Higgsfield. The 3D "Ghost-Prime Core" gem is
  built from the `ai-core/` design reference with three.js. Fonts: Inter and JetBrains Mono (open
  licences).
- Built on open-source software: Electron, React, Playwright, node-pty/xterm, better-sqlite3,
  Transformers.js (Whisper), discord.js, three.js, plus the Claude Agent SDK and Google Gemini.

---

## 8. Known gaps and risks for the live demo (for the demo/ and script/ writers)

1. **Phone and Chrome extension are unverified on real devices.** Show them only as "next"
   (simulator video or screenshots, clearly labelled "simulated"), or test them on the real A05 and
   Chrome first and update this file.
2. `.env` currently says `GHOST_BROWSER_BACKEND=extension`, and the school blocks developer-mode
   extensions. **Set `playwright` for the demo.** It is the tested path.
3. `.env` currently says `GHOST_BRAIN_MODE=claude`. Set it to `auto` to demo routing. Keep it on
   `claude` for maximum reliability on computer tasks.
4. **Gemini free-tier quota and rate limits** can fail mid-demo, and voice depends on Gemini by
   default. Have `GHOST_VOICE_PROVIDER=local` (offline Whisper + espeak-ng) ready as a backup, and
   rehearse on the venue Wi-Fi or a hotspot. Everything except local voice needs internet.
5. Plain Ghost-Prime starts in **FULL AUTO**; `bin/ghost-showcase` starts in **AUTO** (§5). Check
   the badge says AUTO (or PLAN) before a public demo, and set the site policy to strict with a
   short allow-list.
6. **Fixed overnight 25 Sep:** the Claude system prompt used to say "You do NOT have the Jarvis
   one-shot tools on this brain" although `system_power`, `weather_get` and the rest were registered
   for Claude since `5543493`. The prompt now lists them, and `smoke-claude-prompt.mjs` (12/12) checks
   that every one of Claude's 64 allowed tools is described in its prompt. Still ask Claude "What's my
   battery level?" once before the showcase: no live Claude call was possible overnight.
7. **Fixed overnight 25 Sep:** the README used to describe AUTO as "each action approved". It now
   uses the §5 wording (classifier on Claude, no checks on Gemini, no "are you sure?" yet).
8. **Fixed overnight 25 Sep:** with no internet (or Claude down), a question used to sit on
   "working…" for about 3 minutes while Claude retried in silence, and every other message waited
   behind it. Now each retry shows a line ("Can't reach Claude over the internet. Retrying…"), and if
   Claude hasn't started yet it gives up after 2 network retries (3 for server errors): Gemini
   answers instead, or the app says to check the Wi-Fi. A task that already ran a tool keeps waiting
   (running it again could repeat its effect). Tested offline with the SDK stubbed
   (`smoke-claude-retry`, 12 checks); not tried with the real network unplugged.
9. **Fixed overnight 25 Sep (Gemini brain, `smoke-gemini-loop` 7 checks, offline):** every Gemini
   error used to read "400 status code (no body)" (Google sends errors in a shape the SDK didn't
   read), so a wrong or rotated key was impossible to diagnose on the day. The real reason now shows,
   and a rejected key gets a plain sentence. And when Gemini gave an empty final answer after using a
   tool, the reply used to stop at its preamble ("Checking your battery now."); it now asks once more
   for the answer, and says so if there still isn't one.
