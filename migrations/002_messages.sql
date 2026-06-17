-- Ghost-Prime schema (Phase 4): conversation persistence. Idempotent.

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    REFERENCES sessions(id),
  role       TEXT    NOT NULL,   -- 'user' | 'assistant'
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
