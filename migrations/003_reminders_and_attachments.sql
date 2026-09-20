-- Ghost-Prime schema (Phase 5): reminders + rich message content. Idempotent.
--
-- reminders used to be created inline in db.js; it now lives here so the `origin` column is part
-- of the table from the start on fresh installs. Existing databases get `origin` (and
-- messages.model_content) via the ADD COLUMN guards in db.js — SQLite has no ADD COLUMN IF NOT
-- EXISTS, so column additions to already-existing tables cannot be expressed idempotently here.

CREATE TABLE IF NOT EXISTS reminders (
  id         TEXT    PRIMARY KEY,
  text       TEXT    NOT NULL,
  due_at     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  fired      INTEGER DEFAULT 0,
  origin     TEXT             -- where it was asked for: NULL = desktop, 'discord:<channelId>' = a Discord channel
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(fired, due_at);
