import { useEffect, useState } from 'react'
import GhostCore from './GhostCore'

// Tool glyphs/kinds are shared with ToolCard so the rail and the cards never drift apart.
import { TOOL_META, summarizeInput } from './tools/ToolCard'

// MCP tool names arrive namespaced (mcp__ghost-browser__browser_click) — show the bare name.
const cleanName = (n) => (typeof n === 'string' && n.startsWith('mcp__') ? n.split('__').pop() : n)
const fmtDur = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)
// Display-only: the card is narrow, so drop the scheme and "www." (the tooltip keeps the full URL).
const shortUrl = (u) => (typeof u === 'string' ? u.replace(/^https?:\/\/(www\.)?/, '') : u)

// Live "12s" counter for the in-flight task.
function Elapsed({ since }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  if (!since) return null
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return <span className="act-elapsed">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>
}

// Mission Control — the right-hand operational HUD. Everything it shows is derived from state that
// already lives in Main (the in-flight task, the queue, and tool events) plus the browser target;
// it's presentational and never drives the agent loop.
export default function ActivityPanel({
  running,
  queue,
  tools,
  mode,
  agent,
  browserTarget,
  onStopTask,
  onRemoveQueued,
  onStopAll,
  onClose
}) {
  const runEntries = Object.entries(running || {})
  const busy = runEntries.length > 0
  const feed = (tools || []).slice(-14).reverse() // newest action first
  const browserActive = (tools || []).some((t) => t.status === 'running' && /browser/.test(t.name || ''))
  const lastNav = [...(tools || [])].reverse().find((t) => cleanName(t.name) === 'browser_navigate')
  const lastUrl = lastNav ? summarizeInput(lastNav.input) : ''
  const targetLabel = browserTarget === 'active' ? 'your current tab' : "Ghost's own tab"

  return (
    <aside className={`activity${busy ? ' is-busy' : ''}`}>
      <div className="activity-head">
        <span className={`act-pulse ${busy ? 'live' : ''}`} />
        <span className="activity-title">ACTIVITY</span>
        <span className="act-config">
          {(agent?.model || 'sonnet')} · {mode}
        </span>
        {onClose && (
          <button className="act-close" onClick={onClose} title="Hide activity panel" aria-label="Hide activity panel">
            ›
          </button>
        )}
      </div>

      <div className="activity-body">
        <div className={`act-core${busy ? ' live' : ''}`}>
          <GhostCore active={busy} height={132} quality="lite" />
          <div className="act-core-cap">
            <span className="act-core-dot" />
            {busy ? 'thinking…' : 'standby'}
          </div>
        </div>

        <section className="act-section">
          <div className="act-label">Browser</div>
          <div className={`act-browser ${browserActive ? 'active' : ''}`}>
            <span className="act-browser-dot" />
            <div className="act-browser-text">
              <div className="act-browser-state">{browserActive ? 'acting…' : 'idle'}</div>
              <div className="act-browser-target" title={lastUrl || targetLabel}>
                {shortUrl(lastUrl) || targetLabel}
              </div>
            </div>
          </div>
        </section>

        <section className="act-section">
          <div className="act-label">Now running</div>
          {busy ? (
            runEntries.map(([id, t]) => (
              <div className="act-run" key={id}>
                <span className="tool-spinner" />
                <div className="act-run-main">
                  <span className="act-run-text act-run-prompt" title={t.prompt}>
                    {t.prompt}
                  </span>
                  <span className="act-run-meta">
                    running <Elapsed since={t.startedAt} />
                  </span>
                </div>
                <button className="act-x act-stop" onClick={() => onStopTask(id)} title="Stop this task" aria-label="Stop this task">
                  <span className="act-stop-ico" />
                </button>
                <span className="act-run-bar" aria-hidden="true" />
              </div>
            ))
          ) : (
            <div className="act-idle act-slot">Idle — waiting for a task</div>
          )}
        </section>

        {queue.length > 0 && (
          <section className="act-section">
            <div className="act-label">
              Queue <span className="act-count">{queue.length}</span>
              <button className="act-clear" onClick={onStopAll} title="Stop the current task and clear the queue">
                Clear all
              </button>
            </div>
            {queue.map((q, i) => (
              <div className="act-queued" key={i}>
                <span className="act-pos">{i + 1}</span>
                <span className="act-run-text" title={q}>
                  {q}
                </span>
                <button className="act-x" onClick={() => onRemoveQueued(i)} title="Remove from queue" aria-label="Remove from queue">
                  ✕
                </button>
              </div>
            ))}
          </section>
        )}

        <section className="act-section">
          <div className="act-label">
            Tool feed {feed.length > 0 && <span className="act-count">{tools.length}</span>}
          </div>
          {feed.length === 0 ? (
            <div className="act-idle act-slot">No tools run yet</div>
          ) : (
            // A vertical timeline, newest first: the node carries the tool's kind colour + glyph (or
            // the spinner / ✕), the body carries name, duration and the full argument on its own line.
            <div className="act-feed">
              {feed.map((t, i) => {
                const name = cleanName(t.name)
                const meta = TOOL_META[name] || { glyph: '∎', kind: 'tool' }
                const arg = summarizeInput(t.input)
                const live = t.status === 'running'
                return (
                  <div className={`act-tool tool-${meta.kind} ${t.status}${t.isError ? ' err' : ''}`} key={t.id || i}>
                    <span className="act-tool-node" title={live ? 'running' : t.isError ? 'failed' : 'done'}>
                      {live ? <span className="tool-spinner" /> : t.isError ? '✕' : meta.glyph}
                    </span>
                    <div className="act-tool-main">
                      <div className="act-tool-top">
                        <span className="act-tool-name">{name}</span>
                        {live ? (
                          <span className="act-tool-dur act-tool-live">running</span>
                        ) : (
                          t.durationMs != null && <span className="act-tool-dur">{fmtDur(t.durationMs)}</span>
                        )}
                      </div>
                      {arg && (
                        <span className="act-tool-arg" title={arg}>
                          {arg}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
