// PLAN mode must be read-only on BOTH brains. The Claude brain once passed the same allowedTools in
// every mode, and the Agent SDK runs every allowed MCP tool without asking, plan mode or not, so
// "Delete the Showcase folder" in PLAN mode (DEMO.md Demo 7) could really delete it.
// Offline: the Agent SDK is replaced by scripts/lib/claude-sdk-stub.mjs, which records the options.
// Run: GHOST_BRAIN_MODE=claude node --import ./scripts/lib/register-sdk-stub.mjs scripts/smoke-plan-mode.mjs
process.env.GHOST_BRAIN_MODE = 'claude'
process.env.GHOST_CANVA ??= '1'
const gate = await import('../src/main/agent/plan-gate.js')
const { streamChat, claudeToolNames } = await import('../src/main/agent/provider.js')

let pass = 0
let fail = 0
const check = (ok, label, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && extra ? `  → ${extra}` : ''}`)
}
const WRITERS = /(^|__)(file_write|file_create|file_move|file_delete|undo_last|shell_run|shell_open|shell_kill|browser_click|browser_fill|browser_navigate|browser_close_tab|reminder_set|reminder_cancel|clipboard_write|memory_save|youtube_play|jarvis_action_run|phone_tap|phone_type|Write|Edit)$/

// ---- the shared decision -------------------------------------------------------------------
const { isReadOnlyCall } = gate
check(isReadOnlyCall('mcp__ghost-jarvis__system_power', { action: 'battery' }), 'battery is readable in PLAN mode (Claude name)')
check(isReadOnlyCall('system_power', {}), 'system_power with no action (= battery) is readable')
check(!isReadOnlyCall('system_power', { action: 'sleep' }), 'system_power sleep is blocked')
check(!isReadOnlyCall('system_power', { action: 'lock' }), 'system_power lock is blocked')
check(isReadOnlyCall('system_volume', { action: 'get' }) && !isReadOnlyCall('system_volume', { action: 'set', value: 80 }), 'volume: get allowed, set blocked')
check(isReadOnlyCall('system_brightness', {}) && !isReadOnlyCall('system_brightness', { action: 'up' }), 'brightness: get allowed, up blocked')
check(isReadOnlyCall('mcp__ghost-browser__browser_get_page', {}) && isReadOnlyCall('Read', {}), 'reading pages and files is allowed')
for (const n of ['mcp__ghost-files__file_delete', 'mcp__ghost-shell__shell_run', 'file_write', 'Write', 'mcp__canva__create-design'])
  check(!isReadOnlyCall(n, {}), `${n} is blocked`)
check(/Shift\+Tab/.test(gate.planModeMessage('file_delete')) && /!mode auto/.test(gate.planModeMessage('file_delete', 'discord')), 'skip message names the right way to switch')

// ---- the Claude brain's SDK options in each mode ---------------------------------------------
async function optionsFor(mode) {
  globalThis.__sdkCalls = []
  let text = ''
  await streamChat({ messages: [{ role: 'user', content: 'Delete the Showcase folder.' }], mode, onDelta: (t) => (text += t), onEvent() {} })
  return { o: globalThis.__sdkCalls.at(-1)?.options || {}, text }
}
const plan = await optionsFor('plan')
const p = plan.o
check(p.permissionMode === 'plan', 'PLAN → SDK permissionMode plan')
const allowedWriters = (p.allowedTools || []).filter((n) => WRITERS.test(n) || n === 'mcp__canva')
check(allowedWriters.length === 0, 'PLAN: no state-changing tool is auto-approved', allowedWriters.join(', '))
check((p.allowedTools || []).includes('mcp__ghost-browser__browser_get_page'), 'PLAN: reading a page is still auto-approved')
const all = claudeToolNames({ screen: false })
const leaked = all.filter((n) => WRITERS.test(n) && !(p.disallowedTools || []).includes(n))
check(leaked.length === 0, 'PLAN: every state-changing tool is removed (disallowedTools)', leaked.join(', '))
check((p.disallowedTools || []).includes('mcp__canva'), 'PLAN: Canva is removed')
check(typeof p.canUseTool === 'function', 'PLAN: a permission check decides the rest')
if (typeof p.canUseTool === 'function') {
  const ask = (n, input) => p.canUseTool(n, input, { signal: new AbortController().signal })
  check((await ask('mcp__ghost-jarvis__system_power', { action: 'battery' })).behavior === 'allow', 'PLAN: canUseTool allows the battery read')
  const sleep = await ask('mcp__ghost-jarvis__system_power', { action: 'sleep' })
  check(sleep.behavior === 'deny' && /PLAN MODE/.test(sleep.message), 'PLAN: canUseTool denies sleep with the PLAN MODE message')
  check((await ask('mcp__ghost-files__file_delete', { path: '~/Showcase' })).behavior === 'deny', 'PLAN: canUseTool denies file_delete')
  check((await ask('Bash', { command: 'rm -rf ~/Showcase' })).behavior === 'deny', 'PLAN: canUseTool denies Bash')
  check((await ask('ExitPlanMode', {})).behavior === 'deny', 'PLAN: the model cannot leave PLAN mode by itself')
}
check(/PLAN mode/i.test(p.systemPrompt || ''), 'PLAN: the system prompt tells Claude it is in PLAN mode')

for (const mode of ['auto', 'full']) {
  const { o } = await optionsFor(mode)
  check((o.allowedTools || []).includes('mcp__ghost-files__file_delete') && !o.disallowedTools && !o.canUseTool, `${mode.toUpperCase()}: unchanged (all tools allowed, no extra gate)`)
  check(!/PLAN mode is ON/.test(o.systemPrompt || ''), `${mode.toUpperCase()}: no PLAN note in the prompt`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
