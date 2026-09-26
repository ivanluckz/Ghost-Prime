# Ghost-Prime: judge and visitor Q&A

These are the 22 questions you're most likely to get, with short, true answers you can say out
loud. Every answer matches `showcase/FACTS.md` (checked 25 Sep 2026, updated after the overnight run
of 25 to 26 Sep) and the wording of the pitch.

**How to use this sheet**

- **Say:** is your answer. The **bold first sentence** works on its own: if time is short or a judge
  cuts in, say only that. Then two or three more sentences at most, and stop.
- **If they push:** is the extra detail, only if they ask a follow-up.
- **Don't say:** is a trap. It sounds good, but it isn't true or hasn't been tested.
- **Before the 29th:** is a job for you, not something to say. Do it before the showcase.
- Anything in `[square brackets]` is something **only you** can fill in. Never invent it.

**Three golden rules**

1. If you don't know, say: "Good question. I haven't tested that yet." Then write it down. Judges
   trust a student who knows the limits of their project.
2. Say "built" for things that exist, and "working" only for things that are tested. The phone app
   is **built**. Browsing, the terminal, files with undo and memory are **working**: automated tests
   pass. For voice, say: "Voice works in my own testing; the real mic and speaker are only checked
   by hand." (Only the voice logic has an automated test, with pretend speakers and a pretend
   Google.) Try voice live on the showcase Chromebook before the 29th.
3. Be proud of what you did yourself, and be open about the AI help (question 4).

---

## 1. Why did you build it?

**Say:** [Your real reason, in one or two sentences. For example, a moment when you or someone you
know struggled with a computer, or when you wished a chatbot would just *do* the thing. Don't make
one up. A small, true story beats a big, invented one.]

## 2. Who is it for?

**Say:** **It's for students who type slowly, people who find small text hard to read, people new to
computers, and busy teachers.** It runs on a normal school Chromebook, with no pay-per-use bill. I
haven't tested it with these groups yet. That's my next step, and my ask.

**If they push:** You can talk to it or type to it, and it can read its answers out loud, so it's
meant for people who find typing hard and people who find reading hard.

**Don't say:** "It helps people who struggle." (That sounds proven. Say who it's for, and that you
haven't tested it with them yet.)

## 3. How much does it cost to run?

**Say:** **No pay-per-use bills.** It runs on Google's free AI plus a Claude subscription I already
had, and it can run on the free tier alone (less capable at long tasks).

**If they push:** The Claude subscription isn't free. With extra usage turned off, Claude pauses at
its limit and never charges extra. Claude does the thinking in today's demo, so every answer shows a
CLAUDE tag. Normally a router can also send quick questions to Google's free Gemini, and Gemini
turns speech into text. I haven't tested the free-tier-alone mode end to end yet. The hardware is a
school Chromebook with an Intel Core i3 processor. No gaming PC is needed.

**If they ask to see Gemini answer:** say the brains line above. If they still want to see it, type
`/brain gemini`, ask one simple question, for example "What's my battery level?" (tested with Gemini
on 25 Sep), then type `/brain claude` straight after. Credit the tool as you show it: "The battery
tool comes from MARK LIII JARVIS by FatihMakes (CC BY-NC 4.0)."

**Before the 29th:** check that **extra usage is turned off** in your Claude account settings, and
write that and the date into FACTS.md §4 (DEMO.md §1). Until then, only say the "never charges extra"
line as a condition, the way it's written above.

**Don't say:** "It's completely free." (The Claude subscription costs money.)

## 4. What did YOU build, and what comes from Google and Anthropic?

**Say:** **Google and Anthropic make the AI brains. Everything around them is Ghost-Prime.** I
designed it, decided what it should do, tested it, and used an AI coding assistant (Claude Code) to
write much of the code. Every saved version of the project says so.

**If they push:** Ghost-Prime is the app, the voice system, the tools that let it use a browser, a
terminal and files with undo, its memory and reminders, the part that picks which brain answers each
message, and an Android phone app that isn't tested on a real phone yet. The quick controls for
volume, brightness, battery, weather and YouTube are adapted from MARK LIII JARVIS by FatihMakes
(CC BY-NC 4.0), and I credit it. The intro video was made with an AI video tool called Higgsfield.

**If they ask "Is it open source?":** No, Ghost-Prime itself isn't. It's built with free, open-source
tools (Electron, Playwright, SQLite, Whisper, three.js).

**Before the 29th:** change the "I designed it…" sentence so it describes **exactly** what you did.
Use the same sentence in `pitch-2min.md` and on the pitch card. Don't make your part bigger or
smaller than it really was.

## 5. Is it safe? Could it do something dangerous?

**Say:** **It shows every step, and I choose how much it's allowed to do.** PLAN only looks. In AUTO,
on the Claude brain, an automatic safety check decides each action. FULL AUTO runs everything, so I
don't use it in public. There's no "Are you sure?" pop-up yet. That's next.

**If they push:** Today it started in AUTO. The normal app still starts in FULL AUTO, so I always
check the badge before a demo. Changes it makes with its file tools can be undone (single files, not
whole folders or terminal commands). I can limit which websites it's allowed to open. The safety
check in AUTO only applies to the Claude brain. On the Gemini brain, AUTO has no extra checks yet.
The phone app and the Discord remote control only accept commands carrying a secret code or from
people on an allowed list.

**Before the 29th:** run Demo 7 (PLAN mode, "Delete the Showcase folder") once live. The PLAN lock on
the Claude brain was fixed on 25 Sep and has only been tested offline so far (FACTS §5). If it
changes anything in PLAN mode, take "PLAN only looks" out of this answer.

**Don't say:** "It always asks before it does anything." (Nothing asks today. The showcase launcher
starts in AUTO, but the normal app starts in FULL AUTO.)

## 6. What if the AI does something wrong?

**Say:** **It can make mistakes, like any AI, so it shows every step live and I can press Stop.** If
it moves or deletes the wrong file with its file tools, I say "undo that." If I'm not sure about a
task, I use PLAN mode, where it only looks.

**Before the 29th:** press Stop once during a task and make sure it really stops (DEMO.md §1, "Stop,
live"). The fix to Stop has only been tested offline (FACTS §8, item 10). While a task runs, the red
**Stop** button is next to **Send**. (Presenter mode hides the Activity panel, which has the other
stop buttons.) If it doesn't stop, leave "press Stop" out of this answer.

## 7. Is it private? Where does what I say go?

**Say:** **Honest answer: partly.** Your chats, memories, reminders and files are stored on the
Chromebook. But to think, it sends your request to the AI companies, Anthropic and Google. So my rule
is: don't tell it anything private.

**If they push:** With each request it also sends your top saved memories and the pages and
screenshots it reads. Voice recordings, and the text it reads aloud, go to Google unless I switch on
the offline voice mode. On Google's free tier, Google can use what you send to improve its products.

**If they push (for schools):** Before real students used it, I'd switch to offline voice mode and
set up proper privacy rules with the school.

## 8. Does it need the internet?

**Say:** **Yes, for the thinking.** Both AI brains run online, so it needs Wi-Fi or a phone hotspot.
Voice has an offline backup: a small speech model called Whisper that runs on the Chromebook, plus a
simple robot voice. Your chats and memories are saved on the Chromebook.

**If they push:** The offline speech model only understands English.

**Don't say:** "It works offline."

## 9. Can it work in Kinyarwanda?

**Say:** **Not yet.** The app's buttons are in English, the offline speech model only understands
English, and the robot voice has no Kinyarwanda. The online AI understands many languages, so typing
in Kinyarwanda might partly work, but I haven't tested it. It's high on my list, because that would
make it truly useful here.

**If they push:** To do it properly, I'd need four things:

1. speech recognition that really understands spoken Kinyarwanda, tested with real speakers;
2. a Kinyarwanda voice to read the answers aloud;
3. the app's buttons and menus translated;
4. Kinyarwanda words added to the part that picks a brain, because right now it looks for English
   keywords like "open", "click" and "search".

**Before the 29th (optional):** type one simple question to it in Kinyarwanda. If the answer is good,
you may change the middle sentence to: "Typing to it in Kinyarwanda already works. Speaking to it
doesn't yet." Only say that if you have seen it work yourself.

## 10. Does the phone part work?

**Say:** **It's built, but not finished.** I made an Android app that lets Ghost-Prime see a phone
screen as a numbered list and tap, swipe, type and open apps. It passes its tests on a simulated
phone, but I haven't run it on my real Galaxy A05 yet. It's second on my list, after testing it with
real students and teachers.

**If they push:** Pairing by QR code is built too. I call the phone part "in progress" until I've
seen it work on the real phone.

**Before the 29th (only if you want to try the real phone):** rebuild the APK first
(`android-connector/README.md`). The `app-debug.apk` built on 25 Sep can't connect: it lacks
`usesCleartextTraffic`, so Android refuses its plain-HTTP polls (FACTS §2, the phone row).

**Don't say:** "It controls my phone." (Not until you've seen it work on the real A05.)

## 11. How is this different from a normal chatbot?

**Say:** **A normal chatbot tells you the steps. Ghost-Prime does them.** It clicks and types in its
own browser, runs commands and moves files while you watch. It also remembers you from day to day,
and you can talk to it or type.

## 12. Chromebooks already have dictation, Select-to-Speak, ChromeVox and Google Assistant. Why this?

Tech judges often ask this first. It's a fair question, so answer it calmly.

**Say:** **Those are good tools, and I'm not trying to replace them.** Each one helps with one step at
a time. With Ghost-Prime, one sentence becomes a whole job: it opens the website, searches, reads the
page and explains it simply, and it shows every step on screen.

**If they push:** Dictation types what you say, Select-to-Speak and ChromeVox read text aloud, and the
Assistant answers a question or does one quick command. Ghost-Prime runs on a school Chromebook with
no pay-per-use bill.

**If they push ("But big companies already sell AI agents"):** That's true, and I'm not saying nobody
else does this. I wanted one that runs on the cheap school hardware we actually have, costs nothing
per use, shows every step, and can undo its file changes. Building it taught me how these agents
really work. Next I want to test it with the people it's meant for.

**If they push ("Those are built in"):** Yes. Ghost-Prime needs Linux turned on and some setup, so
it's harder to start with. An easy installer is on my list (question 22).

**If they ask "Does ChromeVox read your app?":** "I haven't tested that yet." (Nobody has.)

**Don't say:** "It's the first", "it's the only one" or "it replaces ChromeVox or dictation."

## 13. How long did it take?

**Say:** **About three months: the first version is from 17 June 2026.** When I counted on the night
of 25 to 26 September, it had at least 89 saved versions and about 25,000 lines of code. Much of that
code was written with an AI coding assistant (Claude Code).

**If they push:** The code covers the app, a Chrome extension and an Android app.

## 14. What was the hardest part?

**Say:** [Pick the one that felt hardest **to you**, and add a real moment you remember.]

- **Option A (the Chromebook):** ChromeOS keeps Linux apps in a locked box. They can't control
  other apps or see the whole screen, and my school blocks the developer mode that browser add-ons
  need. So I had to focus on what it *can* control: its own browser window, a terminal and files.
- **Option B (clicking the right thing):** Web pages are messy. I made it give every button, link
  and box on a page a number, and click by number. If the page changes, it has to look again
  instead of clicking the wrong thing.
- **Option C (bugs):** In one big review on 20 September, 127 bugs were fixed in a single update,
  with the AI coding assistant's help.

## 15. How would schools use it?

**Say:** **I can imagine a few ways.** A student who types slowly could research by talking and hear
the answer read aloud. A teacher could hand it boring jobs, like tidying folders or setting
reminders. I haven't tested it with students or teachers yet. That's my next step, and my ask.

**If they push:** A computer club could learn from it too, because you can watch every step it
takes, even the commands it types in its terminal.

**If they push ("Could my school install it?"):** Not easily yet. Right now I install it by hand
from the source code, and it shows up in the Chromebook's app list. An easy installer is on my
roadmap. A school would need Chromebooks with Linux turned on, internet, a free Google AI key, and
ideally a Claude subscription. It would also have to meet the AI companies' age rules (question 16).

## 16. Could children or students under 18 use it?

**Say:** **Not on their own yet.** The AI services it uses are for people aged 18 and over: Google's
Gemini API terms and Claude's consumer terms both say so. Using it with students would need a school
setup that meets the AI companies' age and privacy rules. That's why I'd work with teachers first.

**If they push (what the terms say, checked 25 Sep 2026):**
- Gemini API Additional Terms of Service (last modified 28 Apr 2026): "You must be 18 years of age
  or older to use the APIs." Apps built on it must not be "directed towards or … likely to be
  accessed by individuals under the age of 18."
- Anthropic Consumer Terms (effective 8 Oct 2025): "You must be at least 18 years old or the minimum
  age required to consent to use the Services in your location, whichever is higher."

**Before the 29th (important):** check both terms again. These rules apply to whoever set up the
accounts, too. Talk to your teacher or a parent about how your own use fits them. If a judge asks,
answer truthfully. Don't guess, and don't make anything up.

**Don't say:** "Kids can use it by themselves" or "it's made for children".

## 17. Have you tested it with people who struggle to type or read?

**Say:** **No, not yet.** So far I'm the only one who has tested it. I haven't tested it with these
groups yet. That's my next step, and my ask.

**If they push:** I want to try it with real students and teachers, and learn what works for them
and what doesn't.

**Before the 29th:** if someone really **has** tried it, replace this answer with who tried it and
one thing you learned, here and on the pitch card. Don't invent it.

## 18. How do you know it works?

**Say:** **Over 500 automated checks, and none failed in the last full run, on the night of 25 to 26
September.** Voice works in my own testing; the real mic and speaker are only checked by hand.
Anything not yet tested on real hardware, like the phone, I call "in progress."

**If they push:** The exact count was 523 checks in 34 offline test suites, and there are 45 test
scripts in all. Live checks that Claude and Gemini answer passed on 25 September. The browser-control
test alone runs 38 checks, on test pages in a hidden browser. The AI driving the browser from start to
finish was last checked on 20 September.

## 19. Can it control any app on the computer?

**Say:** **No.** ChromeOS doesn't let Linux apps control the rest of the screen, so it works through
its own browser window, a terminal and your files. That still covers a lot, because so much of what
students do happens on websites.

**If they push:** I also built a Chrome extension so it could use your normal Chrome tabs, but my
school blocks the developer mode it needs, so that part isn't tested on a real device yet.

## 20. What happens if the free AI runs out, or the internet is slow?

**Say:** **Google's free tier has a small daily limit, and I've hit "too many requests" errors while
testing.** If Google's voice fails, I can restart in offline voice mode in about 15 seconds. The
thinking always needs the internet. With extra usage turned off, Claude pauses at its limit and
never charges extra.

**If they push:** The app is also built to switch by itself. For the microphone, any error from
Google, or no answer within 20 seconds, sends the recording to the offline model instead. For
reading aloud, the robot voice takes over, even halfway through an answer. An offline test checks
that reading-aloud logic with a pretend Google and pretend speakers (25 September). The microphone
switch has no test. The app can also pass a message to the other AI brain when Claude can't be
reached, is overloaded, signed out or out of allowance. It only does that before it has started
answering or doing anything, so it never repeats an action, and it shows a note saying it switched.
An offline test with a pretend Claude checks that it switches when there's no internet or Claude is
overloaded, and that it never switches mid-task (25 September). I haven't seen either switch happen
for real yet.

**Before the 29th:** to try the voice switch, start once with
`GEMINI_API_KEY=wrong bin/ghost-showcase --restart`, speak one demo phrase, and check that the words
still come out and the answer is read in the robot voice. The first offline transcription is slow
while the model loads. Then restart normally with `bin/ghost-showcase --restart`. If it works, add
it to FACTS.md first. Then you can say you've seen it.

**Don't say:** "It switches over by itself" as if you've seen it happen.

## 21. Couldn't students use it to cheat?

**Say:** **Any AI can be misused, and a student could ask it to do their homework.** I built it to do
computer jobs and explain things simply. It shows every step and the page it read, so a teacher can
see what it did, and a teacher can limit which websites it opens.

## 22. What's next?

**Say:** **Five things, in this order:**

1. Test it with real students and teachers who find computers hard (my ask).
2. Test the phone app on my real Galaxy A05.
3. Add an "Are you sure?" step before anything that can't be undone.
4. Kinyarwanda.
5. An easy installer, so other schools can use it without me setting it up by hand.

**If they push:** A hands-free wake word (early code exists, but it isn't installed or tested) and a
smarter memory search.

---

## Numbers you can quote (FACTS §6)

Always say the date with a number: "When I counted on 25 September…"

| Number | What it means |
|---|---|
| **About 3 months** | 17 June to 25 September 2026 |
| **Over 500** | automated checks passed, 0 failed, in the last full run (night of 25 to 26 Sep 2026). Exact count: 523 checks in 34 offline test suites |
| **45** | automated test scripts, counted on the night of 25 to 26 Sep 2026 (there were 23 on 25 Sep, in the daytime) |
| **At least 89** | saved versions (commits) of the project, counted on the night of 25 to 26 Sep 2026 |
| **About 25,000** | lines of code across the app, the Chrome extension and the Android app, counted on the night of 25 to 26 Sep 2026. Much of it was written with an AI coding assistant (Claude Code) |
| **64** | tools the Claude brain can use (59 for the Gemini brain), counted 25 Sep 2026 |
| **127** | bugs fixed in one review (20 Sep 2026), with the AI coding assistant's help |

The slides and the poster print the exact count, 523. Out loud, say "over 500" and the date.

## Never claim these (they aren't true, or aren't tested yet)

- It controls a real phone. (Built, tested only on a **simulated** phone.)
- It uses your normal Chrome. (The extension isn't tested on a real device, and the school blocks it.)
- "Hey Ghost" hands-free wake word. (Not installed.)
- It always asks before acting. (Nothing asks yet. That's planned.)
- It's completely free, or it works offline.
- "Claude never charges extra" as a plain fact, until you've checked that extra usage is turned off
  (question 3).
- You've seen it switch to the other AI brain or to the offline voice by itself. (The brain switch
  and the reading-aloud switch have offline tests with pretend services. The microphone switch has
  no test. None of them has been tried for real yet.)
- "Voice is fully tested." (The real mic and speaker are only checked by hand.)
- It works with ChromeVox or other screen readers. (Not tested.)
- It helps [a group] / it's been tested with students. (Say who it's for, and that you haven't tested
  it with them yet.)
- Ghost-Prime is open source. (It's built with open-source tools.)
- It speaks Kinyarwanda.
- It can control any app on the computer.
- Canva design. (Not verified.)
- It's the first or the only assistant like this.
- Children can use it by themselves. (The AI services are 18+; see question 16.)
- "Give it a picture and watch it read it", unless you rehearsed that on the Claude brain. (On the
  day it's pinned to Claude, and pictures on the Claude brain are only checked by hand.)
