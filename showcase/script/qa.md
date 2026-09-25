# Ghost-Prime: judge and visitor Q&A

These are the 22 questions you're most likely to get, with short, true answers you can say out
loud. Every answer matches `showcase/FACTS.md` (checked 25 Sep 2026 against commit `51d8839`).

**How to use this sheet**

- **Say:** is your answer. Two or three sentences, then stop. Short and confident beats long.
- **If they push:** is the extra detail, only if they ask a follow-up.
- **Don't say:** is a trap. It sounds good, but it isn't true or hasn't been tested.
- Anything in `[square brackets]` is something **only you** can fill in. Never invent it.

**Three golden rules**

1. If you don't know, say: "Good question. I haven't tested that yet." Then write it down. Judges
   trust a student who knows the limits of their project.
2. Say "built" for things that exist, and "working" only for things that are tested. The phone app
   is **built**. Browsing, files and memory are **working**: automated tests or checks pass. Voice
   **works in the app, checked by hand** (no automated test yet), so say "it works in my own
   testing", not "it's tested".
3. Be proud of what you did yourself, and be open about the AI help (question 4).

---

## 1. Why did you build it?

**Say:** [Your real reason, in one or two sentences. For example, a moment when you or someone you
know struggled with a computer, or when you wished a chatbot would just *do* the thing. Don't make
one up. A small, true story beats a big, invented one.]

## 2. Who is it for?

**Say:** Anyone who finds computers hard work: students who type slowly, people who struggle to
read small text, people who don't know where to click, and busy teachers. It runs on a normal school
Chromebook, not an expensive computer, and there's no pay-per-use bill.

**If they push:** You can talk to it or type to it, and it can read its answers out loud, so it
helps both people who find typing hard and people who find reading hard.

## 3. How much does it cost to run?

**Say:** There's no pay-per-use bill and no servers to rent. The voice and quick answers use Google's
Gemini on its free tier. Harder computer jobs use Claude, on a Claude subscription I already had.
That subscription isn't free, but if its allowance runs out, Ghost-Prime just pauses. It never
charges extra.

**If they push:** It can also run on Google's free tier alone. That mode is weaker at long,
multi-step jobs, and I'm still testing it. The hardware is a school Chromebook with an Intel Core i3
processor. No gaming PC is needed.

**Don't say:** "It's completely free." (The Claude subscription costs money.)

## 4. What did YOU build, and what comes from Google and Anthropic?

**Say:** Google and Anthropic make the AI brains, the part that understands language. Everything
around the brains is Ghost-Prime: the app, the voice system, the tools that let it use a browser, a
terminal and files with undo, its memory and reminders, the part that picks which brain answers each
message, and an Android phone app. I designed it, decided what it should do, tested it, and used an
AI coding assistant to write much of the code. The assistant is called Claude Code, and every saved
version of the project says so.

**If they push:** The quick controls for volume, brightness, battery, weather and YouTube are
adapted from an open-source project called MARK LIII JARVIS by FatihMakes, and I credit it. The
intro video was made with an AI video tool called Higgsfield.

**If they ask to see the Gemini brain answer:** "For the showcase I've pinned it to Claude for
reliability, so every answer today shows a CLAUDE tag. Normally it picks a brain for each message."
If they still want to see Gemini, type `/brain gemini`, ask one simple question (for example "What's
my battery level?", tested with Gemini on 25 Sep), then type `/brain claude` straight after.

**Before the showcase:** change this answer so it describes **exactly** what you did. Don't make
your part bigger or smaller than it really was.

## 5. Is it safe? Could it do something dangerous?

**Say:** It has three modes. In **PLAN** mode it can only look and never changes anything. In
**AUTO**, Claude runs an automatic safety check on each action. **FULL AUTO** does everything
without checks, so I don't use it in public. You can see every step it takes on screen, file changes
can be undone, and I can limit which websites it's allowed to open.

**Be honest about this:** It doesn't have an "Are you sure?" pop-up before big actions yet. That's
the next safety feature on my list.

**If they push:** The automatic safety check in AUTO only applies to the Claude brain. On the Gemini
brain, AUTO has no extra checks yet. Also, the phone app and the Discord remote control only accept
commands carrying a secret code or from people on an allowed list.

**Don't say:** "It always asks before it does anything." (Nothing asks today, and the app starts in
FULL AUTO unless you switch it.)

## 6. What if the AI does something wrong?

**Say:** It can make mistakes, like any AI. That's why it shows every step live, so you can see what
it's doing and press **Stop**. Its file changes have an undo, so if it moves or deletes the wrong
file, I just say "undo that." And if I'm not sure about a task, I use PLAN mode, where it can look
but not change anything.

**Check before the showcase:** press Stop once during a task and make sure it really stops. If it
doesn't, leave "press Stop" out of this answer.

## 7. Is it private? Where does what I say go?

**Say:** Honest answer: partly. Your chats, memories, reminders and files stay on the Chromebook.
But to think, it sends your request to the AI companies: to Anthropic for Claude, and to Google for
Gemini. Voice recordings go to Google to be turned into text, unless I switch on the offline voice
mode. On Google's free tier, Google can use what you send to improve its products. So my rule is:
don't tell it anything private.

**If they push (for schools):** Before real students used it, I'd switch to offline voice mode and
set up proper privacy rules with the school.

## 8. Does it need the internet?

**Say:** Yes, for the thinking. Both AI brains run online, so it needs Wi-Fi or a phone hotspot.
Voice has an offline backup: a small speech-recognition model called Whisper that runs on the
Chromebook itself, plus a simple robot voice. Your chats and memories are saved on the Chromebook.

**If they push:** The offline speech model only understands English.

**Don't say:** "It works offline."

## 9. Can it work in Kinyarwanda?

**Say:** Not yet, and here's the honest reason. The app's buttons and menus are in English. The
offline speech model only understands English, and the offline voice has no Kinyarwanda. The online
AI models understand many languages, so typing in Kinyarwanda might partly work, but I haven't
tested that, or tested speaking Kinyarwanda to it.

To do it properly, I'd need four things:

1. speech recognition that really understands spoken Kinyarwanda, tested with real speakers;
2. a Kinyarwanda voice to read the answers aloud;
3. the app's buttons and menus translated;
4. Kinyarwanda words added to the part that picks a brain, because right now it looks for English
   keywords like "open", "click" and "search".

It's high on my list, because that's what would make it truly useful here in Rwanda.

**Try before the showcase (optional):** type one simple question to it in Kinyarwanda. If the answer
is good, you may change the middle sentence to: "Typing to it in Kinyarwanda already works. Speaking
to it doesn't yet." Only say that if you have seen it work yourself.

## 10. Does the phone part work?

**Say:** It's built, but not finished. I made an Android app that lets Ghost-Prime see a phone
screen as a numbered list and tap, swipe, type and open apps. You pair it by scanning a QR code.
It passes all its tests on a simulated phone, but I haven't run it on my real Galaxy A05 yet, so I
call it "in progress." That's my very next step.

**Don't say:** "It controls my phone." (Not until you've seen it work on the real A05.)

## 11. How is this different from a normal chatbot?

**Say:** A normal chatbot answers you in text, and then you do the steps yourself. Ghost-Prime does
the steps: it clicks, types, runs commands and moves files on this computer while you watch. It
also remembers you from day to day, and you can do all of it by voice.

## 12. Chromebooks already have tools like this, and big companies sell AI agents. What's new here?

Tech judges often ask this first, and may name dictation, Select-to-Speak, ChromeVox or Google
Assistant. It's a fair question, so answer it calmly.

**Say:** Those tools are good, and Ghost-Prime works alongside them, not instead of them. Dictation
types your words, and Select-to-Speak or ChromeVox read text aloud, but you still do every step
yourself. With Ghost-Prime, one sentence becomes a whole job: it opens the website, searches, reads
the page and explains it simply, or it moves your files and can undo that. And it runs on a school
Chromebook, with no pay-per-use bill, and shows every step on screen.

**If they push ("But big companies already sell AI agents"):** That's true, and I'm not saying
nobody else does this. What I wanted was one that runs on the cheap school hardware we actually have,
costs nothing per use, shows every step, and can undo its file changes. Building it taught me how
these agents really work. Next I want to test it with the people it's meant for.

**Don't say:** "It's the first" or "it's the only one". "It replaces ChromeVox or dictation."

## 13. How long did it take?

**Say:** About three months. The first version is from 17 June 2026, and the project now has 58 saved
versions. It's now about 22,000 lines of code across the app, a Chrome extension and an
Android app, and much of that code was written with an AI coding assistant.

## 14. What was the hardest part?

**Say:** [Pick the one that felt hardest **to you**, and add a real moment you remember.]

- **Option A (the Chromebook):** ChromeOS keeps Linux apps in a locked box. They can't control
  other apps or see the whole screen, and my school blocks the developer mode that browser add-ons
  need. So I had to focus on what it *can* control: its own browser window, a terminal and files.
- **Option B (clicking the right thing):** Web pages are messy. I made it give every button, link
  and box on a page a number, and click by number. If the page changes, it has to look again
  instead of clicking the wrong thing.
- **Option C (bugs):** In one big review, 127 bugs were found and fixed in a single update.

## 15. How would schools use it?

**Say:** I can imagine three ways. First, a student who types slowly or struggles to read small text
can do research by talking and hear the answer read aloud. Second, teachers can hand it boring
computer jobs, like tidying folders, looking things up or setting reminders. Third, a computer club
can learn from it, because you can watch every step it takes, even the commands it types in its
terminal.

**If they push ("Could my school install it?"):** Not easily yet. Right now I install it by hand
from the source code, and it shows up in the Chromebook's app list. An easy installer is on my
roadmap. A school would need Chromebooks with Linux turned on, internet, a free Google AI key, and
ideally a Claude subscription. It would also have to meet the AI companies' age rules (question 16).

## 16. Could children or students under 18 use it?

**Say:** Not on their own yet, and I want to be careful about this. The AI services it uses have age
rules. Google's Gemini API terms say you must be 18 or older, and that apps built on it shouldn't be
aimed at under-18s. Claude's consumer terms also say 18 or older. So using it with students would
need a school or education setup that meets the AI providers' age rules and privacy rules. That's
part of why I'd work with teachers first.

**What the terms say (checked 25 Sep 2026; check again before the 29th):**
- Gemini API Additional Terms of Service (last modified 28 Apr 2026): "You must be 18 years of age
  or older to use the APIs." Apps built on it must not be "directed towards or … likely to be
  accessed by individuals under the age of 18."
- Anthropic Consumer Terms (effective 8 Oct 2025): "You must be at least 18 years old or the minimum
  age required to consent to use the Services in your location, whichever is higher."

**Before the showcase (important):** these rules apply to whoever set up the accounts, too. Talk to
your teacher or a parent about how your own use fits them. If a judge asks, answer truthfully. Don't
guess, and don't make anything up.

**Don't say:** "Kids can use it by themselves" or "it's made for children".

## 17. Have you tested it with people who struggle to type or read?

**Say:** Not properly yet. So far it's mostly been me testing it. That's exactly why my ask is to
try it with real students and teachers: I want to learn what works for them and what doesn't.

**If you HAVE let someone try it:** replace this with who tried it and one thing you learned.
Don't invent it.

## 18. How do you know it works?

**Say:** It has 23 automated test scripts. On 25 September, 13 of them ran 244 checks with zero
failures, plus live checks that both AI brains answer. Voice I've checked by hand in the real app;
it has no automated test yet. And anything that isn't tested on real hardware yet, like the phone,
I call "in progress."

**If they push:** The browser-control tests alone run 38 checks, on test pages in a hidden browser.

## 19. Can it control any app on the computer?

**Say:** No. ChromeOS doesn't let Linux apps control the rest of the screen, so it works through its
own browser window, a terminal and your files. That still covers a lot, because so much of what
students do happens on websites.

**If they push:** I also built a Chrome extension so it could use your normal Chrome tabs, but my
school blocks the developer mode it needs, so that part isn't tested on a real device yet.

## 20. What happens if the free AI runs out, or the internet is slow?

**Say:** Google's free tier has daily limits, and I've hit them while testing. The voice is
designed to fall back to an offline backup if Google fails, but I haven't tested that switch on
purpose yet. So I also have an offline voice mode I can turn on in about 15 seconds. If the Claude
allowance runs out, Claude just pauses. It never charges extra.

**If they push:** The app is also built to hand a message to the other AI brain when one is
unavailable, but that isn't tested either, so I don't count on it.

**Don't say:** "It switches over by itself" as if you've seen it happen. (If you test it before the
showcase, for example by starting the app once with a deliberately wrong Gemini key, and it works,
add that to FACTS.md first. Then you can say it.)

## 21. Couldn't students use it to cheat?

**Say:** Any AI can be misused, and I won't pretend otherwise. But Ghost-Prime is built for doing
computer jobs, like finding, opening, tidying and reminding, not for replacing your own thinking. A
teacher can also limit which websites it's allowed to open, and PLAN mode stops it changing
anything.

## 22. What's next?

**Say:** Four things, in this order:

1. Test the phone app on my real Galaxy A05.
2. Add an "Are you sure?" step before anything that can't be undone.
3. Kinyarwanda.
4. An easy installer, so other schools can use it without me setting it up by hand.

**If they push:** A hands-free "hey Ghost" wake word (the code exists, but it isn't installed or
tested yet) and a smarter memory search.

---

## Numbers you can quote (all from FACTS §6)

| Number | What it means |
|---|---|
| **About 3 months** | 17 June to 25 September 2026 |
| **58** | saved versions (commits) of the project |
| **About 22,000** | lines of code across the app, the Chrome extension and the Android app, much of it written with an AI coding assistant |
| **64** | tools the Claude brain can use (59 for the Gemini brain) |
| **244 checks, 0 failures** | 13 test scripts run on 25 Sep 2026, plus 2 live AI checks |
| **127** | bugs fixed in one review (20 Sep 2026) |

## Never claim these (they aren't true, or aren't tested yet)

- It controls a real phone. (Built, tested only on a **simulated** phone.)
- It uses your normal Chrome. (The extension isn't tested on a real device, and the school blocks it.)
- "Hey Ghost" hands-free wake word. (Not installed.)
- It always asks before acting. (Nothing asks yet. That's planned.)
- It's completely free, or it works offline.
- It speaks Kinyarwanda.
- It can control any app on the computer.
- Canva design. (Not verified.)
- It's the first or the only assistant like this.
- Children can use it by themselves. (The AI services are 18+; see question 16.)
- "Give it a picture and watch it read it", unless you rehearsed that on the Claude brain. (On the
  day it's pinned to Claude, and pictures on the Claude brain are only checked by hand.)
