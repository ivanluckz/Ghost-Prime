// Smoke for the Phase-5 persistence pieces (no LLM, no cost). Runs the REAL db.js bundle under
// Electron against a throwaway userData dir that is first seeded with a PRE-migration-003 schema
// (reminders without `origin`, messages without `model_content`) so the upgrade path is exercised.
// Verifies: migrations + ADD COLUMN guards are idempotent (initDb twice), attachments' model-facing
// content round-trips through saveMessage/sessionMessages, reminders set during a Discord run are
// stamped with that run's origin, and onReminderFired sees each firing exactly once with its origin.
//   build: npm run db:bundle        run: npm run smoke:persistence
const { app } = require('electron')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { mkdtempSync } = require('node:fs')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

const failures = []
const check = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`)
  if (!cond) failures.push(what)
}

app
  .whenReady()
  .then(() => {
    const userData = mkdtempSync(join(tmpdir(), 'ghost-persist-'))
    app.setPath('userData', userData)

    // Seed the OLD schema the way db.js created it before migrations/003 existed.
    const Database = require('better-sqlite3')
    const seed = new Database(join(userData, 'ghost.db'))
    seed.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, summary TEXT);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE reminders (id TEXT PRIMARY KEY, text TEXT NOT NULL, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, fired INTEGER DEFAULT 0);
      INSERT INTO sessions (id, started_at) VALUES ('legacy', 1);
      INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1', 'legacy', 'user', 'old row', 2);
      INSERT INTO reminders (id, text, due_at, created_at, fired) VALUES ('r-old', 'legacy reminder', 1, 1, 0);
    `)
    seed.close()

    const db = require('./_db_bundle.cjs')
    db.initDb(process.cwd())
    db.initDb(process.cwd()) // second boot on the same file: every migration / ADD COLUMN guard must be idempotent
    check(true, 'initDb twice on an upgraded legacy DB (idempotent migrations)')

    // Legacy rows survive and read back with the new optional fields absent / null.
    const legacy = db.sessionMessages('legacy')
    check(legacy.length === 1 && legacy[0].content === 'old row' && !('modelContent' in legacy[0]), 'legacy message row reads back without modelContent')
    check(db.pendingReminders().some((r) => r.id === 'r-old' && r.origin === null), 'legacy reminder reads back with origin null')

    // Attachments: display text vs model-facing content.
    const s = db.startSession()
    const parts = [
      { type: 'text', text: 'summarize this file\n\n--- foo.js ---\nconst x = 1' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ]
    db.saveMessage('user', 'summarize this file 📎 foo.js', { modelContent: parts })
    db.saveMessage('assistant', 'It sets x to 1.')
    db.saveMessage('user', 'plain follow-up', { modelContent: 'plain follow-up' }) // identical → not stored twice
    const rows = db.sessionMessages(s)
    check(rows.length === 3, 'three rows saved')
    check(rows[0].content === 'summarize this file 📎 foo.js', 'display text is what the chat showed')
    check(JSON.stringify(rows[0].modelContent) === JSON.stringify(parts), 'modelContent round-trips as parsed JSON (content parts)')
    check(!('modelContent' in rows[1]) && !('modelContent' in rows[2]), 'rows without a distinct model form carry no modelContent')

    // A reply lands after the user may have switched chats: an explicit sessionId must win over the
    // active session, and a row for a deleted session is dropped rather than misfiled.
    const origin = db.getSessionId()
    const other = db.newSession() // "New chat" while the turn is still running
    check(db.getSessionId() === other && other !== origin, 'new session is now active')
    check(db.saveMessage('assistant', 'late reply *[stopped]*', { sessionId: origin }) === true, 'saveMessage accepts an explicit sessionId')
    check(db.sessionMessages(origin).length === 4 && db.sessionMessages(origin)[3].content === 'late reply *[stopped]*', 'late reply lands in the ORIGINAL session')
    check(db.sessionMessages(other).length === 0, 'the new chat did not receive an orphan assistant row')
    db.saveMessage('user', 'in the new chat')
    check(db.sessionMessages(other).length === 1, 'without sessionId the active session is used')
    db.deleteSession(other)
    check(db.saveMessage('assistant', 'reply for a deleted chat', { sessionId: other }) === false, 'save into a deleted session is skipped')
    check(db.sessionMessages(other).length === 0, 'deleted session stays empty')
    check(db.saveMessage('assistant', 'no active session') === false, 'no active session after its delete → nothing saved')
    db.setActiveSession(origin)

    // Reminders: origin comes from the active run context (Discord run) and is null on the desktop.
    db.setRunContext({ surface: 'discord', origin: 'discord:123456789', notify: null })
    const fromDiscord = db.addReminder('call mum', Date.now() - 1) // already due
    db.setRunContext(null)
    const fromDesktop = db.addReminder('stretch', Date.now() - 1)
    const explicit = db.addReminder('explicit', Date.now() + 3600e3, 'discord:42')
    const pend = Object.fromEntries(db.pendingReminders().map((r) => [r.id, r]))
    check(pend[fromDiscord]?.origin === 'discord:123456789', 'reminder set during a Discord run is stamped with that channel')
    check(pend[fromDesktop]?.origin === null, 'reminder set on the desktop has origin null')
    check(pend[explicit]?.origin === 'discord:42', 'explicit origin argument wins')
    check(db.getRunContext() === null, 'run context cleared')

    // Firing: listeners see each reminder once, with its origin; a re-mark does not re-notify.
    const seen = []
    const off = db.onReminderFired((r) => seen.push(r))
    const due = db.dueReminders(Date.now())
    check(due.length === 3 && due.every((r) => 'origin' in r), 'dueReminders returns the two new due rows + legacy, each with origin')
    for (const r of due) db.markReminderFired(r.id)
    db.markReminderFired(fromDiscord) // already fired → no second notification
    check(seen.length === 3, `listener saw each firing exactly once (${seen.length})`)
    check(seen.find((r) => r.id === fromDiscord)?.origin === 'discord:123456789', 'fired payload carries the Discord origin')
    check(seen.find((r) => r.id === fromDiscord)?.text === 'call mum', 'fired payload carries the text')
    check(db.dueReminders(Date.now()).length === 0, 'nothing due after marking fired')
    off()
    db.markReminderFired(explicit)
    check(seen.length === 3, 'unsubscribed listener is not called')

    // Deleting chats that produced memories (regression, overnight 25 Sep): memories.session_id
    // references sessions(id) and better-sqlite3 enforces foreign keys, so deleting such a chat —
    // or "Delete all chats" — threw "FOREIGN KEY constraint failed" and nothing was deleted.
    const withMem = db.newSession()
    db.saveMessage('user', 'remember I like chemistry', { sessionId: withMem })
    const memId = db.saveMemory('Likes chemistry', 'fact', 5, { sessionId: withMem })
    let delErr = ''
    try {
      db.deleteSession(withMem)
    } catch (e) {
      delErr = e.message
    }
    check(!delErr && db.sessionMessages(withMem).length === 0, `a chat that saved a memory can be deleted${delErr ? ` (${delErr})` : ''}`)
    check(db.allMemories().some((m) => m.id === memId), 'its memory is kept (memories are cleared separately)')
    const again = db.newSession()
    db.saveMemory('Revises on Fridays', 'fact', 5, { sessionId: again })
    let allErr = ''
    try {
      db.deleteAllSessions()
    } catch (e) {
      allErr = e.message
    }
    check(!allErr && db.recentSessions().every((s2) => s2.id !== again), `"Delete all chats" works with memories present${allErr ? ` (${allErr})` : ''}`)

    console.log(failures.length ? `SMOKE_MISMATCH (${failures.length})` : 'SMOKE_OK')
    app.exit(failures.length ? 2 : 0)
  })
  .catch((e) => {
    console.error('SMOKE_FAIL', e)
    app.exit(1)
  })
