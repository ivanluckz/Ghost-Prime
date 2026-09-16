import { useEffect, useRef } from 'react'
import Message from './Message.jsx'
import ToolCard from '../tools/ToolCard.jsx'
import GhostCore from '../GhostCore.jsx'

const EXAMPLES = [
  { icon: '❯', text: 'What files are in my home directory?' },
  { icon: '◉', text: 'Open example.com and tell me what it says' },
  { icon: '⌕', text: "Search the web for today's top AI story" },
  { icon: '✦', text: 'Remember that I prefer concise answers' }
]

export default function MessageList({ messages, onExample, runningIds, trackColor }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const isLive = (m) => !!(m.reqId && runningIds?.has(m.reqId))

  return (
    <div className="messages">
      {messages.length === 0 && (
        <div className="empty">
          <GhostCore active={false} height={210} quality="high" className="hero-core" />
          <h1 className="empty-title">
            Ask <span className="empty-title-accent">Ghost-Prime</span> anything to begin
          </h1>
          <p className="empty-sub">Your terminal, browser, and memory — one sentence away.</p>
          <div className="empty-examples">
            {EXAMPLES.map((ex, i) => (
              <button
                key={ex.text}
                className="example-chip"
                style={{ animationDelay: `${140 + i * 75}ms` }}
                onClick={() => onExample?.(ex.text)}
              >
                <span className="chip-glyph">{ex.icon}</span>
                <span className="chip-text">{ex.text}</span>
                <span className="chip-go">→</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {messages.map((m, i) => {
        const accent = trackColor?.(m.reqId)
        return m.role === 'tool' ? (
          <div key={m.id || i} className={accent ? 'track-wrap' : undefined} style={accent ? { borderLeftColor: accent } : undefined}>
            <ToolCard
              name={m.name}
              input={m.input}
              output={m.output}
              image={m.image}
              status={m.status}
              isError={m.isError}
              durationMs={m.durationMs}
            />
          </div>
        ) : m.role === 'system' ? (
          <div key={i} className="sys-note">
            {m.content}
          </div>
        ) : (
          <Message key={i} role={m.role} content={m.content} error={m.error} streaming={isLive(m)} accent={accent} />
        )
      })}
      <div ref={endRef} />
    </div>
  )
}
