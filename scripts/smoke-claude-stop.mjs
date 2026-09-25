// Stop on the Claude brain (DEMO.md's recovery: "no answer after 30 s, press Stop, ask again").
// The SDK only ends the Claude CLI about 2 s after an abort, and the app kept forwarding everything
// the CLI sent in that window: text kept typing, tool cards kept appearing, and our in-process tools
// (file_create, shell_run…) still RAN if the CLI called them. Now, after Stop: nothing more reaches
// the chat, tools refuse to run, the CLI is interrupted, and the next question runs normally.
// Offline: the Agent SDK is replaced by scripts/lib/claude-sdk-stub.mjs (it keeps going after the
// abort, like the real CLI). Run: node --import ./scripts/lib/register-sdk-stub.mjs scripts/smoke-claude-stop.mjs
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.GHOST_BRAIN_MODE = 'claude'
const { streamChat } = await import('../src/main/agent/provider.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const dir = mkdtempSync(join(tmpdir(), 'ghost-stop-'))
const late = join(dir, 'made-after-stop.txt')
const fine = join(dir, 'made-by-next-run.txt')
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const toolUse = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } })

// 1. Stop during the first words; the fake CLI keeps streaming and calls a tool 300 ms later.
globalThis.__sdkScript = [
  delta('Checking '),
  { sleep: 150 },
  delta('your disk '),
  toolUse('mcp__ghost-files__file_create', { path: late, content: 'x' }),
  { sleep: 150 },
  { callTool: ['ghost-files', 'file_create', { path: late, content: 'x' }] },
  delta('Done.'),
  { sleep: 2500 } // the real CLI is killed about 2 s after the abort
]
globalThis.__sdkToolResults = []
const ac = new AbortController()
const after = []
let stopped = false
const t0 = Date.now()
const res = await streamChat({
  messages: [{ role: 'user', content: 'How much free space is left?' }],
  mode: 'auto',
  signal: ac.signal,
  onDelta: (t) => {
    if (stopped) after.push(`delta:${t}`)
    else {
      stopped = true
      ac.abort() // the presenter presses Stop
    }
  },
  onEvent: (e) => stopped && e.kind !== 'brain' && after.push(`${e.kind}:${e.name || ''}`)
}).then(
  (r) => ({ ok: true, r }),
  (e) => ({ ok: false, e })
)
const ms = Date.now() - t0
check(after.length === 0, 'nothing reaches the chat after Stop', JSON.stringify(after))
check(!existsSync(late), 'a tool the CLI calls after Stop does NOT run', JSON.stringify(globalThis.__sdkToolResults))
const refused = globalThis.__sdkToolResults[0]?.result
check(refused?.isError && /Stop/i.test(JSON.stringify(refused)), 'the tool call is answered with "not run: Stop"', JSON.stringify(refused))
check(!res.ok && /abort/i.test(res.e?.message || ''), 'the turn ends as stopped', JSON.stringify(res))
check(ms < 3500, 'and ends within about 3 s', `${ms} ms`)
check((globalThis.__sdkInterrupted || 0) >= 1, 'the Claude CLI is told to stop (interrupt)')

// 2. The next question works, and its tools run.
globalThis.__sdkScript = [
  toolUse('mcp__ghost-files__file_create', { path: fine, content: 'y' }),
  { callTool: ['ghost-files', 'file_create', { path: fine, content: 'y' }] },
  { type: 'result', subtype: 'success', is_error: false, result: 'Made it.' }
]
globalThis.__sdkToolResults = []
let text = ''
const r2 = await streamChat({ messages: [{ role: 'user', content: 'Make the file.' }], mode: 'auto', signal: new AbortController().signal, onDelta: (t) => (text += t), onEvent() {} }).then(
  (r) => ({ ok: true, r }),
  (e) => ({ ok: false, e })
)
check(r2.ok && /Made it/.test(text), 'the next question runs normally', JSON.stringify(r2))
check(existsSync(fine), "the next question's tools do run", JSON.stringify(globalThis.__sdkToolResults))

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
