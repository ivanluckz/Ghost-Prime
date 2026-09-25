// Showcase OFFLINE REPLAY: scripted re-runs of the rehearsed demos in showcase/demo/DEMO.md, for
// the moment the booth Wi-Fi or Claude fails. It uses the real renderer (same UI, tool cards,
// terminal dock and Activity panel) on top of the design-preview mock backend. Nothing here touches
// the network.
//
//   npm run design   →   http://127.0.0.1:5199/?skipIntro=1&replay=1   (or showcase/demo/replay.sh)
//
// Loaded by dev/mock-ghost.js ONLY when the URL has ?replay=1. Without the flag this file is never
// imported and the design mock behaves exactly as before. Optional flag: &speak=0 stops the replay
// from reading every answer aloud (the app's own voice toggle still works).
//
// HONESTY: this is a scripted re-enactment, not a live run. A small "Offline replay" badge stays on
// screen and the presenter says so out loud (DEMO.md has the exact line). Tool names, inputs and
// output formats mirror the real tools (src/main/agent/provider.js, src/main/tools/*), and the
// answers only claim what showcase/FACTS.md marks as working. Phone control is replayed the way the
// real app behaves with no phone connected (it is built but not yet tested on a real phone).

const HOME = '/home/lol'
const PLAN_DIR = `${HOME}/Showcase`

// The rehearsed phrases, in DEMO.md order. The verification script (showcase/demo/verify-replay.mjs)
// types exactly these, so keep them in sync with DEMO.md.
export const REHEARSED = [
  { demo: 0, title: 'Sound check / greeting', say: 'Say hello to the judges.' },
  { demo: 1, title: 'Terminal, no commands needed', say: 'How much free space is left on this Chromebook?' },
  { demo: 2, title: 'Make a study plan (files)', say: 'Make me a three-day chemistry revision plan and save it in a new folder called Showcase, so I can undo it if I change my mind.' },
  { demo: 2, title: 'Undo it', say: 'Actually, undo that.' },
  { demo: 3, title: 'Remember me', say: "Remember that I'm in [YOUR CLASS] and my favourite subject is chemistry." },
  { demo: 3, title: 'Recall (in a new chat)', say: 'What do you know about me?' },
  { demo: 4, title: 'Reminder', say: 'Remind me in two minutes to drink some water.' },
  { demo: 5, title: 'Read the web for me', say: 'Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.' },
  { demo: 5, title: 'Backup page', say: 'Open example.com and tell me what it says.' },
  { demo: 6, title: 'Battery', say: "What's my battery level?" },
  { demo: 6, title: 'Weather', say: "What's the weather in Kigali right now?" },
  { demo: 7, title: 'PLAN mode (Shift+Tab to PLAN first)', say: 'Delete the Showcase folder.' }
]

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (ms) => Math.round(ms * (0.88 + Math.random() * 0.24)) // ±12% so runs don't feel canned
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const trimPunct = (s) => String(s || '').replace(/^[\s,:;-]+|[\s.!?,;:]+$/g, '')
const words = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[’']/g, '') // "what's" → "whats", "I'm" → "im"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) // = reminders MCP fmt()
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const pad = (n) => String(n).padStart(2, '0')
const isoLocal = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

// Claude-brain tool names (SDK built-ins + the in-process MCP servers) → Gemini-brain names, used
// when the presenter forces `/brain gemini` so the cards show what that brain would call.
const GEMINI_NAME = { shell_run: 'terminal_run', WebSearch: 'web_search', WebFetch: 'web_fetch', Glob: 'file_search' }
const bare = (name) => (name.startsWith('mcp__') ? name.split('__').pop() : name)
const nameFor = (brain, name) => (brain === 'gemini' ? GEMINI_NAME[bare(name)] || bare(name) : name)
const T = {
  shell: 'mcp__ghost-shell__shell_run',
  create: 'mcp__ghost-files__file_create',
  del: 'mcp__ghost-files__file_delete',
  undo: 'mcp__ghost-files__undo_last',
  save: 'mcp__ghost-memory__memory_save',
  recall: 'mcp__ghost-memory__memory_recall',
  remind: 'mcp__ghost-reminders__reminder_set',
  nav: 'mcp__ghost-browser__browser_navigate',
  page: 'mcp__ghost-browser__browser_get_page',
  fill: 'mcp__ghost-browser__browser_fill',
  shot: 'mcp__ghost-browser__browser_screenshot',
  text: 'mcp__ghost-browser__browser_get_text',
  power: 'mcp__ghost-jarvis__system_power',
  weather: 'mcp__ghost-jarvis__weather_get',
  volume: 'mcp__ghost-jarvis__system_volume',
  bright: 'mcp__ghost-jarvis__system_brightness',
  phone: 'mcp__ghost-phone__phone_open_app',
  glob: 'Glob'
}

// ---------------------------------------------------------------------------------------------
// Replay state: files, undo stack, memories, reminders (per page load; a reload starts fresh)
// ---------------------------------------------------------------------------------------------
const state = {
  files: new Set(), // paths "created" during this replay
  dirs: new Set(),
  undo: [], // { label, revert() }
  memories: [
    // Harmless seeds, true of this project (FACTS.md §4). The live app shows whatever the student saved.
    { id: 'rm1', type: 'preference', content: 'Prefers short, simple answers', spoken: 'You like short, simple answers', importance: 6, created_at: Date.now() - 3 * 86400e3, tags: [] },
    { id: 'rm2', type: 'fact', content: 'Uses a school Chromebook and a Galaxy A05 phone', spoken: 'You use a school Chromebook and a Galaxy A05 phone', importance: 5, created_at: Date.now() - 2 * 86400e3, tags: [] }
  ],
  memSeq: 2
}

// "I'm in S5 and my favourite subject is chemistry" → third person for the stored memory…
const IRREGULAR = { have: 'has', do: 'does', go: 'goes', am: 'is', was: 'was', can: 'can', will: 'will', would: 'would', should: 'should', could: 'could', must: 'must', might: 'might', may: 'may' }
function thirdPersonVerb(v) {
  const l = v.toLowerCase()
  if (IRREGULAR[l]) return IRREGULAR[l]
  if (/[^aeiou]y$/.test(l)) return l.slice(0, -1) + 'ies'
  if (/(s|sh|ch|x|z|o)$/.test(l)) return l + 'es'
  return l + 's'
}
function toThird(s) {
  return cap(
    ` ${s} `
      .replace(/\bI['’]m\b|\bI am\b/g, 'User is')
      .replace(/\bI['’]ve\b/g, 'User has')
      .replace(/\bI don['’]t\b/g, "User doesn't")
      .replace(/\bI (\w+)/g, (_, v) => `User ${thirdPersonVerb(v)}`)
      .replace(/\bmy\b/gi, 'their')
      .replace(/\bmine\b/gi, 'theirs')
      .replace(/\bmyself\b/gi, 'themselves')
      .replace(/\bme\b/gi, 'them')
      .trim()
  )
}
// …and second person for what Ghost says back.
function toSecond(s) {
  return ` ${s} `
    .replace(/\bI['’]m\b/g, "you're")
    .replace(/\bI am\b/g, 'you are')
    .replace(/\bI was\b/g, 'you were')
    .replace(/\bI['’]ve\b/g, "you've")
    .replace(/\bI\b/g, 'you')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bmine\b/gi, 'yours')
    .replace(/\bmyself\b/gi, 'yourself')
    .replace(/\bme\b/gi, 'you')
    .trim()
}

// "Remind me in two minutes to drink some water" → { text, inMinutes | at, dueAt, rel }
const WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, couple: 2, few: 3 }
function parseReminder(prompt) {
  const low = prompt.toLowerCase()
  let dueAt = null
  let inMinutes = null
  let at = null
  let rel = ''
  let cut = ''
  const half = low.match(/\bin half an hour\b/)
  const rm = low.match(/\bin\s+(?:a\s+)?(\d+(?:\.\d+)?|[a-z]+)(?:\s+of)?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/)
  const am = low.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\s|$|[.,!?])/)
  if (half) {
    inMinutes = 30
    rel = 'in half an hour'
    cut = half[0]
  } else if (rm && (Number(rm[1]) || WORDNUM[rm[1]])) {
    const n = Number(rm[1]) || WORDNUM[rm[1]]
    const unit = rm[2][0] === 's' ? 'second' : rm[2][0] === 'h' ? 'hour' : 'minute'
    inMinutes = Math.round(n * (unit === 'second' ? 1 / 60 : unit === 'hour' ? 60 : 1) * 100) / 100
    const said = Number(rm[1]) ? n : rm[1] === 'couple' ? 'a couple of' : rm[1] === 'few' ? 'a few' : rm[1]
    rel = `in ${said} ${unit}${n === 1 ? '' : 's'}`
    cut = rm[0]
  } else if (am) {
    let h = Number(am[1])
    const m = Number(am[2] || 0)
    const ap = (am[3] || '').replace(/\./g, '')
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (!ap && h < 8) h += 12 // "at 5" at school means 5 PM
    const d = new Date()
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    dueAt = d.getTime()
    at = isoLocal(dueAt)
    rel = new Date(dueAt).getDate() === new Date().getDate() ? 'today' : 'tomorrow'
    cut = am[0]
  } else {
    inMinutes = 2
    rel = 'in 2 minutes'
  }
  if (inMinutes != null) dueAt = Date.now() + inMinutes * 60e3
  let text = prompt
  if (cut) {
    const i = low.indexOf(cut)
    text = prompt.slice(0, i) + ' ' + prompt.slice(i + cut.length)
  }
  text = text
    .replace(/^\s*(please\s+)?(can you\s+|could you\s+)?(set (me )?a reminder|remind me|reminder)\s*/i, '')
    .replace(/^\s*(to|that|about|for)\s+/i, '')
  text = trimPunct(text.replace(/\s+/g, ' ').replace(/\s+(to|please)$/i, '')) || 'your reminder'
  return { text, inMinutes, at, dueAt, rel }
}

// ---------------------------------------------------------------------------------------------
// Fake screenshots (the live demo shows the real Chrome window; the replay shows these cards)
// ---------------------------------------------------------------------------------------------
function canvas(w, h) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')]
}
function wrap(x, text, left, top, width, lh) {
  let line = ''
  let y = top
  for (const w of text.split(' ')) {
    const next = line ? `${line} ${w}` : w
    if (x.measureText(next).width > width && line) {
      x.fillText(line, left, y)
      line = w
      y += lh
    } else line = next
  }
  if (line) x.fillText(line, left, y)
  return y + lh
}
export function wikiShot() {
  const [c, x] = canvas(800, 450)
  x.fillStyle = '#ffffff'
  x.fillRect(0, 0, 800, 450)
  x.fillStyle = '#f8f9fa'
  x.fillRect(0, 0, 800, 56)
  x.fillStyle = '#a2a9b1'
  x.fillRect(0, 56, 800, 1)
  x.strokeStyle = '#202122'
  x.lineWidth = 1.5
  x.beginPath()
  x.arc(38, 28, 17, 0, Math.PI * 2)
  x.stroke()
  x.fillStyle = '#202122'
  x.font = 'bold 18px Georgia, serif'
  x.fillText('W', 29, 35)
  x.font = '15px Georgia, serif'
  x.fillText('WIKIPEDIA', 64, 27)
  x.font = '10px Georgia, serif'
  x.fillText('The Free Encyclopedia', 64, 42)
  x.strokeStyle = '#a2a9b1'
  x.strokeRect(250, 14, 330, 28)
  x.fillStyle = '#72777d'
  x.font = '13px sans-serif'
  x.fillText('Search Wikipedia', 262, 33)
  x.fillStyle = '#202122'
  x.font = '30px Georgia, serif'
  x.fillText('Photosynthesis', 30, 102)
  x.fillStyle = '#a2a9b1'
  x.fillRect(30, 114, 740, 1)
  x.fillStyle = '#54595d'
  x.font = '12px sans-serif'
  x.fillText('From Wikipedia, the free encyclopedia', 30, 136)
  x.fillStyle = '#202122'
  x.font = '14px sans-serif'
  let y = wrap(
    x,
    'Photosynthesis is a system of biological processes by which photosynthetic organisms, such as most plants, algae and cyanobacteria, convert light energy, typically from sunlight, into the chemical energy necessary to fuel their metabolism.',
    30,
    168,
    470,
    21
  )
  wrap(
    x,
    'Most plants, algae and cyanobacteria take in carbon dioxide and water and release oxygen as a waste product. Photosynthesis is largely responsible for producing and maintaining the oxygen content of the Earth\u2019s atmosphere.',
    30,
    y + 10,
    470,
    21
  )
  // Infobox with a simple diagram.
  x.fillStyle = '#f8f9fa'
  x.fillRect(530, 140, 240, 280)
  x.strokeStyle = '#a2a9b1'
  x.strokeRect(530, 140, 240, 280)
  x.fillStyle = '#ffd54a'
  x.beginPath()
  x.arc(585, 190, 22, 0, Math.PI * 2)
  x.fill()
  x.save()
  x.translate(680, 270)
  x.rotate(-0.6)
  x.fillStyle = '#3f9b3f'
  x.beginPath()
  x.ellipse(0, 0, 62, 28, 0, 0, Math.PI * 2)
  x.fill()
  x.strokeStyle = '#2c6e2c'
  x.lineWidth = 2
  x.beginPath()
  x.moveTo(-60, 0)
  x.lineTo(60, 0)
  x.stroke()
  x.restore()
  x.fillStyle = '#202122'
  x.font = '12px sans-serif'
  x.fillText('CO\u2082 + H\u2082O + light', 560, 355)
  x.fillText('\u2192 glucose + O\u2082', 560, 375)
  x.fillStyle = '#54595d'
  x.font = '11px sans-serif'
  x.fillText('Overview of photosynthesis', 560, 405)
  return c.toDataURL('image/png')
}
function exampleShot() {
  const [c, x] = canvas(800, 450)
  x.fillStyle = '#f0f0f2'
  x.fillRect(0, 0, 800, 450)
  x.fillStyle = '#fdfdff'
  x.fillRect(120, 110, 560, 220)
  x.fillStyle = '#1b1b1b'
  x.font = 'bold 30px sans-serif'
  x.fillText('Example Domain', 160, 170)
  x.font = '16px sans-serif'
  const y = wrap(x, 'This domain is for use in documentation examples without needing permission. Avoid use in operations.', 160, 215, 480, 24)
  x.fillStyle = '#38488f'
  x.fillText('Learn more', 160, y + 8)
  return c.toDataURL('image/png')
}

// ---------------------------------------------------------------------------------------------
// Scenarios. Each: { id, keys, build(ctx) → { brain?, changes?, plan?, steps, answer } }.
//   keys: groups of lowercase word prefixes ("hi$" = that exact word), or a RegExp tested on the
//         lowercased phrase; a scenario matches when every key in ANY group matches some word. The
//         FIRST match wins, so order matters (revision-plan sits before undo because its phrase says
//         "so I can undo it"; reminder sits before revision-plan for "remind me to revise…").
//   steps: { name, input, output | () => output|{output,isError,image}, image?, ms, think?, term?, after? }
//   changes: true → in PLAN mode nothing runs and Ghost explains `plan` instead.
// ---------------------------------------------------------------------------------------------
const fileFrom = (prompt, fallback) => {
  const m = prompt.match(/[\w-]+\.(?:txt|md)\b/i)
  return m ? m[0] : fallback
}
const planText = (subject) =>
  subject === 'chemistry'
    ? `3-DAY CHEMISTRY REVISION PLAN: ACIDS AND BASES

Day 1: Learn (45 min)
- The pH scale, indicators (litmus, universal indicator)
- Properties of acids and bases; strong vs weak
- Make 10 flashcards

Day 2: Practise (45 min)
- Neutralisation: acid + base -> salt + water
- Write and balance 10 equations
- 15 past-paper questions

Day 3: Test yourself (45 min)
- Timed mini-quiz (20 min), then mark it
- Redo every question you got wrong
- One-page summary sheet for the night before the exam`
    : `3-DAY ${subject.toUpperCase()} REVISION PLAN

Day 1: Learn (45 min): read your notes on the main topics and make a one-page summary
Day 2: Practise (45 min): 15 past-paper questions, then check the answers
Day 3: Test yourself (45 min): timed mini-quiz, redo every mistake, final summary sheet`

const SUBJECTS = ['chemistry', 'biology', 'physics', 'maths', 'math', 'mathematics', 'history', 'geography', 'english', 'kinyarwanda', 'french', 'economics', 'ict', 'entrepreneurship']

export const SCENARIOS = [
  {
    id: 'delete',
    keys: [['delete'], ['remove'], ['get', 'rid'], ['bin$']],
    build: ({ prompt }) => {
      const folder = /\bfolder\b|\bdirectory\b/i.test(prompt)
      if (folder) {
        return {
          changes: true,
          plan: [`Check what's inside \`~/Showcase\` (read-only).`, 'Delete the folder with `rm -r ~/Showcase`. Undo only covers single files, not whole folders, so I would tell you that first.'],
          planSteps: [
            {
              name: T.glob,
              input: { pattern: `${PLAN_DIR}/*` },
              ms: 300,
              think: 1500,
              output: () => ([...state.files].filter((f) => f.startsWith(PLAN_DIR)).join('\n') || 'No files found')
            }
          ],
          steps: [
            {
              name: T.shell,
              input: { command: 'rm -r ~/Showcase' },
              ms: 400,
              think: 1500,
              term: { command: 'rm -r ~/Showcase', output: () => (state.dirs.has(PLAN_DIR) ? '' : "rm: cannot remove '/home/lol/Showcase': No such file or directory"), exit: () => (state.dirs.has(PLAN_DIR) ? 0 : 1) },
              after: () => {
                for (const f of [...state.files]) if (f.startsWith(PLAN_DIR)) state.files.delete(f)
                state.dirs.delete(PLAN_DIR)
              }
            }
          ],
          answer: (r) =>
            /No such file/.test(r[0] || '')
              ? "There's no Showcase folder in your home folder, so there was nothing to delete."
              : 'Done. I deleted the Showcase folder. Heads-up: undo only covers single files, so this one cannot be undone.'
        }
      }
      const path = `${PLAN_DIR}/${fileFrom(prompt, 'chemistry-revision-plan.txt')}`
      return {
        changes: true,
        plan: [`Delete \`${path}\` with file_delete. It is reversible, so "undo" would bring it back.`],
        steps: [
          {
            name: T.del,
            input: { path },
            ms: 400,
            think: 1400,
            output: () => {
              if (!state.files.has(path)) return { output: `Error: not found: ${path}`, isError: false }
              state.files.delete(path)
              state.undo.push({ label: `delete ${path}`, revert: () => state.files.add(path) })
              return `Deleted ${path} (undo restores it)`
            }
          }
        ],
        answer: (r) =>
          /not found/.test(r[0] || '')
            ? `I couldn't find \`${path.replace(HOME, '~')}\`. Want me to create it first?`
            : `Deleted \`${path.replace(HOME, '~')}\`. Say **"undo that"** and I'll bring it back.`
      }
    }
  },
  {
    id: 'reminder',
    keys: [['remind'], ['reminder'], ['alarm']],
    build: ({ prompt }) => {
      const r = parseReminder(prompt)
      const input = r.at ? { text: r.text, at: r.at } : { text: r.text, in_minutes: r.inMinutes }
      return {
        changes: true,
        plan: [`Set a reminder for ${fmtTime(r.dueAt)} (${r.rel}): "${cap(r.text)}".`],
        steps: [{ name: T.remind, input, ms: 250, think: 1600, output: () => `Reminder set for ${fmtWhen(r.dueAt)}: "${r.text}"` }],
        answer: () => `Done! At **${fmtTime(r.dueAt)}** (${r.rel}) I'll remind you: "${cap(r.text)}".`,
        onDone: (api) => api.scheduleReminder(r.text, r.dueAt)
      }
    }
  },
  {
    id: 'revision-plan',
    keys: [['revision'], ['revise'], ['study', 'plan'], ['create', 'file'], ['make', 'file'], ['save', 'folder']],
    build: ({ prompt }) => {
      const low = prompt.toLowerCase()
      const subject = SUBJECTS.find((s) => new RegExp(`\\b${s}\\b`).test(low)) || 'chemistry'
      const path = `${PLAN_DIR}/${fileFrom(prompt, `${subject}-revision-plan.txt`)}`
      const content = planText(subject)
      return {
        changes: true,
        plan: [`Write a 3-day ${subject} revision plan.`, `Save it as \`${path.replace(HOME, '~')}\` with file_create, which is reversible, so "undo" removes it.`],
        steps: [
          {
            name: T.create,
            input: { path, content },
            ms: 350,
            think: 3200, // writing the plan takes the model a few seconds
            output: () => {
              if (state.files.has(path)) return { output: `Error: already exists: ${path} (use file_write to overwrite)`, isError: false }
              state.files.add(path)
              state.dirs.add(PLAN_DIR)
              state.undo.push({ label: `create ${path}`, revert: () => state.files.delete(path) })
              return `Created ${path} (undo removes it)`
            }
          }
        ],
        answer: (r) =>
          /already exists/.test(r[0] || '')
            ? `You already have \`${path.replace(HOME, '~')}\`. Should I overwrite it, or save the new plan under a different name?`
            : `Done! I saved your plan as \`${path.replace(HOME, '~')}\`:\n\n- **Day 1: Learn.** ${subject === 'chemistry' ? 'The pH scale, indicators, and how acids and bases behave. Make 10 flashcards.' : 'Read your notes and make a one-page summary.'}\n- **Day 2: Practise.** ${subject === 'chemistry' ? 'Neutralisation equations, then 15 past-paper questions.' : '15 past-paper questions, then check your answers.'}\n- **Day 3: Test yourself.** A timed mini-quiz, then redo every mistake.\n\nIf you change your mind, just say **"undo that"** and I'll remove it.`
      }
    }
  },
  {
    id: 'undo',
    keys: [['undo'], ['take', 'back'], ['put', 'it', 'back'], ['revert']],
    build: () => ({
      changes: true,
      plan: ['Take back the last reversible file change with undo_last.'],
      steps: [
        {
          name: T.undo,
          input: {},
          ms: 500,
          think: 1300,
          output: () => {
            const e = state.undo.pop()
            if (!e) return { output: 'Error: nothing to undo', isError: false }
            e.revert()
            return `Undid: ${e.label}`
          }
        }
      ],
      answer: (r) => {
        const m = String(r[0] || '').match(/^Undid: (\w+) (.+)$/)
        if (!m) return "There's nothing to undo right now. I haven't changed any files yet."
        const file = m[2].split('/').pop()
        return m[1] === 'create'
          ? `Done. I removed **${file}**, so it's as if I never made it.`
          : m[1] === 'delete'
            ? `Done. **${file}** is back, exactly as it was.`
            : `Done. I reverted the change to **${file}**.`
      }
    })
  },
  {
    id: 'memory-recall',
    keys: [/\b(know|remember|tell me) about me\b|\bwho am i\b|\bwhat do you (know|remember)\b|\bdo you remember\b/],
    build: () => ({
      steps: [
        {
          name: T.recall,
          input: {},
          ms: 300,
          think: 1400,
          output: () =>
            state.memories.length
              ? [...state.memories]
                  .sort((a, b) => b.created_at - a.created_at)
                  .map((m) => `- [${m.type}] ${m.content}`)
                  .join('\n')
              : 'No memories stored yet.'
        }
      ],
      answer: () =>
        state.memories.length
          ? `Here's what I remember about you:\n\n${[...state.memories]
              .sort((a, b) => b.created_at - a.created_at)
              .map((m) => `- ${cap(m.spoken)}.`)
              .join('\n')}\n\nI keep these between chats, so you don't have to repeat yourself.`
          : "I don't have anything saved about you yet. Tell me something to remember!"
    })
  },
  {
    id: 'memory-save',
    keys: [['remember'], ['note', 'that'], ['dont', 'forget'], ['keep', 'in', 'mind']],
    build: ({ prompt }) => {
      const clause =
        trimPunct(prompt.replace(/^\s*(please\s+)?(can you\s+|could you\s+)?(remember|note|don['’]?t forget|keep in mind)\s*(that|this)?\s*[:,]?\s*/i, '')) ||
        'this'
      const type = /\b(prefer|like|love|favou?rite|hate|enjoy)/i.test(clause) ? 'preference' : 'fact'
      const content = toThird(clause)
      return {
        changes: true,
        plan: [`Save to long-term memory: "${content}".`],
        steps: [
          {
            name: T.save,
            input: { content, type, importance: 7 },
            ms: 250,
            think: 1500,
            output: 'Saved to memory.',
            after: () => state.memories.push({ id: `rm${++state.memSeq}`, type, content, spoken: toSecond(clause), importance: 7, created_at: Date.now(), tags: [] })
          }
        ],
        answer: () => `Got it. I'll remember that ${toSecond(clause)}. You can ask me about it any time, even in a new chat.`
      }
    }
  },
  {
    id: 'battery',
    keys: [['batter'], ['charg'], ['power', 'left']],
    build: () => ({
      steps: [
        {
          name: T.power,
          input: { action: 'battery' },
          ms: 200,
          think: 1500,
          // Real level from the browser's Battery API when it has one (ChromeOS Chrome does).
          output: async () => {
            let b = { capacity: 76, status: 'Discharging', health: 'Good', technology: 'Li-ion' }
            try {
              const nb = navigator.getBattery ? await navigator.getBattery() : null
              if (nb) b = { capacity: Math.round(nb.level * 100), status: nb.level >= 1 ? 'Full' : nb.charging ? 'Charging' : 'Discharging', health: 'Good', technology: 'Li-ion' }
            } catch {}
            return JSON.stringify(b, null, 2)
          }
        }
      ],
      answer: (r) => {
        let b = {}
        try {
          b = JSON.parse(r[0])
        } catch {}
        const pct = b.capacity ?? 76
        const how = b.status === 'Full' ? "it's full" : b.status === 'Charging' ? "it's charging" : "it's running on battery"
        const tip = b.status !== 'Charging' && b.status !== 'Full' && pct < 25 ? ' You should plug in the charger soon.' : pct >= 50 ? ' That is plenty for now.' : ''
        return `Your battery is at **${pct}%** and ${how}.${tip}`
      }
    })
  },
  {
    id: 'weather',
    keys: [['weather'], ['temperature'], ['forecast'], ['rain']],
    build: ({ prompt }) => {
      const m = prompt.match(/\b(?:in|for|at)\s+([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)/)
      const place = m ? m[1] : 'Kigali'
      const known = /kigali/i.test(place)
      const out = {
        location: known ? 'Kigali, Kigali, Rwanda' : place,
        temperature: '24°C',
        feels_like: '25°C',
        condition: 'Partly cloudy',
        humidity: '61%',
        wind: '11 km/h',
        uv_index: '6',
        forecast: [
          { date: isoLocal(Date.now()).slice(0, 10), max_temp: '27°C', min_temp: '16°C', condition: 'Partly cloudy' },
          { date: isoLocal(Date.now() + 86400e3).slice(0, 10), max_temp: '26°C', min_temp: '16°C', condition: 'Patchy rain nearby' },
          { date: isoLocal(Date.now() + 2 * 86400e3).slice(0, 10), max_temp: '25°C', min_temp: '15°C', condition: 'Light rain shower' }
        ]
      }
      return {
        steps: [{ name: T.weather, input: { location: place }, ms: 1200, think: 1500, output: JSON.stringify(out, null, 2) }],
        answer: `Right now in ${place} it's **24°C and partly cloudy** (feels like 25°C), with a light breeze. Today should reach about 27°C. Rain is possible tomorrow and the day after, so an umbrella might be a good idea.`
      }
    }
  },
  {
    id: 'volume',
    keys: [['volume'], ['louder'], ['quieter'], ['mute'], ['unmute']],
    build: ({ prompt }) => {
      const l = prompt.toLowerCase()
      const set = l.match(/\b(\d{1,3})\s*(%|percent)/)
      const action = set ? 'set' : /unmute/.test(l) ? 'unmute' : /\bmute\b/.test(l) ? 'mute' : /(up|louder|increase|raise)/.test(l) ? 'up' : 'down'
      const input = set ? { action, value: Number(set[1]) } : { action }
      const msg = { set: `Volume set to ${set?.[1]}%`, up: 'Volume increased by 5%', down: 'Volume decreased by 5%', mute: 'Audio muted', unmute: 'Audio unmuted' }[action]
      return {
        changes: true,
        plan: [`Change the volume (${action}${set ? ` to ${set[1]}%` : ''}) with system_volume.`],
        steps: [{ name: T.volume, input, ms: 200, think: 1400, output: JSON.stringify({ success: true, message: msg }, null, 2) }],
        answer: `${msg}.`
      }
    }
  },
  {
    id: 'brightness',
    keys: [['bright'], ['dimmer'], ['dim', 'screen']],
    build: ({ prompt }) => ({
      steps: [
        {
          name: T.bright,
          input: { action: /bright(er|en)|\bup\b|increase|raise/i.test(prompt) ? 'up' : 'down' },
          ms: 200,
          think: 1400,
          // What the real tool returns inside the Chromebook's Linux container (no backlight there).
          output: JSON.stringify({ note: 'Brightness is managed by Chrome OS host system keys (brightness up/down on top row).' }, null, 2)
        }
      ],
      answer: "I can't change the screen brightness from the Chromebook's Linux side, because ChromeOS keeps that control for itself. Use the brightness keys on the top row of the keyboard."
    })
  },
  {
    id: 'photosynthesis',
    keys: [['photosynth'], ['photo', 'synthesis']],
    build: () => ({
      changes: true,
      plan: ['Open wikipedia.org in the browser.', 'Type "photosynthesis" into the search box and press Enter.', 'Read the article and explain it in three simple sentences.'],
      steps: [
        { name: T.nav, input: { url: 'https://www.wikipedia.org' }, ms: 2600, think: 1700, output: 'Navigated — now at https://www.wikipedia.org/ — "Wikipedia"' },
        {
          name: T.page,
          input: {},
          ms: 700,
          think: 900,
          output:
            '# Wikipedia\nhttps://www.wikipedia.org/\n(Act on a numbered element with browser_click / browser_fill { ref: N }.)\n\n## Buttons & controls\n- [1] "Search"\n- [2] "Read Wikipedia in your language"\n\n## Links\n- [3] "English" → https://en.wikipedia.org/\n- [4] "Français" → https://fr.wikipedia.org/\n- [5] "Kiswahili" → https://sw.wikipedia.org/\n\n## Input fields\n- [6] Search Wikipedia (search)'
        },
        {
          name: T.fill,
          input: { ref: 6, value: 'photosynthesis', pressEnter: true },
          ms: 1900,
          think: 1000,
          output: 'Filled [6] and pressed Enter — now at https://en.wikipedia.org/wiki/Photosynthesis — "Photosynthesis - Wikipedia" (page changed — element refs are stale; call browser_get_page again)'
        },
        { name: T.shot, input: {}, ms: 900, think: 700, output: '', image: wikiShot },
        {
          name: T.text,
          input: {},
          ms: 800,
          think: 800,
          output:
            '# Photosynthesis - Wikipedia\nhttps://en.wikipedia.org/wiki/Photosynthesis\n\nPhotosynthesis\nFrom Wikipedia, the free encyclopedia\n\nPhotosynthesis is a system of biological processes by which photosynthetic organisms, such as most plants, algae, and cyanobacteria, convert light energy, typically from sunlight, into the chemical energy necessary to fuel their metabolism. …\n\nMost photosynthetic organisms take in carbon dioxide and water and release oxygen as a waste product. The sugar they make (glucose) stores the energy. Photosynthesis is largely responsible for producing and maintaining the oxygen content of the Earth\u2019s atmosphere. …\n\n…(38412 more characters — call browser_get_text with offset:20000 to continue)'
        }
      ],
      answer: `Here's photosynthesis in three simple sentences:

1. Photosynthesis is how plants, algae and some bacteria make their own food using sunlight.
2. They take in carbon dioxide from the air and water from the soil, and the green pigment chlorophyll captures light energy to turn them into sugar (glucose).
3. Oxygen is released as a by-product, and that is where most of the oxygen we breathe comes from.

In short: **carbon dioxide + water + light → glucose + oxygen**. I left the Wikipedia page open in the browser if you want to read more.`
    })
  },
  {
    id: 'example-com',
    keys: [['example', 'com']],
    build: () => ({
      changes: true,
      plan: ['Open https://example.com in the browser and read the page.'],
      steps: [
        { name: T.nav, input: { url: 'https://example.com' }, ms: 1600, think: 1500, output: 'Navigated — now at https://example.com/ — "Example Domain"' },
        { name: T.shot, input: {}, ms: 700, think: 600, output: '', image: exampleShot },
        {
          name: T.text,
          input: {},
          ms: 400,
          think: 700,
          output: '# Example Domain\nhttps://example.com/\n\nExample Domain\nThis domain is for use in documentation examples without needing permission. Avoid use in operations.\nLearn more'
        }
      ],
      answer: "It's a very simple page titled **Example Domain**. It says the address is reserved for use as an example in documents, so anyone can use it without asking permission, and there's a link to learn more. It's the web's official \"placeholder\" website."
    })
  },
  {
    id: 'disk-space',
    keys: [['space'], ['storage'], ['disk']],
    build: () => ({
      changes: true,
      plan: ['Run `df -h ~` in the terminal to see how much disk space is free.'],
      steps: [
        {
          name: T.shell,
          input: { command: 'df -h ~' },
          ms: 700,
          think: 1600,
          // Real numbers from this Chromebook's Linux container on 25 Sep 2026.
          term: { command: 'df -h ~', output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vdb         50G   28G   22G  57% /' }
        }
      ],
      answer: "You have about **22 GB free** out of 50 GB on this Chromebook's Linux side. It's 57% full, so there's plenty of room. I checked with the `df` command in the terminal below, so you didn't have to."
    })
  },
  {
    id: 'home-files',
    keys: [['files', 'home'], ['home', 'folder'], ['home', 'director'], ['whats', 'in', 'my']],
    build: () => ({
      changes: true,
      plan: ['Run `ls ~` in the terminal to list your home folder.'],
      steps: [
        {
          name: T.shell,
          input: { command: 'ls ~' },
          ms: 400,
          think: 1500,
          term: { command: 'ls ~', output: () => `Downloads  Projects${state.dirs.has(PLAN_DIR) ? '  Showcase' : ''}` }
        }
      ],
      answer: () =>
        `Your home folder has ${state.dirs.has(PLAN_DIR) ? 'three' : 'two'} folders: **Downloads** and **Projects**${state.dirs.has(PLAN_DIR) ? ', plus the **Showcase** folder I made for you' : ''}.`
    })
  },
  {
    id: 'phone',
    keys: [['phone'], ['galaxy'], ['android'], ['whatsapp'], ['youtube', 'on', 'my']],
    build: ({ prompt }) => {
      const app = /whatsapp/i.test(prompt) ? 'com.whatsapp' : /camera/i.test(prompt) ? 'com.sec.android.app.camera' : 'com.google.android.youtube'
      return {
        changes: true,
        plan: [`Open ${app} on your phone with phone_open_app (needs the connector app running on the phone).`],
        steps: [
          {
            name: T.phone,
            input: { app },
            ms: 150,
            think: 1500,
            // Exactly what the bridge says when no phone is connected (browser-bridge.js + phone.js).
            output: 'no Ghost-Prime phone is connected (open the connector app) — call phone_pair to show the pairing QR code.',
            isError: true
          }
        ],
        answer: "Your phone isn't connected to me right now. Open the Ghost-Prime connector app on the phone, or say **\"pair my phone\"** and I'll show the QR code to scan."
      }
    }
  },
  {
    id: 'web-search',
    keys: [['search', 'web'], ['news'], ['top', 'story'], ['latest'], ['today$']],
    build: () => ({
      steps: [],
      answer: "Live web search needs the internet, and this is the **offline replay**, so I can't fetch today's news right now. When we're back online, ask me again and I'll look it up."
    })
  },
  {
    id: 'hello',
    keys: [['hello'], ['hi$'], ['hey$'], ['introduce'], ['who', 'are', 'you$'], ['what', 'can', 'you$', 'do$'], ['judges']],
    build: ({ prompt }) =>
      /what can you do|who are you|introduce/i.test(prompt)
        ? {
            steps: [],
            answer: `I'm **Ghost-Prime**, an assistant that lives on this school Chromebook. You can talk to me or type, and I do the task instead of only explaining it:

- **Use the web for you**: open websites, read them aloud, click and fill things in.
- **Run the computer**: terminal commands you can watch, and creating or moving files, with undo.
- **Remember you**: things you tell me stay remembered from one day to the next.
- **Reminders and quick answers**: like your battery level or the weather.

I can also control an Android phone. That part is built, but it hasn't been tested on a real phone yet, so it's next.`
          }
        : {
            steps: [],
            answer: "Hello, judges! I'm **Ghost-Prime**, a voice assistant running on this school Chromebook. Ask me to do something on the computer, like reading a web page aloud or making a study plan, and I'll do it while you watch."
          }
  }
]

// Unmatched phrases: say plainly that this is a replay, and list what it can show.
const FALLBACK = {
  id: 'fallback',
  build: () => ({
    steps: [],
    answer: `I'm running as an **offline replay** right now (no internet), so I can only replay the demos we rehearsed. Try one of these:\n\n${REHEARSED.filter((r) => r.demo >= 1)
      .map((r) => `- "${r.say.replace("I'm in [YOUR CLASS] and ", '')}"`)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join('\n')}\n\nWhen the connection is back, I can do the real thing.`
  })
}

export function matchScenario(prompt) {
  const ws = words(prompt)
  const has = (k) => (k.endsWith('$') ? ws.includes(k.slice(0, -1)) : ws.some((w) => w.startsWith(k)))
  const low = String(prompt || '').toLowerCase()
  for (const s of SCENARIOS) if (s.keys.some((g) => (g instanceof RegExp ? g.test(low) : g.every(has)))) return s
  return FALLBACK
}

// Speech: mirrors voice.speak() in src/main/voice/index.js (strip markdown, cap at 1200 chars).
export function speakable(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/→/g, ' gives ')
    .replace(/~\//g, 'home folder, ')
    .replace(/[`*_#>|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
}

// ---------------------------------------------------------------------------------------------
// installReplay: swap the design mock's scripted flight demo for these scenarios.
// ---------------------------------------------------------------------------------------------
export function installReplay(ghost, { emit, running }) {
  const params = new URLSearchParams(location.search)
  const autoSpeak = params.get('speak') !== '0'
  const debug = (window.__ghostReplay = { runs: [], spoken: [], scenarios: SCENARIOS.map((s) => s.id) })

  // ---- badge (honesty: always visible) --------------------------------------------------------
  const badge = document.createElement('div')
  badge.className = 'replay-badge'
  badge.setAttribute('role', 'status')
  const badgeText = '● Offline replay · scripted demo'
  badge.textContent = badgeText
  Object.assign(badge.style, {
    position: 'fixed',
    left: '28px',
    bottom: '22px',
    zIndex: '9999',
    pointerEvents: 'none',
    font: "600 10.5px/1 'JetBrains Mono Variable', ui-monospace, monospace",
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'rgba(255, 212, 121, 0.92)',
    background: 'rgba(24, 18, 6, 0.72)',
    border: '1px solid rgba(255, 212, 121, 0.38)',
    borderRadius: '999px',
    padding: '6px 11px',
    backdropFilter: 'blur(6px)'
  })
  document.body.appendChild(badge)
  let flashTimer = null
  const flash = (msg) => {
    badge.textContent = msg
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (badge.textContent = badgeText), 5000)
  }

  // ---- voice out: speechSynthesis, en-GB when available ---------------------------------------
  const synth = window.speechSynthesis
  let lastSaid = null // { raw, at }: the renderer re-sends the same reply when its voice toggle is on
  const pickVoice = () => {
    const vs = synth?.getVoices?.() || []
    const gb = (v) => /^en[-_]GB/i.test(v.lang)
    const en = (v) => /^en/i.test(v.lang)
    // Local (on-device) voices first: they keep working with no internet.
    return vs.find((v) => gb(v) && v.localService) || vs.find(gb) || vs.find((v) => en(v) && v.localService) || vs.find(en) || null
  }
  synth?.addEventListener?.('voiceschanged', () => {}) // nudge Chrome to load the voice list early
  const speakNow = (raw) => {
    const text = speakable(raw)
    if (!text) return
    debug.spoken.push(text)
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return
    try {
      synth.cancel() // like the app: a new reply replaces whatever is still being read
      const voice = pickVoice()
      // Chrome cuts long utterances off after ~15 s, so queue it sentence by sentence.
      const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text]
      let chunk = ''
      const queue = []
      for (const p of parts) {
        if ((chunk + p).length > 180 && chunk) {
          queue.push(chunk)
          chunk = ''
        }
        chunk += p
      }
      if (chunk) queue.push(chunk)
      for (const q of queue) {
        const u = new SpeechSynthesisUtterance(q.trim())
        if (voice) u.voice = voice
        u.lang = voice?.lang || 'en-GB'
        u.rate = 1.02
        synth.speak(u)
      }
    } catch (e) {
      console.warn('[replay] speech failed:', e?.message || e)
    }
  }
  const say = (raw) => {
    if (!autoSpeak) return // &speak=0: only the app's own voice toggle speaks (via voice.speak below)
    lastSaid = { raw, at: Date.now() }
    speakNow(raw)
  }

  // ---- voice in: the browser's own speech recognition (needs internet in Chrome) --------------
  let rec = null
  let heard = ''
  let recErr = ''
  let recEnded = null
  ghost.voice = {
    listenStart() {
      heard = ''
      recErr = ''
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition
      if (!SR) {
        recErr = 'no speech recognition in this browser'
        return
      }
      try {
        rec = new SR()
        rec.lang = 'en-GB'
        rec.continuous = true
        rec.interimResults = false
        rec.onresult = (e) => {
          heard = Array.from(e.results)
            .map((r) => r[0]?.transcript || '')
            .join(' ')
            .trim()
        }
        rec.onerror = (e) => (recErr = e.error || 'speech recognition error')
        recEnded = new Promise((r) => (rec.onend = r))
        rec.start()
      } catch (e) {
        recErr = e?.message || String(e)
        rec = null
      }
    },
    async listenStop() {
      if (rec) {
        try {
          rec.stop()
        } catch {}
        await Promise.race([recEnded, wait(4000)])
        rec = null
      }
      if (heard) return { text: heard }
      flash(recErr === 'network' || !navigator.onLine ? '● Offline replay · mic needs internet, please type' : '● Offline replay · didn’t catch that, please type')
      return { text: '', error: recErr || 'nothing heard' }
    },
    ttsAvailable: async () => true,
    speak(text) {
      if (lastSaid && text === lastSaid.raw && Date.now() - lastSaid.at < 15000) return // already reading it
      speakNow(text)
    },
    stopSpeaking() {
      try {
        synth?.cancel()
      } catch {}
    }
  }

  // ---- reminders ----------------------------------------------------------------------------
  const reminderCbs = new Set()
  ghost.onReminder = (cb) => {
    reminderCbs.add(cb)
    return () => reminderCbs.delete(cb)
  }
  const scheduleReminder = (text, dueAt) =>
    setTimeout(() => {
      say(`Reminder: ${text}`)
      reminderCbs.forEach((cb) => cb({ text }))
    }, Math.max(0, dueAt - Date.now()))

  // ---- chat history + memories ---------------------------------------------------------------
  const store = { sessions: [], history: {}, parents: {}, active: 'r-1', seq: 1 }
  ghost.recentSessions = async () => store.sessions.map((s) => ({ ...s }))
  ghost.sessionMessages = async (id) => (store.history[id] || []).map((m) => ({ ...m }))
  ghost.newSession = async (parentId) => {
    store.active = `r-${++store.seq}`
    if (parentId) store.parents[store.active] = parentId
    return store.active
  }
  ghost.setActiveSession = async (id) => {
    store.active = id
  }
  ghost.activeSession = async () => store.active
  ghost.deleteSession = async (id) => {
    store.sessions = store.sessions.filter((s) => s.id !== id)
    delete store.history[id]
    return true
  }
  ghost.deleteAllSessions = async () => {
    store.sessions = []
    store.history = {}
    return ghost.newSession()
  }
  const record = (role, content) => {
    const id = store.active
    let s = store.sessions.find((x) => x.id === id)
    if (!s) {
      s = { id, title: content.slice(0, 80), started_at: Date.now(), message_count: 0, parent_id: store.parents[id] || null }
      store.sessions.unshift(s)
    }
    ;(store.history[id] ||= []).push({ role, content })
    s.message_count++
  }
  ghost.memoryCount = async () => state.memories.length
  ghost.allMemories = async () => state.memories.map(({ spoken, ...m }) => ({ ...m }))
  ghost.deleteMemory = async (id) => {
    state.memories = state.memories.filter((m) => m.id !== id)
    return true
  }
  ghost.clearMemory = async () => {
    const n = state.memories.length
    state.memories = []
    return n
  }

  // ---- live terminal dock (the agent's shell_run types into it, as in the app) -----------------
  const PROMPT = '\x1b[01;32mlol@penguin\x1b[00m:\x1b[01;34m~\x1b[00m$ '
  const term = { list: [], n: 0, buf: {}, seq: {}, line: {}, dataCbs: new Set(), sessCbs: new Set() }
  const emitSessions = () => {
    const l = term.list.map((s) => ({ ...s }))
    term.sessCbs.forEach((cb) => cb(l))
  }
  const termWrite = (id, data) => {
    term.buf[id] = (term.buf[id] || '') + data
    term.seq[id] = (term.seq[id] || 0) + 1
    term.dataCbs.forEach((cb) => cb({ id, data, seq: term.seq[id] }))
  }
  const termOpen = (agent) => {
    const n = ++term.n
    const s = { id: `t${n}`, name: `Terminal ${n}`, cwd: HOME, alive: true, agent, busy: false, lastExit: null, createdAt: Date.now() }
    term.list.push(s)
    termWrite(s.id, PROMPT)
    emitSessions()
    return s
  }
  const runInTerminal = async (command, output, ms, exit = 0) => {
    const s = term.list.find((x) => x.agent && x.alive) || termOpen(true)
    s.busy = true
    emitSessions()
    await wait(120)
    termWrite(s.id, `${command}\r\n`)
    await wait(jitter(ms))
    termWrite(s.id, (output ? `${output.replace(/\n/g, '\r\n')}\r\n` : '') + PROMPT)
    s.busy = false
    s.lastExit = exit
    emitSessions()
    return `[${s.name} · ${s.id}] exit ${exit}\n${output || '(no output)'}`
  }
  ghost.shell = {
    list: async () => term.list.map((s) => ({ ...s })),
    open: async () => {
      const s = termOpen(false)
      return { id: s.id, name: s.name, cwd: s.cwd }
    },
    kill: async (id) => {
      const had = term.list.some((s) => s.id === id)
      term.list = term.list.filter((s) => s.id !== id)
      emitSessions()
      return had
    },
    scrollback: async (id) => ({ text: term.buf[id] || '', seq: term.seq[id] || 0 }),
    // Typing into the replay terminal just echoes (there is no real shell behind it).
    write(id, d) {
      for (const ch of String(d)) {
        if (ch === '\r') {
          const typed = (term.line[id] || '').trim()
          term.line[id] = ''
          termWrite(id, `\r\n${typed ? `(offline replay: commands don't run here)\r\n` : ''}${PROMPT}`)
        } else if (ch === '\x7f') {
          if (term.line[id]) {
            term.line[id] = term.line[id].slice(0, -1)
            termWrite(id, '\b \b')
          }
        } else if (ch >= ' ') {
          term.line[id] = (term.line[id] || '') + ch
          termWrite(id, ch)
        }
      }
    },
    resize() {},
    onData: (cb) => {
      term.dataCbs.add(cb)
      return () => term.dataCbs.delete(cb)
    },
    onSessions: (cb) => {
      term.sessCbs.add(cb)
      return () => term.sessCbs.delete(cb)
    }
  }

  // ---- the scripted run -------------------------------------------------------------------------
  const plain = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p?.type === 'text' ? p.text : '')).join(' ') : String(c ?? ''))
  let reqSeq = 0

  async function run(requestId, prompt, mode, agent) {
    const aborted = () => !running.has(requestId)
    const sc = matchScenario(prompt)
    const plan = sc.build({ prompt, mode })
    const brain = agent?.brain === 'gemini' || agent?.brain === 'claude' ? agent.brain : 'claude' // .env: GHOST_BRAIN_MODE=claude
    const planMode = mode === 'plan' && plan.changes
    const steps = planMode ? plan.planSteps || [] : plan.steps
    const entry = { prompt, scenario: sc.id, mode, brain, done: false, t0: Date.now(), ms: null }
    debug.runs.push(entry)
    console.info(`[replay] "${prompt}" → ${sc.id}${planMode ? ' (PLAN)' : ''}`)
    record('user', prompt)
    emit('tool', { requestId, kind: 'brain', brain })

    const results = []
    for (const [i, s] of steps.entries()) {
      await wait(jitter(s.think ?? 900))
      if (aborted()) return
      const id = `${requestId}-t${i}`
      emit('tool', { requestId, kind: 'tool_use', id, name: nameFor(brain, s.name), input: s.input })
      let out
      if (s.term) {
        const o = typeof s.term.output === 'function' ? s.term.output() : s.term.output
        const x = typeof s.term.exit === 'function' ? s.term.exit() : s.term.exit ?? 0
        out = await runInTerminal(s.term.command, o, s.ms, x)
      } else {
        await wait(jitter(s.ms))
        out = typeof s.output === 'function' ? await s.output() : s.output
      }
      if (aborted()) return
      const r = out && typeof out === 'object' ? out : { output: out }
      results.push(r.output)
      emit('tool', { requestId, kind: 'tool_result', id, output: r.output ?? '', image: s.image ? s.image() : r.image, isError: !!(r.isError ?? s.isError) })
      s.after?.()
    }

    let answer
    if (planMode) {
      answer = `**I'm in PLAN mode, so I haven't changed anything.** Here's what I would do:\n\n${plan.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nSwitch to AUTO or FULL AUTO with Shift+Tab and ask again if you want me to do it.`
    } else {
      answer = typeof plan.answer === 'function' ? plan.answer(results) : plan.answer
    }
    await wait(jitter(steps.length ? 1000 : 1500))
    for (let i = 0; i < answer.length; ) {
      if (aborted()) return
      const n = 3 + Math.floor(Math.random() * 9)
      emit('delta', { requestId, text: answer.slice(i, i + n) })
      i += n
      await wait(22 + Math.random() * 18)
    }
    if (aborted()) return
    running.delete(requestId)
    record('assistant', answer)
    say(answer) // before 'done', so the renderer's own speak(reply) is recognised as a repeat
    emit('done', { requestId, aborted: false })
    entry.done = true
    entry.ms = Date.now() - entry.t0
    if (!planMode) plan.onDone?.({ scheduleReminder })
  }

  ghost.sendMessage = (messages, mode, agent) => {
    const requestId = `replay_${++reqSeq}`
    running.set(requestId, true)
    const last = [...(messages || [])].reverse().find((m) => m.role === 'user')?.content
    run(requestId, plain(last).trim(), mode, agent).catch((e) => {
      running.delete(requestId)
      emit('error', { requestId, message: String(e?.message || e) })
    })
    return requestId
  }
  const baseAbort = ghost.abort
  ghost.abort = (requestId) => {
    try {
      synth?.cancel()
    } catch {}
    baseAbort(requestId)
  }

  console.info('[replay] offline replay installed: scripted showcase demos (see showcase/demo/DEMO.md)')
}
