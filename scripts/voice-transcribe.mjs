#!/usr/bin/env node
// Speech-to-text for Ghost-Prime. Run as a standalone Node process (spawned by the
// main process with ELECTRON_RUN_AS_NODE=1) so the Whisper model loads outside Electron.
// Input: a 16 kHz mono 16-bit PCM WAV (exactly what `arecord` produces). Output: JSON {text}.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pipeline, env } from '@huggingface/transformers'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Cache the model under the project so it downloads once and is reused offline after.
env.cacheDir = join(__dirname, '..', 'vendor', 'transformers-cache')
env.allowRemoteModels = true

// Minimal WAV reader: walk chunks, find fmt + data, return mono Float32 samples.
function readWavMonoFloat32(path) {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let fmt = null
  let dataOffset = -1
  let dataLen = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      dataOffset = body
      dataLen = Math.min(size, buf.length - body)
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }
  if (!fmt || dataOffset < 0) throw new Error('missing fmt/data chunk')
  if (fmt.bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${fmt.bitsPerSample}`)
  const channels = fmt.channels || 1
  const count = Math.floor(dataLen / 2 / channels)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    let acc = 0
    for (let c = 0; c < channels; c++) acc += buf.readInt16LE(dataOffset + (i * channels + c) * 2)
    out[i] = acc / channels / 32768
  }
  return { samples: out, sampleRate: fmt.sampleRate }
}

const wavPath = process.argv[2]
if (!wavPath) {
  process.stderr.write('usage: voice-transcribe.mjs <wav>\n')
  process.exit(2)
}

try {
  const { samples, sampleRate } = readWavMonoFloat32(wavPath)
  if (sampleRate !== 16000) process.stderr.write(`warning: sample rate ${sampleRate} != 16000\n`)
  // tiny.en: ~40MB download, fast on CPU, good enough for short spoken commands.
  // Bump to whisper-base.en for more accuracy once bandwidth allows.
  const model = process.env.GHOST_WHISPER_MODEL || 'Xenova/whisper-tiny.en'
  const transcriber = await pipeline('automatic-speech-recognition', model)
  const result = await transcriber(samples, { chunk_length_s: 30, stride_length_s: 5 })
  const text = (result?.text || '').trim()
  process.stdout.write(JSON.stringify({ text }))
} catch (err) {
  process.stderr.write(String(err?.stack || err))
  process.exit(1)
}
