import { useState, useRef, useEffect } from 'react'

const COMMANDS = [
  ['/fast', 'snappiest — effort low, no thinking'],
  ['/smart', 'most thorough — effort high + thinking'],
  ['/model', 'sonnet | opus | haiku'],
  ['/brain', 'auto | gemini | claude — which brain answers'],
  ['/effort', 'low | medium | high | xhigh | max'],
  ['/thinking', 'off | adaptive'],
  ['/mode', 'plan | auto | full'],
  ['/voice', 'on | off'],
  ['/showcase', 'on | off — big-text presenter mode'],
  ['/tab', 'own | current — which tab Ghost drives'],
  ['/mirror', 'on | off — chat in Chrome side panel'],
  ['/site', 'open|strict · allow|block <domain> · list'],
  ['/settings', 'open the settings panel'],
  ['/status', 'show current settings'],
  ['/hotkey', 'show the wake-up shortcut'],
  ['/new', 'start a new chat'],
  ['/help', 'list commands']
]
const NEEDS_ARG = ['/model', '/brain', '/effort', '/thinking', '/mode', '/voice', '/tab', '/mirror', '/site']

// Line icons in the same 16px family as the topbar / sidebar.
const svg = { width: 18, height: 18, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
const IconMic = () => (
  <svg {...svg}>
    <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25" />
  </svg>
)
const IconSend = () => (
  <svg {...svg} width={16} height={16} strokeWidth={1.75}>
    <path d="M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" />
  </svg>
)

// Why voice input failed, in words a presenter can act on (the raw reason stays in the console).
export function voiceProblem(error) {
  const e = String(error || '').toLowerCase()
  if (!e || /nothing heard|no-speech|aborted/.test(e)) return "I didn't catch anything. Try again a little closer to the mic, or type it."
  if (/not recording/.test(e)) return 'The mic was not recording. Click the mic, speak, then click it again.'
  if (/429|quota|rate.?limit|resource.?exhausted|too many/.test(e)) return 'The free speech service is busy right now. Try again in a minute, or type it.'
  if (/network|fetch|enotfound|eai_again|econn|etimedout|offline|socket|unreachable/.test(e))
    return "I couldn't reach the speech service. Check the internet, or type it."
  if (/arecord|audio|capture|device|no such file|enoent|permission|not-allowed|microphone/.test(e))
    return "I couldn't use the microphone. Check that Linux may use the mic (ChromeOS Settings → Developers → Linux), or type it."
  return "Voice didn't work that time. Try again, or type it."
}

// `hasAttachments` lets an attachment-only message go out (Main.send substitutes a default prompt).
export default function ChatInput({ onSend, busy, hasAttachments = false }) {
  const [value, setValue] = useState('')
  const [voiceState, setVoiceState] = useState('idle') // idle | listening | transcribing
  const [voiceNote, setVoiceNote] = useState('') // a failed / empty recording, shown for a few seconds
  const noteTimer = useRef(null)
  const taRef = useRef(null)

  const showVoiceNote = (text) => {
    clearTimeout(noteTimer.current)
    setVoiceNote(text)
    noteTimer.current = setTimeout(() => setVoiceNote(''), 6000)
  }
  useEffect(() => () => clearTimeout(noteTimer.current), [])

  // Global hotkey (Ctrl/Cmd+Shift+G) summons the window and lands the cursor right here.
  useEffect(() => window.ghost.onFocusInput?.(() => taRef.current?.focus()), [])
  // Grow with the text (one line by default, up to the CSS max-height) instead of scrolling inside
  // a fixed two-line box.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    // Empty: back to the CSS one-line height. Measuring now would count a long placeholder ("Busy —
    // your message will queue…") that wraps in a narrow composer, and the box stayed two lines tall.
    if (!value) {
      ta.style.height = ''
      ta.style.overflowY = 'hidden'
      return
    }
    ta.style.height = 'auto'
    const max = parseFloat(getComputedStyle(ta).maxHeight) || 170
    const h = ta.scrollHeight + 2 // + top/bottom border (scrollHeight excludes them)
    ta.style.height = `${Math.min(h, max)}px`
    ta.style.overflowY = h > max ? 'auto' : 'hidden'
  }, [value])

  const canSend = !!value.trim() || hasAttachments

  // Send is never blocked: a message sent while a task is running is queued and runs next.
  function submit(e) {
    e.preventDefault()
    if (!canSend) return
    onSend(value)
    setValue('')
  }

  async function toggleMic() {
    if (voiceState === 'transcribing') return
    if (voiceState === 'idle') {
      clearTimeout(noteTimer.current)
      setVoiceNote('')
      setVoiceState('listening')
      window.ghost.voice.listenStart()
      return
    }
    // listening -> stop, transcribe, auto-send
    setVoiceState('transcribing')
    try {
      const res = await window.ghost.voice.listenStop()
      const text = res?.text?.trim()
      if (text) onSend(text)
      else {
        // Never fail silently: the presenter (and the room) need to know to try again or type.
        if (res?.error) console.error('[voice]', res.error)
        showVoiceNote(voiceProblem(res?.error))
      }
    } catch (e) {
      console.error('[voice]', e)
      showVoiceNote(voiceProblem(e?.message || e))
    } finally {
      setVoiceState('idle')
    }
  }

  const placeholder =
    voiceState === 'listening'
      ? 'Listening…'
      : voiceState === 'transcribing'
        ? 'Transcribing…'
        : busy
          ? 'Busy — your message will queue and run next'
          : 'Message Ghost-Prime…'

  const v = value.trim()
  const matches = /^\/[a-z]*$/i.test(v) ? COMMANDS.filter(([c]) => c.startsWith(v.toLowerCase())) : []
  const pick = (c) => {
    setValue(NEEDS_ARG.includes(c) ? c + ' ' : c)
    taRef.current?.focus()
  }

  return (
    <form className="chat-input" onSubmit={submit}>
      {matches.length > 0 && (
        <div className="cmd-menu">
          {matches.map(([c, d]) => (
            <button
              type="button"
              key={c}
              className="cmd-item"
              onMouseDown={(e) => {
                e.preventDefault()
                pick(c)
              }}
            >
              <span className="cmd-name">{c}</span>
              <span className="cmd-desc">{d}</span>
            </button>
          ))}
        </div>
      )}
      {/* Voice state, big enough to read from across the room; floats above the composer. */}
      {(voiceState !== 'idle' || voiceNote) && (
        <div className={`voice-banner voice-banner-${voiceState !== 'idle' ? voiceState : 'note'}`} role="status" aria-live="polite">
          {voiceState === 'listening' ? (
            <>
              <span className="voice-banner-dot" aria-hidden="true" />
              Listening… click the mic again to send
            </>
          ) : voiceState === 'transcribing' ? (
            <>
              <span className="tool-spinner" aria-hidden="true" />
              Turning your speech into text…
            </>
          ) : (
            voiceNote
          )}
        </div>
      )}
      {/* One composer surface: mic, text and Send share a single glass box (focus ring included). */}
      <div className={`composer composer-${voiceState}`}>
        <button
          type="button"
          className={`btn btn-mic mic-${voiceState}`}
          onClick={toggleMic}
          disabled={voiceState === 'transcribing'}
          title="Voice input (local Whisper / Gemini)"
          aria-label="Voice input"
        >
          {voiceState === 'transcribing' ? <span className="mic-dots" aria-hidden="true">…</span> : <IconMic />}
        </button>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter during IME composition (CJK, dead keys) confirms the candidate — never sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing && e.keyCode !== 229) submit(e)
          }}
          placeholder={placeholder}
          rows={1}
        />
        <button type="submit" className="btn btn-send" disabled={!canSend}>
          <IconSend />
          <span className="btn-send-label">Send</span>
        </button>
      </div>
      <div className="input-hint" aria-hidden="true">
        <span><kbd>Enter</kbd> send</span>
        <span><kbd>Shift</kbd>+<kbd>Enter</kbd> newline</span>
        <span><kbd>/</kbd> commands</span>
        <span><kbd>Shift</kbd>+<kbd>Tab</kbd> mode</span>
      </div>
    </form>
  )
}
