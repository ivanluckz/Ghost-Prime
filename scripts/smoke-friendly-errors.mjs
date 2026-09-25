// What a user sees when a brain fails (desktop chat bubble, Discord reply): a plain sentence that
// says what happened and what to do, plus a SHORT technical detail — never a stack trace, a JSON
// dump or an IPC wrapper. The booth demo runs on a projector, so this text is public.
// Run: node scripts/smoke-friendly-errors.mjs
const { friendlyError } = await import('../src/main/agent/friendly-error.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${extra}` : ''}`)
}
const err = (m, extra = {}) => Object.assign(new Error(m), extra)

const cases = [
  // [label, error, must match, must NOT match]
  ['offline (DNS)', err('getaddrinfo EAI_AGAIN api.anthropic.com'), /internet/i],
  ['offline (fetch failed)', new TypeError('fetch failed'), /internet/i],
  ['offline (OpenAI client)', err('Connection error.'), /internet/i],
  ['timeout', err('Request timed out.'), /too long|internet/i],
  ['Claude not logged in', err('Invalid API key · Please run /login (error_during_execution)'), /log in|sign(ed)? in/i],
  ['Claude CLI missing', err('spawn claude ENOENT'), /Claude Code/i],
  ['usage limit', err('Claude AI usage limit reached|1790370000 (error_during_execution)'), /allowance|limit/i],
  ['Gemini quota 429', err('429 Resource has been exhausted (e.g. check quota).', { status: 429 }), /free|busy|limit/i],
  ['Gemini overloaded 503', err('503 The model is overloaded. Please try again later.', { status: 503 }), /busy|try again/i],
  ['missing Gemini key', err('GEMINI_API_KEY is not set for provider "gemini". Add it to .env.'), /Gemini/i],
  ['unknown', err('something odd happened in the tool loop'), /went wrong/i]
]
for (const [label, e, want] of cases) {
  const out = friendlyError(e)
  check(typeof out === 'string' && want.test(out), `${label}: ${JSON.stringify(out)}`, String(out))
}

// Never leak internals.
const stacky = new Error('boom at the router')
stacky.message = 'boom at the router\n    at streamChat (/home/lol/Projects/Ghost-Prime/out/main/index.js:4521:11)\n    at async Object.<anonymous> (node:internal/foo:1:1)'
const s1 = friendlyError(stacky)
check(!/\bat \S+ \(|node:internal|\/home\/|out\/main/.test(s1), 'stack frames and file paths are stripped', s1)
const ipc = friendlyError("Error invoking remote method 'chat:send': Error: getaddrinfo ENOTFOUND generativelanguage.googleapis.com")
check(!/invoking remote method/i.test(ipc) && /internet/i.test(ipc), 'the Electron IPC wrapper is removed', ipc)
const json = friendlyError(err('400 {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.BadRequest","fieldViolations":[{"field":"contents[3]"}]}]}}'))
check(!/fieldViolations|@type/.test(json) && json.length <= 320, 'a JSON error body is reduced to its message', json)
const long = friendlyError(err('x'.repeat(5000)))
check(long.length <= 320, `output is capped (${long.length} chars)`)
check(friendlyError(undefined).length > 0 && friendlyError(null).length > 0, 'null/undefined still give a sentence')
check(friendlyError('plain string error: disk full') .includes('disk full'), 'string errors keep their (short) detail')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
