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
  return db
}

// --- Sessions ------------------------------------------------------------
export function startSession() {
  currentSessionId = randomUUID()
  db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run(currentSessionId, Date.now())
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

// Only sessions that actually contain messages, titled by their first user line.
export function recentSessions(limit = 40) {
  return db
    .prepare(
      `SELECT s.id,
              s.started_at,
              COUNT(m.id) AS message_count,
              (SELECT content FROM messages
                 WHERE session_id = s.id AND role = 'user'
                 ORDER BY created_at ASC LIMIT 1) AS title
         FROM sessions s
         JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.started_at DESC
        LIMIT ?`
    )
    .all(limit)
}

// Delete a chat: its messages and the session row. Remembered facts (memories)
// are cross-session and deliberately kept. Returns true if anything was removed.
export function deleteSession(id) {
  if (!db || !id) return false
  const tx = db.transaction((sid) => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid)
    return db.prepare('DELETE FROM sessions WHERE id = ?').run(sid).changes
  })
  const removed = tx(id)
  if (currentSessionId === id) currentSessionId = null // caller should start a fresh session
  return removed > 0
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
