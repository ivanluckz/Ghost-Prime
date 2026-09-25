import { useEffect, useRef } from 'react'
import Message from './Message.jsx'
import ToolCard from '../tools/ToolCard.jsx'
import GhostCore from '../GhostCore.jsx'

// Start-screen suggestions: the rehearsed showcase demos (showcase/demo/DEMO.md), all safe to click
// in front of an audience. Nothing here lists personal folders or reads private data aloud.
const EXAMPLES = [
  { icon: '◉', text: 'Go to Wikipedia and explain photosynthesis in three simple sentences' },
  { icon: '❯', text: 'How much free space is left on this Chromebook?' },
  { icon: '⏰', text: 'Remind me in two minutes to drink some water' },
  { icon: '✦', text: 'Remember that I like short, simple answers' }
]

export default function MessageList({ messages, onExample, runningIds, trackColor, brainByReq }) {
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
        if (m.role === 'tool') {
          const card = (
            <ToolCard
              key={accent ? undefined : m.id || i}
              name={m.name}
              input={m.input}
              output={m.output}
              image={m.image}
              status={m.status}
              isError={m.isError}
              durationMs={m.durationMs}
            />
          )
          // Untracked cards are direct children of the thread, so consecutive calls join into one
          // panel (tools.css); a parallel-task card keeps its coloured track wrapper.
          return accent ? (
            <div key={m.id || i} className="track-wrap" style={{ borderLeftColor: accent }}>
              {card}
            </div>
          ) : (
            card
          )
        }
        return m.role === 'system' ? (
          <div key={i} className="sys-note">
            {m.content}
          </div>
        ) : (
          <Message
            key={i}
            role={m.role}
            content={m.content}
            error={m.error}
            streaming={isLive(m)}
            accent={accent}
            brain={m.role === 'assistant' && m.reqId ? brainByReq?.[m.reqId] : null}
          />
        )
      })}
      <div ref={endRef} />
    </div>
  )
}
