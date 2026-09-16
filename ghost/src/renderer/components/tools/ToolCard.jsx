import { useState } from 'react'

// Per-tool glyph + kind (kind drives the left-rail accent color in styles.css).
const TOOL_META = {
  Bash: { glyph: '❯', kind: 'terminal' },
  Read: { glyph: '▤', kind: 'file' },
  Write: { glyph: '✎', kind: 'file' },
  Edit: { glyph: '✎', kind: 'file' },
  Glob: { glyph: '⌕', kind: 'search' },
  Grep: { glyph: '⌕', kind: 'search' },
  WebFetch: { glyph: '⤓', kind: 'web' },
  WebSearch: { glyph: '⌕', kind: 'web' },
  browser_navigate: { glyph: '◉', kind: 'browser' },
  browser_get_text: { glyph: '▤', kind: 'browser' },
  browser_click: { glyph: '⊙', kind: 'browser' },
  browser_fill: { glyph: '✎', kind: 'browser' },
  browser_screenshot: { glyph: '◉', kind: 'browser' }
}

function summarizeInput(input) {
  if (!input || typeof input !== 'object') return ''
  if (input.command) return input.command
  if (input.file_path) return input.file_path
  if (input.url) return input.url
  if (input.selector) return input.value ? `${input.selector} ← ${input.value}` : input.selector
  if (input.pattern) return input.pattern
  if (input.query) return input.query
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
