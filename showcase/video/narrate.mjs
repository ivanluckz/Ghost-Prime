// Narration for the demo video: one WAV per narration line in storyboard.json.
// Engines:
//   gemini  Ghost-Prime's own voice: the Gemini speech model and voice the app uses (GEMINI_TTS_MODEL and
//           GEMINI_TTS_VOICE in .env, free tier). Only with NARRATE_ENGINE=gemini, because it needs the
//           internet and the key in .env. One request per line, spaced out for the free tier's limit
//           (3 a minute, and a small number a day). Each answer is kept in voice/*.raw.wav, so a second
//           run only asks for the lines whose words changed. NARRATE_STYLE changes how it is told to speak.
//   Offline, in order of preference (NARRATE_ENGINE=auto, the default):
//   1. Piper (pip install piper-tts) with a British English voice model. Set PIPER_VOICE=/path/to/en_GB-*.onnx
//      (its .onnx.json must sit next to it) or drop the model into voice/piper/. Download one with
//      python3 -m piper.download_voices en_GB-cori-high --download-dir showcase/video/voice/piper
//      (the cloud session that made this kit could not reach huggingface.co, so it fell back to 2.)
//   2. espeak-ng with the MBROLA British voice (apt install mbrola mbrola-en1): `-v mb-en1`.
//   3. espeak-ng's own British voice: `-v en-gb`.
// Overrides: NARRATE_ENGINE=gemini|piper|espeak, NARRATE_VOICE=mb-en1|en-gb|…, NARRATE_WPM=150.
//
// Output: voice/<shot>.wav (24 kHz mono, peak at -3 dBFS, short fade in/out, 0.25 s of room at the end) and
// voice/manifest.json (shot id, file, seconds, text, engine).
//   node showcase/video/narrate.mjs
//   NARRATE_ENGINE=gemini node showcase/video/narrate.mjs && node showcase/video/revoice.mjs
//     (revoice.mjs puts the new voice on the finished video without re-recording it)
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
if (want === 'gemini') {
  // The key stays in .env and is only ever sent to Google in the request header.
  const { config } = await import('dotenv')
  config({ path: join(here, '..', '..', '.env'), quiet: true })
  if (!process.env.GEMINI_API_KEY) throw new Error('NARRATE_ENGINE=gemini but GEMINI_API_KEY is not set in .env')
  const voice = process.env.NARRATE_VOICE || process.env.GEMINI_TTS_VOICE || 'Kore'
  const ttsModel = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'
  const style = process.env.NARRATE_STYLE || 'Read this aloud like a friendly presenter: warm, clear and natural, at a lively pace'
  engine = { name: 'gemini', voice, model: ttsModel, style, wpm: null, command: `POST generativelanguage.googleapis.com/v1beta/models/${ttsModel}:generateContent (voice ${voice})` }
} else if ((want === 'auto' || want === 'piper') && has('piper') && model) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastAsk = 0
// One line from Gemini, as a WAV. Waits out the per-minute limit; stops at once on the daily limit,
// because waiting will not help and every retry would be wasted.
async function geminiSpeak(text, raw) {
  const body = {
    contents: [{ parts: [{ text: `${engine.style}: ${text}` }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: engine.voice } } } }
  }
  for (let attempt = 1; ; attempt++) {
    const wait = lastAsk + 21000 - Date.now() // 3 requests a minute on the free tier
    if (wait > 0) await sleep(wait)
    lastAsk = Date.now()
    let res
    let detail = ''
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${engine.model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000)
      })
      if (res.ok) {
        const j = await res.json()
        const part = (j?.candidates?.[0]?.content?.parts || []).find((p) => p?.inlineData?.data)
        if (part) {
          const rate = (/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1] || '24000'
          const pcm = `${raw}.pcm`
          writeFileSync(pcm, Buffer.from(part.inlineData.data, 'base64'))
          must('ffmpeg', ['-y', '-v', 'error', '-f', 's16le', '-ar', rate, '-ac', '1', '-i', pcm, '-c:a', 'pcm_s16le', raw])
          unlinkSync(pcm)
          return
        }
        detail = `no audio in the answer (${j?.candidates?.[0]?.finishReason || 'no reason given'})`
      } else detail = `${res.status}: ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)}`
    } catch (e) {
      detail = `network: ${e.message}`
    }
    if (/PerDay|per day|daily/i.test(detail)) throw new Error(`Gemini's free daily limit for speech is used up. Try again tomorrow; the lines already made are kept.\n${detail}`)
    if (attempt >= 4 || (res && res.status >= 400 && res.status < 500 && res.status !== 429)) throw new Error(`Gemini speech failed: ${detail}`)
    const retry = Number((/retryDelay"?:\s*"?(\d+)/.exec(detail) || [])[1]) || 20
    console.log(`  (attempt ${attempt} failed: ${detail.slice(0, 140)}; trying again in ${retry + 2} s)`)
    await sleep((retry + 2) * 1000)
  }
}
async function synth(text, raw) {
  if (engine.name === 'gemini') await geminiSpeak(text, raw)
  else if (engine.name === 'piper') must('piper', ['-m', engine.model, '-f', raw], { input: text })
  else must('espeak-ng', ['-v', engine.voice, '-s', String(engine.wpm), '-w', raw, text])
}
// Trim to -3 dBFS peak, fade the edges, add 0.25 s of room, 24 kHz mono. A speech model leaves a pause
// before and after the words: cut both first, so every line starts on time.
function finish(raw, out) {
  let src = raw
  if (engine.name === 'gemini') {
    src = `${raw}.trim.wav`
    const cut = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.04'
    must('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-af', `${cut},areverse,${cut},areverse`, '-c:a', 'pcm_s16le', src])
  }
  const { max } = levels(src)
  const gain = (-3 - max).toFixed(2)
  const dur = seconds(src)
  const fadeOutAt = Math.max(0, dur - 0.12).toFixed(3)
  must('ffmpeg', ['-y', '-v', 'error', '-i', src, '-af', `volume=${gain}dB,afade=t=in:st=0:d=0.02,afade=t=out:st=${fadeOutAt}:d=0.12,apad=pad_dur=0.25`, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', out])
  if (src !== raw) unlinkSync(src)
}

// ---- go ----------------------------------------------------------------------------------------
const lines = []
const problems = []
for (const shot of sb.shots) {
  if (!shot.narration) continue
  const text = spoken(shot.narration)
  const words = text.split(/\s+/).length
  if (words > 30) problems.push(`${shot.id}: narration is ${words} words (max 30)`)
  // Gemini's answers are kept (named by what was asked), so a line is only requested once.
  const asked = engine.name === 'gemini' ? createHash('sha256').update([engine.model, engine.voice, engine.style, text].join('\n')).digest('hex').slice(0, 10) : null
  const raw = join(voiceDir, asked ? `${shot.id}.${asked}.raw.wav` : `${shot.id}.raw.wav`)
  const out = join(voiceDir, `${shot.id}.wav`)
  if (asked && existsSync(raw)) console.log(`${shot.id.padEnd(11)} (kept from the last run)`)
  else await synth(text, raw)
  finish(raw, out)
  if (!asked) unlinkSync(raw)
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
