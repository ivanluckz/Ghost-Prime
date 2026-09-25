// The Gemini brain (Demo 6 fallback, and the free brain) — two bugs found 25 Sep:
//  1. Gemini's OpenAI-compatible endpoint returns errors as a JSON ARRAY. The openai SDK only reads
//     body.error, so a wrong API key, a retired model or a Google 500 all showed "400 status code
//     (no body)". The real reason now comes through, and a bad key gets a plain sentence.
//  2. If Gemini said a preamble ("Checking your battery now.") next to a tool call and then gave an
//     EMPTY final answer, the reply just ended at the preamble. Now it asks once more for the
//     answer, and shows a notice if there still isn't one.
// Offline: a local HTTP server plays Google's error; `openai` is stubbed for the loop test.
// Run: node --import ./scripts/lib/register-offline-stubs.mjs scripts/smoke-gemini-loop.mjs
import { createServer } from 'node:http'
import { register } from 'node:module'

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}

// ---- 1. the real reason of a Gemini error ------------------------------------------------------
const server = createServer((req, res) => {
  res.writeHead(400, { 'content-type': 'application/json; charset=UTF-8' })
  res.end(JSON.stringify([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }]))
}).listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const RealOpenAI = (await import('../node_modules/openai/index.mjs')).default // the real SDK (not the stub below)
const { geminiErrorFetch } = await import('../src/main/agent/provider.js')
const { friendlyError } = await import('../src/main/agent/friendly-error.js')
check(typeof geminiErrorFetch === 'function', 'provider exports the error-unwrapping fetch')
const client = new RealOpenAI({ baseURL: `http://127.0.0.1:${server.address().port}/v1beta/openai/`, apiKey: 'bad', ...(geminiErrorFetch ? { fetch: geminiErrorFetch } : {}) })
let err = null
try {
  await client.chat.completions.create({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }] })
} catch (e) {
  err = e
}
check(/API key not valid/.test(err?.message || ''), "the error carries Google's reason, not '(no body)'", err?.message)
const shown = friendlyError(err)
check(/Gemini/.test(shown) && /key/i.test(shown) && !/no body/.test(shown), 'the user is told the Gemini key was not accepted', shown)
server.close()

// ---- 2. empty final answer after a preamble -------------------------------------------------------
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(spec, ctx, next) {
      if (spec === 'openai') return { url: ${JSON.stringify(new URL('./lib/openai-stub.mjs', import.meta.url).href)}, shortCircuit: true }
      return next(spec, ctx)
    }`),
  import.meta.url
)
// provider.js is already loaded with the real SDK; load a fresh copy that sees the stub.
process.env.GHOST_BRAIN_MODE = 'gemini'
process.env.GEMINI_API_KEY = 'test-key'
const fresh = await import(`../src/main/agent/provider.js?stub=${Date.now()}`)
const tc = (name) => ({ id: 'c1', type: 'function', function: { name, arguments: '{}' } })
const round = (content, calls, finish = calls ? 'tool_calls' : 'stop') => ({ choices: [{ finish_reason: finish, message: { content, ...(calls ? { tool_calls: calls } : {}) } }] })
async function run(script) {
  globalThis.__openaiScript = script
  globalThis.__openaiCalls = []
  let text = ''
  const out = await fresh.streamChat({ messages: [{ role: 'user', content: "What's my battery level?" }], mode: 'auto', onDelta: (t) => (text += t), onEvent() {} })
  return { out, text, calls: globalThis.__openaiCalls }
}
let r = await run([round('Checking your battery now.', [tc('reminder_list')]), round(''), round('Your battery is at 80%.')])
check(/battery is at 80%/.test(r.out), 'an empty final answer after a tool gets one more try, and the answer arrives', JSON.stringify(r.out))
check(r.calls.at(-1)?.tool_choice === 'none', 'the extra try asks for words, not more tools', JSON.stringify(r.calls.at(-1)?.tool_choice))
r = await run([round('Checking your battery now.', [tc('reminder_list')]), round(''), round('')])
check(r.out !== 'Checking your battery now.' && /empty|no final answer|try again/i.test(r.out), 'still empty: the user sees a notice, not just the preamble', JSON.stringify(r.out))
r = await run([round('Checking.', [tc('reminder_list')]), round('Your battery is at 80%.')])
check(r.calls.length === 2 && /80%/.test(r.out), 'a normal answer takes no extra call', `${r.calls.length} calls`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
