import { useEffect, useRef, useState } from 'react'
import MessageList from '../components/chat/MessageList.jsx'
import ChatInput from '../components/chat/ChatInput.jsx'
import SessionSidebar from '../components/SessionSidebar.jsx'
import SettingsPanel from '../components/SettingsPanel.jsx'
import ActivityPanel from '../components/ActivityPanel.jsx'
import TerminalPanel from '../components/TerminalPanel.jsx'
import { playActivate, isMuted, toggleMuted, onMuteChange } from '../audio.js'

// Build identity, injected by electron.vite.config.js — shown in the topbar so it's obvious which
// build is live (the stamp changes every rebuild). typeof guard keeps it safe if not defined.
const GHOST_VERSION = typeof __GHOST_VERSION__ !== 'undefined' ? __GHOST_VERSION__ : '0.0.0'
const GHOST_BUILD = typeof __GHOST_BUILD__ !== 'undefined' ? __GHOST_BUILD__ : ''

// Autonomy modes, cycled with Shift+Tab (like Claude Code).
const MODES = [
  { id: 'plan', label: 'PLAN', hint: 'read-only — plans, runs nothing' },
  { id: 'auto', label: 'AUTO', hint: 'classifier approves each action' },
  { id: 'full', label: 'FULL AUTO', hint: 'no checks — runs everything' }
]

export default function Main() {
  const [messages, setMessages] = useState([]) // { role:'user'|'assistant'|'tool', reqId, ... }
  const [running, setRunning] = useState({}) // reqId -> { prompt, startedAt } — the single in-flight task
  const [queue, setQueue] = useState([]) // prompts waiting their turn (FIFO) — one task runs at a time
  const [mode, setMode] = useState('full')
  const [agent, setAgent] = useState({}) // { model, effort, thinking } — runtime overrides via / commands

  const [voiceOut, setVoiceOut] = useState(false) // speak replies aloud
  const [ttsOk, setTtsOk] = useState(false)
  const [sessions, setSessions] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mirror, setMirror] = useState(true) // auto-sync chat into Chrome's side panel

  const [activityOpen, setActivityOpen] = useState(true) // right-hand Mission Control activity panel
  const [browserTarget, setBrowserTarget] = useState('group') // which tab browser tools act on
  const [muted, setMutedState] = useState(isMuted()) // master sound mute (intro sting + sfx)
  const [shellSessions, setShellSessions] = useState([]) // live terminals (shared with the agent)
  const [termOpen, setTermOpen] = useState(false) // terminal dock visible
  const prevShellCount = useRef(0)
  const voiceOutRef = useRef(false)
  const sendRef = useRef(null) // latest send(), so externally-pushed tasks avoid a stale closure

  const busy = Object.keys(running).length > 0
  const refreshSessions = () => window.ghost.recentSessions().then(setSessions).catch(() => {})

  // Initial load: TTS availability, past sessions, current session id.
  useEffect(() => {
    window.ghost.voice?.ttsAvailable().then(setTtsOk).catch(() => setTtsOk(false))
    refreshSessions()
    window.ghost.activeSession?.().then(setActiveId).catch(() => {})
    window.ghost.browserTarget?.get().then(setBrowserTarget).catch(() => {})
  }, [])

  // Keyboard: Shift+Tab cycles autonomy mode; Ctrl/Cmd+N starts a new chat.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        setMode((m) => {
          const ids = MODES.map((x) => x.id)
          return ids[(ids.indexOf(m) + 1) % ids.length]
        })
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Find the index of the last message belonging to a given request.
  const lastIndexFor = (list, reqId) => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].reqId === reqId) return i
    return -1
  }

  useEffect(() => {
    // Streamed assistant text — routed to ITS request's bubble so parallel tasks never mix.
    const offDelta = window.ghost.onDelta(({ requestId, text }) => {
      setMessages((prev) => {
        const i = lastIndexFor(prev, requestId)
        if (i >= 0 && prev[i].role === 'assistant') {
          const next = [...prev]
          next[i] = { ...next[i], content: next[i].content + text }
          return next
        }
        // First text, or text resuming after a tool card — start a fresh bubble for this task.
        return [...prev, { role: 'assistant', content: text, reqId: requestId }]
      })
    })

    // Tool activity — tagged with its request so it sits in the right track.
    const offTool = window.ghost.onTool((ev) => {
      setMessages((prev) => {
        if (ev.kind === 'tool_use') {
          return [
            ...prev,
            { role: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running', startedAt: Date.now(), reqId: ev.requestId }
          ]
        }
        if (ev.kind === 'tool_result') {
          return prev.map((m) =>
            m.role === 'tool' && m.id === ev.id
              ? {
                  ...m,
                  output: ev.output,
                  image: ev.image,
                  isError: ev.isError,
                  status: 'done',
                  durationMs: m.startedAt ? Date.now() - m.startedAt : null
                }
              : m
          )
        }
        return prev
      })
    })

    const offDone = window.ghost.onDone(({ requestId }) => {
      setRunning((prev) => {
        const n = { ...prev }
        delete n[requestId]
        return n
      })
      refreshSessions() // a new/updated session may now have a title
      // Speak this task's finished reply aloud if voice output is on.
      if (voiceOutRef.current) {
        setMessages((prev) => {
          const reply = [...prev].reverse().find((m) => m.role === 'assistant' && m.reqId === requestId && !m.error)
          if (reply?.content) window.ghost.voice?.speak(reply.content)
          return prev
        })
      }
    })

    const offError = window.ghost.onError(({ requestId, message }) => {
      setMessages((prev) => {
        const i = lastIndexFor(prev, requestId)
        if (i >= 0 && prev[i].role === 'assistant') {
          const next = [...prev]
          next[i] = { ...next[i], content: next[i].content + `\n\n⚠️ ${message}`, error: true }
          return next
        }
        return [...prev, { role: 'assistant', content: `⚠️ ${message}`, error: true, reqId: requestId }]
      })
      setRunning((prev) => {
        const n = { ...prev }
        delete n[requestId]
        return n
      })
    })

    return () => {
      offDelta()
      offTool()
      offDone()
      offError()
    }
  }, [])

  // Keep the mute button in sync if the setting is toggled elsewhere.
  useEffect(() => onMuteChange(setMutedState), [])

  // Live terminals: track the session list for the dock + toolbar badge.
  useEffect(() => {
    window.ghost.shell
      ?.list()
      .then((l) => setShellSessions(l || []))
      .catch(() => {})
    return window.ghost.shell?.onSessions((l) => setShellSessions(l || []))
  }, [])

  // Pop the terminal open the first time Ghost (or you) spins one up, so you can watch it work.
  useEffect(() => {
    const n = shellSessions.length
    if (prevShellCount.current === 0 && n > 0) setTermOpen(true)
    prevShellCount.current = n
  }, [shellSessions])

  // Right-click "Ask Ghost about this" in Chrome pushes a task up here — run it.
  useEffect(() => window.ghost.onExternalTask?.(({ prompt }) => prompt && sendRef.current?.(prompt)), [])

  // Mirror the transcript into Chrome's side panel while mirroring is on. Throttled so a fast
  // token stream doesn't flood the bridge — the panel just needs to keep up, not be frame-perfect.
  useEffect(() => {
    if (!mirror) return
    const id = setTimeout(() => {
      const snap = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
        .map(({ role, content }) => ({ role, content }))
      window.ghost.mirrorChat?.(snap, true)
    }, 200)
    return () => clearTimeout(id)
  }, [messages, mirror])

  function changeMirror(on) {
    setMirror(on)
    if (on) {
      const snap = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
        .map(({ role, content }) => ({ role, content }))
      window.ghost.mirrorChat?.(snap, true)
    } else {
      window.ghost.mirrorChat?.([], false) // tell the panel the mirror is off
    }
  }

  function toggleVoiceOut() {
    setVoiceOut((on) => {
      const next = !on
      voiceOutRef.current = next
      if (!next) window.ghost.voice?.stopSpeaking()
      return next
    })
  }

  function stopTask(reqId) {
    window.ghost.abort(reqId)
    setRunning((prev) => {
      const n = { ...prev }
      delete n[reqId]
      return n
    })
  }

  function stopAll() {
    Object.keys(running).forEach((id) => window.ghost.abort(id))
    setRunning({})
    setQueue([]) // also drop anything waiting in the queue
  }

  function removeFromQueue(idx) {
    setQueue((q) => q.filter((_, i) => i !== idx))
  }

  async function newChat() {
    stopAll()
    window.ghost.voice?.stopSpeaking()
    const id = await window.ghost.newSession()
    setActiveId(id)
    setMessages([])
    refreshSessions()
  }

  // Branch a sub-chat nested under an existing chat, and switch to it.
  async function newSubChat(parentId) {
    stopAll()
    window.ghost.voice?.stopSpeaking()
    const id = await window.ghost.newSession(parentId)
    setActiveId(id)
    setMessages([])
    refreshSessions()
  }

  async function selectSession(id) {
    stopAll() // stop in-flight tasks so their stream doesn't bleed into the other chat
    window.ghost.voice?.stopSpeaking()
    await window.ghost.setActiveSession(id)
    const msgs = await window.ghost.sessionMessages(id)
    setMessages(msgs.map((m) => ({ role: m.role, content: m.content })))
    setActiveId(id)
  }

  async function clearAllChats() {
    stopAll()
    window.ghost.voice?.stopSpeaking()
    const newId = await window.ghost.deleteAllSessions()
    setActiveId(newId)
    setMessages([])
    refreshSessions()
  }

  async function removeSession(id) {
    if (id === activeId) stopAll()
    setSessions((prev) => prev.filter((s) => s.id !== id)) // optimistic — the row vanishes instantly
    await window.ghost.deleteSession?.(id)
    if (id === activeId) {
      setMessages([])
      const newId = await window.ghost.newSession()
      setActiveId(newId)
    }
    refreshSessions()
  }

  // Push a small dim "system note" into the transcript (used to confirm / commands).
  function note(content) {
    setMessages((prev) => [...prev, { role: 'system', content }])
  }

  // Handle a "/" command locally (model / effort / thinking / mode / voice). Returns true if the
  // text was a command and therefore should NOT be sent to the agent.
  function runCommand(text) {
    if (!text.startsWith('/')) return false
    const [cmd, ...rest] = text.slice(1).split(/\s+/)
    const arg = rest.join(' ').trim().toLowerCase()
    const c = (cmd || '').toLowerCase()
    const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
    switch (c) {
      case 'model':
        if (!arg) note(`Model is ${agent.model || 'sonnet (default)'}. Usage: /model sonnet | opus | haiku`)
        else { setAgent((a) => ({ ...a, model: arg })); note(`✓ Model → ${arg}`) }
        return true
      case 'effort':
        if (!EFFORTS.includes(arg)) note('Usage: /effort low | medium | high | xhigh | max')
        else { setAgent((a) => ({ ...a, effort: arg })); note(`✓ Effort → ${arg}`) }
        return true
      case 'thinking':
        if (!['on', 'off', 'adaptive'].includes(arg)) note('Usage: /thinking off | adaptive')
        else { setAgent((a) => ({ ...a, thinking: arg === 'on' ? 'adaptive' : arg })); note(`✓ Thinking → ${arg}`) }
        return true
      case 'fast':
        setAgent((a) => ({ ...a, effort: 'low', thinking: 'off' }))
        note('⚡ Fast mode — effort low, thinking off')
        return true
      case 'smart':
      case 'thorough':
        setAgent((a) => ({ ...a, effort: 'high', thinking: 'adaptive' }))
        note('🧠 Thorough mode — effort high, thinking adaptive')
        return true
      case 'mode':
        if (!['plan', 'auto', 'full'].includes(arg)) note('Usage: /mode plan | auto | full')
        else { setMode(arg); note(`✓ Mode → ${arg}`) }
        return true
      case 'voice':
        if (arg !== 'on' && arg !== 'off') note('Usage: /voice on | off')
        else {
          const on = arg === 'on'
          setVoiceOut(on)
          voiceOutRef.current = on
          if (!on) window.ghost.voice?.stopSpeaking()
          note(`✓ Spoken replies → ${arg}`)
        }
        return true
      case 'tab':
        if (!['own', 'current', 'active', 'group'].includes(arg)) note('Usage: /tab own | current')
        else {
          const t = arg === 'current' || arg === 'active' ? 'active' : 'group'
          window.ghost.browserTarget?.set(t)
          setBrowserTarget(t)
          note(`✓ Browser acts on ${t === 'active' ? 'your current tab' : 'its own tab'}`)
        }
        return true
      case 'mirror':
        if (arg !== 'on' && arg !== 'off') note('Usage: /mirror on | off')
        else { changeMirror(arg === 'on'); note(`✓ Chrome side-panel mirror → ${arg}`) }
        return true
      case 'site': {
        const [sub, ...sr] = arg.split(/\s+/)
        const val = sr.join(' ').trim()
        window.ghost.sites?.get().then((pol) => {
          if (sub === 'open' || sub === 'strict') window.ghost.sites.set({ ...pol, mode: sub }).then(() => note(`✓ Site access → ${sub}`))
          else if (sub === 'allow' && val) window.ghost.sites.set({ ...pol, allow: [...pol.allow, val] }).then(() => note(`✓ Allowed ${val}`))
          else if (sub === 'block' && val) window.ghost.sites.set({ ...pol, block: [...pol.block, val] }).then(() => note(`✓ Blocked ${val}`))
          else if (sub === 'list') note(`Site access: ${pol.mode} · allow [${pol.allow.join(', ') || '—'}] · block [${pol.block.join(', ') || '—'}]`)
          else note('Usage: /site open|strict · /site allow <domain> · /site block <domain> · /site list')
        })
        return true
      }
      case 'hotkey':
      case 'shortcut':
        window.ghost.hotkey?.get().then((h) => {
          const show = (h?.accelerator || '').replace(/CommandOrControl/g, 'Ctrl').split('+').join(' + ') || '—'
          note(`Wake-up shortcut is ${show}. Record a new one in Settings (⚙) → Wake-up shortcut.`)
        })
        return true
      case 'settings':
        setSettingsOpen(true)
        return true
      case 'new':
        newChat()
        return true
      case 'status':
        note(`model ${agent.model || 'sonnet'} · effort ${agent.effort || 'low'} · thinking ${agent.thinking || 'adaptive'} · mode ${mode}`)
        return true
      case 'help':
        note('/model · /effort low…max · /thinking off|adaptive · /fast · /smart · /mode plan|auto|full · /voice on|off · /tab own|current · /mirror on|off · /site … · /hotkey · /settings · /status · /new')
        return true
      default:
        note(`Unknown command "/${c}". Try /help`)
        return true
    }
  }

  // Send a prompt to the agent NOW. History is the conversation so far (each task runs sequentially,
  // so by the time we dispatch, prior replies are already in `messages` as context).
  function dispatch(t) {
    playActivate() // swell as the Core powers up for this task
    window.ghost.voice?.stopSpeaking()
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map(({ role, content }) => ({ role, content }))
    history.push({ role: 'user', content: t })
    const reqId = window.ghost.sendMessage(history, mode, agent)
    setMessages((prev) => [...prev, { role: 'user', content: t, reqId }])
    setRunning({ [reqId]: { prompt: t, startedAt: Date.now() } }) // exactly one task at a time
  }

  // One task runs at a time. If something's already running (or queued), this message waits its turn.
  function send(text) {
    const t = text.trim()
    if (!t) return
    if (runCommand(t)) return // a "/" command — handled locally, nothing goes to the agent
    if (Object.keys(running).length > 0 || queue.length > 0) setQueue((q) => [...q, t])
    else dispatch(t)
  }
  sendRef.current = send

  // Drain the queue: whenever nothing is running and prompts are waiting, fire the next one.
  useEffect(() => {
    if (Object.keys(running).length > 0 || queue.length === 0) return
    const next = queue[0]
    setQueue((q) => q.slice(1))
    dispatch(next)
  }, [running, queue])

  const modeInfo = MODES.find((m) => m.id === mode) || MODES[1]
  const runningIds = new Set(Object.keys(running))
  const tools = messages.filter((m) => m.role === 'tool') // fed to the Mission Control activity panel

  return (
    <div className="main fade-in">
      <SessionSidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={selectSession}
        onNew={newChat}
        onNewSub={newSubChat}
        onDelete={removeSession}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
      />
      <div className="chat-pane">
        <header className="topbar">
          <div className="topbar-drag" title="Drag to move window">
            <span className="brand">
              <span className="brand-mark" aria-hidden="true" />
              GHOST<span className="brand-accent">-PRIME</span>
            </span>
            <span className="brand-version" title={`Version ${GHOST_VERSION} · built ${GHOST_BUILD}`}>
              v{GHOST_VERSION}
              {GHOST_BUILD ? ` · ${GHOST_BUILD}` : ''}
            </span>
          </div>
          <div className="topbar-right">
            <span className="mode" title={`${modeInfo.hint}  ·  Shift+Tab to switch`}>
              <span className={`mode-dot ${mode}`} />
              {modeInfo.label}
              <span className="mode-hint">⇧⇥</span>
            </span>
            <button
              type="button"
              className={`voice-toggle ${voiceOut ? 'on' : ''}`}
              onClick={toggleVoiceOut}
              disabled={!ttsOk}
              title={
                ttsOk
                  ? voiceOut
                    ? 'Spoken replies: ON'
                    : 'Spoken replies: OFF'
                  : 'Voice output unavailable (no TTS engine)'
              }
            >
              {voiceOut ? '🔊' : '🔇'}
            </button>
            <button
              type="button"
              className={`voice-toggle ${muted ? '' : 'on'}`}
              onClick={() => setMutedState(toggleMuted())}
              title={muted ? 'Sound muted (intro + sfx) — click to unmute' : 'Sound on (intro + sfx) — click to mute'}
              aria-label="Toggle app sound"
            >
              🎵
            </button>
            <button
              type="button"
              className={`voice-toggle ${mirror ? 'on' : ''}`}
              onClick={() => changeMirror(!mirror)}
              title={mirror ? 'Chat mirrors to Chrome side panel: ON' : 'Mirror chat to Chrome side panel'}
              aria-label="Mirror chat to Chrome"
            >
              ⧉
            </button>
            <button
              type="button"
              className={`voice-toggle ${settingsOpen ? 'on' : ''}`}
              onClick={() => setSettingsOpen((o) => !o)}
              title="Settings — browser tab, mirror, site access"
              aria-label="Settings"
            >
              ⚙
            </button>
            <button
              type="button"
              className={`voice-toggle term-toggle ${termOpen ? 'on' : ''}`}
              onClick={() => setTermOpen((o) => !o)}
              title={termOpen ? 'Hide terminal' : 'Show terminal'}
              aria-label="Toggle terminal"
            >
              {'>_'}
              {shellSessions.some((s) => s.alive) && <span className="term-badge" />}
            </button>
            <button
              type="button"
              className={`voice-toggle ${activityOpen ? 'on' : ''}`}
              onClick={() => setActivityOpen((o) => !o)}
              title={activityOpen ? 'Hide activity panel' : 'Show activity panel'}
              aria-label="Toggle activity panel"
            >
              ◨
            </button>
            <span className={`status ${busy ? 'status-busy' : ''}`}>
              {busy ? `working…${queue.length ? ` +${queue.length} queued` : ''}` : queue.length ? `${queue.length} queued` : 'ready'}
            </span>
            {!window.ghost.platform?.nativeFrame && (
              <div className="win-controls">
                <button
                  className="win-btn"
                  onClick={() => window.ghost.windowControls?.minimize()}
                  title="Minimize"
                  aria-label="Minimize"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11">
                    <line x1="1.5" y1="6" x2="9.5" y2="6" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                </button>
                <button
                  className="win-btn"
                  onClick={() => window.ghost.windowControls?.maximize()}
                  title="Maximize"
                  aria-label="Maximize"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11">
                    <rect x="1.7" y="1.7" width="7.6" height="7.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                </button>
                <button
                  className="win-btn win-close"
                  onClick={() => window.ghost.windowControls?.close()}
                  title="Close"
                  aria-label="Close"
                >
                  <svg width="11" height="11" viewBox="0 0 11 11">
                    <line x1="2.2" y1="2.2" x2="8.8" y2="8.8" stroke="currentColor" strokeWidth="1.3" />
                    <line x1="8.8" y1="2.2" x2="2.2" y2="8.8" stroke="currentColor" strokeWidth="1.3" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </header>
        {settingsOpen && (
          <SettingsPanel
            onClose={() => setSettingsOpen(false)}
            mirror={mirror}
            onMirrorChange={changeMirror}
            onChatsCleared={clearAllChats}
          />
        )}
        <MessageList messages={messages} onExample={send} runningIds={runningIds} />
        {termOpen && <TerminalPanel sessions={shellSessions} onClose={() => setTermOpen(false)} />}
        <ChatInput onSend={send} busy={busy} />
      </div>
      {activityOpen && (
        <ActivityPanel
          running={running}
          queue={queue}
          tools={tools}
          mode={mode}
          agent={agent}
          browserTarget={browserTarget}
          onStopTask={stopTask}
          onRemoveQueued={removeFromQueue}
          onStopAll={stopAll}
          onClose={() => setActivityOpen(false)}
        />
      )}
    </div>
  )
}
