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
  phone_pair: { glyph: '⌗', kind: 'phone' },
  phone_screenshot: { glyph: '▯', kind: 'phone' },
  phone_ui: { glyph: '☷', kind: 'phone' },
  phone_tap: { glyph: '◎', kind: 'phone' },
  phone_swipe: { glyph: '↕', kind: 'phone' },
  phone_type: { glyph: '⌨', kind: 'phone' },
  phone_key: { glyph: '◁', kind: 'phone' },
  phone_open_app: { glyph: '▶', kind: 'phone' },
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

// Card-only presentation of the argument summary. When summarizeInput had nothing better than raw
// JSON ({"ref":4,"value":"Lisbon"}), show the pairs as `key value` instead of braces and quotes;
// an empty input ({}) shows nothing. The shared summarizeInput (used by the Activity rail) is untouched.
function argView(input) {
  const text = summarizeInput(input)
  let raw = null
  try {
    raw = JSON.stringify(input).slice(0, 140)
  } catch {
    /* unserialisable input: keep the plain summary */
  }
  if (!text || text !== raw || Array.isArray(input)) return { text, pairs: null }
  const pairs = Object.entries(input).map(([k, v]) => {
    let val = typeof v === 'string' ? v : JSON.stringify(v)
    if (typeof val === 'string' && val.length > 60) val = `${val.slice(0, 59)}…`
    return [k, val ?? String(v)]
  })
  return { text: pairs.length ? text : '', pairs }
}

// Chevron points right when collapsed and rotates down when open (see tools.css).
const Chevron = () => (
  <svg className="tool-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
    <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export default function ToolCard({ name, input, output, image, status, isError, durationMs }) {
  const [open, setOpen] = useState(true)
  // Clean up SDK MCP tool names (mcp__ghost-browser__browser_navigate → browser_navigate).
  const displayName = typeof name === 'string' && name.startsWith('mcp__') ? name.split('__').pop() : name
  const meta = TOOL_META[displayName] || { glyph: '∎', kind: 'tool' }
  const arg = argView(input)
  const hasBody = !!output || !!image
  const running = status === 'running'
  const toggle = () => hasBody && setOpen((o) => !o)
  const cls = [
    'toolcard',
    status,
    `tool-${meta.kind}`,
    isError && 'tool-error',
    hasBody && 'has-body',
    hasBody && open && 'is-open'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls}>
      <div
        className="toolcard-head"
        onClick={toggle}
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        aria-expanded={hasBody ? open : undefined}
        onKeyDown={(e) => {
          if (hasBody && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            toggle()
          }
        }}
      >
        <span className="tool-glyph" aria-hidden="true">
          {meta.glyph}
        </span>
        <span className="tool-name">{displayName}</span>
        {arg.text && (
          <code className="tool-arg" title={arg.text}>
            {arg.pairs
              ? arg.pairs.map(([k, v], i) => (
                  <span key={k} className="tool-arg-pair">
                    {i > 0 && ' '}
                    <span className="tool-arg-key">{k}</span> {v}
                  </span>
                ))
              : arg.text}
          </code>
        )}
        <span className="tool-meta">
          {!running && durationMs != null && <span className="tool-time">{fmtDuration(durationMs)}</span>}
          <span className="tool-status" role="img" aria-label={running ? 'Running' : isError ? 'Failed' : 'Done'}>
            {running ? <span className="tool-spinner" /> : isError ? '✕' : '✓'}
          </span>
          {hasBody && <Chevron />}
        </span>
      </div>
      {open && hasBody && (
        <div className="toolcard-body">
          {image && <img className="tool-shot" src={image} alt="browser screenshot" />}
          {output && <pre className="tool-output">{output}</pre>}
        </div>
      )}
    </div>
  )
}
