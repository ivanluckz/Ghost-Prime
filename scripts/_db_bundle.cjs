var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/memory/db.js
var db_exports = {};
__export(db_exports, {
  addReminder: () => addReminder,
  allMemories: () => allMemories,
  cancelReminder: () => cancelReminder,
  clearAllMemory: () => clearAllMemory,
  deleteAllSessions: () => deleteAllSessions,
  deleteMemory: () => deleteMemory,
  deleteSession: () => deleteSession,
  dueReminders: () => dueReminders,
  getPref: () => getPref,
  getRunContext: () => getRunContext,
  getSessionId: () => getSessionId,
  initDb: () => initDb,
  markReminderFired: () => markReminderFired,
  markSessionSummarized: () => markSessionSummarized,
  memoryDigest: () => memoryDigest,
  newSession: () => newSession,
  onReminderFired: () => onReminderFired,
  pendingReminders: () => pendingReminders,
  recallMemories: () => recallMemories,
  recentSessions: () => recentSessions,
  saveMemory: () => saveMemory,
  saveMessage: () => saveMessage,
  sessionMessages: () => sessionMessages,
  sessionSummaryMemories: () => sessionSummaryMemories,
  sessionSummaryState: () => sessionSummaryState,
  setActiveSession: () => setActiveSession,
  setPref: () => setPref,
  setRunContext: () => setRunContext,
  startSession: () => startSession
});
module.exports = __toCommonJS(db_exports);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var import_node_crypto = require("node:crypto");
var import_electron = require("electron");
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var db = null;
var currentSessionId = null;
function initDb(appRoot = import_electron.app.getAppPath()) {
  const dbPath = (0, import_node_path.join)(import_electron.app.getPath("userData"), "ghost.db");
  db = new import_better_sqlite3.default(dbPath);
  db.pragma("journal_mode = WAL");
  const dir = (0, import_node_path.join)(appRoot, "migrations");
  for (const file of (0, import_node_fs.readdirSync)(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec((0, import_node_fs.readFileSync)((0, import_node_path.join)(dir, file), "utf8"));
  }
  const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!hasCol("sessions", "parent_id")) db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  if (!hasCol("memories", "tags")) db.exec("ALTER TABLE memories ADD COLUMN tags TEXT");
  if (!hasCol("memories", "expires_at")) db.exec("ALTER TABLE memories ADD COLUMN expires_at INTEGER");
  if (!hasCol("sessions", "summarized_at")) db.exec("ALTER TABLE sessions ADD COLUMN summarized_at INTEGER");
  if (!hasCol("sessions", "summary_count")) db.exec("ALTER TABLE sessions ADD COLUMN summary_count INTEGER");
  if (!hasCol("reminders", "origin")) db.exec("ALTER TABLE reminders ADD COLUMN origin TEXT");
  if (!hasCol("messages", "model_content")) db.exec("ALTER TABLE messages ADD COLUMN model_content TEXT");
  db.prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now());
  return db;
}
var NOT_EXPIRED = "(expires_at IS NULL OR expires_at > ?)";
function wrapTags(tags) {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const clean = list.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  return clean.length ? "," + clean.join(",") + "," : null;
}
function unwrapTags(s) {
  return s ? s.split(",").filter(Boolean) : [];
}
function startSession(parentId = null) {
  if (!db) return null;
  currentSessionId = (0, import_node_crypto.randomUUID)();
  db.prepare("INSERT INTO sessions (id, started_at, parent_id) VALUES (?, ?, ?)").run(
    currentSessionId,
    Date.now(),
    parentId || null
  );
  return currentSessionId;
}
var newSession = startSession;
function setActiveSession(id) {
  currentSessionId = id;
  return id;
}
function getSessionId() {
  return currentSessionId;
}
function recentSessions(limit = 40) {
  if (!db) return [];
  const rows = db.prepare(
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
  ).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keep = /* @__PURE__ */ new Set();
  for (const r of rows) if (r.message_count > 0 || r.parent_id) keep.add(r.id);
  for (const id of [...keep]) {
    let p = byId.get(id)?.parent_id;
    while (p && byId.has(p) && !keep.has(p)) {
      keep.add(p);
      p = byId.get(p).parent_id;
    }
  }
  return rows.filter((r) => keep.has(r.id)).slice(0, limit);
}
function deleteSession(id) {
  if (!db || !id) return false;
  const subtree = [];
  const stack = [id];
  const childrenStmt = db.prepare("SELECT id FROM sessions WHERE parent_id = ?");
  while (stack.length) {
    const cur = stack.pop();
    subtree.push(cur);
    for (const r of childrenStmt.all(cur)) stack.push(r.id);
  }
  const tx = db.transaction(() => {
    const delMsg = db.prepare("DELETE FROM messages WHERE session_id = ?");
    const delSes = db.prepare("DELETE FROM sessions WHERE id = ?");
    let changes = 0;
    for (const sid of subtree) {
      delMsg.run(sid);
      changes += delSes.run(sid).changes;
    }
    return changes;
  });
  const removed = tx();
  if (subtree.includes(currentSessionId)) currentSessionId = null;
  return removed > 0;
}
function deleteAllSessions() {
  if (!db) return null;
  db.transaction(() => {
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM sessions").run();
  })();
  currentSessionId = null;
  return startSession();
}
function saveMessage(role, content, opts = {}) {
  const sessionId = opts.sessionId ?? currentSessionId;
  if (!db || !sessionId || !content) return false;
  if (!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) return false;
  const mc = opts.modelContent;
  const modelJson = mc != null && mc !== content ? JSON.stringify(mc) : null;
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, model_content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run((0, import_node_crypto.randomUUID)(), sessionId, role, content, modelJson, Date.now());
  return true;
}
function sessionMessages(sessionId) {
  if (!db) return [];
  return db.prepare("SELECT role, content, model_content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId).map(({ model_content, ...row }) => {
    if (model_content == null) return row;
    try {
      return { ...row, modelContent: JSON.parse(model_content) };
    } catch {
      return row;
    }
  });
}
function sessionSummaryState(sessionId) {
  if (!db || !sessionId) return { messageCount: 0, summarizedAt: null, summaryCount: 0 };
  const s = db.prepare("SELECT summarized_at, summary_count FROM sessions WHERE id = ?").get(sessionId);
  const c = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?").get(sessionId);
  return { messageCount: c?.n || 0, summarizedAt: s?.summarized_at || null, summaryCount: s?.summary_count || 0 };
}
function markSessionSummarized(sessionId, messageCount) {
  if (!db || !sessionId) return;
  db.prepare("UPDATE sessions SET summarized_at = ?, summary_count = ? WHERE id = ?").run(Date.now(), messageCount || 0, sessionId);
}
function sessionSummaryMemories(sessionId) {
  if (!db || !sessionId) return [];
  return db.prepare(
    `SELECT content FROM memories WHERE session_id = ? AND tags LIKE '%,session-summary,%' AND ${NOT_EXPIRED} ORDER BY created_at ASC`
  ).all(sessionId, Date.now()).map((r) => r.content);
}
function saveMemory(content, type = "fact", importance = 5, opts = {}) {
  if (!db || !content) return null;
  const id = (0, import_node_crypto.randomUUID)();
  db.prepare(
    "INSERT INTO memories (id, session_id, type, content, importance, created_at, tags, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, opts.sessionId || currentSessionId, type, content, importance, Date.now(), wrapTags(opts.tags), opts.expiresAt || null);
  return id;
}
var MEM_COLS = "id, type, content, importance, created_at, tags, expires_at";
var withTags = (r) => ({ ...r, tags: unwrapTags(r.tags) });
function recallMemories(query, limit = 8, opts = {}) {
  if (!db) return [];
  const now = Date.now();
  const where = [NOT_EXPIRED];
  const params = [now];
  const q = query && query.trim();
  if (q) {
    where.push("content LIKE ?");
    params.push(`%${q}%`);
  }
  if (opts.tag && String(opts.tag).trim()) {
    where.push("tags LIKE ?");
    params.push(`%,${String(opts.tag).trim().toLowerCase()},%`);
  }
  let rows = db.prepare(
    `SELECT ${MEM_COLS} FROM memories WHERE ${where.join(" AND ")} ORDER BY importance DESC, created_at DESC LIMIT ?`
  ).all(...params, limit);
  if (rows.length === 0 && (q || opts.tag)) rows = memoryDigest(limit);
  if (rows.length) {
    const upd = db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?");
    db.transaction((ids) => ids.forEach((id) => upd.run(now, id)))(rows.map((r) => r.id).filter(Boolean));
  }
  return rows.map(withTags);
}
function memoryDigest(limit = 8) {
  if (!db) return [];
  return db.prepare(`SELECT ${MEM_COLS} FROM memories WHERE ${NOT_EXPIRED} ORDER BY importance DESC, created_at DESC LIMIT ?`).all(Date.now(), limit).map(withTags);
}
function allMemories(limit = 200) {
  if (!db) return [];
  return db.prepare(`SELECT ${MEM_COLS} FROM memories WHERE ${NOT_EXPIRED} ORDER BY created_at DESC LIMIT ?`).all(Date.now(), limit).map(withTags);
}
function clearAllMemory() {
  if (!db) return 0;
  return db.prepare("DELETE FROM memories").run().changes;
}
function getPref(key, fallback = null) {
  if (!db) return fallback;
  const row = db.prepare("SELECT value FROM preferences WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
function setPref(key, value) {
  if (!db) return;
  db.prepare(
    "INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, String(value), Date.now());
}
function deleteMemory(id) {
  if (!db || !id) return false;
  return db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}
var activeRunContext = null;
function setRunContext(ctx) {
  activeRunContext = ctx || null;
}
function getRunContext() {
  return activeRunContext;
}
function addReminder(text, dueAt, origin = activeRunContext?.origin ?? null) {
  if (!db || !text || !dueAt) return null;
  const id = (0, import_node_crypto.randomUUID)();
  db.prepare("INSERT INTO reminders (id, text, due_at, created_at, fired, origin) VALUES (?, ?, ?, ?, 0, ?)").run(
    id,
    String(text),
    dueAt,
    Date.now(),
    origin ? String(origin) : null
  );
  return id;
}
function dueReminders(now = Date.now()) {
  if (!db) return [];
  return db.prepare("SELECT id, text, due_at, origin FROM reminders WHERE fired = 0 AND due_at <= ? ORDER BY due_at ASC").all(now);
}
function pendingReminders() {
  if (!db) return [];
  return db.prepare("SELECT id, text, due_at, origin FROM reminders WHERE fired = 0 ORDER BY due_at ASC").all();
}
var reminderFiredListeners = /* @__PURE__ */ new Set();
function onReminderFired(listener) {
  if (typeof listener !== "function") return () => {
  };
  reminderFiredListeners.add(listener);
  return () => reminderFiredListeners.delete(listener);
}
function markReminderFired(id) {
  if (!db || !id) return;
  const row = db.prepare("SELECT id, text, due_at, origin FROM reminders WHERE id = ? AND fired = 0").get(id);
  db.prepare("UPDATE reminders SET fired = 1 WHERE id = ?").run(id);
  if (!row) return;
  for (const fn of reminderFiredListeners) {
    try {
      fn(row);
    } catch {
    }
  }
}
function cancelReminder(id) {
  if (!db || !id) return false;
  return db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes > 0;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  addReminder,
  allMemories,
  cancelReminder,
  clearAllMemory,
  deleteAllSessions,
  deleteMemory,
  deleteSession,
  dueReminders,
  getPref,
  getRunContext,
  getSessionId,
  initDb,
  markReminderFired,
  markSessionSummarized,
  memoryDigest,
  newSession,
  onReminderFired,
  pendingReminders,
  recallMemories,
  recentSessions,
  saveMemory,
  saveMessage,
  sessionMessages,
  sessionSummaryMemories,
  sessionSummaryState,
  setActiveSession,
  setPref,
  setRunContext,
  startSession
});
