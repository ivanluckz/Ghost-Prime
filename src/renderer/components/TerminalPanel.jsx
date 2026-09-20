import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// Terminal theme tuned to the Ghost-Prime palette.
const THEME = {
  background: '#06080f',
  foreground: '#dbe3ff',
  cursor: '#00e6ff',
  cursorAccent: '#04060e',
  selectionBackground: 'rgba(0, 230, 255, 0.28)',
  black: '#11151f',
  red: '#ff5d7a',
  green: '#2ee6a6',
  yellow: '#ffd479',
  blue: '#7aa2f7',
  magenta: '#ff45c0',
  cyan: '#00e6ff',
  white: '#cdd6f4',
  brightBlack: '#46527a',
  brightRed: '#ff7d93',
  brightGreen: '#5cf0bf',
  brightYellow: '#ffe1a3',
  brightBlue: '#a6c0ff',
  brightMagenta: '#ff6fd0',
  brightCyan: '#7df3ff',
  brightWhite: '#ffffff'
}

const FONT = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace"

// One live, persistent multi-session terminal dock. `sessions` is owned by Main (so it can badge the
// toolbar / auto-open); this component owns the xterm instances and the live data stream.
export default function TerminalPanel({ sessions = [], onClose }) {
  const [activeId, setActiveId] = useState(null)
  const [err, setErr] = useState('') // why the last '+' failed (e.g. node-pty backend unavailable)
  const terms = useRef(new Map()) // id -> { term, fit, ready, buf }
  const containers = useRef(new Map()) // id -> DOM node
  const bodyRef = useRef(null)

  // Live output from the main process → the matching xterm (background terminals stay current too).
  useEffect(() => {
    const off = window.ghost.shell?.onData(({ id, data, seq }) => {
      const t = terms.current.get(id)
      if (!t) return
      if (t.ready) t.term.write(data)
      else t.buf.push({ seq, data })
    })
    return off
  }, [])

  function fit(id) {
    const t = terms.current.get(id)
    if (!t) return
    try {
      t.fit.fit()
      window.ghost.shell?.resize(id, t.term.cols, t.term.rows)
    } catch {}
  }

  function mountTerm(id) {
    const el = containers.current.get(id)
    if (!el || terms.current.has(id)) return
    const term = new Terminal({
      fontFamily: FONT,
      fontSize: 12.5,
      lineHeight: 1.18,
      theme: THEME,
      cursorBlink: true,
      scrollback: 6000,
      allowProposedApi: true
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(el)
    const entry = { term, fit: fitAddon, ready: false, buf: [] }
    terms.current.set(id, entry)

    // User keystrokes → the real shell.
    term.onData((d) => window.ghost.shell?.write(id, d))

    // Replay history, then flush anything that streamed in during the async gap. Main numbers every
    // chunk and tells us the seq its scrollback text already covers, so chunks that were both
    // broadcast (and buffered here) and folded into that text are skipped instead of written twice.
    let covered = -1
    window.ghost.shell
      ?.scrollback(id)
      .then((sb) => {
        const text = typeof sb === 'string' ? sb : sb?.text || ''
        if (typeof sb === 'object' && sb && Number.isFinite(sb.seq)) covered = sb.seq
        if (text) term.write(text)
      })
      .catch(() => {})
      .finally(() => {
        entry.ready = true
        for (const { seq, data } of entry.buf) {
          if (Number.isFinite(seq) && seq <= covered) continue
          term.write(data)
        }
        entry.buf = []
        requestAnimationFrame(() => fit(id))
      })
  }

  function disposeTerm(id) {
    const t = terms.current.get(id)
    if (!t) return
    try {
      t.term.dispose()
    } catch {}
    terms.current.delete(id)
  }

  // Reconcile xterm instances to the session list; keep a valid active tab.
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id))
    for (const s of sessions) mountTerm(s.id)
    for (const id of [...terms.current.keys()]) if (!ids.has(id)) disposeTerm(id)

    setActiveId((cur) => {
      if (cur && ids.has(cur)) return cur
      return sessions.length ? sessions[sessions.length - 1].id : null
    })
  }, [sessions])

  // A live session arriving by any path (agent shell_run/shell_open, a later '+') proves the backend
  // recovered, so drop a stale "couldn't open" banner instead of leaving it over the live xterm.
  useEffect(() => {
    if (sessions.some((s) => s.alive)) setErr('')
  }, [sessions])

  // Fit whenever the active tab changes or the dock resizes.
  useEffect(() => {
    if (activeId) requestAnimationFrame(() => fit(activeId))
  }, [activeId])

  useEffect(() => {
    if (!bodyRef.current) return
    const ro = new ResizeObserver(() => activeId && fit(activeId))
    ro.observe(bodyRef.current)
    return () => ro.disconnect()
  }, [activeId])

  // Dispose everything on unmount (the PTYs live on in the main process).
  useEffect(() => {
    return () => {
      for (const id of [...terms.current.keys()]) disposeTerm(id)
    }
  }, [])

  async function openTerminal() {
    const t = terms.current.get(activeId)
    try {
      const r = await window.ghost.shell?.open({ cols: t?.term.cols || 80, rows: t?.term.rows || 24 })
      if (r?.id) setActiveId(r.id)
      setErr('')
    } catch (e) {
      // node-pty failed to load (ABI mismatch after an Electron upgrade) or the spawn failed —
      // say so in the dock instead of a silent 'Uncaught (in promise)' in DevTools.
      const msg = String(e?.message || e || 'Could not open a terminal').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
      setErr(msg)
    }
  }

  function closeTerminal(id, e) {
    e?.stopPropagation()
    window.ghost.shell?.kill(id)
  }

  return (
    <div className="term-dock">
      <div className="term-tabs">
        <span className="term-label">
          <span className="term-glyph">{'>_'}</span> TERMINAL
        </span>
        <div className="term-tablist">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`term-tab ${s.id === activeId ? 'active' : ''} ${s.alive ? '' : 'dead'}`}
              onClick={() => setActiveId(s.id)}
              title={`${s.name} · ${s.cwd}`}
            >
              {s.agent && <span className="term-tab-agent" title="Opened by Ghost">◆</span>}
              <span className={`term-tab-dot ${s.busy ? 'busy' : s.alive ? 'live' : 'dead'}`} />
              <span className="term-tab-name">{s.name}</span>
              <span className="term-tab-x" onClick={(e) => closeTerminal(s.id, e)} title="Close terminal">
                ✕
              </span>
            </button>
          ))}
          <button className="term-new" onClick={openTerminal} title="New terminal">
            +
          </button>
        </div>
        <button className="term-collapse" onClick={onClose} title="Hide terminal">
          ⌄
        </button>
      </div>
      <div className="term-body" ref={bodyRef}>
        {sessions.length === 0 && !err && (
          <div className="term-empty">
            <p>
              No terminal yet. Press <kbd>+</kbd> to open one — or just ask Ghost to run something.
            </p>
          </div>
        )}
        {err && (
          <div
            className={sessions.length === 0 ? 'term-empty term-error' : 'term-error term-error-bar'}
            role="alert"
            style={
              sessions.length === 0
                ? undefined
                : { position: 'absolute', left: 0, right: 0, top: 0, zIndex: 2, padding: '6px 12px', fontSize: 12, background: 'rgba(255, 93, 122, 0.12)', borderBottom: '1px solid rgba(255, 93, 122, 0.35)' }
            }
          >
            <div>
              <strong>Couldn't open a terminal.</strong> <span className="term-error-detail">{err}</span>
              {/terminal backend unavailable/i.test(err) && (
                <div className="term-error-hint">
                  Rebuild the native module: <kbd>npx electron-rebuild -f -o node-pty</kbd>, then restart Ghost-Prime.
                </div>
              )}
              <button
                type="button"
                className="term-error-dismiss"
                onClick={() => setErr('')}
                style={{ marginLeft: 8, padding: '1px 8px', font: 'inherit', fontSize: 11, color: 'inherit', background: 'rgba(255, 255, 255, 0.06)', border: '1px solid rgba(255, 93, 122, 0.35)', borderRadius: 6, cursor: 'pointer' }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className="term-surface"
            style={{ display: s.id === activeId ? 'block' : 'none' }}
            ref={(el) => {
              if (el) containers.current.set(s.id, el)
              else containers.current.delete(s.id)
            }}
          />
        ))}
      </div>
    </div>
  )
}
