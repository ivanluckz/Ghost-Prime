// When Claude can't be reached (Wi-Fi with no internet, a school firewall, Anthropic down), the
// bundled CLI retries about 10 times with backoff, roughly 3 minutes, and only reports each retry as
// an 'api_retry' system message. The app ignored those: "working…" for 3 minutes, no hint, and the
// run slot blocked every other message. Now each retry is shown, and a turn where Claude hasn't said
// or done anything yet gives up after 2 network retries (3 server errors), so the router can switch
// to Gemini or explain that it's the internet.
// Offline: the Agent SDK is replaced by scripts/lib/claude-sdk-stub.mjs.
// Run: node --import ./scripts/lib/register-sdk-stub.mjs scripts/smoke-claude-retry.mjs
process.env.GHOST_BRAIN_MODE = 'claude'
delete process.env.GEMINI_API_KEY // the fallback brain has no key here: its error is the final one
const { streamChat } = await import('../src/main/agent/provider.js')
const { friendlyError } = await import('../src/main/agent/friendly-error.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${String(extra).slice(0, 300)}` : ''}`)
}
const retry = (attempt, status = null) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 1000, error_status: status, error: 'unknown' })
async function run(script, mode = 'auto', ms = 5000) {
  globalThis.__sdkScript = script
  const events = []
  let text = ''
  const t0 = Date.now()
  const p = streamChat({ messages: [{ role: 'user', content: 'How much free space is left?' }], mode, onDelta: (t) => (text += t), onEvent: (e) => events.push(e) })
  const out = await Promise.race([
    p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
    new Promise((r) => setTimeout(() => r({ hung: true }), ms))
  ])
  return { ...out, events, text, ms: Date.now() - t0 }
}

// 1. No internet: two retries, then give up quickly (the real CLI would keep going for ~3 minutes).
let r = await run([retry(1), retry(2), retry(3), 'hang'])
check(!r.hung, 'no internet: the turn ends in seconds, not minutes', `${r.ms} ms`)
const status = r.events.filter((e) => e.kind === 'status')
check(status.length >= 1 && /reach Claude/i.test(status[0].text) && /internet|Wi-?Fi/i.test(status[0].text), 'each retry is shown to the user', JSON.stringify(status))
check(r.events.some((e) => e.kind === 'brain' && e.brain === 'gemini' && e.fallback), 'it tries the other brain (Gemini)', JSON.stringify(r.events))
check(r.ok === false, 'with no Gemini key either, it ends with an error (not a hang)')
check(globalThis.__sdkCalls.at(-1).options.abortController.signal.aborted === true, 'the stuck Claude request is cancelled')

// 2. Anthropic overloaded (529): three retries, then switch brains.
r = await run([retry(1, 529), retry(2, 529), retry(3, 529), retry(4, 529), 'hang'])
check(!r.hung && r.events.some((e) => e.kind === 'brain' && e.fallback), 'Claude overloaded: switches brains after 3 retries', `${r.ms} ms ${JSON.stringify(r.events)}`)
check(r.events.filter((e) => e.kind === 'status').length === 3, 'three retry notices were shown', JSON.stringify(r.events.filter((e) => e.kind === 'status')))

// 3. Mid-task (a tool already ran): keep waiting, just show the notices. Replaying would repeat the tool.
r = await run([
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__ghost-shell__shell_run', input: { command: 'df -h' } }] } },
  retry(1),
  retry(2),
  retry(3),
  { type: 'assistant', message: { content: [{ type: 'text', text: 'You have 28 GB free.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'You have 28 GB free.' }
])
check(r.ok && /28 GB/.test(r.text), 'mid-task retries do not cancel the task', JSON.stringify({ ok: r.ok, e: r.e?.message, text: r.text }))
check(!r.events.some((e) => e.kind === 'brain' && e.fallback), 'mid-task: no brain switch (the tool would run twice)')
check(r.events.filter((e) => e.kind === 'status').length === 3, 'mid-task: the retries are still shown')

// 4. What the user finally reads when both brains are out is plain and actionable.
r = await run([retry(1), retry(2), 'hang'])
const shown = friendlyError(r.e)
check(r.ok === false && !/claude-agent error|stack|\{/.test(shown) && shown.length < 200, 'the final message is short and plain', shown)

// 5. A normal answer is untouched.
r = await run(undefined)
check(r.ok && r.text === 'ok' && !r.events.some((e) => e.kind === 'status'), 'a normal answer shows no retry notice')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
