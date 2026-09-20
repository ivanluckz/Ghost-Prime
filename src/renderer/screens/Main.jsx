import { useEffect, useRef, useState } from 'react'
import MessageList from '../components/chat/MessageList.jsx'
import ChatInput from '../components/chat/ChatInput.jsx'
import SessionSidebar from '../components/SessionSidebar.jsx'
import SettingsPanel from '../components/SettingsPanel.jsx'
import ActivityPanel from '../components/ActivityPanel.jsx'
import TerminalPanel from '../components/TerminalPanel.jsx'
import { playActivate, isMuted, toggleMuted, onMuteChange } from '../audio.js'
import { initAccent } from '../theme.js'

// Build identity, injected by electron.vite.config.js — shown in the topbar so it's obvious which
// build is live (the stamp changes every rebuild). typeof guard keeps it safe if not defined.
const GHOST_VERSION = typeof __GHOST_VERSION__ !== 'undefined' ? __GHOST_VERSION__ : '0.0.0'
const GHOST_BUILD = typeof __GHOST_BUILD__ !== 'undefined' ? __GHOST_BUILD__ : ''

const pick = (a) => a[Math.floor(Math.random() * a.length)]

// Files you can drop into the chat. Text-like files are inlined into the message (works with any
// brain); images are sent to the vision model. Others are declined with a note.
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|cc|hpp|cs|php|sh|bash|zsh|sql|toml|ini|cfg|conf|env|gitignore|dockerfile|makefile|svg|vue|svelte|astro)$/i
const MAX_TEXT_BYTES = 120 * 1024 // 120 KB of inlined text per file
const MAX_IMG_BYTES = 6 * 1024 * 1024 // 6 MB per image

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
  const [attachments, setAttachments] = useState([]) // dropped files pending on the next message
  const [dragOver, setDragOver] = useState(false) // show the drop overlay while a file is over the window
  const [dropNote, setDropNote] = useState('') // transient message about a rejected/too-big drop
  const [brainByReq, setBrainByReq] = useState({}) // reqId -> 'gemini' | 'claude' (which brain answered)
  const prevShellCount = useRef(0)
  const voiceOutRef = useRef(false)
  const sendRef = useRef(null) // latest send(), so externally-pushed tasks avoid a stale closure
  const newChatRef = useRef(null) // latest newChat(), so the global key handler avoids a stale closure
  const runningRef = useRef({}) // mirrors `running` (assigned during render) so stopAll is closure-proof
  // Per-request reply text, kept outside React state: onDone fires in the same tick as the last
  // delta, before React has rendered it, so reading `messages` there would miss the final chunk.
  const replyTextRef = useRef({})
  const dragDepth = useRef(0) // nested dragenter/dragleave depth — dragleave fires on children too
  const ackedRef = useRef(new Set()) // reqIds we've already spoken an instant "on it" for

  // A short, tool-aware "instant acknowledgment" spoken the moment a task reaches for a tool, so
  // there's no silent wait while it works. The finished reply is spoken separately afterwards.
  const ackFor = (name = '') => {
    if (name.includes('browser')) return pick(['On it — checking that now.', 'Let me pull that up.', 'Looking now.'])
    if (name.includes('shell')) return pick(['On it — running that.', 'Working on it.', 'Give me a second.'])
    if (name.includes('file') || name.includes('undo')) return pick(['On it — handling those files.', 'Working on it.'])
    if (name.includes('reminder')) return 'Setting that up.'
    if (name.includes('memory')) return 'One sec.'
    return pick(['On it.', 'Working on it.', 'Give me a moment.', 'Let me take care of that.'])
  }

  const busy = Object.keys(running).length > 0
  const refreshSessions = () => window.ghost.recentSessions().then(setSessions).catch(() => {})

  // Apply the saved accent theme as early as possible.
  useEffect(() => initAccent(), [])

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
        newChatRef.current?.()
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
      replyTextRef.current[requestId] = (replyTextRef.current[requestId] || '') + text
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
      // Router telling us which brain is handling this turn — record it, render nothing.
      if (ev.kind === 'brain') {
        if (ev.requestId) setBrainByReq((prev) => ({ ...prev, [ev.requestId]: ev.brain }))
        return
      }
      // Agent runs are serialized globally (one at a time across the desktop and Discord). Say so
      // when this task has to wait for one that came in from elsewhere, e.g. a phone message.
      if (ev.kind === 'queued') {
        const who = ev.behind === 'discord' ? 'a task from Discord' : 'another task'
        setMessages((prev) => [...prev, { role: 'system', content: `⏳ Waiting — ${who} is running; this starts when it finishes.`, reqId: ev.requestId }])
        return
      }
      // Instant acknowledgment: speak once, the first time a task uses a tool (if voice is on).
      if (ev.kind === 'tool_use' && voiceOutRef.current && ev.requestId && !ackedRef.current.has(ev.requestId)) {
        ackedRef.current.add(ev.requestId)
        window.ghost.voice?.speak(ackFor(ev.name || ''))
      }
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

    // Any tool still spinning for this request will never get a tool_result — close it out.
    const settleTools = (requestId, label) =>
      setMessages((prev) =>
        prev.some((m) => m.role === 'tool' && m.reqId === requestId && m.status === 'running')
          ? prev.map((m) =>
              m.role === 'tool' && m.reqId === requestId && m.status === 'running'
                ? { ...m, status: 'done', isError: true, output: m.output || label, durationMs: m.startedAt ? Date.now() - m.startedAt : null }
                : m
            )
          : prev
      )

    const offDone = window.ghost.onDone(({ requestId, aborted }) => {
      settleTools(requestId, aborted ? 'stopped' : 'no result')
      ackedRef.current.delete(requestId)
      setRunning((prev) => {
        const n = { ...prev }
        delete n[requestId]
        return n
      })
      refreshSessions() // a new/updated session may now have a title
      // Speak this task's finished reply aloud if voice output is on — not a reply the user just stopped.
      const reply = replyTextRef.current[requestId]
      delete replyTextRef.current[requestId]
      if (voiceOutRef.current && !aborted && reply) window.ghost.voice?.speak(reply)
    })

    const offError = window.ghost.onError(({ requestId, message }) => {
      settleTools(requestId, 'failed: ' + message)
      setMessages((prev) => {
        const i = lastIndexFor(prev, requestId)
        if (i >= 0 && prev[i].role === 'assistant') {
          const next = [...prev]
          next[i] = { ...next[i], content: next[i].content + `\n\n⚠️ ${message}`, error: true }
          return next
        }
        return [...prev, { role: 'assistant', content: `⚠️ ${message}`, error: true, reqId: requestId }]
      })
      ackedRef.current.delete(requestId)
      delete replyTextRef.current[requestId]
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

  // A drag cancelled/leaving the window never fires drop; also reset the overlay when focus leaves.
  useEffect(() => {
    const onBlur = () => {
      dragDepth.current = 0
      setDragOver(false)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

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

  // Pushes from main: right-click "Ask Ghost about this" in Chrome / the wake daemon (external tasks),
  // proactive lines (morning briefing / idle check-ins) and reminders — drop them into the chat as
  // they arrive, and speak them if voice output is on. Main buffers these until we say ui:ready, so
  // subscribe first, then announce readiness (order matters: the flush must not race the listeners).
  useEffect(() => {
    const offT = window.ghost.onExternalTask?.(({ prompt }) => prompt && sendRef.current?.(prompt))
    const offP = window.ghost.onProactive?.(({ text, kind }) => {
      if (!text) return
      setMessages((prev) => [...prev, { role: 'assistant', content: text, proactive: kind || 'checkin', reqId: `proactive_${Date.now()}` }])
      if (voiceOutRef.current) window.ghost.voice?.speak(text)
    })
    const offR = window.ghost.onReminder?.(({ text }) => {
      if (!text) return
      playActivate()
      setMessages((prev) => [...prev, { role: 'system', content: `⏰ Reminder: ${text}` }])
      if (voiceOutRef.current) window.ghost.voice?.speak(`Reminder: ${text}`)
    })
    window.ghost.uiReady?.()
    return () => {
      offT?.()
      offP?.()
      offR?.()
    }
  }, [])

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
    Object.keys(runningRef.current).forEach((id) => window.ghost.abort(id))
    setRunning({})
    setQueue([]) // also drop anything waiting in the queue
  }

  function removeFromQueue(idx) {
    setQueue((q) => q.filter((_, i) => i !== idx))
  }

  async function newChat() {
    stopAll()
    window.ghost.voice?.stopSpeaking()
    // If sqlite failed to open, newSession resolves null / rejects — still clear the pane so
    // Ctrl+N / New chat always gives a fresh screen.
    const id = await window.ghost.newSession().catch(() => null)
    setActiveId(id)
    setMessages([])
    refreshSessions()
  }

  // Branch a sub-chat nested under an existing chat, and switch to it.
  async function newSubChat(parentId) {
    stopAll()
    window.ghost.voice?.stopSpeaking()
    const id = await window.ghost.newSession(parentId).catch(() => null) // no-DB: still clear the pane
    setActiveId(id)
    setMessages([])
    refreshSessions()
  }

  async function selectSession(id) {
    stopAll() // stop in-flight tasks so their stream doesn't bleed into the other chat
    window.ghost.voice?.stopSpeaking()
    await window.ghost.setActiveSession(id)
    const msgs = await window.ghost.sessionMessages(id)
    // Rows carry `modelContent` when a turn had attachments: the bubble shows the display text,
    // the brain keeps getting the inlined file / image on every later turn, exactly as live.
    setMessages(msgs.map((m) => ({ role: m.role, content: m.content, ...(m.modelContent != null ? { modelContent: m.modelContent } : {}) })))
    setActiveId(id)
  }

  async function clearAllChats() {
    stopAll()
    window.ghost.voice?.stopSpeaking()
    const newId = await window.ghost.deleteAllSessions().catch(() => null) // no-DB: still clear the pane
    setActiveId(newId)
    setMessages([])
    refreshSessions()
  }

  async function removeSession(id) {
    const wasActive = id === activeId
    if (wasActive) stopAll()
    setSessions((prev) => prev.filter((s) => s.id !== id)) // optimistic — the row vanishes instantly
    await window.ghost.deleteSession?.(id)
    // The delete removes the whole subtree; if the active chat was inside it (the row itself OR a
    // nested sub-chat), main has dropped its current session, so start a fresh one.
    const stillActive = await window.ghost.activeSession?.().catch(() => null)
    if (wasActive || !stillActive) {
      if (!wasActive) stopAll()
      window.ghost.voice?.stopSpeaking()
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
      case 'brain':
        if (!['auto', 'gemini', 'claude'].includes(arg))
          note(`Brain is ${agent.brain || 'auto'}. Usage: /brain auto | gemini | claude  (auto = cheap Gemini for simple asks, Claude for hard/long ones)`)
        else { setAgent((a) => ({ ...a, brain: arg })); note(`✓ Brain → ${arg}${arg === 'auto' ? ' (routing by task)' : ''}`) }
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
        note('/model · /brain auto|gemini|claude · /effort low…max · /thinking off|adaptive · /fast · /smart · /mode plan|auto|full · /voice on|off · /tab own|current · /mirror on|off · /site … · /hotkey · /settings · /status · /new')
        return true
      default:
        note(`Unknown command "/${c}". Try /help`)
        return true
    }
  }

  // Send a prompt to the agent NOW. History is the conversation so far (each task runs sequentially,
  // so by the time we dispatch, prior replies are already in `messages` as context).
  // --- Dropped-file attachments ------------------------------------------
  const readText = (file) =>
    new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result || '').slice(0, MAX_TEXT_BYTES))
      r.onerror = () => resolve('')
      r.readAsText(file)
    })
  const readDataUrl = (file) =>
    new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result || ''))
      r.onerror = () => resolve('')
      r.readAsDataURL(file)
    })

  async function addFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    const added = []
    let rejected = 0
    for (const f of files) {
      const isImg = f.type.startsWith('image/')
      const isText = f.type.startsWith('text/') || TEXT_EXT.test(f.name)
      if (isImg) {
        if (f.size > MAX_IMG_BYTES) { rejected++; continue }
        added.push({ id: `att_${Date.now()}_${added.length}`, kind: 'image', name: f.name, size: f.size, dataUrl: await readDataUrl(f) })
      } else if (isText) {
        added.push({ id: `att_${Date.now()}_${added.length}`, kind: 'text', name: f.name, size: f.size, text: await readText(f) })
      } else {
        rejected++
      }
    }
    if (added.length) setAttachments((prev) => [...prev, ...added])
    if (rejected) {
      setDropNote(`${rejected} file(s) skipped — only text/code files and images are supported.`)
      setTimeout(() => setDropNote(''), 4000)
    }
  }
  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id))
  function onDrop(e) {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files)
  }

  // t = what the chat shows (text + 📎 chips); modelContent = what the brain gets (inlined text
  // files / image parts), kept on the message so EVERY later turn's history still carries the
  // attachment — both brains are stateless per turn and rebuild context from this list.
  function dispatch(t, modelContent) {
    playActivate() // swell as the Core powers up for this task
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map(({ role, content, modelContent: mc }) => ({
        role,
        content: typeof content === 'string' ? content : String(content),
        ...(mc != null && mc !== content ? { modelContent: mc } : {})
      }))
    const rich = modelContent != null && modelContent !== t
    history.push({ role: 'user', content: t, ...(rich ? { modelContent } : {}) }) // model may receive rich (array) content
    const reqId = window.ghost.sendMessage(history, mode, agent)
    setMessages((prev) => [...prev, { role: 'user', content: t, reqId, ...(rich ? { modelContent } : {}) }]) // chat shows the display string
    setRunning({ [reqId]: { prompt: t, startedAt: Date.now() } }) // exactly one task at a time
  }

  // One task runs at a time. If something's already running (or queued), this message waits its turn.
  function send(text) {
    const t = (text || '').trim()
    if (!t && attachments.length === 0) return
    if (t && runCommand(t)) return // a "/" command — handled locally, nothing goes to the agent

    const textFiles = attachments.filter((a) => a.kind === 'text')
    const imgs = attachments.filter((a) => a.kind === 'image')
    // Text files are inlined so any brain can read them; images ride along as vision content.
    let modelText = t
    for (const f of textFiles) modelText += `\n\n[Attached file: ${f.name}]\n\`\`\`\n${f.text}\n\`\`\``
    const display = t + (attachments.length ? (t ? '\n' : '') + attachments.map((a) => `📎 ${a.name}`).join('   ') : '')
    setAttachments([])

    const busy = Object.keys(running).length > 0 || queue.length > 0
    if (imgs.length && !busy) {
      const modelContent = [
        { type: 'text', text: modelText || 'Look at the attached image(s).' },
        ...imgs.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }))
      ]
      dispatch(display, modelContent)
    } else if (busy) {
      setQueue((q) => [...q, modelText + (imgs.length ? '\n(note: dropped images weren’t queued — resend when idle)' : '')])
    } else {
      dispatch(display || modelText, modelText)
    }
  }
  sendRef.current = send
  newChatRef.current = newChat
  runningRef.current = running

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
    <div
      className="main fade-in"
      onDragEnter={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">⬇ Drop files to attach — text &amp; code inline, images sent to vision</div>
        </div>
      )}
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
              <span className="brand-word">GHOST</span>
              <span className="brand-accent">-PRIME</span>
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
        <MessageList messages={messages} onExample={send} runningIds={runningIds} brainByReq={brainByReq} />
        {termOpen && <TerminalPanel sessions={shellSessions} onClose={() => setTermOpen(false)} />}
        {dropNote && <div className="drop-note">{dropNote}</div>}
        {attachments.length > 0 && (
          <div className="attach-row">
            {attachments.map((a) => (
              <span className={`attach-chip ${a.kind}`} key={a.id} title={a.name}>
                {a.kind === 'image' ? (
                  <img className="attach-thumb" src={a.dataUrl} alt="" />
                ) : (
                  <span className="attach-ico">📄</span>
                )}
                <span className="attach-name">{a.name}</span>
                <button className="attach-del" onClick={() => removeAttachment(a.id)} aria-label={`Remove ${a.name}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <ChatInput onSend={send} busy={busy} hasAttachments={attachments.length > 0} />
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
