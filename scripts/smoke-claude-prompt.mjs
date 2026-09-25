// The Claude brain's system prompt must describe exactly the tools Claude is allowed to call.
// It once told Claude "You do NOT have the Jarvis one-shot tools" while system_power / weather_get /
// … were registered and allowed, so "what's my battery?" could be refused on demo day (FACTS §8.6).
// No LLM, no keys. Run: node --import ./scripts/lib/register-electron-stub.mjs scripts/smoke-claude-prompt.mjs
const { buildSystemPrompt, claudeToolNames } = await import('../src/main/agent/provider.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${extra}` : ''}`)
}

const prompt = buildSystemPrompt('claude')
check(typeof claudeToolNames === 'function', 'provider exports claudeToolNames()')
const names = typeof claudeToolNames === 'function' ? claudeToolNames() : []
check(names.length >= 57, `Claude is allowed the full tool set (${names.length} names)`)
const bare = (n) => (n.startsWith('mcp__') ? n.split('__').pop() : n)
const missing = names.map(bare).filter((n) => !new RegExp(`\\b${n}\\b`).test(prompt))
check(missing.length === 0, 'every allowed tool is described in the Claude prompt', missing.join(', '))
check(!/do NOT have the Jarvis/i.test(prompt), 'the prompt no longer denies the Jarvis tools')
for (const t of ['system_power', 'weather_get', 'system_volume', 'system_brightness', 'youtube_play'])
  check(new RegExp(`\\b${t}\\b`).test(prompt), `prompt lists ${t}`)
check(/MARK LIII|Mark-LIII/.test(prompt), 'prompt still credits Jarvis Mark-LIII')
// The screen toolset is off by default: its tools must not be advertised unless enabled.
check(!/\bscreen_screenshot\b/.test(prompt) || process.env.GHOST_SCREEN_TOOLS, 'experimental screen tools not advertised when off')
const g = buildSystemPrompt('gemini')
check(/\bweather_get\b/.test(g) && /\bsystem_power\b/.test(g), 'Gemini prompt lists its Jarvis tools too')

// Both brains must know "now": reminder_set asks the model to turn "at 5" into an ISO time itself.
const now = new Date()
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
for (const [b, pr] of [['claude', prompt], ['gemini', g]]) {
  check(pr.includes(String(now.getFullYear())) && pr.includes(now.toLocaleDateString('en-GB', { weekday: 'long' })), `${b} prompt states today's date (weekday + year)`)
  check(pr.includes(tz), `${b} prompt states the time zone (${tz})`)
  check(/\b\d{2}:\d{2}\b/.test(pr.split('Current local time')[1] || ''), `${b} prompt states the current time`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
