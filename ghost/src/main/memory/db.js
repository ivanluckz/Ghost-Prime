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
  if (!hasCol('memories', 'tags')) db.exec('ALTER TABLE memories ADD COLUMN tags TEXT') // ,a,b, wrapped
  if (!hasCol('memories', 'expires_at')) db.exec('ALTER TABLE memories ADD COLUMN expires_at INTEGER') // ms epoch, nullable
  // Session auto-summary bookkeeping: when a chat was last distilled into memory, and at what
  // message count — so we only re-summarize a chat once it has grown enough new messages.
  if (!hasCol('sessions', 'summarized_at')) db.exec('ALTER TABLE sessions ADD COLUMN summarized_at INTEGER')
  if (!hasCol('sessions', 'summary_count')) db.exec('ALTER TABLE sessions ADD COLUMN summary_count INTEGER')

  // Drop memories that have expired since last run.
  db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now())
  return db
}

// Tags are stored wrapped in commas (",work,billing,") so a single LIKE '%,tag,%' matches one tag.
const NOT_EXPIRED = '(expires_at IS NULL OR expires_at > ?)'
function wrapTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : []
  const clean = list.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
  return clean.length ? ',' + clean.join(',') + ',' : null
}
function unwrapTags(s) {
  return s ? s.split(',').filter(Boolean) : []
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

// --- Session auto-summary bookkeeping ------------------------------------
// State used to decide whether a chat is worth (re)distilling into memory.
export function sessionSummaryState(sessionId) {
  if (!db || !sessionId) return { messageCount: 0, summarizedAt: null, summaryCount: 0 }
  const s = db.prepare('SELECT summarized_at, summary_count FROM sessions WHERE id = ?').get(sessionId)
  const c = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId)
  return { messageCount: c?.n || 0, summarizedAt: s?.summarized_at || null, summaryCount: s?.summary_count || 0 }
}

// Mark a chat as distilled at a given message count, so we don't redo it until it grows.
export function markSessionSummarized(sessionId, messageCount) {
  if (!db || !sessionId) return
  db.prepare('UPDATE sessions SET summarized_at = ?, summary_count = ? WHERE id = ?').run(Date.now(), messageCount || 0, sessionId)
}

// Facts already saved from this chat — handed to the summarizer so it only adds NEW ones.
export function sessionSummaryMemories(sessionId) {
  if (!db || !sessionId) return []
  return db
    .prepare(
      `SELECT content FROM memories WHERE session_id = ? AND tags LIKE '%,session-summary,%' AND ${NOT_EXPIRED} ORDER BY created_at ASC`
    )
    .all(sessionId, Date.now())
    .map((r) => r.content)
}

// --- Memory (cross-session facts the agent chooses to remember) -----------
// opts: { tags: string[]|csv, expiresAt: msEpoch, sessionId } — expiresAt auto-forgets after a
// time; sessionId attributes the memory to a specific chat (defaults to the active session).
export function saveMemory(content, type = 'fact', importance = 5, opts = {}) {
  if (!db || !content) return null
  const id = randomUUID()
  db.prepare(
    'INSERT INTO memories (id, session_id, type, content, importance, created_at, tags, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, opts.sessionId || currentSessionId, type, content, importance, Date.now(), wrapTags(opts.tags), opts.expiresAt || null)
  return id
}

const MEM_COLS = 'id, type, content, importance, created_at, tags, expires_at'
const withTags = (r) => ({ ...r, tags: unwrapTags(r.tags) })

// query = keyword (LIKE on content); opts.tag filters to memories carrying that tag. Expired rows are
// always excluded. Falls back to the digest when a query matches nothing.
export function recallMemories(query, limit = 8, opts = {}) {
  if (!db) return []
  const now = Date.now()
  const where = [NOT_EXPIRED]
  const params = [now]
  const q = query && query.trim()
  if (q) {
    where.push('content LIKE ?')
    params.push(`%${q}%`)
  }
  if (opts.tag && String(opts.tag).trim()) {
    where.push('tags LIKE ?')
    params.push(`%,${String(opts.tag).trim().toLowerCase()},%`)
  }
  let rows = db
    .prepare(
      `SELECT ${MEM_COLS} FROM memories WHERE ${where.join(' AND ')} ORDER BY importance DESC, created_at DESC LIMIT ?`
    )
    .all(...params, limit)
  if (rows.length === 0 && (q || opts.tag)) rows = memoryDigest(limit)
  if (rows.length) {
    const upd = db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?')
    db.transaction((ids) => ids.forEach((id) => upd.run(now, id)))(rows.map((r) => r.id).filter(Boolean))
  }
  return rows.map(withTags)
}

// Compact, highest-signal (non-expired) memories — used for recall fallback and for
// auto-injecting context into the agent's system prompt.
export function memoryDigest(limit = 8) {
  if (!db) return []
  return db
    .prepare(`SELECT ${MEM_COLS} FROM memories WHERE ${NOT_EXPIRED} ORDER BY importance DESC, created_at DESC LIMIT ?`)
    .all(Date.now(), limit)
    .map(withTags)
}

export function allMemories(limit = 200) {
  if (!db) return []
  return db
    .prepare(`SELECT ${MEM_COLS} FROM memories WHERE ${NOT_EXPIRED} ORDER BY created_at DESC LIMIT ?`)
    .all(Date.now(), limit)
    .map(withTags)
}

// Forget everything the agent has remembered across sessions. Returns how many facts were removed.
export function clearAllMemory() {
  if (!db) return 0
  return db.prepare('DELETE FROM memories').run().changes
}
