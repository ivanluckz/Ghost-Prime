// Voice output/input logic (src/main/voice/index.js) without audio hardware or network: fake
// `aplay`, `espeak-ng` and `arecord` on PATH log what would play, and Gemini is a mocked fetch.
// Covers what reads aloud (links as words, lists item by item), the Gemini → offline-voice handover
// when Gemini fails part-way or returns no audio, never speaking while the mic records, and
// dropping recogniser noise like "[BLANK_AUDIO]" instead of sending it as a message.
// Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-voice.mjs
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const bin = mkdtempSync(join(tmpdir(), 'ghost-voice-bin-'))
const LOG = join(bin, 'played.log')
const fake = (name, body) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}
fake('aplay', `cat >/dev/null; echo aplay >> "${LOG}"`)
fake('espeak-ng', `shift 3; echo "espeak $*" >> "${LOG}"`) // args: -s 160 -- <text>
fake('arecord', 'sleep 30')
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.GEMINI_API_KEY = 'test-key'
process.env.GHOST_VOICE_PROVIDER = 'gemini'

const v = await import('../src/main/voice/index.js')
let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const played = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean) : [])
const reset = () => rmSync(LOG, { force: true })
const AUDIO = { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: Buffer.alloc(480).toString('base64') } }] } }] }
let ttsCalls = 0
const mockTts = (plan) => {
  ttsCalls = 0
  globalThis.fetch = async () => {
    const step = plan[Math.min(ttsCalls++, plan.length - 1)]
    if (step === 'fail') return new Response('quota', { status: 429 })
    if (step === 'empty') return Response.json({ candidates: [{ content: { parts: [] } }] })
    return Response.json(AUDIO)
  }
}

// What is read aloud.
const c = v.cleanForSpeech('Read more on [Wikipedia](https://en.wikipedia.org/wiki/Photosynthesis) or https://www.example.com/a/b.\n- carbon dioxide\n- water\n\n```js\nx()\n```')
check(/on Wikipedia or example\.com/.test(c) && !/https?:|\(|\)/.test(c), 'links are read as words, never a spelled-out URL', c)
check(c.split('\n').length >= 3, 'line breaks survive so a list is read item by item', JSON.stringify(c))
check(/code block/.test(c) && !/x\(\)/.test(c), 'code blocks are skipped', c)
const chunks = v.chunkForSpeech(v.cleanForSpeech('Here are the steps:\n1. Open Wikipedia\n2. Search photosynthesis\n3. Read the article\n4. Explain it simply\n5. Read it aloud'))
check(chunks.length >= 2 && chunks[0].length <= 120, `a list is split into several requests, the first one short (${chunks.length}: ${chunks.map((x) => x.length).join(',')})`)
const long = v.chunkForSpeech('This is a sentence that is fairly long. '.repeat(30).trim())
check(long.length <= 6, `long replies use few requests (free-tier quota): ${long.length}`)

// Recogniser noise is dropped.
for (const [t, keep] of [['[BLANK_AUDIO]', false], ['(music)', false], ['.', false], [' * silence * ', false], ['Hello there.', true], ['What is 2 + 2?', true]]) {
  check(!!v.spokenWords(t) === keep, `${JSON.stringify(t)} ${keep ? 'is kept' : 'is treated as silence'}`)
}

// Gemini fails after the first chunk: the rest is read by the offline voice, not dropped.
reset()
mockTts(['ok', 'fail'])
v.speak('First part of the answer is here, long enough for one chunk. Second part carries on with more detail. Third part ends it.')
await wait(1500)
let log = played()
check(log[0] === 'aplay' && log.some((l) => l.startsWith('espeak') && /Second part/.test(l)), 'Gemini failing mid-reply hands the rest to the offline voice', log.join(' | '))
check(!log.some((l) => l.startsWith('espeak') && /First part/.test(l)), '…without repeating what was already spoken', log.join(' | '))

// Gemini returns no audio at all: the whole reply is read offline.
reset()
mockTts(['empty'])
v.speak('Photosynthesis is how plants make food from light.')
await wait(1200)
log = played()
check(log.length === 1 && /espeak .*Photosynthesis/.test(log[0]), 'a reply with no Gemini audio is read by the offline voice, not silent', log.join(' | '))

// The mic is open: no speaking (it would be recorded), and starting to record stops speech.
reset()
let release
globalThis.fetch = () => new Promise((r) => (release = () => r(Response.json(AUDIO))))
v.speak('This should be cut off by the microphone.')
await wait(100)
v.startRecording()
release?.()
await wait(600)
check(played().length === 0, 'starting to record stops Ghost-Prime talking')
v.speak('And nothing is spoken while the mic is open.')
await wait(600)
check(played().length === 0, 'nothing is spoken while the mic is open')
v.shutdownVoice()

rmSync(bin, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
