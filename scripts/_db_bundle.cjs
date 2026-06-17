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
  allMemories: () => allMemories,
  getSessionId: () => getSessionId,
  initDb: () => initDb,
  memoryDigest: () => memoryDigest,
  newSession: () => newSession,
  recallMemories: () => recallMemories,
  recentSessions: () => recentSessions,
  saveMemory: () => saveMemory,
  saveMessage: () => saveMessage,
  sessionMessages: () => sessionMessages,
  setActiveSession: () => setActiveSession,
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
  return db;
}
function startSession() {
  currentSessionId = (0, import_node_crypto.randomUUID)();
  db.prepare("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(currentSessionId, Date.now());
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
  return db.prepare(
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
  ).all(limit);
}
function saveMessage(role, content) {
  if (!db || !currentSessionId || !content) return;
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run((0, import_node_crypto.randomUUID)(), currentSessionId, role, content, Date.now());
}
function sessionMessages(sessionId) {
  if (!db) return [];
  return db.prepare("SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId);
}
function saveMemory(content, type = "fact", importance = 5) {
  if (!db || !content) return null;
  const id = (0, import_node_crypto.randomUUID)();
  db.prepare(
    "INSERT INTO memories (id, session_id, type, content, importance, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, currentSessionId, type, content, importance, Date.now());
  return id;
}
function recallMemories(query, limit = 8) {
  if (!db) return [];
  let rows;
  if (query && query.trim()) {
    rows = db.prepare(
      "SELECT id, type, content, importance, created_at FROM memories WHERE content LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?"
    ).all(`%${query.trim()}%`, limit);
    if (rows.length === 0) rows = memoryDigest(limit);
  } else {
    rows = memoryDigest(limit);
  }
  if (rows.length) {
    const now = Date.now();
    const upd = db.prepare("UPDATE memories SET last_accessed = ? WHERE id = ?");
    db.transaction((ids) => ids.forEach((id) => upd.run(now, id)))(rows.map((r) => r.id).filter(Boolean));
  }
  return rows;
}
function memoryDigest(limit = 8) {
  if (!db) return [];
  return db.prepare("SELECT id, type, content, importance, created_at FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?").all(limit);
}
function allMemories(limit = 200) {
  if (!db) return [];
  return db.prepare("SELECT id, type, content, importance, created_at FROM memories ORDER BY created_at DESC LIMIT ?").all(limit);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  allMemories,
  getSessionId,
  initDb,
  memoryDigest,
  newSession,
  recallMemories,
  recentSessions,
  saveMemory,
  saveMessage,
  sessionMessages,
  setActiveSession,
  startSession
});
