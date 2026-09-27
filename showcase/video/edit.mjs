// Assemble the demo video with ffmpeg: title card → the replay footage → closing card, 16:9 (1920x1080,
// a PC/projector presentation), with each shot's caption as a lower third, an optional small persistent
// badge (storyboard.json → badge; null for none), and the narration lines placed at each shot's
// typing-start time (never overlapping). Also the thumbnail. Cards and overlays are rendered from cards.html (red variant of the
// kit's DESIGN.md look).
//
//   node showcase/video/narrate.mjs && node showcase/video/record.mjs     (first)
//   node showcase/video/edit.mjs [--cards-only] [--skip-cards]
//
// Reads: storyboard.json, timeline.json (record.mjs), voice/manifest.json (narrate.mjs),
//        footage/replay.webm, cards.html, frames/02-hero-answer.png (for the thumbnail)
// Writes: ghost-prime-demo.mp4 (1920x1080, H.264 yuv420p 30 fps, AAC, faststart, <= 25 MB),
//         thumbnail.png (1280x720), plan.json (the exact schedule and layout used: shot windows,
//         captions, narration starts, overlay boxes; check.mjs reads it), render/*.png (regenerated)
// Layout: the 1366x768 app footage scaled to 1664x936 (16:9) at the top of the frame; under it a 120 px
// band holds the caption (left) and the badge, if any (right), so no overlay ever covers the app.
// Rules from the brief: idle or typing stretches longer than 4 s may be sped up (storyboard.json → edit:
// speedUpTypingOver / typingSpeed for typing, speedUpIdleOver / idleSpeed for idle stretches between
// shots); the moments an answer streams are never touched. Narration peaks at -3 dBFS with short fades.
import { chromium } from '../../node_modules/playwright/index.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const cardsOnly = args.includes('--cards-only')
const skipCards = args.includes('--skip-cards')
const sb = JSON.parse(readFileSync(join(here, 'storyboard.json'), 'utf8'))
const renderDir = join(here, 'render')
mkdirSync(renderDir, { recursive: true })
const FPS = sb.output?.fps || 30
const [W, H] = sb.output?.size || [1920, 1080]
const GROUND = '#0A0507' // cards.html --ground
const ed = { speedUpTypingOver: 4, typingSpeed: 1.5, speedUpIdleOver: 4, idleSpeed: 4, lead: 1.0, tail: 0.4, ...(sb.edit || {}) }

const sh = (cmd, a, opts = {}) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const must = (cmd, a, what) => {
  const r = sh(cmd, a)
  if (r.status !== 0) throw new Error(`${what || cmd} failed:\n${(r.stderr || r.stdout || '').slice(-3000)}`)
  return r
}
const fmt = (n) => Number(n.toFixed(3))
const even = (n) => 2 * Math.round(n / 2)
const demos = sb.shots.filter((s) => s.kind === 'demo')
const titleShot = sb.shots.find((s) => s.id === 'title')
const closingShot = sb.shots.find((s) => s.id === 'closing')
const who = sb.presenter || {}

// ---- layout (1920x1080) ------------------------------------------------------------------------------
const band = 120
const FW = 1664
const FH = even((FW * sb.viewport.height) / sb.viewport.width) // 936 for 1366x768
const FX = (W - FW) / 2
const FY = Math.max(16, Math.round((H - band - FH) / 2))
const BAND_Y = FY + FH
const layout = { footage: { x: FX, y: FY, w: FW, h: FH }, band: { x: FX, y: BAND_Y, w: FW, h: H - BAND_Y } }

// ---- cards -----------------------------------------------------------------------------------------
async function renderCards() {
  const browser = await chromium.launch({ executablePath: process.env.GHOST_CHROMIUM || undefined, args: ['--disable-gpu', '--disable-dev-shm-usage'] })
  const base = pathToFileURL(join(here, 'cards.html')).href
  let problems = 0
  async function shoot(params, out, { viewport, element } = {}) {
    const ctx = await browser.newContext({ viewport: viewport || { width: W, height: H }, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => {
      problems++
      console.log('PAGEERROR:', e.message)
    })
    page.on('requestfailed', (r) => {
      problems++
      console.log('REQUESTFAILED:', r.url())
    })
    await page.goto(`${base}?${new URLSearchParams(params)}`)
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))))
    })
    const fonts = await page.evaluate(() => [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))])
    if (/title|closing|thumb/.test(params.view) && !fonts.some((f) => /Archivo/.test(f))) {
      problems++
      console.log(`fonts not loaded for ${params.view}: ${fonts.join(', ') || 'none'}`)
    }
    await page.waitForTimeout(120)
    if (element) await page.locator(element).screenshot({ path: out, omitBackground: true })
    else await page.screenshot({ path: out })
    await ctx.close()
    console.log('rendered', out.replace(here + '/', ''))
  }
  const common = { eyebrow: sb.event.replace(/\s+(\d{4})$/, ' · $1'), name: who.name || '', class: who.class || '', school: who.school || '' }
  const tc = titleShot?.card || {}
  const cc = closingShot?.card || {}
  await shoot({ view: 'title', ...common, statement: tc.statement || 'Use a computer just by talking.' }, join(renderDir, 'title.png'))
  await shoot({ view: 'closing', ...common, line1: cc.line1, line2: cc.line2 }, join(renderDir, 'closing.png'))
  if (sb.badge) await shoot({ view: 'badge', text: sb.badge }, join(renderDir, 'badge.png'), { viewport: { width: 900, height: 200 }, element: '#el' })
  for (const s of demos) await shoot({ view: 'caption', text: s.caption }, join(renderDir, `caption-${s.id}.png`), { viewport: { width: 1200, height: 200 }, element: '#el' })
  const heroFrame = join(here, 'frames', `${String(demos.findIndex((s) => s.id === 'hero') + 1).padStart(2, '0')}-hero-answer.png`)
  await shoot({ view: 'thumb', ...common, chip: sb.badge || '', img: existsSync(heroFrame) ? pathToFileURL(heroFrame).href : '' }, join(renderDir, 'thumb.png'))
  await browser.close()
  if (problems) throw new Error(`${problems} problem(s) rendering the cards`)
}
if (!skipCards) await renderCards()
if (cardsOnly) {
  console.log('cards only: done')
  process.exit(0)
}

// ---- schedule -------------------------------------------------------------------------------------
const tl = JSON.parse(readFileSync(join(here, 'timeline.json'), 'utf8'))
const mf = JSON.parse(readFileSync(join(here, 'voice', 'manifest.json'), 'utf8'))
const narr = Object.fromEntries(mf.lines.map((l) => [l.shot, l]))
const footage = join(here, tl.video)
if (!existsSync(footage)) throw new Error(`footage missing: ${tl.video} (run record.mjs)`)
if (tl.viewport.width !== sb.viewport.width || tl.viewport.height !== sb.viewport.height) throw new Error(`timeline.json was recorded at ${tl.viewport.width}x${tl.viewport.height}, storyboard says ${sb.viewport.width}x${sb.viewport.height}: re-run record.mjs`)
const rec = tl.shots
const byId = Object.fromEntries(rec.map((r) => [r.id, r]))
for (const s of demos) if (!byId[s.id]) throw new Error(`timeline.json has no shot ${s.id}; re-run record.mjs`)

const srcStart = Math.max(0, rec[0].typingStart - ed.lead)
const srcEnd = Math.min(tl.videoSeconds, rec.at(-1).finish + ed.tail)
// Sped up: typing stretches longer than the threshold, and idle stretches between shots longer than the
// threshold (the answer is done and the next phrase has not started). Answers always stream at 1x.
const fast = rec.filter((r) => r.typingSeconds > ed.speedUpTypingOver).map((r) => ({ start: r.typingStart, end: r.enter, speed: ed.typingSpeed, shot: r.id, what: 'typing' }))
rec.forEach((r, i) => {
  const next = rec[i + 1]
  if (!next) return
  const idleStart = r.finish + 0.3
  const idleEnd = (next.commandStart ?? next.typingStart) - 0.3
  if (idleEnd - idleStart > ed.speedUpIdleOver) fast.push({ start: idleStart, end: idleEnd, speed: ed.idleSpeed, shot: `${r.id}→${next.id}`, what: 'idle' })
})
fast.sort((a, b) => a.start - b.start)
const segs = []
let cur = srcStart
for (const f of fast) {
  if (f.start > cur) segs.push({ start: cur, end: f.start, speed: 1 })
  segs.push(f)
  cur = f.end
}
if (cur < srcEnd) segs.push({ start: cur, end: srcEnd, speed: 1 })
const segLen = (s) => (s.end - s.start) / s.speed
const footSec = segs.reduce((a, s) => a + segLen(s), 0)
const mapT = (t) => {
  let acc = 0
  for (const s of segs) {
    if (t <= s.end) return acc + Math.max(0, t - s.start) / s.speed
    acc += segLen(s)
  }
  return acc
}
const titleSec = Math.max(titleShot?.seconds || 5, (narr.title?.seconds || 0) + 0.9)
const closingSec = Math.max(closingShot?.seconds || 6, (narr.closing?.seconds || 0) + 0.9)
const footStart = titleSec
const footEnd = titleSec + footSec
const total = footEnd + closingSec
const out = (t) => fmt(footStart + mapT(t))

const shots = demos.map((s, i) => {
  const r = byId[s.id]
  const next = rec[i + 1]
  // A shot's caption appears when its shot visibly starts: the new chat screen (recall), /mode plan being
  // typed (PLAN), or else the typing of its phrase.
  const begin = (x) => (x.newChatAt != null && x.newChatSeconds != null ? x.newChatAt + x.newChatSeconds : x.commandStart ?? x.typingStart)
  const start = out(begin(r))
  const end = next ? fmt(out(begin(next)) - 0.05) : fmt(footEnd)
  return { id: s.id, caption: s.caption, start, end, typingStart: out(r.typingStart), enter: out(r.enter), answerDone: out(r.answerDone), finish: out(r.finish), narrationStart: out(r.typingStart), narrationSeconds: narr[s.id]?.seconds || 0 }
})
const narration = [
  ...(narr.title ? [{ shot: 'title', start: 0.4, seconds: narr.title.seconds, file: narr.title.file }] : []),
  ...shots.filter((s) => narr[s.id]).map((s) => ({ shot: s.id, start: s.narrationStart, seconds: narr[s.id].seconds, file: narr[s.id].file })),
  ...(narr.closing ? [{ shot: 'closing', start: fmt(footEnd + 0.4), seconds: narr.closing.seconds, file: narr.closing.file }] : [])
]
const problems = []
for (let i = 0; i + 1 < narration.length; i++) {
  const a = narration[i]
  const b = narration[i + 1]
  if (a.start + a.seconds + 0.1 > b.start) problems.push(`narration overlap: ${a.shot} ends at ${fmt(a.start + a.seconds)} s, ${b.shot} starts at ${b.start} s`)
}
if (total > (sb.output?.maxSeconds || 120)) problems.push(`total ${total.toFixed(1)} s is over ${sb.output?.maxSeconds || 120} s`)

// overlay boxes (for check.mjs too)
const pngSize = (file) => {
  const [w, h] = must('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).stdout.trim().split(',').map(Number)
  return { w, h }
}
if (sb.badge) {
  const badgeSize = pngSize(join(renderDir, 'badge.png'))
  layout.badge = { x: FX + FW - badgeSize.w + 4, y: BAND_Y + Math.round((H - BAND_Y - badgeSize.h) / 2), ...badgeSize }
}
const capSize = pngSize(join(renderDir, `caption-${demos[0].id}.png`))
layout.caption = { x: FX - 4, y: BAND_Y + Math.round((H - BAND_Y - capSize.h) / 2), ...capSize }
if (layout.badge && layout.caption.x + capSize.w > layout.badge.x) console.log(`note: caption box reaches ${layout.caption.x + capSize.w}px, badge starts at ${layout.badge.x}px (captions are short, so the text itself stays clear)`)

const plan = {
  madeAt: new Date().toISOString(),
  size: [W, H],
  totalSeconds: fmt(total),
  layout,
  title: { start: 0, end: fmt(titleSec) },
  footage: { start: fmt(footStart), end: fmt(footEnd), source: tl.video, sourceStart: fmt(srcStart), sourceEnd: fmt(srcEnd), segments: segs.map((s) => ({ ...s, start: fmt(s.start), end: fmt(s.end), outStart: fmt(footStart + mapT(s.start)), outEnd: fmt(footStart + mapT(s.end)) })) },
  closing: { start: fmt(footEnd), end: fmt(total) },
  badge: sb.badge ? { text: sb.badge, start: fmt(footStart), end: fmt(footEnd) } : null,
  shots,
  narration
}
writeFileSync(join(here, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
console.log(`plan: title ${titleSec.toFixed(1)} s · footage ${footSec.toFixed(1)} s (${segs.length} segment(s)${fast.length ? `; sped up: ${fast.map((f) => `${f.what} ${f.shot} ${f.speed}x`).join(', ')}` : ''}) · closing ${closingSec.toFixed(1)} s · total ${total.toFixed(1)} s`)
for (const s of shots) console.log(`  ${s.id.padEnd(11)} caption ${s.start.toFixed(1).padStart(5)}–${s.end.toFixed(1).padStart(5)} s · narration at ${s.narrationStart.toFixed(1)} s for ${s.narrationSeconds.toFixed(1)} s · answer done ${s.answerDone.toFixed(1)} s`)
if (problems.length) {
  console.log(problems.join('\n'))
  process.exit(1)
}

// ---- narration bed ---------------------------------------------------------------------------------
const bed = join(renderDir, 'narration.wav')
{
  const inputs = []
  const chains = []
  narration.forEach((n, i) => {
    inputs.push('-i', join(here, n.file))
    chains.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(n.start * 1000)}:all=1[n${i}]`)
  })
  const mix = `${narration.map((_, i) => `[n${i}]`).join('')}amix=inputs=${narration.length}:normalize=0:duration=longest,apad,atrim=0:${total.toFixed(3)},aformat=channel_layouts=stereo[a]`
  const raw = join(renderDir, 'narration-raw.wav')
  must('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${chains.join(';')};${mix}`, '-map', '[a]', '-c:a', 'pcm_s16le', raw], 'narration bed')
  // Mono → stereo costs 3 dB: measure the bed and bring its peak back to exactly -3 dBFS.
  const det = sh('ffmpeg', ['-v', 'info', '-i', raw, '-af', 'volumedetect', '-f', 'null', '-'])
  const peak = Number((det.stderr.match(/max_volume: (-?[\d.]+) dB/) || [])[1])
  const gain = Number.isFinite(peak) ? (-3 - peak).toFixed(2) : '0'
  must('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', `volume=${gain}dB`, '-c:a', 'pcm_s16le', bed], 'narration level')
  console.log(`narration bed: peak ${peak} dB, gain ${gain} dB → -3 dBFS`)
}

// ---- the cut ---------------------------------------------------------------------------------------
const outFile = join(here, 'ghost-prime-demo.mp4')
{
  const inputs = ['-loop', '1', '-framerate', String(FPS), '-t', titleSec.toFixed(3), '-i', join(renderDir, 'title.png'), '-i', footage, '-loop', '1', '-framerate', String(FPS), '-t', closingSec.toFixed(3), '-i', join(renderDir, 'closing.png')]
  let idx = 3
  const f = []
  f.push(`[0:v]fps=${FPS},format=yuv420p,setsar=1,fade=t=in:st=0:d=0.4,fade=t=out:st=${(titleSec - 0.4).toFixed(3)}:d=0.4[t]`)
  f.push(`${segs.map((s, i) => `[1:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed}[s${i}]`).join(';')};${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=1:a=0[fc]`)
  f.push(`[fc]fps=${FPS},scale=${FW}:${FH}:flags=lanczos,pad=${W}:${H}:${FX}:${FY}:color=${GROUND},setsar=1,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=${(footSec - 0.3).toFixed(3)}:d=0.3[f]`)
  f.push(`[2:v]fps=${FPS},format=yuv420p,setsar=1,fade=t=in:st=0:d=0.4,fade=t=out:st=${(closingSec - 0.6).toFixed(3)}:d=0.6[c]`)
  f.push(`[t][f][c]concat=n=3:v=1:a=0[v0]`)
  let v = 'v0'
  const overlay = (img, pos, start, end, label) => {
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', total.toFixed(3), '-i', img)
    const i = idx++
    f.push(`[${i}:v]format=rgba,fade=t=in:st=${start.toFixed(3)}:d=0.25:alpha=1,fade=t=out:st=${Math.max(start, end - 0.25).toFixed(3)}:d=0.25:alpha=1[${label}]`)
    f.push(`[${v}][${label}]overlay=x=${pos.x}:y=${pos.y}:format=auto:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${label}o]`)
    v = `${label}o`
  }
  if (layout.badge) overlay(join(renderDir, 'badge.png'), layout.badge, footStart, footEnd, 'bd')
  shots.forEach((s, k) => overlay(join(renderDir, `caption-${s.id}.png`), layout.caption, s.start, s.end, `c${k}`))
  f.push(`[${v}]format=yuv420p[vout]`)
  inputs.push('-i', bed)
  const a = idx++
  for (const crf of [20, 23, 26, 29]) {
    must('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', `${a}:a`, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-r', String(FPS), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-t', total.toFixed(3), outFile], 'ffmpeg ghost-prime-demo.mp4')
    const mb = statSync(outFile).size / 1048576
    console.log(`wrote ghost-prime-demo.mp4: ${mb.toFixed(1)} MB at crf ${crf}`)
    if (mb <= 25) break
  }
}
must('ffmpeg', ['-y', '-v', 'error', '-i', join(renderDir, 'thumb.png'), '-vf', 'scale=1280:720:flags=lanczos', join(here, 'thumbnail.png')], 'thumbnail')
console.log('wrote thumbnail.png')
console.log('EDIT DONE')
