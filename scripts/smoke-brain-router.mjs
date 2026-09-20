// The brain router: computer-control turns (browser, terminal, files, apps) go to Claude; the
// Jarvis one-shot controls that only exist on the Gemini path, plain chat, and dropped images
// stay on Gemini; hard reasoning/coding still goes to Claude.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-brain-router.mjs
// Clear the env BEFORE loading provider.js (a static import would be hoisted above the deletes).
delete process.env.GHOST_BRAIN_MODE
delete process.env.GHOST_CONTROL_BRAIN
const { pickBrain } = await import('../src/main/agent/provider.js')

const cases = [
  // computer control → claude
  ['open amazon.com and add a usb-c cable to my cart', 'claude'],
  ['go to the school portal and check my timetable', 'claude'],
  ['click the green button', 'claude'],
  ['log in to gmail and reply to the latest email from my teacher', 'claude'],
  ['fill in the form with my name and email', 'claude'],
  ['search for cheap flights to berlin on google', 'claude'],
  ['download the pdf on this page', 'claude'],
  ['take a screenshot of the page', 'claude'],
  ['run the tests', 'claude'],
  ['install ffmpeg', 'claude'],
  ['git status', 'claude'],
  ['move all the pngs in downloads into a folder called screenshots', 'claude'],
  ['delete the old backup files', 'claude'],
  ['open discord', 'claude'],
  ['what is on this page', 'claude'],
  ['post "hello" on my discord server', 'claude'],
  // hard reasoning/coding → claude (unchanged)
  ['refactor this module to use async iterators', 'claude'],
  // …even when a Jarvis keyword appears in a coding ask (the one-shot pre-emption is short-text only)
  ['refactor this module so CPU usage stays flat', 'claude'],
  ['debug why this leaks memory usage over time: ```js\nsetInterval(() => cache.push(new Array(1e6)), 10)\n```', 'claude'],
  // gemini-only controls → gemini
  ['turn the volume up', 'gemini'],
  ['set brightness to 50', 'gemini'],
  ["what's the weather tomorrow", 'gemini'],
  ['play lofi music on youtube', 'gemini'],
  ['how much battery do I have', 'gemini'],
  ['remind me at 5 to call mum', 'gemini'],
  ['copy that to my clipboard', 'gemini'],
  // plain chat → gemini
  ['hi', 'gemini'],
  ['what does "move" mean in chess', 'gemini'],
  ['tell me a joke about programmers', 'gemini'],
  ['translate "good morning" to german', 'gemini'],
  ['who won the 2022 world cup', 'gemini']
]

let pass = 0
let fail = 0
for (const [text, want] of cases) {
  const got = pickBrain({ messages: [{ role: 'user', content: text }] })
  const ok = got === want
  console.log(`${ok ? '✅' : '❌'} ${got.padEnd(6)} ← "${text}"${ok ? '' : `  (wanted ${want})`}`)
  ok ? pass++ : fail++
}
// A dropped image always goes to Gemini (the only path that takes images as input).
const img = pickBrain({ messages: [{ role: 'user', content: [{ type: 'text', text: 'click the login button' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] })
console.log(`${img === 'gemini' ? '✅' : '❌'} ${img.padEnd(6)} ← click the login button + [image]`)
img === 'gemini' ? pass++ : fail++
// Explicit overrides still win.
const forced = pickBrain({ brain: 'gemini', messages: [{ role: 'user', content: 'click the green button' }] })
console.log(`${forced === 'gemini' ? '✅' : '❌'} ${forced.padEnd(6)} ← /brain gemini override`)
forced === 'gemini' ? pass++ : fail++

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
