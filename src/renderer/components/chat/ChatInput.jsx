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

// `hasAttachments` lets an attachment-only message go out (Main.send substitutes a default prompt).
export default function ChatInput({ onSend, busy, hasAttachments = false }) {
  const [value, setValue] = useState('')
  const [voiceState, setVoiceState] = useState('idle') // idle | listening | transcribing
  const taRef = useRef(null)

  // Global hotkey (Ctrl/Cmd+Shift+G) summons the window and lands the cursor right here.
  useEffect(() => window.ghost.onFocusInput?.(() => taRef.current?.focus()), [])

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
      else if (res?.error) console.error('[voice]', res.error)
    } finally {
      setVoiceState('idle')
    }
  }

  const placeholder =
    voiceState === 'listening'
      ? 'Listening… tap the mic to send'
      : voiceState === 'transcribing'
        ? 'Transcribing…'
        : busy
          ? 'Busy — your message will queue and run next (Enter to send)'
          : 'Message Ghost-Prime…   (Enter to send, Shift+Enter for newline, / for commands)'

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
      <button
        type="button"
        className={`btn btn-mic mic-${voiceState}`}
        onClick={toggleMic}
        disabled={voiceState === 'transcribing'}
        title="Voice input (local Whisper / Gemini)"
        aria-label="Voice input"
      >
        {voiceState === 'transcribing' ? '…' : '🎙'}
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
        Send
      </button>
    </form>
  )
}
