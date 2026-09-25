# Overnight handoff — Ghost-Prime (branch `ghost-prime`)

You are working unattended overnight in a cloud session with this GitHub repo. The student
presents Ghost-Prime at the **Rwanda Innovation Showcase on 29 September 2026**. Everything you do
should make the app and the showcase kit better and more reliable for that day. Work in small,
verified commits on `ghost-prime` and push as you go.

## What Ghost-Prime is
An Electron desktop AI assistant that runs on a school Chromebook (Crostini Linux). You talk or type;
it drives the browser, a terminal, files, reminders, memory and (in progress) an Android phone.
Brain: Claude via the Claude Agent SDK (`GHOST_BRAIN_MODE=claude`); Gemini's free tier handles speech.
Main code: `src/main/` (agent/provider.js = brains, router and tool servers; tools/*.js = tools;
browser-bridge.js = local bridge to the Chrome extension and the phone app), `src/renderer/` (React UI),
`extension/` (Chrome extension), `android-connector/` (Kotlin phone app).
**Read `showcase/FACTS.md` first**: it is the verified list of what works and what doesn't.

## What you CANNOT do in the cloud (don't try)
- No `.env` (secrets are gitignored) → no real Claude/Gemini calls, no Discord, no bridge token.
- No Chromebook, no Chrome extension, no Android phone, no Electron window with real brains.
- Never commit secrets. Never run `npm run build` (its postbuild hook auto-commits and pushes). Use
  `npx electron-vite build` to check the build.
- Don't rewrite git history or force-push.

## How to verify your work (all runs without secrets)
- Build: `npx electron-vite build`
- **Design preview** (renderer in a plain browser with a mock backend and demo data):
  `npm run design` → http://127.0.0.1:5199/?skipIntro=1. Screenshot every UI state:
  `node scripts/design-capture.mjs <outdir> <prefix>`. Any `PAGEERROR` line = the React tree crashed.
  Offline showcase replay: `…/?skipIntro=1&replay=1` (scripted demos in src/renderer/dev/showcase-scenarios.js).
- Smoke tests (no LLM). Browser ones need
  `GHOST_BROWSER_HEADLESS=1 GHOST_BROWSER_CHANNEL= GHOST_BROWSER_PROFILE=/tmp/gp GHOST_BROWSER_BACKEND=playwright`:
  `node scripts/smoke-browser-control.mjs` (38), `node scripts/smoke-browser-click.mjs` (11),
  `node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-brain-router.mjs` (35),
  `… scripts/smoke-phone-tools.mjs` (13), `… scripts/smoke-extension-e2e.mjs` (30),
  `… scripts/smoke-env-bool.mjs`, `… scripts/smoke-proactive.mjs`, `node scripts/smoke-bridge.mjs`,
  `node scripts/bridge-smoke.mjs`. Electron-only: `npx electron scripts/smoke-db.cjs`,
  `smoke-persistence.cjs`. (Playwright Chromium may need `npx playwright install chromium`.)
- Android: `cd android-connector && gradle assembleDebug` if an Android SDK is available; otherwise
  just keep Kotlin changes minimal and obviously correct.
- Keep every suite green. If a test was already failing before you touched anything, note it; don't hide it.

## Tasks, in priority order

### 1. Finish the design pass (visual only, no behaviour changes)
Four design agents were interrupted mid-work. Their edits are in `src/renderer/styles/{shell,chat,tools,activity}.css`
and the matching components. `styles/panels.css` (Settings popover + terminal dock) was never
started. The rules:
- Keep the dark holographic identity (cyan/violet/magenta, glass) but calmer. One accent per element,
  readable contrast, 4px spacing grid, tokens from `:root` in `src/renderer/styles.css`.
- Refine from the per-area sheets; don't bloat `styles.css`.
- Performance: no backdrop-filter/blur on anything that re-renders while streaming (bubbles, tool
  cards), animate only transform/opacity, and respect prefers-reduced-motion.
- Markdown must render GitHub tables and `>` blockquotes and scroll code blocks horizontally. Keep
  the link sanitising: only http(s)/mailto become links.
Then capture all states before and after, review every screenshot yourself as a demanding designer
(cohesion across panels, alignment, no clipped text, the 900px "narrow" state), and fix what's weak.

### 2. Presenter ("showcase") mode
`bin/ghost-showcase` exports `GHOST_SHOWCASE=1`, but nothing uses it yet. Add a big-text presenter mode:
- Larger type and chat width, simplified top bar, readable from 2–3 m on a projector.
- Toggle with `/showcase` and on by default when `GHOST_SHOWCASE=1`. The flag has to reach the
  renderer; follow the existing `--ghost-native-frame` additionalArguments pattern in src/main/index.js.
- Verify in the design preview.

### 3. Finish the showcase kit (`showcase/`)
Judges scored it 7/10. The poster and demo revisions are done; the **slides** and **script** fixes are
not. Apply these (must-fix first):
- slides: slide 6 footnote wrongly says everything not marked BY HAND passed automated tests. Match FACTS.md.
- slides/poster: the screenshots show the red FULL AUTO badge and off-message demo content (flights
  to Lisbon). Re-capture from the design preview with an education/accessibility demo and a safer mode.
  Consider adding a demo session to `src/renderer/dev/mock-ghost.js`.
- slides: slide 4 "It saves what it found" isn't in any rehearsed demo. Slide 5 "two AI brains"
  contradicts DEMO.md's all-Claude setup. Slide 8 "Free and open source" wrongly implies Ghost-Prime
  is open source. Impact claims need wording that admits there's no user study yet.
- script: use one hero demo everywhere (pitch-2min, slides, DEMO.md). Give the 2-min pitch a
  realistic demo slot. Voice claims must match FACTS.md's voice status. Add the originality Q&A
  ("Chromebooks already have dictation, Select-to-Speak, ChromeVox, Google Assistant — why this?").
  Fix Q18's fallback claim. Be clear AI helped write the code. Soften the "for young children" targeting.
- Re-export every PDF (`showcase/*/export.mjs` / `render.mjs`), look at the previews, and keep
  [YOUR NAME]/[YOUR CLASS]/[SCHOOL] as placeholders.
- Keep `showcase/demo/` replay scenarios and DEMO.md in sync with whatever the hero demo becomes.

### 4. Improve the app itself (reliability first, then features)
Things that make the live demo safer or more impressive, verifiable without secrets:
- Harden anything the showcase demos touch: weather, reminders, memory, the Playwright browser path
  (backend=auto fallback), terminal. Add or extend smoke tests for them.
- Friendlier failure messages when Claude/Gemini are unreachable (offline booth), and make sure the
  UI never shows a raw stack trace.
- Voice UX polish in the renderer: listening/transcribing states visible from across a room.
- Look for bugs with fresh eyes: read the code, write a failing test, fix it. Don't do speculative
  refactors.
- Phone connector (android-connector): only small, safe improvements. It hasn't been tested on the
  real Galaxy A05 yet.

## Stop / report
Commit each finished piece with a clear message. Before stopping, update this file's
"Overnight results" section with what you did, what you verified (test counts), what's still open,
and anything the student must do in person: test the phone and extension, fill in the name
placeholders, rehearse DEMO.md.

## Overnight results
_(fill in)_
