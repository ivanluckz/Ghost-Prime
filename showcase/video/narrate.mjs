// Narration for the demo video: one WAV per narration line in storyboard.json, from a free OFFLINE voice.
// Engines, in order of preference:
//   1. Piper (pip install piper-tts) with a British English voice model. Set PIPER_VOICE=/path/to/en_GB-*.onnx
//      (its .onnx.json must sit next to it) or drop the model into voice/piper/. Download one with
//      python3 -m piper.download_voices en_GB-cori-high --download-dir showcase/video/voice/piper
//      (the cloud session that made this kit could not reach huggingface.co, so it fell back to 2.)
//   2. espeak-ng with the MBROLA British voice (apt install mbrola mbrola-en1): `-v mb-en1`.
//   3. espeak-ng's own British voice: `-v en-gb`.
// Overrides: NARRATE_ENGINE=piper|espeak, NARRATE_VOICE=mb-en1|en-gb|…, NARRATE_WPM=150.
//
// Output: voice/<shot>.wav (24 kHz mono, peak at -3 dBFS, short fade in/out, 0.25 s of room at the end) and
// voice/manifest.json (shot id, file, seconds, text, engine). Keep the WAVs: the app's real Gemini voice can
// replace them file by file later, and edit.mjs only needs the manifest.
//   node showcase/video/narrate.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sb = JSON.parse(readFileSync(join(here, 'storyboard.json'), 'utf8'))
const voiceDir = join(here, 'voice')
mkdirSync(voiceDir, { recursive: true })

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts })
const has = (cmd) => sh('sh', ['-c', `command -v ${cmd}`]).status === 0
const must = (cmd, args, opts) => {
  const r = sh(cmd, args, opts)
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${(r.stderr || r.stdout || '').slice(-800)}`)
  return r
}
for (const tool of ['ffmpeg', 'ffprobe']) if (!has(tool)) throw new Error(`${tool} is not installed`)

// ---- pick the engine ----------------------------------------------------------------------------
function piperModel() {
  const env = process.env.PIPER_VOICE
  if (env && existsSync(env)) return env
  const dir = join(voiceDir, 'piper')
  if (!existsSync(dir)) return null
  const gb = readdirSync(dir).filter((f) => f.endsWith('.onnx')).sort((a, b) => (b.startsWith('en_GB') ? 1 : 0) - (a.startsWith('en_GB') ? 1 : 0))
  return gb.length ? join(dir, gb[0]) : null
}
const wpm = Number(process.env.NARRATE_WPM) || 150
const want = process.env.NARRATE_ENGINE || 'auto'
let engine
const model = piperModel()
if ((want === 'auto' || want === 'piper') && has('piper') && model) {
  engine = { name: 'piper', voice: model.split('/').pop().replace(/\.onnx$/, ''), model, wpm: null, command: `piper -m ${model} -f <out.wav>` }
} else if (want === 'piper') {
  throw new Error('NARRATE_ENGINE=piper but no voice model was found (PIPER_VOICE, or voice/piper/*.onnx)')
} else if (has('espeak-ng')) {
  const mbrola = has('mbrola') && /\bmb-en1\b/.test(sh('espeak-ng', ['--voices=mb']).stdout || '')
  const voice = process.env.NARRATE_VOICE || (mbrola ? 'mb-en1' : 'en-gb')
  engine = { name: 'espeak-ng', voice, wpm, command: `espeak-ng -v ${voice} -s ${wpm} -w <out.wav> "<text>"` }
} else throw new Error('no offline voice: install piper-tts (with a voice model) or espeak-ng')
console.log(`engine: ${engine.name} · voice ${engine.voice}${engine.wpm ? ` · ${engine.wpm} wpm` : ''}`)

// ---- helpers -----------------------------------------------------------------------------------
const seconds = (file) => Number(must('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.trim())
function levels(file) {
  const r = sh('ffmpeg', ['-v', 'info', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
  const pick = (k) => Number((r.stderr.match(new RegExp(`${k}: (-?[\\d.]+) dB`)) || [])[1])
  return { mean: pick('mean_volume'), max: pick('max_volume') }
}
// What the voice says: the on-screen text with the few things a robot voice trips over smoothed out.
const spoken = (t) => t.replace(/Ghost-Prime/g, 'Ghost Prime').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()

function synth(text, raw) {
  if (engine.name === 'piper') must('piper', ['-m', engine.model, '-f', raw], { input: text })
  else must('espeak-ng', ['-v', engine.voice, '-s', String(engine.wpm), '-w', raw, text])
}
// Trim to -3 dBFS peak, fade the edges, add 0.25 s of room, 24 kHz mono.
function finish(raw, out) {
  const { max } = levels(raw)
  const gain = (-3 - max).toFixed(2)
  const dur = seconds(raw)
  const fadeOutAt = Math.max(0, dur - 0.12).toFixed(3)
  must('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', `volume=${gain}dB,afade=t=in:st=0:d=0.02,afade=t=out:st=${fadeOutAt}:d=0.12,apad=pad_dur=0.25`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', out])
}

// ---- go ----------------------------------------------------------------------------------------
const lines = []
const problems = []
for (const shot of sb.shots) {
  if (!shot.narration) continue
  const text = spoken(shot.narration)
  const words = text.split(/\s+/).length
  if (words > 30) problems.push(`${shot.id}: narration is ${words} words (max 30)`)
  const raw = join(voiceDir, `${shot.id}.raw.wav`)
  const out = join(voiceDir, `${shot.id}.wav`)
  synth(text, raw)
  finish(raw, out)
  unlinkSync(raw)
  const s = seconds(out)
  const { mean, max } = levels(out)
  const wps = words / Math.max(0.1, s - 0.25)
  // Sanity: a real, audible line at a speaking pace. (2.0–4.2 words/s covers 120–250 wpm.)
  if (!(s > 0.8 && s < 25)) problems.push(`${shot.id}: odd duration ${s.toFixed(2)} s`)
  if (!(mean > -35)) problems.push(`${shot.id}: too quiet or silent (mean ${mean} dB)`)
  if (!(max <= -2.8 && max >= -3.5)) problems.push(`${shot.id}: peak ${max} dB, expected about -3 dB`)
  if (wps < 1.6 || wps > 4.5) problems.push(`${shot.id}: ${wps.toFixed(1)} words/s does not sound like speech`)
  lines.push({ shot: shot.id, file: relative(here, out), seconds: Number(s.toFixed(3)), text: shot.narration, spoken: text, words, engine: `${engine.name} ${engine.voice}`, meanDb: mean, peakDb: max })
  console.log(`${shot.id.padEnd(11)} ${s.toFixed(2).padStart(6)} s  ${String(words).padStart(2)} words  mean ${mean} dB  peak ${max} dB  ${wps.toFixed(1)} w/s`)
}
const manifest = {
  generatedAt: new Date().toISOString(),
  engine,
  format: '24 kHz mono 16-bit WAV, peak -3 dBFS, 0.25 s of room at the end',
  replace: 'To use the real Ghost-Prime voice, save each line as the same file name (any sample rate; edit.mjs resamples), keep `text`, update `seconds` and `engine`, then run edit.mjs.',
  lines
}
writeFileSync(join(voiceDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`wrote voice/manifest.json (${lines.length} lines, ${lines.reduce((a, l) => a + l.seconds, 0).toFixed(1)} s of narration)`)
if (problems.length) {
  console.log(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('NARRATION OK')
