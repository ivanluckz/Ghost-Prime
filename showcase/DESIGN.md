# Showcase kit: design system and content canon

One look and one set of words for the slides, the poster and the pitch card. Every claim still comes
from `FACTS.md`; this file only decides **how** it looks and **which exact words** we use everywhere.

## 1. Look

The kit is Ghost-Prime's own world, tightened for a projector and for paper: a dark console, one
cyan accent, and type you can read from the back of a school hall. Calm and exact beats flashy.

### Colour (dark: slides, dark poster)

| Token | Hex | Use |
|---|---|---|
| Void | `#05070F` | Ground of every slide |
| Deck | `#0B1020` | The rare raised surface (a screenshot frame, a code/trace strip) |
| Ink | `#EEF2FF` | Primary text |
| Mist | `#9AA8CC` | Secondary text, captions |
| Line | `#1E2742` | Hairlines, dividers, frames |
| Cyan | `#00E6FF` | **The one accent**: Ghost-Prime acting, the hero phrase, links |
| Violet | `#7C5CFF` | Only inside the gem / wordmark gradient and diagram arrows |
| Mint | `#2EE6A6` | Status: works today (tested) |
| Amber | `#FFB454` | Status: in progress, honest limits, "not yet" |
| Coral | `#FF5D7A` | Only for "never claim" lists and errors |

Light (paper) theme for the printed poster and pitch card: Paper `#FFFFFF`, Ink `#0B1020`,
Ink-2 `#3A4563`, Line `#D5DCEC`, Cyan `#0784A3`, Violet `#5B3DF5`, Mint `#0E8F66`, Amber `#9A5B00`,
Coral `#C22D4B`. On paper, colour goes on text, lines and small marks, never on big fills.

Mint / Amber / Coral are **semantic** (status), not decoration. Cyan is the only brand accent on a
page. Gradient text (cyan → violet → magenta) is allowed **once per deliverable**: the wordmark.

### Type

All fonts are bundled next to each file (offline at the booth). Never rely on a system font.

| Role | Face | Setting |
|---|---|---|
| Display | **Archivo** variable (`archivo-latin-var.woff2`, OFL) | Headlines `font-stretch:112%; font-weight:760; letter-spacing:-0.02em; line-height:1.02`. Huge statements and big numbers `font-stretch:125%; font-weight:820`. |
| Wordmark | Archivo | `GHOST-PRIME`, `font-stretch:125%; font-weight:800; letter-spacing:0.14em`, the only gradient text |
| Body | Inter (bundled) | 400 / 500 / 600, `line-height:1.35` on slides, 1.45 on paper |
| Utility | JetBrains Mono (bundled) | Eyebrows and labels (UPPERCASE, `letter-spacing:0.14em`), tool traces, captions with numbers, `font-variant-numeric: tabular-nums` |

Declare it as `@font-face { font-family:'Archivo Kit'; src:url('…/archivo-latin-var.woff2') format('woff2'); font-weight:100 900; font-stretch:62% 125%; }`
with a real fallback stack (`'Archivo Kit', 'Inter Kit', 'Liberation Sans', Arial, sans-serif`).
Headings get `text-wrap: balance`.

**Slide scale (1920×1080 px):** eyebrow 24 mono · body 34 · title 84–96 (max 2 lines) · statement
120–150 · big number 150–180 · caption 24 mono. **Nothing on a slide below 24 px**, body copy never
below 30 px. About **30 words of on-slide text at most** (the speaker notes carry the rest).

**Paper scale:** poster (A2) headline ≥ 120 px at 96 dpi CSS, body ≥ 22 px; pitch card (A4) body
11–12 pt, cue text larger. Keep running text near 65 characters wide.

### Layout

- Slides: 1920×1080, side margins 120 px, top 96 px, footer baseline 1016 px. 12-column grid,
  32 px gutters. **One idea per slide**: a statement on the left, one visual on the right (a real
  app screenshot, a trace, or a diagram), or one full-width visual.
- No grids of look-alike icon cards. Lists are typographic: a hairline, a short bold lead, one line
  of Mist. Borders, fills and radius only where an element is truly a separate object (a
  screenshot, the trace strip, a status chip).
- Numbered markers only for real sequences (the demo steps, "what's next" in order).
- Footer on every content slide: `GHOST-PRIME` (mono, small) left, `NN / TT` right, both Mist.
  Keep the subtle HUD corner brackets; no other ornament.
- Status chips: pill, 1 px border in the status colour at ~45 %, text in the status colour, mono
  uppercase: `WORKS · TESTED`, `WORKS · CHECKED ONCE`, `WORKS · BY HAND`, `IN PROGRESS`, `PLANNED`.

### The signature detail

Ghost-Prime reads a web page as a **numbered list** (`[6] Search Wikipedia (search)`) and clicks by
number. Use that as the kit's recurring motif where it explains something: the demo slide's trace,
the poster's "how it works". Real tool names in JetBrains Mono, e.g.

```
browser_navigate  wikipedia.org
browser_get_page  [6] Search Wikipedia (search)
browser_fill      [6] "photosynthesis" ↵
browser_get_text  Photosynthesis - Wikipedia
```

### App screenshots

`showcase/app-shots/*.png` (re-shoot with `node showcase/app-shots/capture.mjs` while `npm run design`
runs). They are the real interface in presenter mode, AUTO mode, playing the scripted replay of the
hero demo. Caption every one: **"The real app screen, with a scripted sample of the demo."**
Never use the old flight/Lisbon shots or anything showing FULL AUTO.

| File | Shows |
|---|---|
| `hero-working.png` | The hero demo mid-run: tool cards streaming, Activity panel "Acting…" |
| `hero-answer.png` | The three-sentence photosynthesis answer |
| `terminal.png` | Demo 1: the terminal typed `df -h` itself, plain-words answer |
| `plan-mode.png` | Demo 7: PLAN mode explains and changes nothing |
| `app-full.png` | The whole app at normal size: history, chat, Activity, AUTO |

## 2. Words (use these exactly)

- **Hero phrase** (identical in the slides, the pitch, DEMO.md, the replay, the pitch card):
  *Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.*
- **Tagline:** Use a computer just by talking.
- **One-liner:** A voice assistant that does the task for you, built on a school Chromebook.
- **Cost:** No pay-per-use bills. It runs on Google's free AI plus a Claude subscription I already
  had, and it can run on the free tier alone (less capable at long tasks).
- **Brains on demo day:** Claude does the thinking in today's demo, so every answer shows a CLAUDE
  tag. Normally a router can also send quick questions to Google's free Gemini. (Never "two AI
  brains" as the headline of how it works; the demo is all-Claude.)
- **Open source:** "Built with free, open-source tools (Electron, Playwright, SQLite, Whisper,
  three.js)." Never say or imply that Ghost-Prime itself is open source.
- **Voice:** "Voice works in my own testing; the real mic and speaker are only checked by hand."
  (Only the voice logic has an automated test, with pretend speakers and a pretend Google.) Voice
  needs the internet (Google) unless the offline voice mode is switched on. To speak: the mic button.
  Ctrl+Shift+G only brings the window up and puts the cursor in the chat box. Never "Hey Ghost".
- **Phone / Chrome extension:** built, tested only on a simulated phone / a headless browser.
  "In progress." Never "it controls my phone".
- **Safety:** PLAN only looks and changes nothing. In AUTO it acts on its own (corrected 28 Sep: the
  app pre-approves its own tools, so no automatic check judges them; FACTS §5). FULL AUTO runs
  everything. The showcase launch starts in AUTO; plain Ghost-Prime starts in FULL AUTO. **There is no
  "Are you sure?" pop-up yet.** Never say "an automatic safety check decides each action".
- **Impact:** "Who it's for", never "who it helps" as if proven. Always pair it with: "I haven't
  tested it with these groups yet. That's my next step, and my ask."
- **Audience:** students who type slowly, people who find small text hard to read, people new to
  computers, busy teachers. **Not** "young children" (the AI services are 18+; FACTS/qa.md Q16).
- **Authorship:** "I designed it, decided what it should do, tested it, and used an AI coding
  assistant (Claude Code) to write much of the code." Keep `[YOUR NAME]`, `[YOUR CLASS]`, `[SCHOOL]`
  as literal placeholders.
- **Credit** wherever battery / weather / volume / brightness / YouTube tools appear: "MARK LIII
  JARVIS by FatihMakes (CC BY-NC 4.0)".
- **Numbers** (FACTS §6, counted 25 Sep and the night of 25–26 Sep): 64 tools (Claude brain) ·
  "over 500 automated checks passed, 0 failed" (exact: 523 checks in 34 offline test suites,
  25–26 Sep 2026) · 45 test scripts · about 3 months (17 Jun – 25 Sep) · at least 89 commits (to
  26 Sep) · about 25,000 lines · 127 bugs fixed in one audit (20 Sep). Quote the date with the
  checks. On a slide or the poster the big number is **523**; out loud it is "over 500".
- **How each capability was checked** (for any "what works" list; from FACTS §2):
  web browser = automated tests 25 Sep (tool tests without the AI; the AI driving it last ran
  20 Sep) · terminal = automated tests 25 Sep · files + undo = automated tests 25 Sep · memory, chat
  history, reminders = automated tests, re-run 25 Sep · voice in/out = by hand (only the logic has
  an offline test) · web search = by hand (result parsing tested offline; page fetch checked once
  25 Sep) · pictures = checked once with Gemini 19 Sep · battery = checked once with Gemini 25 Sep ·
  weather = automated tests against a pretend service. Chips: the first four are `WORKS · TESTED`,
  voice and web search are `WORKS · BY HAND`. Never write that everything not marked "by hand"
  passed automated tests.
