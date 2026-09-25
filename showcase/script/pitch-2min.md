# Ghost-Prime: the 2-minute pitch

**Target:** 2:00, including the live demo. You say about 200 words, which takes about 1:25 at an
easy pace (140 words a minute). The other 35 seconds or so belong to Ghost-Prime: about 6 s to give
it the request, and about 20–30 s while it reads its answer aloud. These are estimates. Your own
stopwatch times (below) are the real ones.
**Rule:** every sentence below matches `showcase/FACTS.md` (checked 25 Sep 2026). Don't add
claims. If you change a line, check it against FACTS first.

**The one demo sentence (the "hero phrase").** It is the same, word for word, in this script, in
`showcase/demo/DEMO.md` (Demo 5 and the cue card), on the poster and in the slide 4 notes. It is also
scripted in the offline replay (Plan C). Don't change it on the day.

> **Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.**

**How to read the cues**

- **[pause]**: stop for one breath and look at the judges.
- **[demo]**: do the action written next to it.
- *(Text in brackets and italics)*: the first line to drop if your rehearsal runs over 2:00.
- Text in "quotes" after **Say to Ghost-Prime** is what you speak into the mic.

---

## Why the demo starts in the first 20 seconds

The web demo is the slowest one. DEMO.md estimates **30–60 seconds** before the answer comes, and
it has never been timed on the showcase setup. So you **start it straight after the hook** and talk
about the problem while it works. By the time you have explained the problem and the idea, it should
be ready to read its answer aloud. You never stand in silence waiting for it.

---

## Rehearse and time it (27–28 September)

Nobody has timed this pitch yet. The times in this script are **estimates** from word counts and
from DEMO.md. Do two full run-throughs **on the showcase Chromebook, over your phone hotspot**, with a
stopwatch, and write the real times here:

| Run | Date | Network | Send → answer starts (s) | Answer read aloud (s) | Whole pitch (m:ss) | Talked or typed? |
|---|---|---|---|---|---|---|
| 1 | | | | | | |
| 2 | | | | | | |

Also check, on that Chromebook and that hotspot:

- **Mic → text:** click the mic, say the hero phrase, and check that the words come out right.
- **Spoken replies:** the answer is read aloud loudly enough to hear from 2 metres away.
- Voice is only checked by hand so far (FACTS §2, "WORKING (manual)"). When both work, write the
  date and "checked on the showcase Chromebook over the hotspot" into the voice rows of FACTS.md.

**Decide after rehearsal.** If "send → answer starts" took **more than 50 seconds in both runs**,
use the **fast version** for the timed slot (at the bottom of this page). It uses Demo 1, which
DEMO.md estimates at 10–20 seconds. Keep the hero phrase for the booth, where time is not fixed.

---

## Before your slot (10 minutes before)

1. Start the app with `bin/ghost-showcase --restart` (DEMO.md, section 2).
2. Type `/mode auto` until the badge says **AUTO**. Not **FULL AUTO** in public. Not **PLAN**
   either: PLAN only looks and never clicks, so the demo would stop.
3. Type `/voice on`.
4. Type `/site strict`, then `/site allow wikipedia.org`, then `/site allow example.com`, then
   `/site list` to check. These are the same two sites as DEMO.md (example.com is the backup page).
5. **Warm up the browser.** Type `Open example.com and tell me what it says.` The first browser
   launch is the slow one (DEMO.md), so this gets it out of the way. Leave that browser window open,
   snapped to the right (**Alt + ]**), with Ghost-Prime on the left (**Alt + [**).
6. Press **Ctrl+N** for a fresh chat, and hide the chat history.
7. **Talk or type?** Listen to the room. If the mic got the hero phrase right when you tried it here
   at the venue, you'll speak it. If the hall is too loud, you'll type it. Decide now, not in the
   middle of the pitch.
8. The backup recording is ready on your phone or laptop, **only if you made one**.

---

## The script

### 1. Hook, and start the demo (0:00 to 0:20)

Hi, I'm **[YOUR NAME]** from **[YOUR CLASS]** at **[SCHOOL]**. **[pause]**

What if you could use a computer just by talking? I could type this, but watch me just talk.

**[demo: click the mic button]**

**Say to Ghost-Prime:** "Go to the Wikipedia website, search for photosynthesis, and explain it to
me in three simple sentences."

**[demo: click the mic button again to send]**

> **If you decided to type:** say "I could say it, but the hall is loud, so I'll type it." Type the
> same sentence and press Enter.

It may say a short line such as "Let me pull that up." That means it has started. Carry on.

### 2. Problem, while it works (0:20 to 0:40)

While it works, here's the problem. Lots of people get stuck on computers. Some type slowly. Some
can't read small text. A chatbot only tells you the steps. You still do them yourself. **[pause]**

### 3. The idea (0:40 to 1:00)

Ghost-Prime does the steps for you. **[point at the browser]** Look: it's using the browser by
itself. It numbers every button and link, then picks the right one. **[point at the step cards]**
Every step shows up here.

It runs on this normal school Chromebook, **[touch the Chromebook]** with no pay-per-use bills:
Google's free AI, plus a Claude subscription I already had.

### 4. The answer (about 1:00 to 1:25)

**[When it starts reading its answer aloud, stop talking, wherever you are in the script, and let it
finish. Don't talk over it. Then carry on from where you stopped.]**

If it hasn't started by about **1:05**, say: "It uses AI over the internet, so it takes a moment."
Then go on to part 5, and stop when it speaks.

### 5. What's new, and who it's for (1:25 to 1:45)

Chromebooks can already type what you say or read text aloud. Ghost-Prime does the whole job from
one sentence. **[pause]**

It's for students who type slowly, people who struggle with small screens, and busy teachers. *(And
it remembers you from day to day.)*

### 6. Ask (1:45 to 2:00)

I built it over three months. I designed it, decided what it should do, tested it, and used an AI
coding assistant to write much of the code. **[pause]**

My ask: help me test it with real students and teachers who find computers hard. Thank you!

> **Change the "I designed it…" sentence** so it says exactly what **[YOUR NAME]** did. Use the same
> sentence in `qa.md` (question 4) and on the pitch card. Don't make your part bigger or smaller.

---

## If the demo goes wrong (stay calm, never pretend)

| What happens | What you say and do |
|---|---|
| No answer by about 1:05 | "It's thinking. It uses AI over the internet, and the Wi-Fi here is busy." Carry on with part 5, and stop when it speaks. |
| The mic doesn't work, or the words come out wrong | "Voice needs the internet too. Let me type it instead." Type the same sentence and press Enter. |
| "Site not allowed" | You missed step 4 of the setup. Say "I've locked it to safe sites, and I missed one." Type `/site allow wikipedia.org` and ask again, or move on. |
| It clicks the wrong thing or gets stuck | "That's a real AI making a real mistake. That's why it shows every step." Press **Stop** and move on. |
| Nothing works at all | "That's live tech! Here's a recording of it doing the same thing." Show the backup video **only if you recorded one**. If you didn't, say "I'll show you at the booth." |

**Never** say it worked if it didn't. Judges respect "it failed, and here's why" much more than a
cover-up.

## If you have extra time (the demo was quick)

- "It can also move and delete files, and if it gets it wrong, I just say 'undo that'."
- "Normally it picks between two AI brains for each message: Google's Gemini for quick things, and
  Claude for hard computer jobs. For the showcase I've pinned it to Claude for reliability, so every
  answer today shows a CLAUDE tag."
- "Next: the same thing on a cheap Android phone. The phone app is built and works on a simulated
  phone. Testing it on my real Galaxy A05 comes next."

## The fast version (only if your rehearsal said the web demo is too slow)

Keep the whole script, and change only these lines:

- **Part 1:** after "watch me just talk", **Say to Ghost-Prime:** "How much free space is left on
  this Chromebook?" (Demo 1 in DEMO.md, word for word. Its estimate is 10–20 seconds, so it may
  answer during part 2. Stop and let it speak, as in part 4.)
- **Part 3,** instead of the browser lines: "Look: it opened a terminal and typed the command itself.
  You don't need to know any commands. Every step shows up here." **[point at the terminal and the
  step cards]**
- **Part 5,** add after "the whole job from one sentence": "At the booth I'll show you it reading
  Wikipedia for me."
- Afterwards, close the terminal with the **⌄** button.

## Lines you must NOT add (FACTS.md says they aren't true or aren't tested)

- "It controls my phone." The phone app is built but **not tested on a real phone**.
- "Just say 'hey Ghost'." The wake word is **not installed**. Use the mic button or Ctrl+Shift+G.
- "It always asks before doing anything." **Nothing asks "are you sure?" yet.** That's planned.
- "It's completely free" or "It works offline." Claude needs a subscription, and everything except
  the backup voice needs the internet.
- "It's the first" or "the only" assistant like this. Say what it does, not that nobody else does it.
- "It works in Kinyarwanda." Not yet (see `qa.md`, question 9).
- "It can control any app." It can't. It uses its own browser window, a terminal and your files.
- "Watch it read this picture." On the day it is pinned to Claude, and pictures on the Claude brain
  are only checked by hand. Don't offer a picture demo unless you rehearsed it on the Claude brain.
