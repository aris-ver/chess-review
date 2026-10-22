-- Signing in from the desktop app (docs/accounts.md). The Worker does the provider round trip in the system browser
-- as for the website, then sends the browser on to the app's own loopback address with a one-time code instead of
-- setting a cookie. The app swaps that code, with the PKCE verifier only it knows, for a session token.

ALTER TABLE logins ADD COLUMN app_challenge TEXT;     -- the app's PKCE challenge: set for a sign-in started by the app
ALTER TABLE logins ADD COLUMN app_port INTEGER;       -- where it listens: http://127.0.0.1:<port>/account/callback

-- A finished sign-in waiting for the app to collect it: 2 minutes, once.
CREATE TABLE app_codes (
  code_hash TEXT PRIMARY KEY,          -- SHA-256 of the code sent to the loopback address
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,             -- SHA-256 of the verifier the app must show
  created_at INTEGER NOT NULL
);
