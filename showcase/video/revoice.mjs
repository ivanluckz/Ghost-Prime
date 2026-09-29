// Put a new narration on the finished video without re-recording or re-cutting it: the picture is copied
// as it is, only the sound changes. Use it after narrate.mjs made new voice files (for example
// NARRATE_ENGINE=gemini, Ghost-Prime's own voice) when the raw footage is not on this machine.
//
//   NARRATE_ENGINE=gemini node showcase/video/narrate.mjs
//   node showcase/video/revoice.mjs
//   node showcase/video/check.mjs
//
// Reads: ghost-prime-demo.mp4, plan.json (where each line starts), voice/manifest.json, voice/*.wav
// Writes: ghost-prime-demo.mp4 (same picture, new sound), plan.json (the new line lengths and voice)
// Every line keeps its start time, so it has to fit before the next one starts. A line that is a little
// too long is played up to 12 % faster (that still sounds natural); longer than that is an error, and
// nothing is written.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const renderDir = join(here, 'render')
mkdirSync(renderDir, { recursive: true })
const sh = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 28 })
const must = (cmd, a, what) => {
  const r = sh(cmd, a)
  if (r.status !== 0) throw new Error(`${what || cmd} failed:\n${(r.stderr || r.stdout || '').slice(-3000)}`)
  return r
}
const fmt = (n) => Number(n.toFixed(3))
const seconds = (file) => Number(must('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.trim())

const plan = JSON.parse(readFileSync(join(here, 'plan.json'), 'utf8'))
const mf = JSON.parse(readFileSync(join(here, 'voice', 'manifest.json'), 'utf8'))
const narr = Object.fromEntries(mf.lines.map((l) => [l.shot, l]))
const total = plan.totalSeconds
const video = join(here, 'ghost-prime-demo.mp4')
const MAX_SPEED = 1.12
const ROOM = 0.25 // narrate.mjs leaves this much silence after the words

// ---- fit every line into its slot ---------------------------------------------------------------------
const problems = []
const lines = plan.narration.map((n, i) => {
  const l = narr[n.shot]
  if (!l) {
    problems.push(`${n.shot}: no line in voice/manifest.json`)
    return n
  }
  const next = plan.narration[i + 1]
  const slot = (next ? next.start - 0.1 : total - 0.3) - n.start
  let file = join(here, l.file)
  let secs = seconds(file)
  let speed = 1
  if (secs > slot) {
    speed = Math.ceil(((secs - ROOM) / (slot - ROOM)) * 1000) / 1000
    if (speed > MAX_SPEED) problems.push(`${n.shot}: the line is ${secs.toFixed(2)} s but only ${slot.toFixed(2)} s are free (it would need ${speed}x). Shorten its narration in storyboard.json.`)
    else {
      const fitted = join(renderDir, `voice-${n.shot}.wav`)
      must('ffmpeg', ['-y', '-v', 'error', '-i', file, '-af', `atempo=${speed}`, '-c:a', 'pcm_s16le', fitted], `speed up ${n.shot}`)
      file = fitted
      secs = seconds(file)
    }
  }
  console.log(`  ${n.shot.padEnd(11)} at ${n.start.toFixed(1).padStart(5)} s · ${secs.toFixed(2)} s of ${slot.toFixed(2)} s free${speed > 1 ? ` · played ${speed}x` : ''}`)
  return { shot: n.shot, start: n.start, seconds: fmt(secs), file: l.file, ...(speed > 1 ? { speed } : {}), path: file }
})
if (problems.length) {
  console.log(problems.join('\n'))
  process.exit(1)
}

// ---- narration bed (the same mix as edit.mjs) -----------------------------------------------------------
const bed = join(renderDir, 'narration.wav')
{
  const inputs = []
  const chains = []
  lines.forEach((n, i) => {
    inputs.push('-i', n.path)
    chains.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(n.start * 1000)}:all=1[n${i}]`)
  })
  const mix = `${lines.map((_, i) => `[n${i}]`).join('')}amix=inputs=${lines.length}:normalize=0:duration=longest,apad,atrim=0:${total.toFixed(3)},aformat=channel_layouts=stereo[a]`
  const raw = join(renderDir, 'narration-raw.wav')
  must('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${chains.join(';')};${mix}`, '-map', '[a]', '-c:a', 'pcm_s16le', raw], 'narration bed')
  const det = sh('ffmpeg', ['-v', 'info', '-i', raw, '-af', 'volumedetect', '-f', 'null', '-'])
  const peak = Number((det.stderr.match(/max_volume: (-?[\d.]+) dB/) || [])[1])
  const gain = Number.isFinite(peak) ? (-3 - peak).toFixed(2) : '0'
  must('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', `volume=${gain}dB`, '-c:a', 'pcm_s16le', bed], 'narration level')
  console.log(`narration bed: peak ${peak} dB, gain ${gain} dB → -3 dBFS`)
}

// ---- same picture, new sound --------------------------------------------------------------------------
const before = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', video]).stdout.trim()
const tmp = join(renderDir, 'revoiced.mp4')
must('ffmpeg', ['-y', '-v', 'error', '-i', video, '-i', bed, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-t', total.toFixed(3), tmp], 'ffmpeg revoice')
const after = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', tmp]).stdout.trim()
if (before !== after) throw new Error(`the picture changed: ${before} frames before, ${after} after. The video was left as it was.`)
renameSync(tmp, video)
console.log(`wrote ghost-prime-demo.mp4: ${(statSync(video).size / 1048576).toFixed(1)} MB, ${after} frames (picture untouched)`)

// ---- the plan check.mjs reads ---------------------------------------------------------------------------
plan.narration = lines.map(({ path, ...n }) => n)
for (const s of plan.shots) if (narr[s.id]) s.narrationSeconds = lines.find((l) => l.shot === s.id)?.seconds ?? s.narrationSeconds
plan.voice = { engine: mf.engine?.name, voice: mf.engine?.voice, model: mf.engine?.model || null, revoicedAt: new Date().toISOString() }
writeFileSync(join(here, 'plan.json'), JSON.stringify(plan, null, 2) + '\n')
console.log('REVOICE DONE')
