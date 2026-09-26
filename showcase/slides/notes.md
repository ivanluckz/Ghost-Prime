# Ghost-Prime pitch: speaker notes

Open `slides.html` in Chrome and press **F** for full screen. **→ / Space / click** goes to the next slide and **←** goes back. **Home** and **End** jump to the first and last slide, and `slides.html#4` opens slide 4 (the live demo). `slides.pdf` is the same deck as a PDF.

Keep the whole `showcase` folder together. The slides load their screenshots from `../app-shots/` and their fonts from `assets/fonts/`, so they work offline. Every claim comes from `showcase/FACTS.md`, and the wording follows `showcase/DESIGN.md`. If something changes before the 29th (for example, you test the phone on the real A05), update FACTS.md first and the slides second.

To fill in your details, replace `[YOUR NAME]`, `[YOUR CLASS]` and `[SCHOOL]` in `slides.html`. Each one appears twice: on slide 1 and on slide 13. Then rebuild the previews and the PDF from the repo folder:
`node showcase/slides/render.mjs`

The screenshots on slides 3, 5 and 8 are the real app screen playing a scripted sample of the demo (the offline replay). Their caption says so: "The real app screen, with a scripted sample of the demo." Never describe them as something you did live. The demo you run on slide 4 is live.

## Timing

The full deck takes **about 7 minutes**, including the live demo. The demo alone takes about 1½ minutes, because the answer can take 30 to 60 seconds to start.

| # | Slide | Time |
|---|---|---|
| 1 | Title | 15 s |
| 2 | The problem | 30 s |
| 3 | The idea | 30 s |
| 4 | Live demo | about 90 s |
| 5 | It answers | skip it if the live demo worked |
| 6 | How it works | 40 s |
| 7 | What works today | 40 s |
| 8 | Safety | 35 s |
| 9 | Your data | 25 s |
| 10 | Cost | 25 s |
| 11 | Who it's for | 25 s |
| 12 | What's next | 30 s |
| 13 | Thank you | 20 s |

**If you have less time:**
- **About 5 minutes:** skip slide 5. On slides 6 and 9, say only the first sentence of the script. On slide 12, say only the first item.
- **About 3 minutes:** show slides 1, 4 (the demo), 7, 8, 11 and 13. Skip the others with **→**.
- **2 minutes:** don't use the deck. Use `showcase/script/pitch-2min.md`. It has its own timing for the same hero demo.

---

**1 · Title.** "Hello, I'm [YOUR NAME] from [YOUR CLASS] at [SCHOOL]. This is Ghost-Prime. It lets you use a computer just by talking. It's a voice assistant that does the task for you, and I built it on a school Chromebook, with no pay-per-use bills."

**2 · The problem.** "Computers are part of school life now, but they expect fast typing and small text. That's hard for students who type slowly, for people who find small text hard to read, and for people new to computers. Teachers are busy too. A chatbot only tells you the steps. You still have to do them yourself." (No statistics here on purpose. Keep it to what everyone in the room has seen.)

**3 · The idea.** "Ghost-Prime does the steps for you. You ask, by voice or by typing. An AI plans the steps. In today's demo, that's Claude. Then Ghost-Prime does them itself: it opens websites, clicks and types, handles files and runs commands. When it's done, it tells you, and it can read the answer aloud." Point at the screenshot: "This is the real app screen, with a scripted sample of the demo. Each card is one step. Now let me show you the real thing."

**4 · Live demo.** This is **Demo 5** in `showcase/demo/DEMO.md`, run in the live app you started with `bin/ghost-showcase --restart`. Read the sentence on the slide, then switch to the app: Ghost-Prime snapped to the left, its browser snapped to the right. Say the request if the mic got it right when you tried it at the venue. Otherwise type it.

> Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.

If you type it, say: "I could say it, but the hall is loud." Then describe only what it really does: "It's opening Wikipedia… it lists every button and box on the page with a number… it types photosynthesis into the search box… it opens the article… and now it explains it in three simple sentences." If voice is on, it reads the answer aloud. Stop talking and let it finish. Point at the step cards: "Every step shows up here, so you always know what it's doing." Point at the tag: "The CLAUDE tag shows which AI answered."

Expect **30 to 60 seconds** before the answer starts. While you wait, say: "It uses AI over the internet, so it takes a moment. A chatbot would only tell me the steps. Ghost-Prime is doing them." If nothing has happened after about a minute, press the red **Stop** button next to **Send** (presenter mode hides the other stop buttons) and type the backup: `Open example.com and tell me what it says.` If a site is slow or blocked, say so plainly.

The steps on the slide (with box number 6) come from the rehearsed sample. Live, the search box may get a different number. That's normal.

**No internet?** Use Plan C (`showcase/demo/replay.sh`), and say this before you start: "The internet here isn't cooperating, so here's a replay of the same demos. It's the real app's screen, but these answers are scripted, not live."

**5 · It answers.** If the live demo worked, skip this slide. If the live demo failed and you didn't use Plan C, show it and say: "This is the real app screen, with a scripted sample of the demo, so you can see what the answer looks like. I'll run it live for you at the booth."

**6 · How it works.** "Everything runs in one app on the Chromebook, and it drives real tools: a web browser, a terminal, files with undo, web search, memory and reminders. The thinking happens on the internet. In today's demo Claude does the thinking, so every answer shows a CLAUDE tag. Normally a router can also send quick questions to Google's free Gemini. Gemini also turns your voice into text, and there's an offline voice mode as a backup. Voice works in my own testing; the real mic and speaker are only checked by hand. The Android phone app and the Chrome extension are built. I've only tested them on a simulated phone and in a headless browser, so they're dashed and marked in progress."

**7 · What works today.** "Each line says how I checked it. Using websites, the terminal, files with undo, memory and reminders all passed automated tests on 25 September. Web search works in my own testing. Voice works in my own testing; the real mic and speaker are only checked by hand. Over 500 automated checks passed, and none failed: 523 checks in 34 offline test suites, on the night of 25 to 26 September. The Claude brain can use 64 tools, and I've been building Ghost-Prime for about three months."

(If asked: 64 includes the 7 tools built into Claude. The first commit was on 17 June 2026. The browser tests on the 25th drive a real browser on test pages without the AI. The AI driving the browser from start to finish was last checked on 20 September. Memory and reminders first passed on 20 September and were re-run on the 25th. For web search, the part that reads the results is tested offline with a saved search page, and a live search is checked by hand. Fetching a web page was checked once, on 25 September. For voice, only the logic has an automated test, with pretend speakers and a pretend Google. The two live checks that Claude and Gemini answer last passed on 25 September in the daytime. They were not part of the overnight run.)

**8 · Safety.** "An AI that clicks and types for you has to be safe, so you choose how much it can do. PLAN only looks. In AUTO, on the Claude brain, an automatic safety check decides each action. FULL AUTO runs everything. The showcase launch starts in AUTO; plain Ghost-Prime starts in FULL AUTO. To be honest: there's no 'Are you sure?' pop-up yet. That's next." Point at the screenshot: "This is the real app screen, with a scripted sample of the demo. In PLAN mode it explains what it would do, and it says it hasn't changed anything. The PLAN lock passes its automated checks." **Only if Demo 7 passed when you ran it live on 28 September**, add: "And I ran it live yesterday."

(If asked: the PLAN checks run offline, with a stand-in for Claude. On the Gemini brain, AUTO runs tools without asking, exactly like FULL AUTO. Today's demo uses Claude. You can also block websites or allow only a short list, file changes can be undone, and the local bridge only accepts a secret token.)

(Before you start: check the badge says AUTO. Don't use PLAN for the web demo, because PLAN only looks and never clicks. If Demo 7 changed anything when you ran it live on 28 September (DEMO.md section 1), write that into FACTS.md section 5, delete the `<figure>` on the Safety slide in `slides.html`, re-run `node showcase/slides/render.mjs`, and leave out the PLAN screenshot lines above. Presenter mode hasn't been tried on the Chromebook itself yet, so try it on the projector before the 29th.)

**9 · Your data.** "Your chats, memories, reminders and files are stored on the Chromebook. But each request sends the conversation, your top 8 saved memories, and the pages and screenshots it reads to the AI. Voice goes to Google unless offline voice is on. Google's free tier may use what you send, so don't tell it secrets."

(If asked: on Claude turns this goes to Anthropic, and on Gemini turns to Google. Voice recordings and the text of spoken answers go to Google. The chat database stays on the Chromebook.)

**10 · Cost.** "No pay-per-use bills. It runs on Google's free AI plus a Claude subscription I already had, and it can run on the free tier alone, though it's less capable at long tasks. The hardware is a Core i3 school Chromebook, with no gaming PC and no paid cloud servers. It's built with free, open-source tools: Electron, Playwright, SQLite, Whisper and three.js." (If asked: with extra usage credits turned off, the Claude subscription pauses when its allowance runs out and never charges more. Gemini's free tier has daily limits. I haven't tested the free-tier-only mode from start to finish yet. The open-source part is the tools. Ghost-Prime's own code is in a private repository.)

**11 · Who it's for.** "It's for students who type slowly: they can say it instead of typing it. It's for people who find small text hard to read: they can hear the answer instead of reading it. It's for people new to computers: plain words instead of menus. And it's for busy teachers, who can hand over the clicking and typing. I haven't tested it with these groups yet. That's my next step, and my ask." (Don't pitch it for young children. The AI services it uses are for people aged 18 and over; see `showcase/script/qa.md`, question 16.)

**12 · What's next.** "Here's what comes next, in order. First, test it with real students and teachers, especially people who find computers hard, to learn what really helps them. Second, try the phone app on a real Galaxy A05. So far I've only tested it on a simulated phone. Third, an 'Are you sure?' check before anything that can't be undone. Fourth, Kinyarwanda: understanding it, speaking it, and translating the menus. Fifth, an easy installer, so other schools can try it." (If asked about the Chrome extension: it passes its tests in a headless browser, but the school blocks developer-mode extensions on this Chromebook. Before you try the real phone, rebuild the phone app: the current APK can't connect. See FACTS.md, the phone row.)

**13 · Thank you.** "Murakoze, thank you! I'm happy to take questions. At the booth, tell me a topic and I'll ask Ghost-Prime about it." Then say how it was built, as it says on the slide: "I designed it, decided what it should do, tested it, and used an AI coding assistant, Claude Code, to write much of the code." Change that sentence, on the slide and here, so it says exactly what you did. Don't claim more or less than that. The small print credits the AI brains (Claude and Gemini), the intro video (AI-generated with Higgsfield; it plays when you start the app), the quick PC tools (battery, weather) from MARK LIII JARVIS by FatihMakes (CC BY-NC 4.0), and the fonts.

(At the booth you speak each visitor's request yourself, because voice recordings go to Google and the free tier has a daily limit. See `showcase/script/pitch-30s.md`. If a judge asks what's new compared with Chromebook dictation, Select-to-Speak, ChromeVox or Google Assistant, use the answer in `showcase/script/qa.md`, question 12.)

---

### Check before you present

- Follow `showcase/demo/DEMO.md` section 1 (the day before) and section 2 (at the booth). In short: start with `bin/ghost-showcase --restart` and check that the line it prints says `browser=playwright`. Check the badge says **AUTO**. Then type `/voice on`, `/site strict`, `/site allow wikipedia.org`, `/site allow example.com` and `/site list`, and press Ctrl+N. Leave `.env` alone: the launcher sets the browser for you.
- Run Demo 7 (PLAN mode) live once on 28 September. What happens decides what you say on slide 8.
- Voice in and voice out are only checked by hand. Try both on the showcase Chromebook, over the showcase Wi-Fi or hotspot, before the 29th. Keep offline voice ready as a backup: `GHOST_VOICE_PROVIDER=local bin/ghost-showcase --restart`.
- Presenter mode (big text, AUTO badge) hasn't been tried on the Chromebook itself yet. Try it on the real projector before the 29th.
- On the real projector, check from the back of the room that the thin lines between list rows (slides 2, 7, 9, 10, 11 and 12) and the edge of the step strip on slide 4 still show. If they disappear, change `--line: #1E2742;` near the top of `slides.html` to `--line: #33406A;` and re-run `node showcase/slides/render.mjs`. The words read fine either way.
- Plan C is `showcase/demo/replay.sh`. Rehearse it once, and say the Plan C line before you start it.
- Never show `.env` on screen.
