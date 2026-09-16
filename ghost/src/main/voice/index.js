import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'

// Voice I/O. Two backends, chosen at call time:
//   gemini (default when GEMINI_API_KEY is set) — Google's natural neural voices over the REST
//           API. STT: send the recorded WAV to Gemini for transcription. TTS: Gemini speech
//           generation → raw PCM → aplay. Free on the AI Studio tier (rate-limited).
//   local  — fully offline: arecord → Whisper (Transformers.js), and Piper/espeak-ng → aplay.
// Capture (arecord) and playback (aplay) are shared; only the brains differ. Any Gemini error
// (no key, network, quota) falls back to the local path so voice never hard-fails.
const APP_ROOT = app.getAppPath()
const REC_PATH = join(tmpdir(), 'ghost-voice-rec.wav')
const TRANSCRIBE_SCRIPT = join(APP_ROOT, 'scripts', 'voice-transcribe.mjs')

const PIPER_DIR = join(APP_ROOT, 'vendor', 'piper')
const PIPER_BIN = join(PIPER_DIR, 'piper')
const PIPER_VOICE = join(PIPER_DIR, 'voices', 'en_US-amy-medium.onnx')
const ESPEAK_DATA = join(PIPER_DIR, 'espeak-ng-data')

// --- Gemini voice config (read at call time so dotenv has loaded) --------
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const geminiKey = () => process.env.GEMINI_API_KEY || ''
const sttModel = () => process.env.GEMINI_STT_MODEL || 'gemini-2.5-flash'
const ttsModel = () => process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts'
const ttsVoice = () => process.env.GEMINI_TTS_VOICE || 'Kore'
// 'gemini' | 'local'. Default to gemini when a key is present, otherwise the offline path.
const voiceProvider = () => process.env.GHOST_VOICE_PROVIDER || (geminiKey() ? 'gemini' : 'local')
const useGemini = () => voiceProvider() === 'gemini' && !!geminiKey()

let recProc = null
let speakProcs = []
let speakSeq = 0 // bumped to cancel an in-flight Gemini TTS fetch when stopped/superseded

function commandExists(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'ignore'] })
  return r.status === 0
}

let espeakChecked = false
let espeakOk = false
function hasEspeak() {
  if (!espeakChecked) {
    espeakOk = commandExists('espeak-ng')
    espeakChecked = true
  }
  return espeakOk
}

function hasPiper() {
  return existsSync(PIPER_BIN) && existsSync(PIPER_VOICE)
}

// True if we can speak at all: Gemini (key present), or a local engine.
export function ttsAvailable() {
  return useGemini() || hasPiper() || hasEspeak()
}

async function geminiGenerate(model, body) {
  const res = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    throw new Error(`Gemini ${res.status} (${model}): ${detail}`)
  }
  return res.json()
}

// --- Speech-to-text (push-to-talk) ---------------------------------------
export function startRecording() {
  if (recProc) return
  // S16_LE / 16 kHz / mono — what Whisper wants, and valid WAV input for Gemini too.
  recProc = spawn('arecord', ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', REC_PATH])
  recProc.on('error', (e) => console.error('[voice] arecord error:', e.message))
}

export function stopRecordingAndTranscribe() {
  return new Promise((resolve, reject) => {
    if (!recProc) return reject(new Error('not recording'))
    const p = recProc
    recProc = null
    p.on('close', () => {
      transcribe(REC_PATH).then(resolve, reject)
    })
    p.kill('SIGINT') // lets arecord finalize a valid WAV header
  })
}

// Route to Gemini when enabled, with a clean fall back to local Whisper on any failure.
function transcribe(wavPath) {
  if (useGemini()) {
    return geminiTranscribe(wavPath).catch((e) => {
      console.warn('[voice] Gemini STT failed → local Whisper:', e.message)
      return transcribeLocal(wavPath)
    })
  }
  return transcribeLocal(wavPath)
}

async function geminiTranscribe(wavPath) {
  const data = readFileSync(wavPath).toString('base64')
  const j = await geminiGenerate(sttModel(), {
    contents: [
      {
        parts: [
          {
            text:
              'Transcribe this audio verbatim. Output ONLY the spoken words as plain text — no quotes, ' +
              'no labels, no commentary. If there is no clear speech, output nothing.'
          },
          { inlineData: { mimeType: 'audio/wav', data } }
        ]
      }
    ],
    generationConfig: { temperature: 0 }
  })
  const parts = j?.candidates?.[0]?.content?.parts || []
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join(' ')
    .trim()
}

function transcribeLocal(wavPath) {
  return new Promise((resolve, reject) => {
    // Run the model outside Electron's process: the Electron binary as plain Node.
    const proc = spawn(process.execPath, [TRANSCRIBE_SCRIPT, wavPath], {
      cwd: APP_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `transcribe exited ${code}`))
      try {
        resolve((JSON.parse(out).text || '').trim())
      } catch {
        resolve(out.trim())
      }
    })
  })
}

// --- Text-to-speech ------------------------------------------------------
export function speak(text) {
  stopSpeaking()
  const seq = ++speakSeq
  // Strip markdown noise and cap length so we don't narrate a whole code dump.
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
  if (!clean) return
  if (useGemini()) {
    speakWithGemini(clean, seq).catch((e) => {
      console.warn('[voice] Gemini TTS failed → local voice:', e.message)
      if (seq === speakSeq) speakLocal(clean)
    })
  } else {
    speakLocal(clean)
  }
}

function speakLocal(text) {
  if (hasPiper()) speakWithPiper(text)
  else if (hasEspeak()) speakWithEspeak(text)
}

// Split into small chunks so the FIRST audio starts after one sentence's worth of TTS, not the
// whole reply — much snappier. Tiny fragments merge so we don't hammer the API.
function chunkForSpeech(text) {
  const parts = text.match(/[^.!?\n]+[.!?\n]*/g) || [text]
  const chunks = []
  let buf = ''
  for (const p of parts) {
    buf += p
    if (buf.trim().length >= 60 || /[.!?\n]\s*$/.test(buf)) {
      if (buf.trim()) chunks.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) chunks.push(buf.trim())
  return chunks
}

// Play raw PCM via aplay; resolves when playback finishes, so chunks play back-to-back.
function playPcm(pcm, rate, seq) {
  return new Promise((resolve) => {
    if (seq !== speakSeq) return resolve()
    const play = spawn('aplay', ['-q', '-r', rate, '-f', 'S16_LE', '-c', '1', '-t', 'raw', '-'])
    speakProcs = [play]
    play.on('error', () => resolve())
    play.on('close', () => resolve())
    play.stdin.on('error', () => {}) // ignore EPIPE if killed mid-write
    play.stdin.write(pcm)
    play.stdin.end()
  })
}

async function speakWithGemini(text, seq) {
  let played = false
  for (const chunk of chunkForSpeech(text)) {
    if (seq !== speakSeq) return // stopped or superseded
    let j
    try {
      j = await geminiGenerate(ttsModel(), {
        contents: [{ parts: [{ text: chunk }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: ttsVoice() } } }
        }
      })
    } catch (e) {
      if (!played) throw e // nothing spoken yet → let speak() fall back to the local voice
      console.warn('[voice] TTS chunk failed mid-reply, stopping early:', e.message) // don't re-speak
      return
    }
    if (seq !== speakSeq) return
    const part = (j?.candidates?.[0]?.content?.parts || []).find((p) => p?.inlineData?.data)
    if (!part) continue
    const pcm = Buffer.from(part.inlineData.data, 'base64')
    // mimeType is like "audio/L16;codec=pcm;rate=24000" — use the real rate so pitch is correct.
    const rate = (/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1] || '24000'
    await playPcm(pcm, rate, seq) // play this chunk fully before fetching the next
    played = true
  }
}

function speakWithPiper(text) {
  const piper = spawn(PIPER_BIN, ['--model', PIPER_VOICE, '--espeak_data', ESPEAK_DATA, '--output-raw'], {
    cwd: PIPER_DIR,
    env: { ...process.env, LD_LIBRARY_PATH: PIPER_DIR }
  })
  // amy-medium is 22050 Hz, 16-bit mono raw PCM.
  const play = spawn('aplay', ['-q', '-r', '22050', '-f', 'S16_LE', '-t', 'raw', '-'])
  speakProcs = [piper, play]
  piper.on('error', (e) => console.error('[voice] piper error:', e.message))
  play.on('error', (e) => console.error('[voice] aplay error:', e.message))
  piper.stdout.pipe(play.stdin)
  piper.stdin.write(text)
  piper.stdin.end()
}

function speakWithEspeak(text) {
  const proc = spawn('espeak-ng', ['-s', '160', text])
  proc.on('error', (e) => console.error('[voice] espeak-ng error:', e.message))
  speakProcs = [proc]
}

export function stopSpeaking() {
  speakSeq++ // invalidate any in-flight Gemini TTS fetch so it won't start playing
  for (const p of speakProcs) {
    try {
      p.kill('SIGKILL')
    } catch {}
  }
  speakProcs = []
}
