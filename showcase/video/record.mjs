// Record the demo footage from the OFFLINE REPLAY (the real renderer in headless Chromium, scripted
// answers; see showcase/demo/DEMO.md Plan C). It types every demo shot of storyboard.json the way a
// person would (~35 ms per character), presses Enter, waits for the answer to finish streaming (+1.8 s,
// or longer so the shot fits its narration line), scrolls the thread to the bottom, and moves on.
// The approach copies showcase/demo/verify-replay.mjs.
//
//   npm run design                              (in another terminal: the preview server)
//   node showcase/video/narrate.mjs             (first, so each shot is held long enough for its line)
//   node showcase/video/record.mjs [--small]    (--small: normal layout instead of presenter mode)
// It records at storyboard.json → viewport (1366x768, the school Chromebook's screen, 16:9).
//
// Output (next to this file): footage/replay.webm, timeline.json (video-time seconds for each shot's
// typing start, Enter, answer done and finish) and frames/*.png, one set per shot, to look at: fonts
// loaded, nothing blank, the "Offline replay" badge clear of the composer. It fails if a phrase lands on
// the wrong scenario, if the page throws, or if the badge sits on the composer.
// GHOST_CHROMIUM=/path/to/chrome uses that binary (the cloud session used the pre-installed one).
import { chromium } from '../../node_modules/playwright/index.mjs'
import { REHEARSED } from '../../src/renderer/dev/showcase-scenarios.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sb = JSON.parse(readFileSync(join(here, 'storyboard.json'), 'utf8'))
const small = process.argv.includes('--small')
const base = process.env.GHOST_REPLAY_URL || (small ? sb.replayUrl.replace('&showcase=1', '') : sb.replayUrl)
const { width, height } = sb.viewport
const footageDir = join(here, 'footage')
const framesDir = join(here, 'frames')
mkdirSync(footageDir, { recursive: true })
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })
const videoOut = join(footageDir, 'replay.webm')

// Narration lengths (voice/manifest.json), so a shot is never shorter than its line.
const manifestPath = join(here, 'voice', 'manifest.json')
const narration = {}
if (existsSync(manifestPath)) for (const l of JSON.parse(readFileSync(manifestPath, 'utf8')).lines) narration[l.shot] = l.seconds
else console.log('note: voice/manifest.json missing; run narrate.mjs first so shots are held long enough for their lines')

const failures = []
const fail = (m) => {
  failures.push(m)
  console.log('FAIL:', m)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const demos = sb.shots.filter((s) => s.kind === 'demo')
// DEMO.md: "Say your real class". The template stays the REHEARSED phrase; what gets typed has the real
// values from storyboard.json → presenter.
const who = sb.presenter || {}
const fill = (t) => t.replace(/\[YOUR CLASS\]/g, who.class || '[YOUR CLASS]').replace(/\[YOUR NAME\]/g, who.name || '[YOUR NAME]').replace(/\[SCHOOL\]/g, who.school || '[SCHOOL]')

// Every phrase must be one of the rehearsed ones, character for character (the replay's matching is loose,
// but DEMO.md's cue card and the replay are the contract).
for (const s of demos) if (!REHEARSED.some((r) => r.say === s.phrase)) fail(`"${s.phrase}" is not a REHEARSED phrase (storyboard shot ${s.id})`)
if (failures.length) process.exit(1)

let pageErrors = 0
const external = new Set()
const browser = await chromium.launch({ executablePath: process.env.GHOST_CHROMIUM || undefined, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  recordVideo: { dir: footageDir, size: { width, height } },
  timezoneId: 'Africa/Kigali', // the reminder card shows a clock time; make it Rwanda's
  locale: 'en-GB'
})
// Headless Chromium has no voices; record what would be spoken instead (and keep the page quiet).
await ctx.addInitScript(() => {
  window.__utter = []
  if (window.speechSynthesis) {
    window.speechSynthesis.speak = (u) => window.__utter.push({ text: u.text, lang: u.lang })
  }
})
// "No internet": only the local preview server is reachable, like the booth without Wi-Fi.
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url())
  if (['127.0.0.1', 'localhost'].includes(u.hostname) || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue()
  external.add(u.origin)
  return route.abort()
})
const page = await ctx.newPage()
const t0 = Date.now() // wall clock of the first video frame, roughly; calibrated by the flash below
page.on('pageerror', (e) => {
  pageErrors++
  console.log('PAGEERROR:', e.message)
})
await page.goto(base)
await page.waitForSelector('.chat-input textarea', { timeout: 30000 })
await page.evaluate(() => document.fonts.ready)
await sleep(1500)
const fonts = await page.evaluate(() => [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))])
console.log('fonts loaded:', fonts.join(', ') || 'NONE')
if (!fonts.some((f) => /Inter/.test(f)) || !fonts.some((f) => /JetBrains/.test(f))) fail('the app fonts (Inter, JetBrains Mono) did not load')
const modeText = await page.locator('.mode').innerText().catch(() => '')
console.log('mode badge:', modeText.trim())
if (!small && !/^AUTO$/i.test(modeText.trim())) fail(`presenter mode should start in AUTO, badge says "${modeText.trim()}"`)
if (!(await page.locator('.replay-badge').count())) fail('the "Offline replay" badge is missing')

// The honesty badge must never sit on the composer or the bar (same check as verify-replay.mjs).
async function badgeClear(where) {
  const hit = await page.evaluate(() => {
    const box = (s) => document.querySelector(s)?.getBoundingClientRect()
    const b = box('.replay-badge')
    if (!b || !b.width) return 'badge not visible'
    const over = (o) => o && b.left < o.right && o.left < b.right && b.top < o.bottom && o.top < b.bottom
    return over(box('.chat-input')) ? 'composer' : over(box('.topbar')) ? 'bar' : b.right > innerWidth || b.bottom > innerHeight ? 'window edge' : ''
  })
  if (hit) fail(`${where}: the replay badge overlaps the ${hit}`)
}
await badgeClear('start screen')

// Calibration: a 300 ms white flash at a known moment. edit.mjs and this script find its first frame in the
// video, which pins wall-clock times to video time exactly (the screencast has its own start and latency).
const flashAt = Date.now()
await page.evaluate(() => {
  const d = document.createElement('div')
  d.id = '__flash'
  d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:2147483647'
  document.body.appendChild(d)
})
await sleep(300)
await page.evaluate(() => document.getElementById('__flash')?.remove())
await sleep(1800)

// Human typing: ~35 ms per character with a little jitter, a breath after commas and full stops, and
// drift-free pacing (each character is due at a fixed time, whatever the round trip costs).
const T = sb.typing
async function typeHuman(text) {
  let due = Date.now()
  for (const ch of text) {
    await page.keyboard.type(ch)
    due += T.msPerChar + (Math.random() * 2 - 1) * T.jitterMs + (ch === ',' ? T.pauseAfterCommaMs : /[.?!]/.test(ch) ? T.pauseAfterStopMs : 0)
    const w = due - Date.now()
    if (w > 0) await sleep(w)
  }
}
const runs = () => page.evaluate(() => window.__ghostReplay?.runs.length || 0)
const scrollEnd = () => page.evaluate(() => document.querySelector('.messages')?.scrollTo(0, 1e6))

const shots = []
for (const s of demos) {
  const phrase = fill(s.phrase)
  const rec = { id: s.id, demo: s.demo, scenario: s.scenario, phrase }
  if (s.before?.newChat) {
    rec.newChatAt = Date.now()
    // Ctrl+N, the way the app hears it (Main.jsx listens for keydown on window). Then wait for the
    // empty start screen. Under software GL (swiftshader, as in the cloud) mounting that screen's 3D
    // gem freezes the page for ~7 s (WebGL setup), so the old chat stays on screen that long; on a real
    // GPU it is instant. The stretch is idle footage, and edit.mjs speeds idle stretches over 4 s up.
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true })))
    const emptyAt = await page.waitForFunction(() => !!document.querySelector('.messages > .empty'), null, { timeout: 20000, polling: 50 }).then(() => Date.now(), () => null)
    if (emptyAt == null) fail(`${s.id}: Ctrl+N did not start a new chat within 20 s`)
    else rec.newChatSeconds = Number(((emptyAt - rec.newChatAt) / 1000).toFixed(2))
    await sleep(700)
  }
  if (s.before?.command) {
    rec.command = s.before.command
    rec.commandStart = Date.now()
    await page.locator('.chat-input textarea').click()
    await typeHuman(s.before.command)
    rec.commandEnter = Date.now()
    await page.keyboard.press('Enter')
    if (s.before.expectMode) {
      await page.waitForFunction((m) => document.querySelector(`.mode.mode-${m}`), s.before.expectMode, { timeout: 5000 }).catch(() => fail(`${s.id}: ${s.before.command} did not switch the badge to ${s.before.expectMode}`))
    }
    await sleep(900)
  }
  const before = await runs()
  await page.locator('.chat-input textarea').click()
  rec.typingStart = Date.now()
  await typeHuman(phrase)
  rec.enter = Date.now()
  await page.keyboard.press('Enter')
  try {
    await page.waitForFunction((n) => window.__ghostReplay.runs.length > n && window.__ghostReplay.runs.at(-1).done, before, { timeout: 60000 })
  } catch {
    fail(`${s.id}: the replay did not finish answering "${phrase}"`)
  }
  rec.answerDone = Date.now()
  const run = await page.evaluate(() => window.__ghostReplay.runs.at(-1))
  rec.landed = run?.scenario
  rec.mode = run?.mode
  rec.brain = run?.brain
  if (run?.scenario !== s.scenario) fail(`${s.id}: "${phrase}" landed on ${run?.scenario}, expected ${s.scenario}`)
  if (s.before?.expectMode && run?.mode !== s.before.expectMode) fail(`${s.id}: ran in mode ${run?.mode}, expected ${s.before.expectMode}`)
  // Hold: the brief's 1.8 s after the answer stops, or longer so the shot fits its narration line (which
  // starts at typing start) plus a small gap before the next line.
  const elapsed = (Date.now() - rec.typingStart) / 1000
  const need = (narration[s.id] || 0) + (sb.narrationGapSeconds ?? 0.7)
  // Per shot: storyboard.json shots[].holdAfterAnswerSeconds (longer for answers worth reading in full).
  const hold = Math.max(s.holdAfterAnswerSeconds ?? sb.holdAfterAnswerSeconds ?? 1.8, need - elapsed)
  rec.holdSeconds = Number(hold.toFixed(2))
  await sleep(hold * 1000 - 250)
  await scrollEnd()
  await sleep(250)
  rec.finish = Date.now()
  await badgeClear(s.id)
  shots.push(rec)
  console.log(`${s.id.padEnd(11)} → ${String(run?.scenario).padEnd(15)} typed ${((rec.enter - rec.typingStart) / 1000).toFixed(1)} s · answer ${((rec.answerDone - rec.enter) / 1000).toFixed(1)} s · hold ${hold.toFixed(1)} s · shot ${((rec.finish - rec.typingStart) / 1000).toFixed(1)} s${rec.command ? ` (after ${rec.command})` : ''}${rec.newChatSeconds != null ? ` (new chat took ${rec.newChatSeconds} s)` : ''}`)
}
await sleep(1200)
const utter = await page.evaluate(() => window.__utter.length)
const video = page.video()
await ctx.close()
if (existsSync(videoOut)) unlinkSync(videoOut)
await video.saveAs(videoOut)
await video.delete().catch(() => {})
for (const f of readdirSync(footageDir)) if (f.endsWith('.webm') && f !== 'replay.webm') unlinkSync(join(footageDir, f))
await browser.close()

// ---- calibrate: find the white flash in the video ------------------------------------------------
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 })
const metaFile = join(footageDir, 'flash-scan.txt')
const scanUntil = Math.min(12, (flashAt - t0) / 1000 + 6)
sh('ffmpeg', ['-y', '-v', 'error', '-t', String(scanUntil), '-i', videoOut, '-vf', `signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${metaFile}`, '-f', 'null', '-'])
let flashPts = null
if (existsSync(metaFile)) {
  // The very first frames are the blank white page before the app loads, so the flash is the first
  // bright frame AFTER the dark app has been on screen.
  let pts = null
  let seenDark = false
  for (const line of readFileSync(metaFile, 'utf8').split('\n')) {
    const p = line.match(/pts_time:([\d.]+)/)
    if (p) pts = Number(p[1])
    const y = line.match(/YAVG=([\d.]+)/)
    if (!y) continue
    const luma = Number(y[1])
    if (luma < 100) seenDark = true
    else if (luma > 150 && seenDark && flashPts == null) flashPts = pts
  }
  unlinkSync(metaFile)
}
if (flashPts == null) fail('calibration flash not found in the video (no bright frame after a dark one in the first seconds)')
const offset = flashPts == null ? 0 : flashPts - (flashAt - t0) / 1000
const vt = (ms) => Number(((ms - t0) / 1000 + offset).toFixed(3))
const videoSeconds = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoOut]).stdout.trim())
console.log(`video ${videoSeconds.toFixed(1)} s · flash at ${flashPts?.toFixed(3)} s → wall-clock offset ${offset.toFixed(3)} s`)

const timeline = {
  recordedAt: new Date().toISOString(),
  base,
  layout: small ? 'normal' : 'presenter',
  viewport: { width, height },
  video: 'footage/replay.webm',
  videoSeconds,
  calibration: { flashAtVideoSeconds: flashPts, offsetSeconds: Number(offset.toFixed(3)) },
  fonts,
  utterancesQueued: utter,
  shots: shots.map((r) => ({
    id: r.id,
    demo: r.demo,
    scenario: r.landed,
    mode: r.mode,
    brain: r.brain,
    phrase: r.phrase,
    ...(r.command ? { command: r.command, commandStart: vt(r.commandStart), commandEnter: vt(r.commandEnter) } : {}),
    ...(r.newChatAt ? { newChatAt: vt(r.newChatAt), newChatSeconds: r.newChatSeconds ?? null } : {}),
    typingStart: vt(r.typingStart),
    enter: vt(r.enter),
    answerDone: vt(r.answerDone),
    finish: vt(r.finish),
    typingSeconds: Number(((r.enter - r.typingStart) / 1000).toFixed(2)),
    answerSeconds: Number(((r.answerDone - r.enter) / 1000).toFixed(2)),
    holdSeconds: r.holdSeconds,
    shotSeconds: Number(((r.finish - r.typingStart) / 1000).toFixed(2))
  }))
}
writeFileSync(join(here, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n')

// ---- frames to look at: one set per shot ------------------------------------------------------------
let n = 0
for (const s of timeline.shots) {
  n++
  const at = {
    typing: s.typingStart + s.typingSeconds * 0.6,
    working: s.enter + Math.min(2.5, s.answerSeconds * 0.4),
    answer: s.answerDone + 0.15,
    end: s.finish - 0.15
  }
  for (const [k, t] of Object.entries(at)) {
    const out = join(framesDir, `${String(n).padStart(2, '0')}-${s.id}-${k}.png`)
    const r = sh('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', videoOut, '-frames:v', '1', '-update', '1', out])
    if (r.status !== 0 || !existsSync(out)) fail(`could not extract frame ${k} of ${s.id} at ${t.toFixed(2)} s`)
  }
}
console.log(`frames: ${framesDir}`)
console.log(external.size ? `blocked external requests (would need internet): ${[...external].join(', ')}` : 'no external requests: works offline')
console.log(pageErrors ? `${pageErrors} page error(s)` : 'no page errors')
const first = timeline.shots[0]?.typingStart
const last = timeline.shots.at(-1)?.finish
if (first != null) console.log(`footage: ${((last ?? 0) - first).toFixed(1)} s of demos (from ${first.toFixed(1)} s to ${last.toFixed(1)} s)`)
console.log(failures.length || pageErrors ? `${failures.length + pageErrors} failure(s)` : 'RECORDING OK')
process.exit(failures.length || pageErrors ? 1 : 0)
