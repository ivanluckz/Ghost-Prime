import { useState } from 'react'

function fmtTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// Line icons (16px grid, 1.5 stroke, currentColor) — one family with the topbar and composer.
const svg = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
const IconPanel = ({ open }) => (
  <svg {...svg}>
    <rect x="2" y="2.75" width="12" height="10.5" rx="2.25" />
    <path d="M6.25 2.75v10.5" />
    {open ? <path d="M11 6.5 9.5 8l1.5 1.5" /> : <path d="M9.5 6.5 11 8l-1.5 1.5" />}
  </svg>
)
const IconPlus = () => (
  <svg {...svg}>
    <path d="M8 3.25v9.5M3.25 8h9.5" />
  </svg>
)
// "Branch off" — a sub-chat hangs under its parent.
const IconBranch = () => (
  <svg {...svg}>
    <path d="M4.5 3v4.5a2.5 2.5 0 0 0 2.5 2.5h5.5" />
    <path d="M10.25 7.75 12.5 10l-2.25 2.25" />
  </svg>
)
const IconX = () => (
  <svg {...svg} width={14} height={14}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </svg>
)
const IconChevron = () => (
  <svg {...svg} width={12} height={12} strokeWidth={1.75}>
    <path d="m6 4 4 4-4 4" />
  </svg>
)
const IconChats = () => (
  <svg {...svg} width={22} height={22} strokeWidth={1.25}>
    <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.25V11h.5" />
  </svg>
)

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
  // Root rows only reserve a disclosure column when at least one root actually has sub-chats.
  const anyNested = roots.some((s) => childrenOf.has(s.id))

  function renderRow(s, depth) {
    const kids = childrenOf.get(s.id) || []
    const isCollapsed = collapsedIds.has(s.id)
    const n = s.message_count || 0
    return (
      <div key={s.id} className="session-branch">
        <div className={`session-row${s.id === activeId ? ' is-active' : ''}`}>
          {kids.length > 0 ? (
            <button
              className={`session-twisty${isCollapsed ? '' : ' open'}`}
              onClick={(e) => toggleCollapse(e, s.id)}
              title={isCollapsed ? 'Expand' : 'Collapse'}
              aria-expanded={!isCollapsed}
            >
              <IconChevron />
            </button>
          ) : (
            (depth > 0 || anyNested) && <span className="session-twisty-spacer" />
          )}
          <button
            className={`session-item${s.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(s.id)}
            title={s.title || 'Untitled chat'}
          >
            <span className="session-title">{s.title || 'Untitled chat'}</span>
            <span className="session-meta">
              {fmtTime(s.started_at)} · {n} {n === 1 ? 'msg' : 'msgs'}
              {kids.length > 0 && isCollapsed && <span className="session-kids"> · {kids.length} sub</span>}
            </span>
          </button>
          <span className="session-actions">
            <button className="session-sub" onClick={(e) => addSub(e, s.id)} title="New sub-chat under this" aria-label="New sub-chat">
              <IconBranch />
            </button>
            <button
              className={`session-del${confirmId === s.id ? ' confirming' : ''}`}
              onClick={(e) => clickDelete(e, s.id)}
              title={confirmId === s.id ? 'Click again to delete' : 'Delete chat'}
              aria-label="Delete chat"
            >
              {confirmId === s.id ? 'Delete?' : <IconX />}
            </button>
          </span>
        </div>
        {kids.length > 0 && !isCollapsed && (
          <div className="session-children">{kids.map((k) => renderRow(k, depth + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-head">
        <button
          className="sidebar-collapse"
          onClick={onToggle}
          title={collapsed ? 'Show history' : 'Hide history'}
          aria-label={collapsed ? 'Show history' : 'Hide history'}
        >
          <IconPanel open={!collapsed} />
        </button>
        {!collapsed && (
          <button className="btn-new" onClick={onNew} title="Start a new chat (Ctrl+N)">
            <IconPlus />
            <span className="btn-new-label">New chat</span>
            <kbd className="btn-new-kbd">Ctrl N</kbd>
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="sidebar-list">
          {sessions.length === 0 && (
            <div className="sidebar-empty">
              <IconChats />
              <span className="sidebar-empty-title">No saved chats yet</span>
              <span className="sidebar-empty-sub">Conversations you start will show up here.</span>
            </div>
          )}
          {roots.map((s) => renderRow(s, 0))}
        </div>
      )}
    </aside>
  )
}
