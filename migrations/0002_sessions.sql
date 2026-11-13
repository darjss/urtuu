ALTER TABLE messages ADD COLUMN from_session TEXT;
ALTER TABLE messages ADD COLUMN to_session TEXT;

CREATE TABLE sessions (
  login TEXT NOT NULL,
  session TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (login, session)
);
