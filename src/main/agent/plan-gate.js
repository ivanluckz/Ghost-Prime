// PLAN mode ("read-only", Shift+Tab) for BOTH brains. One list, so the Gemini loop and the Claude
// Agent SDK agree on what may run while a teacher has the app in PLAN mode.
//
// A tool is read-only when it only looks at things (pages, files, memory, the weather). Some Jarvis
// tools do both: system_power reads the battery by default but can also lock or sleep the computer,
// system_volume / system_brightness default to 'get' but can also change the level. Those are judged
// per call by their `action` (see isReadOnlyCall).

// Bare tool names (no mcp__server__ prefix). Built-in Claude tools included (Read, Glob, …).
export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'file_read',
  'file_search',
  'file_grep',
  'phone_screenshot',
  'phone_ui',
  'browser_get_page',
  'browser_get_text',
  'browser_find',
  'browser_screenshot',
  'browser_list_tabs',
  'browser_list_browsers',
  'browser_wait_for',
  'browser_wait_for_navigation',
  'browser_read_pages',
  'shell_read',
  'shell_list',
  'undo_list',
  'memory_recall',
  'system_telemetry',
  'weather_get',
  'reminder_list',
  'clipboard_read',
  'web_search',
  'web_fetch'
])

// Tools whose default action only reads. Maps the tool to [its default action, the read-only actions].
const READ_ACTIONS = {
  system_power: ['battery', ['battery']],
  system_volume: ['get', ['get']],
  system_brightness: ['get', ['get']]
}

export function bareToolName(name) {
  const parts = String(name || '').split('__') // mcp__<server>__<tool>
  return parts[0] === 'mcp' && parts.length >= 3 ? parts.slice(2).join('__') : String(name || '')
}

// Statically read-only: safe to auto-approve before seeing the arguments.
export const isReadOnlyTool = (name) => READ_ONLY_TOOLS.has(bareToolName(name))

// Can tool `name` run with these arguments while in PLAN mode?
export function isReadOnlyCall(name, args) {
  const bare = bareToolName(name)
  if (READ_ONLY_TOOLS.has(bare)) return true
  const rule = READ_ACTIONS[bare]
  if (!rule) return false
  const action = args && typeof args === 'object' && args.action != null ? String(args.action) : rule[0]
  return rule[1].includes(action)
}

// Could this tool ever run in PLAN mode (for some arguments)? The rest are hidden from Claude.
export const mayRunInPlan = (name) => isReadOnlyTool(name) || bareToolName(name) in READ_ACTIONS

// What the model is told when a call is skipped. It relays this to the user, so it must name the
// right way to switch on this surface (the desktop cycles with Shift+Tab, Discord has !mode).
export function planModeMessage(name, surface = 'desktop') {
  const howToSwitch =
    surface === 'discord' ? 'Switch with `!mode auto` or `!mode full` to execute.' : 'Switch to AUTO or FULL mode with Shift+Tab to execute.'
  return `[PLAN MODE: Skipping execution of state-changing tool "${bareToolName(name)}". ${howToSwitch}]`
}

// Agent SDK options that enforce PLAN mode on the Claude brain. The SDK's own 'plan' permission mode
// only hard-blocks its built-in Write/Edit: every name in allowedTools runs without asking, MCP tools
// included. So in PLAN mode: auto-approve only the read-only tools, remove every tool that can only
// change things, and check the mixed ones (system_power, …) per call in canUseTool.
export function claudePlanOptions(names, { surface = 'desktop', extraDisallowed = [] } = {}) {
  return {
    allowedTools: names.filter(isReadOnlyTool),
    disallowedTools: [...new Set(['Write', 'Edit', 'NotebookEdit', 'Bash', ...names.filter((n) => !mayRunInPlan(n)), ...extraDisallowed])],
    canUseTool: async (toolName, input) => {
      if (isReadOnlyCall(toolName, input)) return { behavior: 'allow', updatedInput: input }
      if (toolName === 'ExitPlanMode')
        return { behavior: 'deny', message: 'Stay in PLAN mode: give your plan as the answer. Only the user can switch mode (Shift+Tab).' }
      return { behavior: 'deny', message: planModeMessage(toolName, surface) }
    }
  }
}
