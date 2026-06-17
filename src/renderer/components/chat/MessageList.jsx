import { useEffect, useRef } from 'react'
import Message from './Message.jsx'
import ToolCard from '../tools/ToolCard.jsx'

const EXAMPLES = [
  { icon: '❯', text: 'What files are in my home directory?' },
  { icon: '◉', text: 'Open example.com and tell me what it says' },
  { icon: '⌕', text: "Search the web for today's top AI story" },
  { icon: '✦', text: 'Remember that I prefer concise answers' }
]

export default function MessageList({ messages, onExample, runningIds }) {
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const isLive = (m) => !!(m.reqId && runningIds?.has(m.reqId))

  return (
    <div className="messages">
      {messages.length === 0 && (
        <div className="empty">
          <div className="hero-orb" aria-hidden="true">
            <span className="orb-halo" />
            <span className="orb-ring orb-ring-1" />
            <span className="orb-ring orb-ring-2" />
            <span className="orb-ring orb-ring-3" />
            <span className="orb-core" />
            <span className="orb-glyph">◇</span>
          </div>
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
      {messages.map((m, i) =>
        m.role === 'tool' ? (
          <ToolCard
            key={m.id || i}
            name={m.name}
            input={m.input}
            output={m.output}
            image={m.image}
            status={m.status}
            isError={m.isError}
            durationMs={m.durationMs}
          />
        ) : m.role === 'system' ? (
          <div key={i} className="sys-note">
            {m.content}
          </div>
        ) : (
          <Message key={i} role={m.role} content={m.content} error={m.error} streaming={isLive(m)} />
        )
      )}
      <div ref={endRef} />
    </div>
  )
}
