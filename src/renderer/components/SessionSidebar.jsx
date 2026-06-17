import { useState } from 'react'

function fmtTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function SessionSidebar({ sessions, activeId, onSelect, onNew, onDelete, collapsed, onToggle }) {
  const [confirmId, setConfirmId] = useState(null)

  // Two-step inline confirm — no native confirm() (it's slow/unreliable in a frameless Wayland window).
  function clickDelete(e, id) {
    e.stopPropagation()
    if (confirmId === id) {
      setConfirmId(null)
      onDelete?.(id)
    } else {
      setConfirmId(id)
      setTimeout(() => setConfirmId((c) => (c === id ? null : c)), 3000) // auto-cancel if ignored
    }
  }

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-head">
        <button className="sidebar-collapse" onClick={onToggle} title={collapsed ? 'Show history' : 'Hide history'}>
          {collapsed ? '»' : '«'}
        </button>
        {!collapsed && (
          <button className="btn-new" onClick={onNew} title="Start a new chat (Ctrl+N)">
            + New
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="sidebar-list">
          {sessions.length === 0 && <div className="sidebar-empty">No saved chats yet</div>}
          {sessions.map((s) => (
            <div key={s.id} className="session-row">
              <button
                className={`session-item${s.id === activeId ? ' active' : ''}`}
                onClick={() => onSelect(s.id)}
                title={s.title || 'Untitled chat'}
              >
                <span className="session-title">{s.title || 'Untitled chat'}</span>
                <span className="session-meta">
                  {fmtTime(s.started_at)} · {s.message_count}
                </span>
              </button>
              <button
                className={`session-del${confirmId === s.id ? ' confirming' : ''}`}
                onClick={(e) => clickDelete(e, s.id)}
                title={confirmId === s.id ? 'Click again to delete' : 'Delete chat'}
                aria-label="Delete chat"
              >
                {confirmId === s.id ? (
                  'Delete?'
                ) : (
                  <svg width="13" height="13" viewBox="0 0 13 13">
                    <line x1="3" y1="3" x2="10" y2="10" stroke="currentColor" strokeWidth="1.4" />
                    <line x1="10" y1="3" x2="3" y2="10" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
