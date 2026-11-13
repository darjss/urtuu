CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX tokens_login ON tokens (login);

CREATE TABLE invites (
  code_hash TEXT PRIMARY KEY,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_login TEXT NOT NULL,
  to_login TEXT NOT NULL,
  body TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX messages_unread ON messages (to_login, read_at);
CREATE INDEX messages_thread ON messages (thread_id, created_at);
