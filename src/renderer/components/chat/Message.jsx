import Markdown from './Markdown.jsx'

export default function Message({ role, content, error, streaming, accent, brain }) {
  const isUser = role === 'user'
  const useMarkdown = role === 'assistant' && !error && content
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
        {useMarkdown ? <Markdown text={content} /> : content || (role === 'assistant' ? '…' : '')}
      </div>
    </div>
  )
}
