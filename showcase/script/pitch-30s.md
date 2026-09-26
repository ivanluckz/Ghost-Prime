# Ghost-Prime: the 30-second pitch (for visitors walking past)

**Target:** about 30 seconds. The pitch below is about 80 words, about 35 seconds at an easy 140 words
a minute. Smile, and point at the screen.
Every line matches `showcase/FACTS.md` (checked 25 Sep 2026).

---

Hi! I'm **[YOUR NAME]**. **[pause]**

This is **Ghost-Prime**. You talk, and it opens websites, clicks, types and reads the answer aloud.
**[pause]**

I built it on a school Chromebook, with help from an AI coding assistant. It has no pay-per-use
bills.

It's for students who type slowly, people who find small text hard to read, people new to computers,
and busy teachers. I haven't tested it with these groups yet. That's my next step, and my ask.

Give me a topic, and watch.

---

## Even shorter (about 10 seconds, for a crowd)

"This is Ghost-Prime. You talk, and it uses this school Chromebook for you. I built it with help from
an AI coding assistant. Want to see?"

## If younger visitors stop to watch

Ghost-Prime isn't made for children, so don't pitch it to them. They can watch the screen while you
run a demo. They don't speak or type to it. The AI services it uses are for people aged 18 and over
(see the question about children and under-18s in `qa.md`).

If you want to say something to them, keep it to what's on the screen: "Watch what happens on the
screen."

---

## Visitor notes (read these once)

- **You give the request, not the visitor.** Ask them for a topic, then say it into the mic yourself
  (or type it if the hall is loud), in the same shape as the hero phrase:
  "Go to the Wikipedia website, search for **[their topic]**, and explain it to me in three simple
  sentences." There are three reasons:
  1. Voice recordings go to Google to be turned into text, and on the free tier Google may use them
     to improve its products (FACTS §5). Visitors shouldn't say personal things into it.
  2. Google's free tier has a small daily limit (FACTS §4). A queue of visitors could use it up
     before the judges arrive, and voice depends on it.
  3. Every visitor request also uses my Claude allowance. With extra usage turned off, Claude pauses
     when the allowance runs out and never charges extra (FACTS §4). Check that setting before the
     29th (`pitch-2min.md`, "Rehearse"). A paused Claude means no live demo for the judges, so keep
     visitor demos short, and don't run them right before the judges.
- **Why Wikipedia?** Site access is set to **strict**, and only `wikipedia.org` and `example.com`
  are allowed (FACTS §8, and the setup in `showcase/demo/DEMO.md`). Any other website gets "Site not
  allowed". So keep visitor requests on Wikipedia. If a visitor wants a different site, say: "I've
  locked it to safe sites for today. Let's find it on Wikipedia instead."
- **Mode:** start it with `bin/ghost-showcase` (it starts in AUTO) and check the badge says **AUTO**.
  Never use **FULL AUTO** in public. Plain Ghost-Prime starts in FULL AUTO.
- Say no to anything that deletes, buys, posts or logs in, and to anything personal.
- The offline replay (Plan C) only knows the rehearsed phrases. Visitor topics work only in the live
  app.
- If a visitor asks something you can't answer, say: "Good question. I haven't tested that yet."
  Then write it down. That's a perfectly good answer.
- If anyone asks about the phone, it's **built but not tested on a real phone yet**. See the phone
  question in `qa.md`.
- If anyone asks why every answer says CLAUDE: "Claude does the thinking in today's demo, so every
  answer shows a CLAUDE tag. Normally a router can also send quick questions to Google's free Gemini."
