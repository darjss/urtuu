-- One shared channel replaces threads, sessions and read receipts. Readers keep their own cursor (the last id they saw).
DROP TABLE messages;
DROP TABLE sessions;
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_login TEXT NOT NULL,
  body TEXT NOT NULL,
  approved INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
