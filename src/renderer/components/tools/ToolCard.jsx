import { useState } from 'react'

export const TOOL_META = {
  Bash: { glyph: '❯', kind: 'terminal' },
  terminal_run: { glyph: '❯', kind: 'terminal' },
  shell_run: { glyph: '❯', kind: 'terminal' },
  shell_open: { glyph: '❯', kind: 'terminal' },
  shell_read: { glyph: '❯', kind: 'terminal' },
  shell_list: { glyph: '❯', kind: 'terminal' },
  shell_kill: { glyph: '❯', kind: 'terminal' },
  Read: { glyph: '▤', kind: 'file' },
  file_read: { glyph: '▤', kind: 'file' },
  Write: { glyph: '✎', kind: 'file' },
  file_write: { glyph: '✎', kind: 'file' },
  Edit: { glyph: '✎', kind: 'file' },
  file_edit: { glyph: '✎', kind: 'file' },
  file_create: { glyph: '＋', kind: 'file' },
  file_move: { glyph: '⇄', kind: 'file' },
  file_delete: { glyph: '✕', kind: 'file' },
  undo_last: { glyph: '↶', kind: 'file' },
  undo_list: { glyph: '↶', kind: 'file' },
  Glob: { glyph: '⌕', kind: 'search' },
  file_search: { glyph: '⌕', kind: 'search' },
  Grep: { glyph: '⌕', kind: 'search' },
  file_grep: { glyph: '⌕', kind: 'search' },
  WebFetch: { glyph: '⤓', kind: 'web' },
  web_fetch: { glyph: '⤓', kind: 'web' },
  WebSearch: { glyph: '⌕', kind: 'web' },
  web_search: { glyph: '⌕', kind: 'web' },
  browser_navigate: { glyph: '◉', kind: 'browser' },
  browser_get_page: { glyph: '◎', kind: 'browser' },
  browser_get_text: { glyph: '▤', kind: 'browser' },
  browser_click_at: { glyph: '⊙', kind: 'browser' },
  browser_go_back: { glyph: '←', kind: 'browser' },
  browser_go_forward: { glyph: '→', kind: 'browser' },
  browser_reload: { glyph: '↻', kind: 'browser' },
  browser_wait_for: { glyph: '◷', kind: 'browser' },
  browser_wait_for_navigation: { glyph: '◷', kind: 'browser' },
  browser_close_tab: { glyph: '✕', kind: 'browser' },
  browser_list_browsers: { glyph: '◫', kind: 'browser' },
  browser_use_browser: { glyph: '◫', kind: 'browser' },
  browser_click: { glyph: '⊙', kind: 'browser' },
  browser_fill: { glyph: '✎', kind: 'browser' },
  browser_screenshot: { glyph: '◉', kind: 'browser' },
  browser_hover: { glyph: '☝', kind: 'browser' },
  browser_find: { glyph: '⌕', kind: 'browser' },
  browser_drag: { glyph: '⇢', kind: 'browser' },
  browser_read_pages: { glyph: '▤', kind: 'browser' },
  browser_scroll: { glyph: '↕', kind: 'browser' },
  browser_press_key: { glyph: '⌨', kind: 'browser' },
  browser_list_tabs: { glyph: '◫', kind: 'browser' },
  browser_use_tab: { glyph: '◫', kind: 'browser' },
  system_volume: { glyph: '🔊', kind: 'system' },
  system_brightness: { glyph: '🔆', kind: 'system' },
  system_power: { glyph: '⚡', kind: 'system' },
  system_telemetry: { glyph: '📊', kind: 'system' },
  weather_get: { glyph: '🌤', kind: 'weather' },
  reminder_set: { glyph: '⏰', kind: 'reminder' },
  reminder_list: { glyph: '⏰', kind: 'reminder' },
  reminder_cancel: { glyph: '⏰', kind: 'reminder' },
  youtube_play: { glyph: '▶', kind: 'media' },
  jarvis_action_run: { glyph: '⚙', kind: 'jarvis' },
  memory_save: { glyph: '🧠', kind: 'memory' },
  memory_recall: { glyph: '🧠', kind: 'memory' },
  clipboard_read: { glyph: '📋', kind: 'system' },
  clipboard_write: { glyph: '📋', kind: 'system' },
  notify_user: { glyph: '🔔', kind: 'system' },
  screen_screenshot: { glyph: '🖥', kind: 'system' }
}

export function summarizeInput(input) {
  if (!input || typeof input !== 'object') return ''
  if (input.command) return input.command
  if (input.path) return input.path
  if (input.file_path) return input.file_path
  if (input.url) return input.url
  if (input.selector) return input.value ? `${input.selector} ← ${input.value}` : input.selector
  if (input.pattern) return input.pattern
  if (input.query) return input.query
  if (input.action) return input.value ? `${input.action} (${input.value})` : input.action
  if (input.location) return input.location
  if (input.text) return input.text
  try {
    return JSON.stringify(input).slice(0, 140)
  } catch {
    return ''
  }
}

function fmtDuration(ms) {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export default function ToolCard({ name, input, output, image, status, isError, durationMs }) {
  const [open, setOpen] = useState(true)
  // Clean up SDK MCP tool names (mcp__ghost-browser__browser_navigate → browser_navigate).
  const displayName = typeof name === 'string' && name.startsWith('mcp__') ? name.split('__').pop() : name
  const meta = TOOL_META[displayName] || { glyph: '∎', kind: 'tool' }
  const arg = summarizeInput(input)
  const hasBody = !!output || !!image
  const running = status === 'running'

  return (
    <div className={`toolcard ${status} tool-${meta.kind}${isError ? ' tool-error' : ''}`}>
      <div
        className="toolcard-head"
        onClick={() => hasBody && setOpen((o) => !o)}
        style={{ cursor: hasBody ? 'pointer' : 'default' }}
      >
        <span className="tool-status">
          {running ? <span className="tool-spinner" /> : isError ? '✕' : '✓'}
        </span>
        <span className="tool-glyph">{meta.glyph}</span>
        <span className="tool-name">{displayName}</span>
        {arg && <code className="tool-arg">{arg}</code>}
        <span className="tool-meta">
          {!running && durationMs != null && <span className="tool-time">{fmtDuration(durationMs)}</span>}
          {hasBody && <span className="tool-chevron">{open ? '▾' : '▸'}</span>}
        </span>
      </div>
      {open && image && <img className="tool-shot" src={image} alt="browser screenshot" />}
      {open && output && <pre className="tool-output">{output}</pre>}
    </div>
  )
}
