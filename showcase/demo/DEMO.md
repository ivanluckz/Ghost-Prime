# Ghost-Prime: live demo runbook

**Rwanda Innovation Showcase, 29 September 2026** · Presenter: **[YOUR NAME]**, **[YOUR CLASS]**, **[SCHOOL]**

This runbook is built so the demo cannot embarrass you. It has three plans:

| Plan | When | What you run |
|---|---|---|
| **A: live** | Internet and Claude work | `bin/ghost-showcase`, then the demos below |
| **B: live, reduced** | Gemini voice fails, or one demo misbehaves | Type instead of talking, offline voice, or skip to the next demo |
| **C: offline replay** | No internet, or Claude is down | `showcase/demo/replay.sh`. It shows the same interface playing scripted demos, **and you say it's a replay** |

Only show what `showcase/FACTS.md` marks as working. Everything in the main list below is marked
WORKING or WORKING (manual) there. The phone and the Chrome extension are **bonus** demos that you show
only if you tested them the day before.

---

## 0. Honest lines to learn by heart

- **Cost:** "No pay-per-use bills. It runs on free Google AI plus a Claude subscription I already had,
  and it can run on the free tier alone."
- **Phone:** "The phone part is built, but I haven't tested it on a real phone yet. That's my next step."
- **Safety:** "There's no 'are you sure?' pop-up yet. That's next. For now, PLAN mode makes it read-only."
- **Plan C:** "The internet here isn't cooperating, so here's a replay of the same demos. It's the real
  app's screen, but these answers are scripted, not live."
- **Who built it:** "I designed it, decided what it should do, tested it, and used an AI coding
  assistant to write much of the code." (Change this so it says what you really did.)
- **Credit** (when you show battery or weather): those tools come from "MARK LIII JARVIS" by
  FatihMakes (CC BY-NC 4.0).

---

## 1. The day before (28 September)

### Power and kit
- [ ] Charge the Chromebook to 100%. Pack the charger and an extension lead or power strip. On 25 Sep
      the battery was at 7–17%.
- [ ] Charge the phone too. Its hotspot drains the battery fast.
- [ ] Pack headphones or a small speaker if the hall is loud. The Chromebook speaker is quiet.
- [ ] Print the **cue card** at the bottom of this file.

### Network plan (school Wi-Fi is the weak point)
School and venue Wi-Fi often has a sign-in page, blocks some sites, or blocks devices from talking to
each other (so the phone can't reach the Chromebook).
- [ ] **Main plan:** use the **phone's hotspot** with a data bundle (at least 1 GB to be safe), and
      connect the Chromebook to it. You control it, and it doesn't depend on the venue.
- [ ] **Backup:** the venue Wi-Fi. Ask the organisers for the password on the day and test it at the
      booth with the preflight check (below).
- [ ] **No internet at all:** Plan C (offline replay). Rehearse it once today (section 6).

### Logins and settings (never open `.env` on a screen that others can see)
- [ ] Open the Linux terminal and run:
      ```bash
      cd ~/Projects/Ghost-Prime
      showcase/demo/preflight.sh --live
      ```
      It checks the build, the Gemini key (it never prints it), the Claude login, the internet, the mic,
      sound, battery and memory. `--live` asks Claude and Gemini one tiny question each. Fix every `FAIL`.
- [ ] If the Claude check fails: run `claude` in the terminal and log in again.
- [ ] If the Gemini check fails (quota or "429"): voice still works offline with
      `GHOST_VOICE_PROVIDER=local bin/ghost-showcase`. Rehearse one demo that way.
- [ ] Leave `GHOST_BRAIN_MODE=claude` in `.env`. It is the most reliable setting for computer tasks.
      `bin/ghost-showcase` handles the other showcase settings for you (see section 2). That includes
      the browser: it uses `playwright` even though `.env` says `extension`, so leave `.env` alone.

### Privacy sweep (do not skip this)
Visitors will read your screen and hear what Ghost-Prime says.
- [ ] **Memories:** open Settings (the sliders icon at the top right) and go to Memory. Read every
      memory and **delete anything you wouldn't want read aloud to a stranger**. "What do you know about
      me?" reads them out.
- [ ] **Chat history:** the sidebar shows old chat titles. Delete the ones that are private, or collapse
      the sidebar (the panel button left of "New chat") before visitors arrive.
- [ ] **Files:** never ask it to list your home folder or Downloads on the big screen. Don't open the
      Files app on the projector. Demo 2 writes into its own `Showcase` folder for this reason. (The four
      example buttons on the start screen are rehearsed demos and safe to click: photosynthesis, free
      space, the water reminder and "short, simple answers".)
- [ ] **Browser:** the launcher drives a separate, clean browser profile. Don't sign in to anything in it.
- [ ] **Notifications:** on the day, turn on ChromeOS **Do Not Disturb** so personal messages don't pop
      up. Ghost-Prime reminders still appear in the chat and are read aloud.

### Test every demo (the real app, the real settings)
- [ ] Start it the showcase way: `bin/ghost-showcase --restart`. Check that the line it prints says
      `browser=playwright`, the tested built-in browser.
- [ ] Do the setup steps in section 2, then run **every demo in section 3 twice**. Write your times in
      the "Your time" column. If a demo fails twice, drop it from your list.
- [ ] Run Demo 5 once early. The first browser launch creates the clean profile, and that launch is slower.
- [ ] Try the **bonus** demos (section 4) only if you want them. If they don't work end to end today,
      they are "next" tomorrow, not a demo.
- [ ] Rehearse **Plan C** once (section 6) and check that you can hear the replay speak.

---

## 2. At the booth: setup (15 minutes before visitors)

1. Plug in the charger. Connect to the network you chose. Turn on Do Not Disturb. Close other apps and
   tabs, because the Chromebook needs its memory for the AI and the browser.
2. Open the **Terminal** app (Linux) and run:
   ```bash
   cd ~/Projects/Ghost-Prime
   showcase/demo/preflight.sh          # 10 seconds; every line should be OK
   bin/ghost-showcase --restart        # starts Ghost-Prime with the showcase settings
   ```
   The launcher sets **`GHOST_BROWSER_BACKEND=playwright`** for you: Ghost-Prime's own clean browser
   window, the tested path (FACTS.md §8.2). It ignores the `extension` setting in `.env`, so you don't
   need to open `.env`. It also turns off surprise check-ins, background summaries, Canva and Discord.
   **Check the line it prints: it must say `browser=playwright`.** If it says anything else, or shows a
   WARNING, open a new terminal tab and run `bin/ghost-showcase --restart` again. The intro video
   plays once. Let it play for the people watching, or click to skip it.
   The launcher also turns on **presenter mode**: big text you can read from 2–3 metres, the chat
   history tucked away, and the badge starts at **AUTO** instead of FULL AUTO. Type `/showcase off` if
   you need the normal layout (for example to reach Settings' memory list), and `/showcase on` to go back.
3. **Window:** maximise Ghost-Prime (the square button at the top right). For Demo 5, snap Ghost-Prime
   to the left half (**Alt + [**). When the browser window opens, snap it to the right (**Alt + ]**).
   Presenter mode already uses big text, and it still fits when the window is snapped to half the
   screen. On a projector, **Ctrl + the window-switcher key** switches mirroring on and off.
4. **Settings, typed into the chat box:**
   - Check the badge at the top says **AUTO** (the showcase launcher starts there). If it doesn't, type
     `/mode auto`. Plain Ghost-Prime starts in FULL AUTO: never demo in FULL AUTO.
   - `/voice on`. Answers are read aloud.
   - `/site strict`, then `/site allow wikipedia.org`, then `/site allow example.com`, then `/site list`
     to check. Now the browser only goes to those sites.
   - `/status`. Check that it says **mode auto**. The brain shows as a small **CLAUDE** tag on each
     answer (the sound check in step 6 shows it).
   - Press **Ctrl+N** for a fresh chat. Presenter mode keeps the chat history hidden; if you left it,
     type `/showcase on` again.
5. **Volume:** set the ChromeOS volume to about 80%. If Ghost-Prime is quiet, run
   `pactl set-sink-volume @DEFAULT_SINK@ 100%` in the terminal (this is the Linux side's own volume).
6. **Sound check:** type *"Say hello to the judges."* (Demo 0). You should hear the answer.
7. **Plan C ready:** if the preflight shows more than 1.5 GB of free memory, open a second terminal tab
   and run `showcase/demo/replay.sh` now. That leaves a replay tab ready in Chrome, and switching to it
   takes 2 seconds. Otherwise start it only if you need it (about 20 seconds).

**Talking vs typing:** click the **mic** button (or press **Ctrl+Shift+G** to jump to the chat box),
speak, and click the mic again to send. The hall will be noisy, so **speak the short phrases** (Demos 1,
4, 6) and **type the long ones** (Demos 2 and 5). Say "I'll type this one because it's long, but I
could say it."

---

## 3. The demos, most reliable first

Times are estimates. Replace them with your own times from rehearsal. The "Replay" column is the time
the Plan C replay takes (measured on 25 Sep). The replay is faster than the live app, so don't promise
visitors the replay speed.

| # | What it shows | Say or type (exact) | Estimate | Replay | Your time | FACTS.md |
|---|---|---|---|---|---|---|
| 0 | Sound check and greeting | *Say hello to the judges.* | 5–10 s | ~2 s | | WORKING (chat) |
| 1 | Terminal, no commands needed | *How much free space is left on this Chromebook?* | 10–20 s | ~5 s | | WORKING |
| 2 | Makes a study plan, then undo | *Make me a three-day chemistry revision plan…* then *Actually, undo that.* | 15–30 s + 5–10 s | ~6 s + ~3 s | | WORKING |
| 3 | Remembers you | *Remember that I'm in [YOUR CLASS]…* then (new chat) *What do you know about me?* | 5–10 s each | ~4 s each | | WORKING |
| 4 | Reminders | *Remind me in two minutes to drink some water.* | 5–10 s (+2 min) | ~3 s | | WORKING |
| 5 | Reads the web for you | *Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.* | 30–60 s | ~15 s | | WORKING |
| 6 | Quick questions | *What's my battery level?* / *What's the weather in Kigali right now?* | 5–15 s each | ~3–5 s each | | battery WORKING, weather WORKING (manual) |
| 7 | Safety: read-only PLAN mode | Shift+Tab to PLAN, then *Delete the Showcase folder.* | 10–20 s | ~4 s | | WORKING (manual) |

**If a judge has only 2 minutes:** do Demo 1, then 3, then 5. Skip 5 if the network is slow today.
Demo 4 is a nice extra: set the reminder early, and it interrupts you two minutes later.

### Demo 0: sound check and greeting
- **Type:** `Say hello to the judges.`
- **They see:** the answer appears word by word, with a **CLAUDE** tag showing which AI answered, and
  Ghost-Prime reads it aloud.
- **If it fails:** no sound means turning the ChromeOS volume up and checking that `/voice on` is set.
  If no answer comes after 20 s, you have an internet or Claude problem, so go to section 5.

### Demo 1: the terminal, no commands needed
- **Say:** `How much free space is left on this Chromebook?`
- **They see:** a **terminal** slides open at the bottom. Ghost-Prime types a disk command (usually
  `df -h`) and runs it where everyone can watch. Then it answers in plain words (on 25 Sep: about 22 GB
  free of 50 GB).
- **Point to make:** "You don't need to know commands. Ask in normal words and watch it work."
- **Afterwards:** close the terminal with the **⌄** button so the answers have room.
- **If it fails:** if the terminal shows "Couldn't open a terminal", skip to Demo 3. If there's no answer
  after 30 s, press the ■ stop button in the Activity panel and ask once more.

### Demo 2: a study plan, with undo
- **Type:** `Make me a three-day chemistry revision plan and save it in a new folder called Showcase, so I can undo it if I change my mind.`
- **They see:** a **file_create** card with the path `~/Showcase/chemistry-revision-plan.txt`, and a short
  plan (Day 1 learn, Day 2 practise, Day 3 test yourself) read aloud.
- **Then say:** `Actually, undo that.`
- **They see:** an **undo_last** card ("Undid: create …"). The file is gone.
- **Point to make:** "Moves, deletes and new files can be undone, so a mistake isn't a disaster."
- **If it fails:** if undo says "nothing to undo", it saved the file a different way. Say "delete that
  file", then "undo that", and it comes back. If that fails too, move on.

### Demo 3: it remembers you
- **Say:** `Remember that I'm in [YOUR CLASS] and my favourite subject is chemistry.` (Say your real class.)
- **They see:** a **memory_save** card and "Got it, I'll remember…".
- **Then:** press **Ctrl+N** (a brand-new chat) and say `What do you know about me?`
- **They see:** it lists what it remembers, including what you just told it, in a chat that never heard
  it. It reads the list aloud.
- **Point to make:** "It remembers me from one day to the next, stored on this Chromebook."
- **Before the showcase:** do the privacy sweep of memories (section 1).
- **If it fails:** if it says it knows nothing, ask "What do you remember about my favourite subject?".

### Demo 4: reminders
- **Say:** `Remind me in two minutes to drink some water.`
- **They see:** a **reminder_set** card with the time. **Two minutes later**, "⏰ Reminder: drink some
  water" appears in the chat and is read aloud (and pops up as a notification unless Do Not Disturb is on).
- **Point to make:** "Good for students: revision, homework, medicine."
- **If it fails:** if the reminder doesn't fire, don't bring it up again. Carry on.

### Demo 5: it reads the web for you (the main demo)
- **Type:** `Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.`
- **They see:** a browser window opens. Ghost-Prime goes to Wikipedia, types "photosynthesis" into the
  search box by itself, and opens the article. The cards show each step (numbered buttons, a screenshot).
  Then it explains it in three simple sentences and **reads it aloud**. If that browser shows a bar saying
  it is being controlled by automated software, that's normal.
- **Point to make:** "For someone who struggles to read small text, or to type, it reads the web for
  them and explains it simply."
- **If it fails:** if the site is slow or blocked, type `Open example.com and tell me what it says.` (a tiny
  page that loads anywhere). With no internet, use Plan C for this demo.

### Demo 6: quick questions
- **Say:** `What's my battery level?` then `What's the weather in Kigali right now?`
- **They see:** a **system_power** or **weather_get** card, then a one-line spoken answer.
- **Known quirk (FACTS §8.6):** Claude's instructions wrongly tell it that it doesn't have these tools. It
  may use a terminal command or a web search instead, or refuse. **Test it the day before.** If it
  misbehaves, type `/brain gemini` before this demo and `/brain claude` straight after. Battery through
  Gemini was tested on 25 Sep.
- **Say the credit:** "the battery and weather tools come from the open-source MARK LIII JARVIS project."
- **Don't demo screen brightness.** The Linux side of a Chromebook can't change it. Ghost-Prime will say
  so and point to the brightness keys, which is honest but not impressive.

### Demo 7: safety, read-only PLAN mode (for teachers)
- **Do:** press **Shift+Tab** until the badge says **PLAN** (or type `/mode plan`). Then say `Delete the Showcase folder.`
- **They see:** it **does not** delete anything. It explains what it *would* do and says to switch mode if
  you mean it.
- **Then:** press Shift+Tab until it says **AUTO** again (or `/mode auto`).
- **Point to make:** "A teacher can make it read-only. There's no 'are you sure?' pop-up yet. That's next."
- **Why this folder:** if PLAN mode were ever off by mistake, the only thing at risk is the demo folder.
  **Never** use a real folder (Downloads, Documents) for this demo.

---

## 4. Bonus demos (only if tested the day before)

These are **BUILT, NOT TESTED ON A REAL DEVICE** in FACTS.md. If they didn't work end to end on 28 Sep,
don't show them live. Say they're next, and show the simulator screenshots labelled "simulated" if
the slides have them. If they did work, update FACTS.md first, with what you tested.

### B1: control the Android phone (Galaxy A05)
- **Say:** `Open YouTube on my phone.`
- **Needs:** the connector app installed on the phone, with Accessibility and screen-capture permission. It
  also needs a **private** `GHOST_BRIDGE_TOKEN`, and `GHOST_BRIDGE_HOST=0.0.0.0` when you start the app
  (`GHOST_BRIDGE_HOST=0.0.0.0 bin/ghost-showcase --restart`). The phone and the Chromebook must be on the
  **same network that lets devices talk to each other**. Use the phone's own hotspot, because school
  Wi-Fi usually blocks this. You will probably also need ChromeOS to forward port 8731 to Linux
  (Settings → About ChromeOS → Developers → Linux → Port forwarding). Pair with *"Pair my phone"* and
  scan the QR code.
- **If it isn't connected:** Ghost-Prime says "no Ghost-Prime phone is connected". That's your cue for the
  honest line about the phone.

### B2: your own Chrome, through the extension
- The school has blocked developer-mode extensions on this Chromebook, so this almost certainly can't be
  shown. The launcher always uses Ghost-Prime's own tested browser (`browser=playwright`), even if the
  extension is connected.
- Only if you got it working end to end on 28 Sep (and updated FACTS.md): start with
  `GHOST_BROWSER_BACKEND=extension bin/ghost-showcase --restart` for this one demo. Straight afterwards,
  go back with plain `bin/ghost-showcase --restart` and check that it says `browser=playwright` again.

---

## 5. When something goes wrong

| What you see | Do this |
|---|---|
| No answer at all after 30 s | Press the **■ stop** button next to the task (Activity panel, right), ask once more. If it fails again, check the internet (section 2 preflight) and go to Plan C. |
| "Claude … not logged in" or usage-limit message | For simple demos (memory, reminder, battery), type `/brain gemini`, the free brain. Battery was tested with it; the rest is less tested. Otherwise Plan C. |
| Mic does nothing, or the words come out wrong | Type instead. Gemini voice broken: `GHOST_VOICE_PROVIDER=local bin/ghost-showcase --restart` (offline Whisper + espeak-ng voice). |
| No sound | ChromeOS volume up; `/voice on`; `pactl set-sink-mute @DEFAULT_SINK@ 0`. |
| Browser window doesn't appear (Demo 5) | Wait 10 s (the first launch is slow). Then try `Open example.com and tell me what it says.` Then Plan C for Demo 5 only. |
| "Site not allowed" | You're in strict mode: `/site allow <that-site.org>`, or pick an allowed site. |
| The app window disappeared | `bin/ghost-showcase --restart` (about 15 s). |
| "Ghost-Prime is already running WITHOUT the showcase settings" | Use `bin/ghost-showcase --restart`. |
| The start-up line doesn't say `browser=playwright`, or shows a WARNING | Open a new terminal tab (it forgets settings typed earlier), run `bin/ghost-showcase --restart`, and check that it says `browser=playwright`. |
| A visitor asks for something you haven't tested | "Let's try it!" is fine for harmless questions. Say no to anything that deletes, buys, posts or logs in. |

---

## 6. Plan C: the offline replay

The replay is the **real Ghost-Prime interface** running in Chrome with a scripted "brain". The tool cards,
live terminal, activity panel, reminders and memory list all look and behave like the app. The answers
are pre-written for the rehearsed phrases above. It needs **no internet**, because the fonts, the 3D core
(three.js) and the scripts are all local files. It was tested with every outside connection blocked.

**Start it** (in the Linux terminal):
```bash
cd ~/Projects/Ghost-Prime
showcase/demo/replay.sh            # starts the local preview server if needed, opens the page in Chrome
```
Or by hand: run `npm run design` in one terminal, then open
**http://localhost:5199/?skipIntro=1&replay=1** in Chrome (http://127.0.0.1:5199/… inside Linux).
Press the full-screen key. Options: `replay.sh --quiet` (adds `&speak=0`, so answers are not read aloud)
and `replay.sh --linux` (opens it in the Linux Chrome as an app window). Stop the server with **Ctrl+C**
in its terminal.

**Use it:**
- Type the same phrases as in section 3. The matching is loose, but stick to the cue card. Ctrl+N (new
  chat) before *"What do you know about me?"*, `/mode plan` for Demo 7, `/mode auto` and `/voice on`
  all work the same way as in the app.
- **It talks:** every answer is read aloud with Chrome's built-in voice (British English if the Chromebook
  has one; ChromeOS has offline voices). The Linux Chrome may be silent, which is why the default is
  ChromeOS Chrome. Check the sound during the day-before rehearsal.
- **The mic** in replay uses Chrome's own speech recognition, which needs the internet. Offline, the badge
  says "please type", so type.
- Anything it wasn't scripted for gets an honest answer: "I'm running as an offline replay… here's what I
  can show". Battery shows the Chromebook's **real** battery level when Chrome allows it.
- **Start again from scratch:** reload the page (F5).
- **Honesty:** a small **"Offline replay · scripted demo"** badge stays in the bottom-left corner. Say the
  Plan C line from section 0 **before** you start.

**Check the replay still works** after anyone changes the app's design (needs the preview server running):
```bash
node showcase/demo/verify-replay.mjs      # types every phrase, screenshots each one, fails on any error
```

---

## 7. After the showcase

- `/site open` puts the browser back to "allow all except blocked sites".
- Start Ghost-Prime normally again (the app icon or `ghost-prime`). The showcase settings only apply when
  you use `bin/ghost-showcase`.
- If you don't want to keep them, delete the demo memory (Settings → Memory) and the `~/Showcase` folder.

---

## Cue card (print this)

```
0  Say hello to the judges.
1  How much free space is left on this Chromebook?      (then close terminal: ⌄)
2  Make me a three-day chemistry revision plan and save it in a new folder
   called Showcase, so I can undo it if I change my mind.
   Actually, undo that.
3  Remember that I'm in [YOUR CLASS] and my favourite subject is chemistry.
   Ctrl+N  ->  What do you know about me?
4  Remind me in two minutes to drink some water.               (fires in 2 min)
5  Go to the Wikipedia website, search for photosynthesis, and explain it
   to me in three simple sentences.
   backup: Open example.com and tell me what it says.
6  What's my battery level?  /  What's the weather in Kigali right now?
   (if it refuses: /brain gemini ... then /brain claude)
7  /mode plan (badge: PLAN)  ->  Delete the Showcase folder.  ->  /mode auto

SETUP: bin/ghost-showcase --restart   ->  check it prints: browser=playwright
       /mode auto · /voice on · /site strict · /site allow wikipedia.org
       /site allow example.com · /site list · Ctrl+N
PLAN C: showcase/demo/replay.sh
        say: "Here's a replay; these answers are scripted, not live."
```
