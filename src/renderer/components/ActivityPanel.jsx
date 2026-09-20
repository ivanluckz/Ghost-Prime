import { useEffect, useState } from 'react'
import GhostCore from './GhostCore'

// Tool glyphs/kinds are shared with ToolCard so the rail and the cards never drift apart.
import { TOOL_META, summarizeInput } from './tools/ToolCard'

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
    <aside className="activity">
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
        <div className="act-core">
          <GhostCore active={busy} height={132} quality="lite" />
          <div className="act-core-cap">{busy ? 'thinking…' : 'standby'}</div>
        </div>

        <section className="act-section">
          <div className="act-label">Browser</div>
          <div className={`act-browser ${browserActive ? 'active' : ''}`}>
            <span className="act-browser-dot" />
            <div className="act-browser-text">
              <div className="act-browser-state">{browserActive ? 'acting…' : 'idle'}</div>
              <div className="act-browser-target" title={lastUrl || targetLabel}>
                {lastUrl || targetLabel}
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
                <span className="act-run-text" title={t.prompt}>
                  {t.prompt}
                </span>
                <Elapsed since={t.startedAt} />
                <button className="act-x" onClick={() => onStopTask(id)} title="Stop this task" aria-label="Stop this task">
                  ✕
                </button>
              </div>
            ))
          ) : (
            <div className="act-idle">Idle — waiting for a task</div>
          )}
        </section>

        {queue.length > 0 && (
          <section className="act-section">
            <div className="act-label">
              Queue <span className="act-count">{queue.length}</span>
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
            <button className="act-clear" onClick={onStopAll} title="Stop the current task and clear the queue">
              Clear queue
            </button>
          </section>
        )}

        <section className="act-section">
          <div className="act-label">
            Tool feed {feed.length > 0 && <span className="act-count">{tools.length}</span>}
          </div>
          {feed.length === 0 ? (
            <div className="act-idle">No tools run yet</div>
          ) : (
            <div className="act-feed">
              {feed.map((t, i) => {
                const name = cleanName(t.name)
                const meta = TOOL_META[name] || { glyph: '∎', kind: 'tool' }
                const arg = summarizeInput(t.input)
                return (
                  <div className={`act-tool tool-${meta.kind} ${t.status}${t.isError ? ' err' : ''}`} key={t.id || i}>
                    <span className="act-tool-status">
                      {t.status === 'running' ? <span className="tool-spinner" /> : t.isError ? '✕' : '✓'}
                    </span>
                    <span className="act-tool-glyph">{meta.glyph}</span>
                    <span className="act-tool-name">{name}</span>
                    {arg && (
                      <span className="act-tool-arg" title={arg}>
                        {arg}
                      </span>
                    )}
                    {t.status !== 'running' && t.durationMs != null && <span className="act-tool-dur">{fmtDur(t.durationMs)}</span>}
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
