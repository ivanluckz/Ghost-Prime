# Ghost-Prime pitch: speaker notes

Open `slides.html` in Chrome and press **F** for full screen. **→ / Space / click** goes to the next slide and **←** goes back. **Home** and **End** jump to the first and last slide, and `slides.html#6` opens slide 6. `slides.pdf` is the same deck as a PDF. Keep the `assets/` folder next to `slides.html`. Every claim in the deck comes from `showcase/FACTS.md`. If something changes before the 29th (for example, you test the phone on the real A05), update FACTS.md first and the slides second.

To fill in your details, replace `[YOUR NAME]`, `[YOUR CLASS]` and `[SCHOOL]` in `slides.html` (each appears twice, on slides 1 and 11). Then rebuild the previews and the PDF from the repo folder:
`flock /tmp/claude-1000/design-capture.lock node showcase/slides/render.mjs`

Aim for about 30 seconds per slide, plus the demo.

---

**1 · Title.** "Hello, I'm [YOUR NAME] from [YOUR CLASS] at [SCHOOL]. This is Ghost-Prime, a voice assistant that lets you use a computer just by talking. I built it on a school Chromebook, and running it costs nothing per use."

**2 · The problem.** "Computers are part of school life now, but they expect you to type fast and read small text. That's hard for beginners and children, for people with hand or movement difficulties, and for anyone with weak eyesight. At school, time on a shared computer is short too. When the computer is the hard part, people miss out on what it could do for them." (No statistics here on purpose. Keep it to what everyone in the room has seen.)

**3 · The idea.** "Ghost-Prime turns that around. You click the microphone and say what you want, or you type it. An AI works out the steps, and then Ghost-Prime does them itself: it opens websites, clicks and types, handles files and runs commands. When it has finished, it tells you, and it can read the answer aloud."

**4 · Live demo.** "Let me show you." Run the demo from `showcase/demo/`. Say what is happening at each step: "I'm asking out loud… now it's opening the website… it's clicking… it's saving what it found… and now it reads the answer back." Point at the right-hand panel: "Every step shows up here live, so you always know what it's doing." The screenshot on the slide uses sample data. The demo itself is live. If the Wi-Fi or Google's free voice service fails, switch to offline voice or type the request instead, and say so openly.

**5 · How it works.** "Everything runs in one app on the Chromebook. Your voice is turned into text. Google's free Gemini does this, and there is an offline fallback. Then a 'brain router' picks which AI should handle the request: Claude for long, many-step tasks, or Gemini for voice and quick answers. The AI then uses Ghost-Prime's tools: a web browser, a terminal, files with undo, web search, memory and reminders. The Android phone app and the Chrome extension are built. They connect through a local bridge locked with a secret token, but I haven't tested them on real devices yet, which is why they're dashed and marked 'in progress'."

**6 · What it can do today.** "These all work today. Most of them pass automated tests. I have 23 test scripts, and when I ran them on 25 September, 244 checks passed and none failed. The two marked 'by hand', voice and web search, work in the real app but don't have an automated test yet. The AI can use 64 tools, and I've been building it for about three months." (If asked: 64 is the Claude brain's tool count, which includes 7 built into Claude. The 244 checks come from 13 offline test scripts. The first commit was on 17 June 2026.)

**7 · Safety & privacy.** "An AI that clicks and types for you has to be safe. You choose how free it is. PLAN only looks. In AUTO, on the Claude brain, Claude's own safety check decides each action, and on the Gemini brain AUTO runs without asking, like FULL AUTO. FULL AUTO runs everything. You can block websites or allow only a safe list, file changes can be undone, and only my own devices can connect. Your chats, memories and files stay on the Chromebook. Your request and the pages it reads go to the AI so it can answer. Voice goes to Google unless you switch to offline voice, and Google's free tier may use what you send, so don't tell it secrets. And to be honest: there is no 'Are you sure?' pop-up yet. That's next." (The app starts in FULL AUTO by default. Say which mode you're using for the demo, and use AUTO or PLAN with a short allow-list of sites.)

**8 · Cost.** "Running Ghost-Prime adds no new costs: no pay-per-use bill, no servers, no gaming PC. It runs on a school Chromebook with an Intel Core i3. The AI is Google Gemini's free tier plus a Claude subscription I already had. It can also run on the free tier alone, but it's less capable at long tasks. Everything else is free and open source." (If asked: with extra usage credits turned off, the Claude subscription pauses when its allowance runs out and never charges more. Gemini's free tier has daily limits.)

**9 · Who it helps.** "A student can say 'Open the page about photosynthesis and read it to me.' A teacher can say 'Remind me at five to mark the tests.' People who find typing or reading hard can speak instead of typing and listen instead of reading. And anyone new to computers can use plain words instead of hunting through menus and tiny buttons. When a computer is easy to use, more people can learn with it."

**10 · What's next.** "Some parts are built but not finished. Phone control passes its tests on a simulated phone, and the next step is a real Galaxy A05. Controlling my own Chrome works in tests, but it needs the school to allow extensions. The hands-free 'Hey Ghost' wake word is written but not installed yet. Planned next: an 'Are you sure?' check before big actions, an easy installer so other schools can try it, and smarter memory search. The goal is for anyone to use a computer and phone just by talking."

**11 · Thank you.** "Murakoze, thank you! I'm happy to take questions, and you can talk to Ghost-Prime yourself at the booth." Be open about how it was built: "I designed Ghost-Prime, decided what it should do and tested it, and I used an AI coding assistant, Claude Code, to write much of the code." Change that sentence to match exactly what you did. Don't claim more or less than that. The credits line on the slide says the same.

---

### Check before you present (from FACTS.md §8)

- Voice in and voice out are only checked by hand. Try both on the showcase Chromebook, with the showcase Wi-Fi or hotspot, before the 29th. Have offline voice (`GHOST_VOICE_PROVIDER=local`) ready as a backup.
- Set `GHOST_BROWSER_BACKEND=playwright` for the demo. The extension path is blocked by the school and hasn't been tested.
- Switch from FULL AUTO to AUTO or PLAN, and set site access to strict with a short allow-list.
- Never show `.env` on screen.
