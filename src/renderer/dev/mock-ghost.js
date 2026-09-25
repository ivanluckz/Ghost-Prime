// Design preview: a fake `window.ghost` so the renderer runs in a plain browser (Vite dev server,
// `npm run design`) with demo data — no Electron, no database, no bridge, no brain calls. Loaded by
// main.jsx only in dev and only when the real preload is absent, so it never ships in the app.
//
// Scripted replies: send any message to get a streamed answer with tool cards. Include "slow" to
// keep a tool running (spinner + Activity panel busy), "error" for a failed tool + error reply.
// Add ?replay=1 to the URL for the showcase offline replay instead (see the bottom of this file).
import QRCode from 'qrcode'

const listeners = { delta: new Set(), tool: new Set(), done: new Set(), error: new Set() }
const emit = (kind, payload) => listeners[kind].forEach((cb) => cb(payload))
const on = (kind) => (cb) => {
  listeners[kind].add(cb)
  return () => listeners[kind].delete(cb)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const now = Date.now()
const day = 86400000

// Demo content follows the showcase's hero demo (showcase/demo/DEMO.md, Demo 5) and the study-plan
// demo, so screenshots taken from this preview are on-message. No real names: the class is a
// placeholder the presenter fills in.
const HERO = 'Go to the Wikipedia website, search for photosynthesis, and explain it to me in three simple sentences.'

const sessions = [
  { id: 's-web', title: HERO, started_at: now - 2 * 3600e3, message_count: 4, parent_id: null },
  { id: 's-sub', title: 'Turn it into three quiz questions', started_at: now - 1.5 * 3600e3, message_count: 2, parent_id: 's-web' },
  { id: 's-plan', title: 'Make me a three-day chemistry revision plan', started_at: now - day, message_count: 4, parent_id: null },
  { id: 's-hi', title: 'What do you know about me?', started_at: now - 3 * day, message_count: 2, parent_id: null }
]

// Exercises every Markdown block the thread renders: list, table, blockquote, a long code line
// (horizontal scroll), bold/italic and a link.
const md = `Here's **photosynthesis** in three simple sentences:

1. Photosynthesis is how plants, algae and some bacteria make their own food using sunlight.
2. They take in **carbon dioxide** from the air and **water** from the soil, and the green pigment chlorophyll turns them into sugar (glucose).
3. **Oxygen** is released as a by-product, and that's where most of the oxygen we breathe comes from.

| Goes in | Comes out |
|---|---|
| Carbon dioxide (from the air) | Glucose (food for the plant) |
| Water (from the roots) | Oxygen (into the air) |
| Light energy (from the sun) | — |

> Source: the Wikipedia article *Photosynthesis*. I left it open in the browser if you want to read more.

The word equation, if your teacher asks for it:

\`\`\`text
carbon dioxide + water  --(light energy, absorbed by chlorophyll)-->  glucose + oxygen
\`\`\`

Want me to turn this into three quiz questions? The full article: [en.wikipedia.org/wiki/Photosynthesis](https://en.wikipedia.org/wiki/Photosynthesis).`

const history = {
  's-web': [
    { role: 'user', content: HERO },
    { role: 'assistant', content: md },
    { role: 'user', content: 'Which part of the plant does it happen in?' },
    { role: 'assistant', content: 'Mostly in the **leaves**. Their cells contain tiny green parts called *chloroplasts*, and that is where chlorophyll catches the light.' }
  ],
  's-sub': [
    { role: 'user', content: 'Turn it into three quiz questions' },
    { role: 'assistant', content: '1. Which gas do plants take in for photosynthesis?\n2. What does chlorophyll do?\n3. Which gas do plants give out?\n\n**Answers:** carbon dioxide · it captures light energy · oxygen.' }
  ],
  's-plan': [
    { role: 'user', content: 'Make me a three-day chemistry revision plan and save it in a new folder called Showcase, so I can undo it if I change my mind.' },
    { role: 'assistant', content: 'Done. I saved it as `~/Showcase/chemistry-revision-plan.txt`:\n\n- **Day 1, learn:** atoms, the periodic table and bonding.\n- **Day 2, practise:** balancing equations and moles.\n- **Day 3, test yourself:** a past paper, then go over your mistakes.\n\nSay "undo that" if you change your mind.' },
    { role: 'user', content: 'Actually, undo that.' },
    { role: 'assistant', content: 'Undone. `chemistry-revision-plan.txt` is gone and the Showcase folder is back to how it was.' }
  ],
  's-hi': [
    { role: 'user', content: 'What do you know about me?' },
    { role: 'assistant', content: "Here's what I remember:\n\n- Your favourite subject is **chemistry**.\n- You like short, simple answers.\n- You asked me to remind you to drink some water." }
  ]
}

const memories = [
  { id: 'm1', type: 'preference', content: 'Likes short, simple answers', importance: 8, created_at: now - 3 * day, tags: [] },
  { id: 'm2', type: 'fact', content: 'Favourite subject is chemistry', importance: 7, created_at: now - 2 * day, tags: [] },
  { id: 'm3', type: 'task', content: 'Chemistry revision plan lives in ~/Showcase', importance: 6, created_at: now - day, tags: ['school'] }
]

let reqSeq = 0
let active = 's-web'
const running = new Map()

async function script(requestId, prompt) {
  const aborted = () => !running.has(requestId)
  const slow = /slow/i.test(prompt)
  const fail = /error/i.test(prompt)
  const { wikiShot } = await import('./showcase-scenarios.js')
  emit('tool', { requestId, kind: 'brain', brain: 'claude' })
  const steps = [
    { name: 'mcp__ghost-browser__browser_navigate', input: { url: 'https://www.wikipedia.org' }, output: 'Navigated — now at https://www.wikipedia.org/ — "Wikipedia"', ms: 700 },
    {
      name: 'mcp__ghost-browser__browser_get_page',
      input: {},
      output: '# Wikipedia\nhttps://www.wikipedia.org/\n(Act on a numbered element with browser_click / browser_fill { ref: N }.)\n\n## Buttons & controls\n- [1] "Search"\n- [2] "Read Wikipedia in your language"\n## Input fields\n- [6] Search Wikipedia (search)',
      ms: 500
    },
    {
      name: 'mcp__ghost-browser__browser_fill',
      input: { ref: 6, value: 'photosynthesis', pressEnter: true },
      output: 'Filled [6] and pressed Enter — now at https://en.wikipedia.org/wiki/Photosynthesis — "Photosynthesis - Wikipedia" (page changed)',
      ms: slow ? 60000 : 900
    },
    { name: 'mcp__ghost-browser__browser_screenshot', input: { annotate: true }, output: 'Numbered elements: [1] Search · [2] Photosynthesis · [3] Contents', image: wikiShot(), ms: 600 },
    fail
      ? { name: 'mcp__ghost-browser__browser_get_text', input: {}, output: 'Error: the page did not finish loading within 15 seconds', isError: true, ms: 700 }
      : {
          name: 'mcp__ghost-browser__browser_get_text',
          input: {},
          output: '# Photosynthesis - Wikipedia\nhttps://en.wikipedia.org/wiki/Photosynthesis\n\nPhotosynthesis is a system of biological processes by which photosynthetic organisms, such as most plants, algae, and cyanobacteria, convert light energy, typically from sunlight, into the chemical energy necessary to fuel their metabolism. …',
          ms: 600
        }
  ]
  for (const [i, s] of steps.entries()) {
    if (aborted()) return
    const id = `${requestId}-t${i}`
    emit('tool', { requestId, kind: 'tool_use', id, name: s.name, input: s.input })
    await wait(s.ms)
    if (aborted()) return
    emit('tool', { requestId, kind: 'tool_result', id, output: s.output, image: s.image, isError: !!s.isError })
  }
  if (fail) {
    running.delete(requestId)
    emit('error', { requestId, message: "Wikipedia didn't finish loading, so I stopped there. Check the internet connection and ask me again." })
    return
  }
  for (const chunk of md.match(/[\s\S]{1,24}/g)) {
    if (aborted()) return
    emit('delta', { requestId, text: chunk })
    await wait(14)
  }
  running.delete(requestId)
  emit('done', { requestId, aborted: false })
}

const ghost = {
  // ?showcase=1 previews a bin/ghost-showcase launch (presenter mode on, AUTO mode).
  platform: { isLinux: true, nativeFrame: false, showcase: new URLSearchParams(location.search).get('showcase') === '1' },
  uiReady: () => {},
  sendMessage(messages) {
    const requestId = `demo_${++reqSeq}`
    running.set(requestId, true)
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    // Start on the next tick, like the real IPC round trip: the renderer adds the user's bubble
    // right after sendMessage returns, and the first tool card must land below it.
    setTimeout(() => script(requestId, typeof last === 'string' ? last : ''), 0)
    return requestId
  },
  abort(requestId) {
    if (!running.delete(requestId)) return
    emit('done', { requestId, aborted: true })
  },
  onDelta: on('delta'),
  onTool: on('tool'),
  onDone: on('done'),
  onError: on('error'),
  recentSessions: async () => sessions.map((s) => ({ ...s })),
  sessionMessages: async (id) => (history[id] || []).map((m) => ({ ...m })),
  newSession: async () => {
    active = `s-new-${++reqSeq}`
    return active
  },
  setActiveSession: async (id) => {
    active = id
  },
  activeSession: async () => active,
  deleteSession: async (id) => {
    const i = sessions.findIndex((s) => s.id === id)
    if (i >= 0) sessions.splice(i, 1)
    return true
  },
  deleteAllSessions: async () => {
    sessions.length = 0
    return 's-new'
  },
  memoryCount: async () => memories.length,
  allMemories: async () => memories.map((m) => ({ ...m })),
  deleteMemory: async (id) => {
    const i = memories.findIndex((m) => m.id === id)
    if (i >= 0) memories.splice(i, 1)
    return true
  },
  clearMemory: async () => {
    const n = memories.length
    memories.length = 0
    return n
  },
  onProactive: () => () => {},
  onReminder: () => () => {},
  onFocusInput: () => () => {},
  onExternalTask: () => () => {},
  windowControls: { minimize() {}, maximize() {}, close() {} },
  browserTarget: { get: async () => 'group', set: async (t) => t },
  phone: {
    async pairInfo(host) {
      const h = host || '10.14.46.195'
      const uri = `ghostprime://pair?host=${h}&port=8731&token=demo-token`
      return { host: h, port: 8731, uri, dataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 360 }), problems: [] }
    }
  },
  // The showcase setup (DEMO.md): strict, with the two demo sites allowed.
  sites: { get: async () => ({ mode: 'strict', allow: ['wikipedia.org', 'example.com'], block: ['mybank.com'] }), set: async (p) => p },
  mirrorChat() {},
  hotkey: {
    get: async () => ({ accelerator: 'CommandOrControl+Shift+G', default: 'CommandOrControl+Shift+G' }),
    set: async (accelerator) => ({ ok: true, accelerator, default: 'CommandOrControl+Shift+G' })
  },
  shell: {
    list: async () => [],
    open: async () => ({ id: 't1', name: 'Terminal 1', cwd: '~' }),
    kill: async () => true,
    scrollback: async () => '',
    write() {},
    resize() {},
    onData: () => () => {},
    onSessions: () => () => {}
  },
  // The mic "hears" the hero phrase after a short transcription, so the voice states can be
  // previewed; ?voice=fail previews the failure note instead.
  voice: {
    listenStart() {},
    listenStop: async () => {
      await wait(1200)
      return new URLSearchParams(location.search).get('voice') === 'fail' ? { error: 'arecord: audio open error: No such file or directory' } : { text: HERO }
    },
    ttsAvailable: async () => true,
    speak() {},
    stopSpeaking() {}
  }
}

// Showcase offline replay (?replay=1 ONLY): scripted demo runs from ./showcase-scenarios.js replace
// the flight script above. Without the flag nothing below runs and the mock is unchanged.
if (new URLSearchParams(location.search).get('replay') === '1') {
  const { installReplay } = await import('./showcase-scenarios.js')
  installReplay(ghost, { emit, running })
}

window.ghost = ghost
console.info('[design] mock window.ghost installed — demo data, no backend')
