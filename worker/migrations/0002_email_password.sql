-- Signing in with an email address and a password. The address is an identity like a Lichess or Google one
-- (provider 'email', subject = the address in lower case); the password lives here, only as a salted hash.

CREATE TABLE passwords (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,                  -- pbkdf2-sha256$<iterations>$<salt>$<hash>, base64url
  updated_at INTEGER NOT NULL
);

-- A 6-digit code sent by email, waiting to be typed in: to confirm a sign-up, to reset a password, or to add an
-- address to a signed-in account. One per address and purpose; 15 minutes and 5 tries.
CREATE TABLE email_codes (
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,               -- 'signup' | 'reset' | 'link'
  code_hash TEXT NOT NULL,
  password_hash TEXT,                  -- signup, link: the password chosen, already hashed
  user_id TEXT,                        -- link: the account getting the address
  tries INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, purpose)
);

-- Failed password logins per address, to slow down guessing: 10 in 15 minutes and that address waits.
CREATE TABLE login_failures (
  email TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);
