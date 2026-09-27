# Ghost-Prime demo video: storyboard

**A 90–120 s narrated video, 16:9 widescreen (1920×1080), for the booth screen or projector and to share.**
It was recorded from the app's **offline replay**: the real React interface in a plain browser, playing
scripted demos. The cloud session has no `.env`, so there was no real Claude or Gemini. Every phrase below is
typed **character for character** from `REHEARSED` in `src/renderer/dev/showcase-scenarios.js`. Anything
else makes the replay answer "this is a replay". The one exception is `[YOUR CLASS]`, which is filled with the
real class, as DEMO.md says ("say your real class"). Every word on screen and in the narration follows
`showcase/FACTS.md`.

**Presenter:** Ivan Lucky KUNDWA · Grade 9 · Ntare-louisenlund (`storyboard.json` → `presenter`).
**Look:** a red variant of the kit's `showcase/DESIGN.md`, as the presenter asked. It keeps the dark ground,
Archivo, Inter and JetBrains Mono, the HUD brackets and the gem. Red replaces cyan as the one accent, and the
gradient is used once, on the wordmark. The app footage itself is unchanged, since the replay is frozen.

`storyboard.json` is the machine-readable version that `record.mjs`, `narrate.mjs` and `edit.mjs` read.

Story: greeting → the hero web demo → remember me / what do you know about me → reminder → a study plan
(which creates the folder the safety demo then refuses to delete) → PLAN-mode safety demo.

| # | Shot | Say or type (exact) | Narration (≤ 30 words) | Caption (≤ 8 words) | Target |
|---|---|---|---|---|---|
| 0 | **Title card** | — | "Ghost-Prime, by Ivan Lucky. Use a computer just by talking." | — | 5 s |
| 1 | Greeting (Demo 0) | *Say hello to the judges.* | "Ghost-Prime is an AI assistant on a school Chromebook. You talk or type, and it does the task." | Talk or type. It does the task. | 8 s |
| 2 | **Hero: reads the web** (Demo 5) | *Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.* | "Now it reads the web for you. It opens Wikipedia, types the search itself, reads the article, and explains it in three simple sentences. Every step shows as a card." | Reads the web, explains it simply | 22 s |
| 3 | Remember me (Demo 3) | *Remember that I'm in Grade 9 and my favourite subject is chemistry.* | "It remembers you from one day to the next. Tell it something once; the memory is stored on the Chromebook." | It remembers what you tell it | 9 s |
| 4 | Recall, in a new chat (Demo 3) | **Ctrl+N**, then *What do you know about me?* | "In a brand-new chat, it still knows: what you just said, and what it learned before." | A new chat. It still knows. | 8 s |
| 5 | Reminder (Demo 4) | *Remind me in two minutes to drink some water.* | "Reminders, for homework and revision. Two minutes from now it speaks up, in the chat and out loud." | Reminders that speak up | 8 s |
| 6 | Study plan, a file with undo (Demo 2) | *Make me a three-day chemistry revision plan and save it in a new folder called Showcase, so I can undo it if I change my mind.* | "Files too. It writes a three-day revision plan and saves it in a new folder. What it creates with its file tools can be undone." | Makes files, with undo | 12 s |
| 7 | **Safety: PLAN mode** (Demo 7) | `/mode plan`, then *Delete the Showcase folder.* | "Safety for teachers. In plan mode it only looks: asked to delete that folder, it explains what it would do and changes nothing. An 'are you sure?' pop-up is next." | PLAN mode: it only looks | 14 s |
| 8 | **Closing card** | — | "Recorded from the app's offline replay. Come and try it live at the booth." | — | 6 s |

The target total is 92 s. The recorded footage sets the real length; `plan.json` has the final times.

## What each shot shows, and why it is honest

- **Title card:** the wordmark, the tagline *Use a computer just by talking.*, the line "A voice assistant
  that does the task for you, built on a school Chromebook.", "Rwanda Innovation Showcase · 2026" and
  "Ivan Lucky KUNDWA · Grade 9 · Ntare-louisenlund".
- **Greeting:** the answer streams word by word with the **CLAUDE** tag. By about 13 s the viewer has heard and
  read what Ghost-Prime is.
- **Hero (Demo 5):** the one demo used across the whole kit. The cards run `browser_navigate`,
  `browser_get_page` (the page as a numbered list, `[6] Search Wikipedia`), `browser_fill`, a screenshot card
  and `browser_get_text`. Then comes the three-sentence answer, held 5 s so it can be read. FACTS §2 marks the
  browser WORKING (automated tests on 25 Sep).
- **Remember / recall:** `memory_save`, then Ctrl+N and `memory_recall`. The list shows "You're in Grade 9
  and your favourite subject is chemistry" plus two harmless seed memories. FACTS §2 marks memory WORKING.
- **Reminder:** a `reminder_set` card with the time, recorded in the Kigali time zone. FACTS §2 marks
  reminders WORKING. The video does not show the reminder firing; the narration only says it will.
- **Study plan:** `file_create` writes `~/Showcase/chemistry-revision-plan.txt`. FACTS §2 marks files with
  undo WORKING. This shot also creates the folder for the safety demo.
- **PLAN mode:** `/mode plan` is typed; DEMO.md says never use Shift+Tab. The badge says PLAN, and a read-only
  `Glob` card looks inside the folder. The answer starts "I'm in PLAN mode, so I haven't changed anything".
  FACTS §5 marks PLAN read-only, from an automated test run offline. The narration ends with the honest
  line: an "are you sure?" pop-up is next, and it is not there yet.
- **Closing card:** "Demo walkthrough recorded from the app's offline replay" and "Come and try it live
  at the booth".

## Overlays

- **Badge:** "Demo walkthrough · offline replay", bottom right, under the footage, for the whole walkthrough.
  The replay's own amber "Offline replay · scripted demo" chip is also visible inside the app throughout.
- **Captions:** each demo's caption is a lower third, bottom left. It sits in the band under the footage, so
  it never covers the app.
- **Narration:** each line starts at its shot's typing-start time and never overlaps the next line. The
  recorder holds each shot long enough for its line.

## Deliberately left out

- Battery was checked once, with Gemini only. Weather was tested against a pretend service. Volume, the
  phone, the Chrome extension and voice input are either not tested well enough on the real device or
  cannot be shown in a replay.
- Undo after the study plan is left out. It would empty the folder before the PLAN demo and add 6 s.
- There is no claim about who it helps. FACTS.md says there is no user study yet, so the video shows what
  the app does and leaves "who it's for" to the presenter.
