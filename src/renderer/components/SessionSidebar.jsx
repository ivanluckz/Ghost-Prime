import { useState } from 'react'

function fmtTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function SessionSidebar({ sessions, activeId, onSelect, onNew, onNewSub, onDelete, collapsed, onToggle }) {
  const [confirmId, setConfirmId] = useState(null)
  const [collapsedIds, setCollapsedIds] = useState(() => new Set()) // parent ids whose sub-chats are hidden

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

  function toggleCollapse(e, id) {
    e.stopPropagation()
    setCollapsedIds((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  function addSub(e, id) {
    e.stopPropagation()
    setCollapsedIds((prev) => {
      // make sure the parent is expanded so the new sub-chat is visible
      if (!prev.has(id)) return prev
      const n = new Set(prev)
      n.delete(id)
      return n
    })
    onNewSub?.(id)
  }

  // Build a parent→children tree from the flat list. A session whose parent isn't in the list
  // (e.g. trimmed by the query limit) is treated as a root so it never disappears.
  const ids = new Set(sessions.map((s) => s.id))
  const childrenOf = new Map()
  const roots = []
  for (const s of sessions) {
    if (s.parent_id && ids.has(s.parent_id)) {
      if (!childrenOf.has(s.parent_id)) childrenOf.set(s.parent_id, [])
      childrenOf.get(s.parent_id).push(s)
    } else {
      roots.push(s)
    }
  }

  function renderRow(s, depth) {
    const kids = childrenOf.get(s.id) || []
    const isCollapsed = collapsedIds.has(s.id)
    return (
      <div key={s.id} className="session-branch">
        <div className="session-row" style={depth ? { paddingLeft: Math.min(depth, 4) * 13 } : undefined}>
          {kids.length > 0 ? (
            <button className="session-twisty" onClick={(e) => toggleCollapse(e, s.id)} title={isCollapsed ? 'Expand' : 'Collapse'}>
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="session-twisty-spacer" />
          )}
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
          <button className="session-sub" onClick={(e) => addSub(e, s.id)} title="New sub-chat under this" aria-label="New sub-chat">
            +
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
        {kids.length > 0 && !isCollapsed && kids.map((k) => renderRow(k, depth + 1))}
      </div>
    )
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
          {roots.map((s) => renderRow(s, 0))}
        </div>
      )}
    </aside>
  )
}
