// Verify the rendered video against plan.json, the way a careful editor would before handing it over:
//   1. ffprobe: 1920x1080 H.264 yuv420p 30 fps, AAC, duration <= 120 s, size <= 25 MB, faststart.
//   2. Frames every 3 s into check/, plus a contact sheet, to look at by eye.
//      Black-frame detection: nothing black except the fades between cards and footage.
//   3. Overlays: the badge region is lit during the footage; each shot's caption region is lit in its window.
//   4. Audio: speech present in every narration window, silence between lines (no overlap, nothing stray),
//      no clipping (peak <= -2.5 dBFS).
//   node showcase/video/check.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plan = JSON.parse(readFileSync(join(here, 'plan.json'), 'utf8'))
const sb = JSON.parse(readFileSync(join(here, 'storyboard.json'), 'utf8'))
const checkDir = join(here, 'check')
rmSync(checkDir, { recursive: true, force: true })
mkdirSync(checkDir, { recursive: true })
const sh = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 28 })
const problems = []
const bad = (m) => {
  problems.push(m)
  console.log('FAIL:', m)
}
const ok = (m) => console.log('ok  ', m)
const total = plan.totalSeconds

function probe(file) {
  const r = sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate:format=duration,size', '-of', 'json', file])
  const j = JSON.parse(r.stdout)
  const v = j.streams.find((s) => s.codec_type === 'video')
  const a = j.streams.find((s) => s.codec_type === 'audio')
  return { v, a, duration: Number(j.format.duration), size: Number(j.format.size) }
}
function faststart(file) {
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(Math.min(statSync(file).size, 8 << 20))
  readSync(fd, buf, 0, buf.length, 0)
  const moov = buf.indexOf('moov')
  const mdat = buf.indexOf('mdat')
  return moov >= 0 && (mdat < 0 || moov < mdat)
}
function levels(file, start, dur) {
  const r = sh('ffmpeg', ['-v', 'info', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
  const pick = (k) => Number((r.stderr.match(new RegExp(`${k}: (-?[\\d.]+) dB`)) || [])[1])
  return { mean: pick('mean_volume'), max: pick('max_volume') }
}
function regionLuma(file, t, [w, h, x, y]) {
  const r = sh('ffmpeg', ['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-`, '-f', 'null', '-'])
  return Number((r.stdout.match(/YAVG=([\d.]+)/) || [])[1])
}
function blackPeriods(file) {
  const r = sh('ffmpeg', ['-v', 'info', '-i', file, '-an', '-vf', 'blackdetect=d=0.15:pix_th=0.10', '-f', 'null', '-'])
  return [...r.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

function checkVideo(name, { W, H, badgeRegion, captionRegion, frameEvery, tileCols }) {
  const file = join(here, name)
  console.log(`\n== ${name}`)
  if (!existsSync(file)) return bad(`${name} is missing`)
  const p = probe(file)
  const fps = p.v?.r_frame_rate
  ;(p.v?.codec_name === 'h264' ? ok : bad)(`${name}: video ${p.v?.codec_name} ${p.v?.width}x${p.v?.height} ${p.v?.pix_fmt} ${fps}`)
  if (p.v?.pix_fmt !== 'yuv420p') bad(`${name}: pixel format ${p.v?.pix_fmt}, expected yuv420p`)
  if (fps !== '30/1') bad(`${name}: frame rate ${fps}, expected 30/1`)
  if (p.v?.width !== W || p.v?.height !== H) bad(`${name}: ${p.v?.width}x${p.v?.height}, expected ${W}x${H}`)
  ;(p.a?.codec_name === 'aac' ? ok : bad)(`${name}: audio ${p.a?.codec_name} ${p.a?.sample_rate} Hz`)
  ;(p.duration <= (sb.output?.maxSeconds || 120) ? ok : bad)(`${name}: duration ${p.duration.toFixed(2)} s (plan ${total} s, limit ${sb.output?.maxSeconds || 120} s)`)
  if (!near(p.duration, total, 0.3)) bad(`${name}: duration ${p.duration.toFixed(2)} s does not match plan.json ${total} s`)
  ;(p.size <= 25 * 1048576 ? ok : bad)(`${name}: ${(p.size / 1048576).toFixed(1)} MB (limit 25 MB)`)
  ;(faststart(file) ? ok : bad)(`${name}: faststart (moov before mdat)`)

  // frames to look at
  const prefix = 'l'
  sh('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vf', `fps=1/${frameEvery}`, join(checkDir, `${prefix}-%03d.png`)])
  const n = Math.floor(p.duration / frameEvery) + 1
  sh('ffmpeg', ['-y', '-v', 'error', '-pattern_type', 'glob', '-i', join(checkDir, `${prefix}-*.png`), '-vf', `scale=640:-1,tile=${tileCols}x${Math.ceil(n / tileCols)}:padding=4:margin=4:color=#333333`, '-frames:v', '1', join(checkDir, `sheet-${prefix}.png`)])
  ok(`${name}: ${n} frames every ${frameEvery} s → check/${prefix}-NNN.png, check/sheet-${prefix}.png`)

  // black frames only in the fades
  const allowed = [
    [0, 0.5],
    [plan.title.end - 0.5, plan.title.end + 0.4],
    [plan.footage.end - 0.4, plan.footage.end + 0.5],
    [total - 0.8, total + 0.1]
  ]
  const black = blackPeriods(file)
  const stray = black.filter(([s, e]) => !allowed.some(([a, b]) => s >= a - 0.05 && e <= b + 0.05))
  ;(stray.length ? bad : ok)(`${name}: black frames ${black.length ? black.map(([s, e]) => `${s.toFixed(2)}–${e.toFixed(2)}`).join(', ') : 'none'}${stray.length ? ` — outside the fades: ${stray.map(([s, e]) => `${s.toFixed(2)}–${e.toFixed(2)}`).join(', ')}` : ' (fades only)'}`)

  // overlays: badge lit through the footage, each caption lit in its window, band dark without a caption.
  // Luma is the raw Y plane (limited range: black = 16), so the Void ground reads about 20; anything
  // drawn on it reads 30 and up.
  const DARK = 24
  const LIT = 28
  const mid = (plan.footage.start + plan.footage.end) / 2
  const badgeY = regionLuma(file, mid, badgeRegion)
  ;(badgeY > LIT ? ok : bad)(`${name}: badge region luma ${badgeY?.toFixed(1)} mid-footage (lit is > ${LIT})`)
  const badgeEnd = regionLuma(file, plan.footage.end - 0.6, badgeRegion)
  ;(badgeEnd > LIT ? ok : bad)(`${name}: badge region luma ${badgeEnd?.toFixed(1)} at the end of the footage`)
  for (const s of plan.shots) {
    const t = (s.start + s.end) / 2
    const y = regionLuma(file, t, captionRegion)
    ;(y > LIT ? ok : bad)(`${name}: caption "${s.caption}" region luma ${y?.toFixed(1)} at ${t.toFixed(1)} s`)
  }
  const noCap = regionLuma(file, plan.footage.start + 0.35, captionRegion)
  ;(noCap < DARK ? ok : bad)(`${name}: caption region luma ${noCap?.toFixed(1)} just before the first caption (dark is < ${DARK})`)

  // audio: speech in every narration window, silence between, no clipping
  const lines = plan.narration
  for (const [i, l] of lines.entries()) {
    const { mean, max } = levels(file, l.start + 0.05, Math.max(0.3, l.seconds - 0.35))
    ;(mean > -35 ? ok : bad)(`${name}: narration ${l.shot.padEnd(10)} ${l.start.toFixed(1)}–${(l.start + l.seconds).toFixed(1)} s mean ${mean} dB peak ${max} dB`)
    if (max > -2.5) bad(`${name}: ${l.shot} peaks at ${max} dB (clipping risk)`)
    const next = lines[i + 1]
    const gapStart = l.start + l.seconds + 0.05
    const gapEnd = next ? next.start - 0.05 : total - 0.1
    if (gapEnd - gapStart > 0.3) {
      const g = levels(file, gapStart, gapEnd - gapStart)
      ;(g.max < -50 ? ok : bad)(`${name}: gap after ${l.shot.padEnd(10)} ${gapStart.toFixed(1)}–${gapEnd.toFixed(1)} s peak ${g.max} dB (silence expected)`)
    }
  }
  const head = levels(file, 0, Math.max(0.2, lines[0].start - 0.05))
  ;(head.max < -50 ? ok : bad)(`${name}: before the first line 0–${(lines[0].start - 0.05).toFixed(1)} s peak ${head.max} dB`)
  const all = levels(file, 0, total)
  ;(all.max <= -2.5 ? ok : bad)(`${name}: overall peak ${all.max} dB, mean ${all.mean} dB`)
}

const L = plan.layout
const box = (b, w = b.w) => [Math.min(w, b.w), b.h, b.x, b.y]
checkVideo('ghost-prime-demo.mp4', { W: plan.size[0], H: plan.size[1], badgeRegion: box(L.badge), captionRegion: box(L.caption, 760), frameEvery: 3, tileCols: 6 })
const thumb = join(here, 'thumbnail.png')
if (existsSync(thumb)) {
  const r = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', thumb]).stdout.trim()
  ok(`thumbnail.png ${r} (${(statSync(thumb).size / 1024).toFixed(0)} KB)`)
} else bad('thumbnail.png is missing')
console.log(problems.length ? `\n${problems.length} problem(s)` : '\nALL CHECKS PASSED')
process.exit(problems.length ? 1 : 0)
