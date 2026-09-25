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

const sessions = [
  { id: 's-browser', title: 'Find me a cheap flight to Lisbon in October and compare the top three', started_at: now - 2 * 3600e3, message_count: 6, parent_id: null },
  { id: 's-sub', title: 'Only direct flights please', started_at: now - 1.5 * 3600e3, message_count: 2, parent_id: 's-browser' },
  { id: 's-code', title: 'Refactor the reminders scheduler', started_at: now - day, message_count: 4, parent_id: null },
  { id: 's-hi', title: 'hey who am i ?', started_at: now - 40 * day, message_count: 3, parent_id: null }
]

const md = `Here's what I found — **three direct options** under €150:

| Airline | Depart | Price |
|---|---|---|
| TAP Portugal | 08:40 | €128 |
| easyJet | 13:15 | €96 |
| Ryanair | 19:50 | €84 |

1. **Ryanair** is cheapest but lands after 22:00.
2. **easyJet** is the best balance — you'd arrive mid-afternoon.
3. **TAP** includes a checked bag.

> Prices change fast; I left the easyJet tab open so you can book.

The search I ran:

\`\`\`js
const results = await searchFlights({ from: 'KGL', to: 'LIS', month: 10, direct: true })
results.sort((a, b) => a.price - b.price)
\`\`\`

Want me to hold the easyJet fare? More at [skyscanner.net](https://www.skyscanner.net).`

const history = {
  's-browser': [
    { role: 'user', content: 'Find me a cheap flight to Lisbon in October and compare the top three' },
    { role: 'assistant', content: md },
    { role: 'user', content: 'nice, which one has the best reviews?' },
    { role: 'assistant', content: 'TAP scores highest (4.2★ on Skytrax), then easyJet (3.6★). Ryanair trails at 2.9★ — mostly for fees, not safety.' }
  ],
  's-sub': [{ role: 'user', content: 'Only direct flights please' }, { role: 'assistant', content: 'All three above are direct. 👍' }],
  's-code': [
    { role: 'user', content: 'Refactor the reminders scheduler so missed reminders fire on startup' },
    { role: 'assistant', content: 'Done. `initReminders()` now sweeps anything past due on boot:\n\n```js\nfor (const r of pending()) if (r.due_at <= Date.now()) fire(r)\n```\n\nTests pass (`smoke-reminders`: 9/9).' }
  ],
  's-hi': [
    { role: 'user', content: 'hey who am i ?' },
    { role: 'assistant', content: "You're **Jes** — you're building Ghost-Prime on a Chromebook and learning web security on the side." }
  ]
}

const memories = [
  { id: 'm1', type: 'preference', content: 'Prefers concise answers', importance: 8, created_at: now - 3 * day, tags: [] },
  { id: 'm2', type: 'fact', content: 'Uses a Chromebook with Crostini; phone is a Galaxy A05', importance: 7, created_at: now - 2 * day, tags: [] },
  { id: 'm3', type: 'task', content: 'Rotate the leaked API keys', importance: 9, created_at: now - day, tags: ['security'] }
]

// A fake "screenshot" for tool cards that return an image.
function fakeShot(label) {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 360
  const x = c.getContext('2d')
  const g = x.createLinearGradient(0, 0, 640, 360)
  g.addColorStop(0, '#f7f8fb')
  g.addColorStop(1, '#e3e8f2')
  x.fillStyle = g
  x.fillRect(0, 0, 640, 360)
  x.fillStyle = '#ff6600'
  x.fillRect(0, 0, 640, 48)
  x.fillStyle = '#fff'
  x.font = 'bold 20px sans-serif'
  x.fillText('easyJet', 20, 32)
  x.fillStyle = '#1b2433'
  x.font = 'bold 26px sans-serif'
  x.fillText(label, 24, 110)
  x.font = '16px sans-serif'
  for (let i = 0; i < 4; i++) {
    x.fillStyle = i === 1 ? '#fff4e8' : '#ffffff'
    x.fillRect(24, 140 + i * 50, 592, 40)
    x.fillStyle = '#1b2433'
    x.fillText(`KGL → LIS   ${['08:40', '13:15', '19:50', '21:05'][i]}   €${[128, 96, 84, 142][i]}`, 40, 166 + i * 50)
  }
  return c.toDataURL('image/png')
}

let reqSeq = 0
let active = 's-browser'
const running = new Map()

async function script(requestId, prompt) {
  const aborted = () => !running.has(requestId)
  const slow = /slow/i.test(prompt)
  const fail = /error/i.test(prompt)
  emit('tool', { requestId, kind: 'brain', brain: 'claude' })
  const steps = [
    { name: 'mcp__ghost-browser__browser_navigate', input: { url: 'https://www.easyjet.com/en' }, output: 'Navigated — now at https://www.easyjet.com/en — "easyJet | Cheap flights"', ms: 700 },
    { name: 'mcp__ghost-browser__browser_get_page', input: {}, output: '# easyJet | Cheap flights\n(Act on a numbered element with browser_click / browser_fill { ref: N }.)\n\n## Buttons & controls\n- [1] "Show flights"\n- [2] "Accept cookies"\n## Input fields\n- [3] From (text)\n- [4] To (text)', ms: 500 },
    { name: 'mcp__ghost-browser__browser_fill', input: { ref: 4, value: 'Lisbon', pressEnter: true }, output: 'Filled [4] and pressed Enter — now at https://www.easyjet.com/en/buy/flights (page changed)', ms: slow ? 60000 : 900 },
    { name: 'mcp__ghost-browser__browser_screenshot', input: { annotate: true }, output: 'Numbered elements: [1] Select · [2] Select · [3] Select', image: fakeShot('Kigali → Lisbon · Oct 14'), ms: 600 },
    { name: 'mcp__ghost-shell__shell_run', input: { command: 'node scripts/compare.mjs --sort price' }, output: fail ? 'Error: Cannot find module scripts/compare.mjs\n[exit code: 1]' : 'Ryanair  €84\neasyJet  €96\nTAP      €128\n[exit code: 0]', isError: fail, ms: 700 },
    { name: 'weather_get', input: { location: 'Lisbon' }, output: '{ "location": "Lisbon", "temperature": "24°C", "condition": "Sunny" }', ms: 400 }
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
    emit('error', { requestId, message: 'The compare script failed — I stopped before booking anything.' })
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
  platform: { isLinux: true, nativeFrame: false },
  uiReady: () => {},
  sendMessage(messages) {
    const requestId = `demo_${++reqSeq}`
    running.set(requestId, true)
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
    script(requestId, typeof last === 'string' ? last : '')
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
  browserTarget: { get: async () => 'active', set: async (t) => t },
  phone: {
    async pairInfo(host) {
      const h = host || '10.14.46.195'
      const uri = `ghostprime://pair?host=${h}&port=8731&token=demo-token`
      return { host: h, port: 8731, uri, dataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 360 }), problems: [] }
    }
  },
  sites: { get: async () => ({ mode: 'open', allow: [], block: ['mybank.com'] }), set: async (p) => p },
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
  voice: {
    listenStart() {},
    listenStop: async () => ({ text: '' }),
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
