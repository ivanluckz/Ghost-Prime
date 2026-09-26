// Check the showcase OFFLINE REPLAY end to end in headless Chromium: types every rehearsed phrase
// from src/renderer/dev/showcase-scenarios.js (the same list DEMO.md uses), screenshots each result,
// and fails on page errors or a phrase that lands on the wrong scenario. It also runs the hero demo at
// half the screen (683×768, Ghost-Prime snapped left as in DEMO.md §2), fails if the "Offline replay"
// badge covers the composer, and checks that the plain design preview (no ?replay=1) still runs its
// own scripted demo (the design screenshots rely on it).
//
// Needs the design server (`npm run design`). Run it directly from the repo root (no flock needed):
//   node showcase/demo/verify-replay.mjs [outdir] [baseUrl]
// baseUrl defaults to presenter mode ('…&showcase=1', starts in AUTO), which is what
// showcase/demo/replay.sh opens at the booth. Pass 'http://127.0.0.1:5199/?skipIntro=1' to check the
// normal layout (replay.sh --small), which starts in FULL AUTO.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REHEARSED } from '../../src/renderer/dev/showcase-scenarios.js'

const [outdir = join(tmpdir(), 'ghost-replay-shots'), base = 'http://127.0.0.1:5199/?skipIntro=1&showcase=1'] = process.argv.slice(2)
const PRESENTER = /[?&]showcase=1\b/.test(base) // booth layout: must start in AUTO, never FULL AUTO
mkdirSync(outdir, { recursive: true })
const EXPECT = ['hello', 'disk-space', 'revision-plan', 'undo', 'memory-save', 'memory-recall', 'reminder', 'photosynthesis', 'example-com', 'battery', 'weather', 'delete']
const failures = []
const fail = (msg) => {
  failures.push(msg)
  console.log('FAIL:', msg)
}
let pageErrors = 0
const consoleErrors = []
const external = new Set() // any request that would need the internet (all are blocked below)

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
async function open(url, label, viewport = { width: 1366, height: 768 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  // Record what would be spoken (headless Chromium has no voices, so capture the utterances).
  await ctx.addInitScript(() => {
    window.__utter = []
    if (window.speechSynthesis) {
      const orig = window.speechSynthesis.speak.bind(window.speechSynthesis)
      window.speechSynthesis.speak = (u) => {
        window.__utter.push({ text: u.text, lang: u.lang })
        try {
          orig(u)
        } catch {}
      }
    }
  })
  // Simulate "no internet": only the local preview server is reachable.
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url())
    if (['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue()
    external.add(u.origin)
    return route.abort()
  })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => {
    pageErrors++
    console.log('PAGEERROR:', e.message)
  })
  p.on('console', (m) => {
    if (m.type() === 'error' && !/^\[voice\]/.test(m.text())) consoleErrors.push(`[${label}] ${m.text().split('\n')[0].slice(0, 160)}`)
  })
  await p.goto(url)
  await p.waitForSelector('.chat-input textarea', { timeout: 30000 })
  await p.waitForTimeout(1000)
  return p
}
const shot = async (p, name) => {
  await p.waitForTimeout(400)
  await p.screenshot({ path: join(outdir, `${name}.png`) })
  console.log('saved', name)
}
const send = async (p, text) => {
  await p.locator('.chat-input textarea').fill(text)
  await p.keyboard.press('Enter')
}
async function setMode(p, id) {
  await send(p, `/mode ${id}`)
  await p.waitForFunction((cls) => document.querySelector(`.mode.mode-${cls}`), id, { timeout: 5000 }).catch(() => fail(`/mode ${id} did not switch the badge`))
}
const runs = (p) => p.evaluate(() => window.__ghostReplay?.runs.length || 0)
// The honesty badge must never sit on the composer (or the bar): in presenter mode the history
// sidebar it normally lives in is hidden.
async function badgeClear(p, where) {
  const hit = await p.evaluate(() => {
    const box = (s) => document.querySelector(s)?.getBoundingClientRect()
    const b = box('.replay-badge')
    if (!b || !b.width) return 'badge not visible'
    const over = (o) => o && b.left < o.right && o.left < b.right && b.top < o.bottom && o.top < b.bottom
    return over(box('.chat-input')) ? 'composer' : over(box('.topbar')) ? 'bar' : b.right > innerWidth || b.bottom > innerHeight ? 'window edge' : ''
  })
  if (hit) fail(`${where}: the replay badge overlaps the ${hit}`)
}
async function sendAndWait(p, text, timeout = 45000) {
  const before = await runs(p)
  await send(p, text)
  await p.waitForFunction((n) => window.__ghostReplay.runs.length > n && window.__ghostReplay.runs.at(-1).done, before, { timeout })
  return p.evaluate(() => window.__ghostReplay.runs.at(-1))
}

try {
  // ---- replay: every rehearsed phrase, in DEMO.md order, in one session like the booth ----------
  const p = await open(`${base}&replay=1`, 'replay')
  if (!(await p.locator('.replay-badge').count())) fail('replay badge missing')
  await shot(p, '00-replay-empty')
  await badgeClear(p, 'start screen')
  for (const [i, r] of REHEARSED.entries()) {
    if (r.title.startsWith('Recall')) await p.keyboard.press('Control+n') // DEMO.md: ask in a brand-new chat
    // Typed, as DEMO.md says: from AUTO (presenter mode) one Shift+Tab would go to FULL AUTO.
    if (r.demo === 7) await setMode(p, 'plan')
    let mid = null
    if (EXPECT[i] === 'photosynthesis') mid = setTimeout(() => shot(p, `${String(i + 1).padStart(2, '0')}-photosynthesis-running`).catch(() => {}), 5200)
    const run = await sendAndWait(p, r.say)
    clearTimeout(mid)
    if (run.scenario !== EXPECT[i]) fail(`"${r.say}" → ${run.scenario}, expected ${EXPECT[i]}`)
    if (i === 0 && PRESENTER && run.mode !== 'auto') fail(`presenter mode started in mode ${run.mode}, expected auto`)
    if (r.demo === 7 && run.mode !== 'plan') fail(`PLAN demo ran in mode ${run.mode}`)
    console.log(`ok   ${run.scenario.padEnd(15)} ${(run.ms / 1000).toFixed(1).padStart(5)}s brain=${run.brain} mode=${run.mode}  "${r.say}"`)
    await shot(p, `${String(i + 1).padStart(2, '0')}-${run.scenario}`)
    if (EXPECT[i] === 'disk-space') {
      const t = await p.locator('.term-dock .xterm-rows').innerText().catch(() => '')
      if (!/df -h/.test(t)) fail('terminal dock did not show the df command')
      await p.locator('.term-collapse').click() // DEMO.md: close the dock after Demo 1 to give answers room
    }
    if (EXPECT[i] === 'photosynthesis') {
      if (!(await p.locator('img.tool-shot').count())) fail('no screenshot card in the browser demo')
      else {
        await p.locator('img.tool-shot').last().scrollIntoViewIfNeeded()
        await shot(p, `${String(i + 1).padStart(2, '0')}-photosynthesis-screenshot-card`)
      }
    }
  }
  const last = await p.locator('.messages').innerText()
  if (!/PLAN mode/.test(last)) fail('PLAN answer missing')
  if (/FULL AUTO|Shift\+Tab/.test(last.split('Delete the Showcase folder.').pop())) fail('PLAN answer suggests FULL AUTO or Shift+Tab (DEMO.md says /mode auto)')
  await setMode(p, 'auto')

  // The app's own voice toggle on top of the replay's speech: an "On it" ack, then the answer ONCE.
  await send(p, '/voice on')
  await p.waitForTimeout(300)
  const before = await p.evaluate(() => window.__ghostReplay.spoken.length)
  await sendAndWait(p, "What's my battery level?")
  await p.waitForTimeout(300)
  const said = await p.evaluate((n) => window.__ghostReplay.spoken.slice(n), before)
  if (said.filter((t) => /battery is at/.test(t)).length !== 1) fail(`voice toggle: answer spoken ${said.filter((t) => /battery is at/.test(t)).length} times`)
  console.log('voice on → spoken:', said.map((t) => t.slice(0, 40)).join(' | '))

  // A reminder that fires during the test, an unmatched phrase, and the mic with no speech service.
  await sendAndWait(p, 'Remind me in 5 seconds to stand up and stretch.')
  await p.waitForFunction(() => /Reminder: stand up and stretch/.test(document.querySelector('.messages')?.innerText || ''), null, { timeout: 12000 }).catch(() => fail('reminder did not fire'))
  await shot(p, '20-reminder-fired')
  const fb = await sendAndWait(p, 'Tell me about the history of Rwanda')
  if (fb.scenario !== 'fallback') fail(`unmatched phrase → ${fb.scenario}`)
  await shot(p, '21-fallback')
  await p.locator('button[aria-label="Voice input"]').click()
  await p.waitForTimeout(700)
  await p.locator('button[aria-label="Voice input"]').click()
  await p.waitForTimeout(1500)
  await shot(p, '22-mic-no-speech-service')
  await badgeClear(p, 'mic message')

  const spoken = await p.evaluate(() => ({ answers: window.__ghostReplay.spoken, utter: window.__utter }))
  const n = await runs(p)
  if (spoken.answers.length < n) fail(`only ${spoken.answers.length} of ${n} answers were spoken`)
  console.log(`spoken: ${spoken.answers.length} answers, ${spoken.utter.length} utterances queued (lang ${[...new Set(spoken.utter.map((u) => u.lang))].join(',') || 'n/a'})`)
  console.log('first spoken line:', spoken.answers[0])
  await p.context().close()

  // ---- half the screen (DEMO.md §2: Ghost-Prime snapped left for the hero demo) ----------------
  const half = await open(`${base}&replay=1&speak=0`, 'replay half-screen', { width: 683, height: 768 })
  await shot(half, '40-half-empty')
  await badgeClear(half, 'half-screen start screen')
  const hero = REHEARSED.find((r) => r.demo === 5)
  const hr = await sendAndWait(half, hero.say)
  if (hr.scenario !== 'photosynthesis') fail(`half-screen: hero phrase → ${hr.scenario}`)
  await shot(half, '41-half-hero')
  await badgeClear(half, 'half-screen hero answer')
  await half.context().close()

  // ---- &speak=0: the replay stays silent unless the app's voice toggle is on --------------------
  const quiet = await open(`${base}&replay=1&speak=0`, 'replay quiet')
  await sendAndWait(quiet, 'Say hello to the judges.')
  if ((await quiet.evaluate(() => window.__ghostReplay.spoken.length)) !== 0) fail('speak=0 still spoke')
  await quiet.context().close()

  // ---- regression: the plain design preview must still play its own scripted demo ---------------
  const q = await open(base, 'plain preview')
  if (await q.locator('.replay-badge').count()) fail('replay badge shown without ?replay=1')
  if (await q.evaluate(() => 'ghostReplay' in window || '__ghostReplay' in window)) fail('replay installed without ?replay=1')
  await send(q, 'look up photosynthesis')
  await q.waitForTimeout(7000)
  const txt = await q.locator('.messages').innerText()
  if (!/browser_navigate/.test(txt) || !/goes in/i.test(txt)) fail('plain preview no longer runs its scripted demo')
  await shot(q, '30-plain-preview-unchanged')
  await q.context().close()
} catch (e) {
  fail(e?.message || String(e))
} finally {
  await browser.close()
}
console.log(external.size ? `blocked external requests (would need internet): ${[...external].join(', ')}` : 'no external requests: works offline')
if (consoleErrors.length) console.log(`console errors (${consoleErrors.length}):\n  ${[...new Set(consoleErrors)].slice(0, 8).join('\n  ')}`)
console.log(pageErrors ? `${pageErrors} page error(s)` : 'no page errors')
console.log(failures.length ? `${failures.length} failure(s)` : 'ALL REPLAY CHECKS PASSED')
console.log('screenshots:', outdir)
process.exit(failures.length || pageErrors ? 1 : 0)
