-- Blundr accounts: who you are (one row per account, one per sign-in method), your sessions, and your puzzle
-- progress as the lines of its JSONL files. Nothing else about you is kept; reviewed games never come here.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                 -- random, not derived from anything about you
  created_at INTEGER NOT NULL,         -- unix seconds
  last_seen_at INTEGER NOT NULL,       -- accounts unused for RETENTION_DAYS are deleted (scheduled())
  consent_version TEXT NOT NULL,       -- the terms/privacy version agreed to at sign-up, and when
  consent_at INTEGER NOT NULL
);

CREATE TABLE identities (
  provider TEXT NOT NULL,              -- 'lichess' | 'google'
  subject TEXT NOT NULL,               -- the provider's id for you
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,                           -- Lichess username, or the Google account's email
  email TEXT,                          -- Google only
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,         -- SHA-256 of the cookie's token: a leaked table logs nobody in
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- A sign-in on its way through the provider: the PKCE verifier, and whether it was a sign-up with consent given.
CREATE TABLE logins (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  verifier TEXT NOT NULL,
  mode TEXT NOT NULL,                  -- 'login' | 'signup' | 'link'
  link_user TEXT,                      -- for 'link': the signed-in account getting another sign-in method
  created_at INTEGER NOT NULL
);

CREATE TABLE progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file TEXT NOT NULL,                  -- e.g. puzzle_attempts.jsonl, profiles/<id>/puzzle_attempts.jsonl
  line TEXT NOT NULL,                  -- one JSON object, as the browser wrote it
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file, line)
);
