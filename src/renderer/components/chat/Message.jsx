import Markdown from './Markdown.jsx'

// Main.jsx appends failures to a reply as "\n\n⚠️ <reason>" (or sends just "⚠️ <reason>").
const WARN = '⚠️ '

// Split a failed reply into the partial answer (still Markdown) and the failure reason, so a
// half-streamed table or code block keeps its formatting instead of collapsing to raw text.
function splitFailure(content) {
  const text = String(content || '')
  const at = text.lastIndexOf(WARN)
  if (at < 0) return { body: '', failure: text }
  return { body: text.slice(0, at).trimEnd(), failure: text.slice(at + WARN.length) }
}

export default function Message({ role, content, error, streaming, accent, brain }) {
  const isUser = role === 'user'
  const { body, failure } = error ? splitFailure(content) : { body: content, failure: null }
  const useMarkdown = role === 'assistant' && body
  return (
    <div
      className={`msg msg-${role}${error ? ' msg-error' : ''}${streaming ? ' msg-streaming' : ''}${accent ? ' msg-tracked' : ''}`}
      style={accent ? { borderLeftColor: accent } : undefined}
    >
      <div className="msg-role">
        {accent && <span className="track-dot" style={{ background: accent }} />}
        {isUser ? 'you' : 'ghost'}
        {!isUser && brain && <span className={`brain-tag brain-${brain}`}>{brain}</span>}
      </div>
      <div className="msg-content">
        {useMarkdown ? <Markdown text={body} /> : failure == null && (content || (role === 'assistant' ? '…' : ''))}
        {failure != null && (
          <div className="msg-failure">
            <span className="msg-failure-icon" aria-hidden="true">
              !
            </span>
            <span className="msg-failure-text">{failure}</span>
          </div>
        )}
      </div>
    </div>
  )
}
