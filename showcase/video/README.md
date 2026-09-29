# Ghost-Prime demo video

This is a narrated walkthrough of Ghost-Prime, about 1.5 minutes long. It is 16:9 widescreen (1920×1080)
for a PC, TV or projector at the booth of the Rwanda Innovation Showcase (29 October 2026; the video itself shows no date), and for sharing.
Presenter: **Ivan Lucky KUNDWA · Grade 9 · Ntare-louisenlund**.

**How it was made, read first.** The video plays as a straight screen recording of Ghost-Prime, with no
"replay" label, as the presenter asked. It was recorded from the app's **offline replay**: the real React
interface running in a plain browser, with the answers and tool cards played from a script
(`src/renderer/dev/showcase-scenarios.js`, DEMO.md "Plan C"). No real Claude or Gemini call happened, because the
cloud session that made it has no `.env`. The replay's own "Offline replay · scripted demo" chip was hidden
while recording, the way `showcase/app-shots/capture.mjs` hides it for the slide screenshots.
- Every feature shown is marked WORKING in `showcase/FACTS.md`, and the narration only claims what FACTS.md
  backs up. PLAN mode is the one caveat: FACTS §5 says it was tested offline and should be run once live on
  28 Sep.
- **If a judge or visitor asks whether it's live:** say it's a recorded walkthrough of the app, and show the
  real thing at the booth. Don't say it was a live run.

## The files

| File | What it is |
|---|---|
| `ghost-prime-demo.mp4` | **The video.** 1920×1080, H.264 (yuv420p), 30 fps, AAC, faststart. The app, recorded at the school Chromebook's 1366×768 screen size, fills the top of the frame at 1664×936 (16:9). A band underneath holds each shot's caption, so no overlay covers the app. |
| `thumbnail.png` | A 1280×720 still with the wordmark, the tagline and the hero answer. |
| `storyboard.md`, `storyboard.json` | The shot list: exact phrases, narration lines (≤ 30 words), captions (≤ 8 words), target seconds, and why each shot is honest. The scripts read the JSON, which also holds the presenter's name, class and school. |
| `record.mjs` | Playwright in headless Chromium. It types each phrase into the replay at about 35 ms per character, waits for the answer, scrolls, and writes `timeline.json` and `frames/`. |
| `timeline.json` | The measured times (seconds into the raw footage) for each shot: typing start, Enter, answer done and finish. It also records the scenario each phrase landed on and the calibration offset. |
| `narrate.mjs` | One WAV per narration line, plus `voice/manifest.json`. With `NARRATE_ENGINE=gemini` it uses Ghost-Prime's own Gemini voice; otherwise a free offline voice. |
| `revoice.mjs` | Puts new narration on the finished video without re-recording it: the picture is copied as it is, only the sound changes. |
| `voice/*.wav`, `voice/manifest.json` | The narration. The manifest lists shot id, file, seconds, text and engine. |
| `cards.html` | The title card, closing card, captions and thumbnail, in a red variant of the kit's design system. `edit.mjs` renders it to PNG. |
| `edit.mjs` | The ffmpeg assembly of the video and the thumbnail. It writes `plan.json`. |
| `plan.json` | The exact schedule and layout of the final cut: each shot's caption window, narration start and answer-done time, the footage segments and speed-ups, and the overlay boxes. |
| `check.mjs` | Verification: ffprobe, frames every 3 s into `check/`, black-frame detection, caption presence, and audio checks per window. |
| `.gitignore` | Keeps the raw footage, frames, rendered cards and check frames out of git. They are regenerated. |

## What is in the video

Title card → seven demo shots from the offline replay → closing card.
1. **Greeting:** "Say hello to the judges."
2. **Hero web demo:** Wikipedia → photosynthesis in three simple sentences (DEMO.md Demo 5).
3. **Remember me:** "Remember that I'm in Grade 9 and my favourite subject is chemistry."
4. **Recall:** Ctrl+N, then "What do you know about me?"
5. **Reminder:** a two-minute reminder.
6. **Study plan:** a chemistry revision plan saved to a new folder. This is a file with undo, and it also
   creates the folder for the last demo.
7. **Safety:** `/mode plan`, then "Delete the Showcase folder." PLAN mode only looks, and says so.

Every phrase is typed character for character from the rehearsed list, with `[YOUR CLASS]` filled in, so the
replay plays the intended scenario. `record.mjs` fails if one lands anywhere else. `storyboard.md` has the table
with the narration and captions.

Left out on purpose:
- Battery, which was only checked once, with Gemini.
- Weather, which was only tested against a pretend service.
- Volume, the phone, the Chrome extension and voice input.
- Any "who it helps" claim, since there is no user study yet (FACTS.md).

## The look

The kit's `showcase/DESIGN.md` uses cyan as its one accent. The presenter asked for a **red** theme like their
slides, but no red deck was found in the repo, Canva or Google Drive. The video therefore uses a red variant of
DESIGN.md.
- **Kept from DESIGN.md:** the dark ground, the Archivo display type, Inter and JetBrains Mono, the HUD
  brackets, the gem, and one gradient used once, on the wordmark.
- **Changed:** red (`#FF3B47`) is the accent, the wordmark gradient runs ember → red → crimson, and the ground
  is warmed to `#0A0507`.
- **Unchanged:** the app footage itself, because the replay is frozen.

To match an existing red deck exactly, change the `:root` tokens and the `wmGrad` stops in `cards.html`, then
run `edit.mjs --skip-cards` after `edit.mjs --cards-only`. In practice a plain `edit.mjs` does both.

## How it was made

1. **Footage.** `record.mjs` opens `http://127.0.0.1:5199/?skipIntro=1&replay=1&showcase=1&speak=0`. That is
   presenter mode, which uses big text and starts in AUTO. The page runs at 1366×768 in headless Chromium
   (`--use-gl=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`) with Playwright's `recordVideo`.
   - The replay's "Offline replay · scripted demo" chip is hidden (`storyboard.json` → `hideReplayLabel`), and
     the recorder fails if "offline replay" or "scripted demo" is visible on screen at any shot.
   - The page's speech is stubbed, and every non-local request is blocked, so it works with no internet.
   - The time zone is Kigali.
   - It types like a person: 35 ms per character with jitter, and a breath after commas.
   - After each answer stops streaming it waits 1.8 s, or longer when the shot needs time for its narration
     line or for reading the answer. It then scrolls the thread to the bottom.
   - A 300 ms white flash before the first shot pins wall-clock times to video time.
   - It extracts four frames per shot into `frames/` to look at.
2. **Narration.** The video now has Ghost-Prime's own voice (Gemini speech model, voice Kore, free tier), made
   on the Chromebook on 29 Sep 2026 with `NARRATE_ENGINE=gemini node showcase/video/narrate.mjs` and put on the
   finished video with `revoice.mjs`. Every line kept its start time and fitted its slot at normal speed. The
   words of each line were checked with the app's offline Whisper transcriber. The first cut, from the cloud,
   used espeak-ng and the MBROLA British voice `mb-en1` at 150 wpm. It trims each file to a −3 dBFS peak with short fades and 0.25 s of room, then checks the file is
   neither silent nor an odd length. Piper (`pip install piper-tts`) installed, but its voice models are on
   huggingface.co, which the cloud session's network policy blocks. `narrate.mjs` prefers Piper whenever a
   voice model is present (see "Regenerate").
3. **Cards.** `edit.mjs` renders `cards.html` with Playwright: title, closing, one caption per shot, and the
   thumbnail. The closing card is the tagline plus "Come and try it live at the booth". Fonts are the kit's bundled Archivo, Inter and JetBrains Mono. The wordmark outlines and the
   gem shape are the slides' own.
4. **Edit.** `edit.mjs` places each narration line at its shot's typing-start time and fails if two lines would
   overlap. It lifts the mix back to a −3 dBFS peak, because mono → stereo costs 3 dB. Then one ffmpeg pass
   builds title (fade in and out) → footage → closing. The captions are overlaid with 0.25 s fades.
   The encode is libx264 crf 20 (it steps up if the file would pass 25 MB), AAC 160 kbps, `+faststart`.
   - **Sped up:** typing stretches longer than 4 s run at 1.5×. Idle stretches between shots longer than 4 s
     run at 4×. The only one is the ~8 s pause after Ctrl+N, while software GL sets up the start screen's 3D
     gem; on a real GPU it is instant.
   - **Never sped up:** the moments an answer streams.
5. **Checks.** `check.mjs` (below), and a look at every extracted frame.

## Regenerate

Run these from the repo root after `npm install --legacy-peer-deps`, with ffmpeg and espeak-ng installed
(ideally mbrola and mbrola-en1 too):

```bash
npm run design                                   # terminal 1: the preview server on 127.0.0.1:5199
node showcase/video/narrate.mjs                  # terminal 2: voice/*.wav + voice/manifest.json
node showcase/video/record.mjs                   # footage/replay.webm, timeline.json, frames/
node showcase/video/edit.mjs                     # ghost-prime-demo.mp4, thumbnail.png, plan.json
node showcase/video/check.mjs                    # verify; frames to look at in check/
```

Options and knobs:
- **Chromium:** `GHOST_CHROMIUM=/path/to/chrome` makes `record.mjs` and `edit.mjs` use that browser. The cloud
  session used the pre-installed `/opt/pw-browsers/chromium`. On the Chromebook, running
  `npx playwright install chromium` once is enough.
- **A better voice:** run
  `python3 -m piper.download_voices en_GB-cori-high --download-dir showcase/video/voice/piper`, or set
  `PIPER_VOICE=/path/to/en_GB-*.onnx`. Then re-run `narrate.mjs`, `record.mjs` and `edit.mjs`; narrate picks
  Piper automatically. `NARRATE_VOICE=en-gb` forces espeak-ng's plain British voice, and `NARRATE_WPM=150` sets
  the pace.
- **The app's real voice (done):** `NARRATE_ENGINE=gemini node showcase/video/narrate.mjs`, then
  `node showcase/video/revoice.mjs`, then `node showcase/video/check.mjs`. It needs the internet and
  `GEMINI_API_KEY` in `.env`. It is one request per line and the free tier allows only a few a day, so the
  answers are kept in `voice/*.raw.wav` (not in git) and only changed lines are asked for again.
  `NARRATE_VOICE=Puck` picks another Gemini voice; `NARRATE_STYLE="…"` changes how it is told to speak.
  If a changed line no longer fits before the next one, shorten it, or run `record.mjs` and `edit.mjs` again.
- **Name, class, school:** edit `presenter` in `storyboard.json`. The class also goes into the memory demo.
- **Timing:** `storyboard.json` → `edit` sets `speedUpTypingOver` and `typingSpeed`, `speedUpIdleOver` and
  `idleSpeed`, and `lead` and `tail`. A shot's `holdAfterAnswerSeconds` sets how long its finished answer
  stays on screen.

## What was verified (cloud session, 27 Sep 2026)

- **Recording (`record.mjs`).** Every phrase landed on its scenario, with no page errors. The app fonts
  (Inter, JetBrains Mono) loaded, and presenter mode started in AUTO. No "offline replay" or "scripted demo"
  text was on screen at any shot, and no request left the machine.
- **Narration (`narrate.mjs`).** There are 9 lines of 3.9–10.9 s each. Each has a mean level of about −20 dB,
  a peak of −3 dB, and a normal speaking pace.
- **The video (`check.mjs`, 37 checks, all passed):**
  - It is 1920×1080 H.264 yuv420p at 30 fps with AAC 48 kHz and faststart. It runs 96.2 s, matching
    `plan.json`, and is 14.7 MB.
  - There are no black frames outside the fades.
  - Each caption is present in its own window.
  - There is speech in each of the 9 narration windows and true silence (−91 dB) in every gap between lines,
    so no line overlaps another. The overall peak is −3 dB, so nothing clips.
- **By eye.** The four frames per shot in `frames/` and the frames every 3 s in `check/` were checked.
  - The captions sit in the band under the app and never cover it.
  - The hero answer stays fully on screen for about 5 s.
  - The title and closing cards carry the presenter's name, class and school, and nothing reads "replay".

## What could not be done in the cloud

- **No listening.** The narration was checked by numbers (duration, level, words per second) and by
  transcribing it, not by ear. Watch it with sound before the booth.
- **No Piper voice.** The network policy blocked the download, so the first cut used espeak-ng. It was
  replaced by the Gemini voice on 29 Sep (see step 2).
- **No real AI and no Chromebook.** The footage is the offline replay with its label hidden (see the note
  at the top). The video itself doesn't say so, so say "recorded walkthrough" if asked.
