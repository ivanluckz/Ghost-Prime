import Markdown from './Markdown.jsx'

export default function Message({ role, content, error, streaming }) {
  const isUser = role === 'user'
  const useMarkdown = role === 'assistant' && !error && content
  return (
    <div className={`msg msg-${role}${error ? ' msg-error' : ''}${streaming ? ' msg-streaming' : ''}`}>
      <div className="msg-role">{isUser ? 'you' : 'ghost'}</div>
      <div className="msg-content">
        {useMarkdown ? <Markdown text={content} /> : content || (role === 'assistant' ? '…' : '')}
      </div>
    </div>
  )
}
