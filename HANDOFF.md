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

_Written by the overnight session, 25→26 Sep 2026. Every change is a small commit on `ghost-prime`,
pushed. showcase/FACTS.md was updated alongside each fix, so it is still the source of truth._

### What was done

**1. Design pass: finished.** `styles/panels.css` was written, the four half-done sheets were
completed, and every UI state was captured and reviewed. That includes the 900 px "narrow" state,
presenter mode and both voice states. Markdown renders GitHub tables and blockquotes, and a
React key bug in it was fixed. A **Stop** button now sits next to Send while a task runs.

**2. Presenter mode: done.** `/showcase on|off`, and on by default when launched with
`bin/ghost-showcase` (`GHOST_SHOWCASE=1` reaches the renderer the same way the native-frame flag
does). It gives big type and a wider chat, a simplified top bar, the chat list tucked away, and it
starts in **AUTO**, not FULL AUTO. Voice states ("Listening… click the mic again to send",
"Turning your speech into text…", and a plain reason when the mic fails) are readable from across
a room. Checked in the design preview and by launching the built app under Xvfb.

**3. Showcase kit: redesigned and fact-checked.**
A new design system, `showcase/DESIGN.md`, fixes the palette, the type (Archivo, Inter, JetBrains
Mono, bundled so the PDFs work offline), the 24 px floor on slides, and the canon wording for every
claim. Each deliverable then went through five steps: an audit, a rebuild, an adversarial fact check
against FACTS.md, a design review of the rendered previews, and a fix pass. The deliverables are the
slides, the poster, the pitch card and scripts, and qa.md with DEMO.md and the replay. A final pass
checked the whole kit against itself. Every item on the judges' list is fixed:
- The slide footnote about automated tests is replaced by a status chip on each row.
- The screenshots are fresh, in AUTO, with the photosynthesis demo. There are no flights and no
  FULL AUTO.
- "It saves what it found", "two AI brains" and "free and open source" are gone.
- The impact wording says there's no user study yet.
- One hero phrase is used everywhere, character for character.
- The 2-minute pitch has a realistic demo slot.
- The voice claims match FACTS.
- The originality Q&A (dictation, Select-to-Speak, ChromeVox, Assistant) is added as qa.md Q12.
- The old Q18 fallback claim is fixed; it is now Q20 and says what is tested and what isn't.
- The audience is no longer "young children".
- The kit says plainly that an AI coding assistant helped write the code.

The numbers match FACTS §6: 64 tools, 523 checks in 34 suites, and about 3 months of building. All
PDFs are re-exported, and `[YOUR NAME]` / `[YOUR CLASS]` / `[SCHOOL]` stay literal. The replay and
DEMO.md are in sync, and `showcase/demo/verify-replay.mjs` passes in both layouts.

**4. The app: many real bugs fixed, each with a failing test first.** A read-only bug hunt went over
every subsystem, and two skeptics checked each finding. The ones that matter most on the day:
- **PLAN mode was not really read-only on the Claude brain.** The SDK ran every always-allowed tool,
  so Demo 7 ("Delete the Showcase folder") relied on the model choosing not to. It is enforced now.
- **Stop now really stops.** Before, text kept typing for about 2 s, a tool called in that window
  still ran, and late words could appear in the next chat.
- **No internet no longer means 3 silent minutes of "working…".** Each retry is shown, and it gives
  up early, trying Gemini or saying to check the Wi-Fi.
- **Browser (Demo 5):**
  - Element numbers no longer change meaning between steps, and a form is submitted once on a slow site.
  - A crashed tab is replaced, and downloads are reported properly.
  - Launch errors name the real cause, and it falls back to the bundled Chromium if Chrome is missing.
- **Terminal (Demo 1):** one main terminal, no hang on a bad quote, pagers, multi-line, `~` folders.
- **Undo (Demo 2):** it never throws away changes made after the step being undone.
- **Memory and history (Demo 3):** deleting a chat that saved a memory no longer fails.
- **Reminders (Demo 4):** both brains know today's date and time. A reminder is never reported saved
  when it wasn't.
- **Voice:** it never goes silent mid-reply, never records its own voice, and doesn't send silence.
- **Weather, volume, YouTube and web search:**
  - Weather: no "undefined°C".
  - Volume: capped at 100%.
  - YouTube: song titles with an apostrophe work.
  - Web search: snippets stay with their own links.
- **Site access (teachers):** four ways around the allow/block list are closed.
- **Error messages:** plain English everywhere, including Gemini's real reason. If the window
  crashes, it reloads by itself.
- **Phone app (android-connector):** small, safe fixes, and plain HTTP to the Chromebook is now
  allowed. The APK built before this can't connect; **rebuild it**. It was not compiled here (no
  Android SDK in the cloud).

### What was verified
- **Build:** `npx electron-vite build` is clean.
- **`npm run test:offline`:** new; one command, about 3 minutes, no internet or keys. **34 suites,
  523 checks, 0 failed.** 21 of those suites were written tonight.
- **Electron database suites:** `scripts/electron-db-smokes.sh` passes smoke-db, smoke-summary and
  smoke-persistence (28).
- **Design capture:** `scripts/design-capture.mjs`, 16 states, no page errors.
- **Offline replay:** `showcase/demo/verify-replay.mjs` passes in the normal layout and in presenter mode.
- **UI and window checks:** `scripts/check-stop-ui.mjs` (4) and `scripts/check-renderer-crash.mjs` (5)
  pass, the latter against the built app under Xvfb.
- **Not run:** anything that needs the real Claude login, the Gemini key, the Chromebook, the phone
  or the extension.

### Still open
- The live AI checks (Claude, Gemini) were not run overnight (no keys in the cloud).
- The phone app and the Chrome extension are still untested on real devices.
- There is no "are you sure?" confirmation for irreversible actions yet (it's on the "next" slide).
- Many fixes were tested only offline. They are marked that way in FACTS.md, with what to try live:
  PLAN mode, Stop, the retry notices, and battery on Claude.
- The replay and the app screenshots show the Chromebook's Linux username (`lol`, as in `/home/lol`,
  `lol@penguin`). If you'd rather not show it, change `HOME`/`PROMPT` in
  `src/renderer/dev/showcase-scenarios.js`, then re-shoot with `node showcase/app-shots/capture.mjs`.

### Video (27 Sep, cloud session)

**What was made.** `showcase/video/ghost-prime-demo.mp4` is a 96-second narrated demo video. It is 16:9
widescreen (1920×1080) for a PC, TV or projector at the booth, and for sharing. `thumbnail.png` goes with it.
- It plays as a straight recording of the app, with **no "replay" label**, as asked. It was actually recorded
  from the app's offline replay, because the cloud has no `.env` and so no real Claude or Gemini. The replay's
  own "Offline replay · scripted demo" chip was hidden while recording, as the slide screenshots already do.
  Every feature shown is marked WORKING in FACTS.md. **If a judge asks whether it's live, say it's a recorded
  walkthrough and show the real thing at the booth.**
- Title card ("Ivan Lucky KUNDWA · Grade 9 · Ntare-louisenlund") → seven demos → closing card.
  - The demos, in order: greeting, the hero Wikipedia → photosynthesis demo, "Remember that I'm in Grade 9…",
    "What do you know about me?" in a new chat, a two-minute reminder, a chemistry revision plan saved to a new
    folder, and `/mode plan` then "Delete the Showcase folder".
  - Every phrase is typed character for character from the rehearsed list.
  - Every caption and narration line follows FACTS.md. `storyboard.md` lists them, why each shot is honest, and
    what was left out.
- **The look is a red variant of DESIGN.md**, as asked. No red deck was found in the repo, Canva or Drive, so
  red simply replaces cyan as the accent on the cards and overlays. The app footage keeps its own colours.
- The pipeline can be re-run: `narrate.mjs` (offline voice), `record.mjs` (Playwright drives the replay),
  `edit.mjs` (ffmpeg) and `check.mjs` (verification). `showcase/video/README.md` has the commands.

**What was verified.**
- Every phrase landed on its scenario, with no page errors, and no "offline replay" text was on screen at any shot.
- `check.mjs` passed all 37 checks:
  - H.264 yuv420p at 30 fps with AAC and faststart, 14.7 MB.
  - No black frames outside the fades.
  - Every caption is present in its window, and no "offline replay" or "scripted demo" text is on screen.
  - Speech is present in all 9 narration windows, with true silence between lines and no clipping.
- Every extracted frame was looked at: four per shot, plus one every 3 s of the final cut.

**What you should check yourself.**
1. **Watch it with sound.** The narration is a free offline voice (espeak-ng with the MBROLA British voice),
   and it was checked by numbers, not by ear. Piper, a better free voice, installed, but its voice models are
   on huggingface.co, which the cloud network blocks. One command in the README fetches one on the Chromebook.
2. **Decide whether to re-narrate with the app's real Gemini voice.** `voice/manifest.json` lists each line
   (shot, file, seconds, text). Record each line with the app's voice under the same file name, update
   `seconds`, then re-run `record.mjs` and `edit.mjs`.
3. **The red.** If you have a red slide deck, send it, or put its hex colours in `cards.html` (the `:root`
   tokens and `wmGrad`) and re-run `edit.mjs`.
4. **The name** appears on the video only. The slides, poster and pitch card still carry the `[YOUR NAME]`
   placeholders, so fill those in as listed below.
5. Play it once on the booth screen from 3 m away and check that the captions read.

### Poster (28 Sep, cloud session): print this one

**Print `showcase/poster/poster-light.pdf`** (A2, 420×594 mm) or `poster-light-a3.pdf` (A3) on white paper.
The dark PDFs are for a screen only: they have no bleed and a hairline white edge, so a shop would reject them.

**What changed.**
- **Name:** the footer says "Ivan Lucky KUNDWA · Grade 9 · Ntare-louisenlund".
- **Colour:** the look is the red variant used by the demo video. The wordmark, gem, headline accent,
  numbered steps and the screenshot callout are red. The status chips stay green and amber.
- **Caption:** it now reads "The Ghost-Prime app during the photosynthesis demo." It no longer says
  "scripted sample", as asked for the video.
- **Images (28 Sep):** three instead of one. The app column now stacks two screens, "1 · It does the
  steps" (the tool cards) and "2 · It explains simply" (the three-sentence answer with the mic note). The
  ghost figure from the app's intro video sits beside the headline, tinted red and credited
  "Art: AI-generated (Higgsfield)" (FACTS §7). Source: `showcase/poster/img/ghost-art.png`.

**A review before print.** Four reviewers looked at the poster (facts, paper legibility, the dark theme,
print production), and a skeptic tried to refute each finding. Seven findings survived and all are fixed:
1. **Safety line (the important one).** The poster said "Claude's automatic safety check decides each
   action" in AUTO. The code says otherwise: outside PLAN, `provider.js` pre-approves every Ghost-Prime tool
   (`allowedTools`), so no automatic check judges browser, shell or file actions. The poster now says "In
   PLAN mode it only looks and changes nothing. In AUTO it acts on its own, and there is no 'Are you sure?'
   pop-up yet." FACTS.md §5, DESIGN.md §2, DEMO.md's honest lines and qa.md Q5 are corrected the same way.
   **Don't say the old line tomorrow.** The slides, slide notes, pitch card and README still carry it,
   untouched because only the poster is needed.
2. **Browser row:** the 25 Sep tests ran without the AI, so the row now adds "Tested with the AI on 20 Sep."
3. **Spacing:** the sheet was 10 px overfull. Tighter gaps give 36 px between bands, so one more line of
   authorship text still fits. `export.mjs` now fails if anything reaches the bottom margin (tested: three
   extra lines make it fail).
4. **Dark theme labels:** the dark theme is now labelled "for screens" instead of "print shop".
5. **Corner brackets:** they were semi-transparent, which Chromium exports as soft masks that Ghostscript
   (common in print-shop software) silently drops. They are opaque now: 0 soft masks, and Ghostscript draws
   them.
6. **The 300 dpi PNG fallback** (`export.mjs light --print-png`) now carries its DPI, so it opens at A2 size
   instead of 1.75 m wide.

**Verified.** All four PDFs are 1 page at exact A2 or A3 size, and the fonts are embedded. The screenshot
prints at 281 ppi on A2 and 397 on A3. Every text colour passes contrast on white: ink 19:1, accent 5.9:1,
amber 5.4:1. The layout check is clean in both themes.

**Before you print:** read the authorship sentence in the footer ("I designed it, decided what it should
do, tested it, and used an AI coding assistant…") and make sure it says exactly what Ivan did. Edit it in
`showcase/poster/poster.html`, then run
`GHOST_CHROMIUM=/opt/pw-browsers/chromium node showcase/poster/export.mjs` (on the Chromebook, plain
`node showcase/poster/export.mjs`). If a print shop rejects the PDF's fonts (Chromium embeds them as Type 3),
give them the PNG from `node showcase/poster/export.mjs light --print-png` and say "print at 420 × 594 mm".

### What you must do in person (before 29 Sep)
1. **Rebuild the phone APK** (`android-connector`, see its README), then test it on the Galaxy A05.
   Test the Chrome extension too. Until then, show both only as "next".
2. **Fill in the placeholders** `[YOUR NAME]`, `[YOUR CLASS]`, `[SCHOOL]` in the slides, poster, pitch
   card and scripts. Re-export the PDFs: `node showcase/slides/render.mjs`, `node showcase/poster/export.mjs`
   and `node showcase/script/export.mjs`.
3. **Rotate the API keys** that FACTS §5 lists as exposed, and put the new ones in `.env`.
4. **Run `showcase/demo/preflight.sh --live`** the day before, on the booth network. Then rehearse
   **DEMO.md** end to end with the real brains. Check especially:
   - Demo 7: PLAN mode now blocks for real.
   - Press **Stop** once mid-answer.
   - Ask "What's my battery level?" once on Claude.
5. **Try presenter mode on the projector:** `bin/ghost-showcase`, or type `/showcase on`. Check it
   reads from 2–3 m, and that the badge says AUTO.
6. **Set site access to strict** with the DEMO.md allow-list. It is currently open on the Chromebook.

