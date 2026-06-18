import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import Database from 'better-sqlite3'

let db = null
let currentSessionId = null

export function initDb(appRoot = app.getAppPath()) {
  const dbPath = join(app.getPath('userData'), 'ghost.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  // Run every migration in order (001, 002, …). All are idempotent.
  const dir = join(appRoot, 'migrations')
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(dir, file), 'utf8'))
  }

  // Columns added after a table's first migration (SQLite has no ADD COLUMN IF NOT EXISTS).
  const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)
  if (!hasCol('sessions', 'parent_id')) db.exec('ALTER TABLE sessions ADD COLUMN parent_id TEXT') // nested sub-chats
  return db
}

// --- Sessions ------------------------------------------------------------
// parentId nests this chat under another as a "sub-chat" (shown indented in the sidebar).
export function startSession(parentId = null) {
  currentSessionId = randomUUID()
  db.prepare('INSERT INTO sessions (id, started_at, parent_id) VALUES (?, ?, ?)').run(
    currentSessionId,
    Date.now(),
    parentId || null
  )
  return currentSessionId
}

export const newSession = startSession

export function setActiveSession(id) {
  currentSessionId = id
  return id
}

export function getSessionId() {
  return currentSessionId
}

// Sessions for the sidebar, titled by their first user line. We keep any chat that has messages,
// any sub-chat (has a parent — shown even while empty, so a freshly-branched thread appears at
// once), and the ancestors of those so the tree always has its parent rows to hang under.
export function recentSessions(limit = 40) {
  const rows = db
    .prepare(
      `SELECT s.id,
              s.started_at,
              s.parent_id,
              COUNT(m.id) AS message_count,
              (SELECT content FROM messages
                 WHERE session_id = s.id AND role = 'user'
                 ORDER BY created_at ASC LIMIT 1) AS title
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.started_at DESC`
    )
    .all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const keep = new Set()
  for (const r of rows) if (r.message_count > 0 || r.parent_id) keep.add(r.id)
  // Pull in ancestors of kept rows so every sub-chat has its parent header present.
  for (const id of [...keep]) {
    let p = byId.get(id)?.parent_id
    while (p && byId.has(p) && !keep.has(p)) {
      keep.add(p)
      p = byId.get(p).parent_id
    }
  }
  return rows.filter((r) => keep.has(r.id)).slice(0, limit)
}

// Delete a chat AND its nested sub-chats (their messages + session rows). Remembered facts
// (memories) are cross-session and deliberately kept. Returns true if anything was removed.
export function deleteSession(id) {
  if (!db || !id) return false
  // Collect the whole subtree (id + every descendant sub-chat).
  const subtree = []
  const stack = [id]
  const childrenStmt = db.prepare('SELECT id FROM sessions WHERE parent_id = ?')
  while (stack.length) {
    const cur = stack.pop()
    subtree.push(cur)
    for (const r of childrenStmt.all(cur)) stack.push(r.id)
  }
  const tx = db.transaction(() => {
    const delMsg = db.prepare('DELETE FROM messages WHERE session_id = ?')
    const delSes = db.prepare('DELETE FROM sessions WHERE id = ?')
    let changes = 0
    for (const sid of subtree) {
      delMsg.run(sid)
      changes += delSes.run(sid).changes
    }
    return changes
  })
  const removed = tx()
  if (subtree.includes(currentSessionId)) currentSessionId = null // caller should start a fresh session
  return removed > 0
}

// Wipe ALL chats (every message + session) and start a fresh empty one. Memories are kept —
// clearing those is a separate, explicit action. Returns the new active session id.
export function deleteAllSessions() {
  if (!db) return null
  db.transaction(() => {
    db.prepare('DELETE FROM messages').run()
    db.prepare('DELETE FROM sessions').run()
  })()
  currentSessionId = null
  return startSession()
}

// --- Messages ------------------------------------------------------------
export function saveMessage(role, content) {
  if (!db || !currentSessionId || !content) return
  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(randomUUID(), currentSessionId, role, content, Date.now())
}

export function sessionMessages(sessionId) {
  if (!db) return []
  return db
    .prepare('SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId)
}

// --- Memory (cross-session facts the agent chooses to remember) -----------
export function saveMemory(content, type = 'fact', importance = 5) {
  if (!db || !content) return null
  const id = randomUUID()
  db.prepare(
    'INSERT INTO memories (id, session_id, type, content, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, currentSessionId, type, content, importance, Date.now())
  return id
}

export function recallMemories(query, limit = 8) {
  if (!db) return []
  let rows
  if (query && query.trim()) {
    // Keyword match (no embeddings yet); fall back to most-important if nothing matches.
    rows = db
      .prepare(
        'SELECT id, type, content, importance, created_at FROM memories WHERE content LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?'
      )
      .all(`%${query.trim()}%`, limit)
    if (rows.length === 0) rows = memoryDigest(limit)
  } else {
    rows = memoryDigest(limit)
  }
  if (rows.length) {
    const now = Date.now()
    const upd = db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?')
    db.transaction((ids) => ids.forEach((id) => upd.run(now, id)))(rows.map((r) => r.id).filter(Boolean))
  }
  return rows
}

// Compact, highest-signal memories — used both for recall fallback and for
// auto-injecting context into the agent's system prompt.
export function memoryDigest(limit = 8) {
  if (!db) return []
  return db
    .prepare('SELECT id, type, content, importance, created_at FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?')
    .all(limit)
}

export function allMemories(limit = 200) {
  if (!db) return []
  return db
    .prepare('SELECT id, type, content, importance, created_at FROM memories ORDER BY created_at DESC LIMIT ?')
    .all(limit)
}

// Forget everything the agent has remembered across sessions. Returns how many facts were removed.
export function clearAllMemory() {
  if (!db) return 0
  return db.prepare('DELETE FROM memories').run().changes
}
