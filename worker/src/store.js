// Everything the Worker keeps, in D1 (migrations/0001_accounts.sql). Puzzle progress is a set of lines per file:
// the browser sends the lines it added and the ones it took away (a reset moves a file's lines into an archive
// file), so two browsers writing at once can't undo each other, and adding the same line twice changes nothing.

export const MAX_LINES = 200000;          // per account: years of puzzles a day
export const MAX_BATCH = 20000;           // per request
export const MAX_LINE = 2000;             // bytes; a real line is ~100
const FILE = /^(profiles\/[a-z0-9_.-]{1,80}\/)?puzzle_(attempts|solved|daily)(\.reset-[0-9-]{1,40})?\.jsonl$/;

export class BadRequest extends Error {}

const DAY = 86400;

export function validFile(f) {
  return typeof f === 'string' && FILE.test(f) && !f.includes('..');
}

// {file: [line, ...]} from the request, checked: only puzzle-progress files, only JSON objects.
export function checkLines(obj, what) {
  if (obj == null) return [];
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new BadRequest(`${what}: {file: [lines]} expected`);
  const out = [];
  for (const [file, lines] of Object.entries(obj)) {
    if (!validFile(file)) throw new BadRequest(`${what}: not a puzzle-progress file: ${file}`);
    if (!Array.isArray(lines)) throw new BadRequest(`${what}: ${file}: a list of lines expected`);
    for (const line of lines) {
      if (typeof line !== 'string' || line.length > MAX_LINE) throw new BadRequest(`${what}: ${file}: bad line`);
      let v;
      try { v = JSON.parse(line); } catch { throw new BadRequest(`${what}: ${file}: a line isn't JSON`); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequest(`${what}: ${file}: a line isn't a JSON object`);
      out.push([file, line]);
    }
  }
  if (out.length > MAX_BATCH) throw new BadRequest(`${what}: more than ${MAX_BATCH} lines in one request`);
  return out;
}

// ---------- accounts and sign-in methods ----------

export async function identityUser(db, provider, subject) {
  const r = await db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(provider, subject).first();
  return r ? r.user_id : null;
}

export async function createUser(db, { id, now, consentVersion }, provider, who) {
  await db.batch([
    db.prepare('INSERT INTO users (id, created_at, last_seen_at, consent_version, consent_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, now, now, consentVersion, now),
    addIdentityStmt(db, id, provider, who, now),
  ]);
}

function addIdentityStmt(db, userId, provider, who, now) {
  return db.prepare('INSERT INTO identities (provider, subject, user_id, name, email, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(provider, who.subject, userId, who.name, who.email, now);
}

export async function addIdentity(db, userId, provider, who, now) {
  await addIdentityStmt(db, userId, provider, who, now).run();
}

// The provider's current name and email replace the old ones, so a changed Google address doesn't linger.
export async function refreshIdentity(db, provider, who) {
  await db.prepare('UPDATE identities SET name = ?, email = ? WHERE provider = ? AND subject = ?')
    .bind(who.name, who.email, provider, who.subject).run();
}

export async function removeIdentity(db, userId, provider) {
  const n = await db.prepare('SELECT COUNT(*) AS n FROM identities WHERE user_id = ?').bind(userId).first();
  if (n.n <= 1) throw new BadRequest('that is the only way to sign in: delete the account instead');
  await db.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').bind(userId, provider).run();
}

export async function account(db, userId) {
  const u = await db.prepare('SELECT id, created_at, consent_version, consent_at FROM users WHERE id = ?').bind(userId).first();
  if (!u) return null;
  const ids = await db.prepare('SELECT provider, name, email, created_at FROM identities WHERE user_id = ? ORDER BY created_at')
    .bind(userId).all();
  const lines = await db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ?').bind(userId).first();
  return { ...u, identities: ids.results, progress_lines: lines.n };
}

// ---------- sessions and sign-ins in progress ----------

export async function createSession(db, tokenHash, userId, now, days) {
  await db.batch([
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(tokenHash, userId, now, now + days * DAY),
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId),
  ]);
}

// The account a session belongs to, or null; using it counts as being seen, and keeps the session going.
export async function sessionUser(db, tokenHash, now, days) {
  const s = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').bind(tokenHash).first();
  if (!s || s.expires_at <= now) return null;
  if (s.expires_at - now < (days - 1) * DAY) {      // at most one write a day per session
    await db.batch([
      db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + days * DAY, tokenHash),
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, s.user_id),
    ]);
  }
  return s.user_id;
}

export async function deleteSession(db, tokenHash) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function startLogin(db, { state, provider, verifier, mode, linkUser, now }) {
  await db.prepare('INSERT INTO logins (state, provider, verifier, mode, link_user, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(state, provider, verifier, mode, linkUser || null, now).run();
}

// A sign-in can be finished once, within 15 minutes.
export async function takeLogin(db, state, now) {
  const l = await db.prepare('DELETE FROM logins WHERE state = ? RETURNING provider, verifier, mode, link_user, created_at')
    .bind(state).first();
  return l && l.created_at > now - 900 ? l : null;
}

// ---------- puzzle progress ----------

export async function progress(db, userId) {
  const rows = await db.prepare('SELECT file, line FROM progress WHERE user_id = ? ORDER BY file, added_at, rowid')
    .bind(userId).all();
  const files = {};
  for (const r of rows.results) (files[r.file] ||= []).push(r.line);
  return files;
}

export async function applyProgress(db, userId, add, remove, now) {
  const stmts = [];
  for (let i = 0; i < add.length; i += 20) {        // 20 rows x 4 values: under D1's 100 bound parameters
    const chunk = add.slice(i, i + 20);
    stmts.push(db.prepare('INSERT OR IGNORE INTO progress (user_id, file, line, added_at) VALUES ' +
      chunk.map(() => '(?, ?, ?, ?)').join(', ')).bind(...chunk.flatMap(([f, l]) => [userId, f, l, now])));
  }
  for (const [f, l] of remove) {
    stmts.push(db.prepare('DELETE FROM progress WHERE user_id = ? AND file = ? AND line = ?').bind(userId, f, l));
  }
  if (add.length) {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ?').bind(userId).first();
    if (n.n + add.length - remove.length > MAX_LINES) throw new BadRequest(`more than ${MAX_LINES} lines of progress`);
  }
  for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
  await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId).run();
}

// ---------- your data: all of it out, or all of it gone ----------

export async function exportAll(db, userId) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  const ids = await db.prepare('SELECT provider, subject, name, email, created_at FROM identities WHERE user_id = ?').bind(userId).all();
  const ses = await db.prepare('SELECT created_at, expires_at FROM sessions WHERE user_id = ?').bind(userId).all();
  return { account: u, sign_in_methods: ids.results, sessions: ses.results, puzzle_progress: await progress(db, userId) };
}

export async function deleteUser(db, userId) {
  await db.batch([
    db.prepare('DELETE FROM progress WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM identities WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM logins WHERE link_user = ?').bind(userId),
    db.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

// The daily clean-up: expired sessions, sign-ins never finished, and accounts unused for `retentionDays`.
export async function expire(db, now, retentionDays) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM logins WHERE created_at <= ?').bind(now - 900),
  ]);
  const old = await db.prepare('SELECT id FROM users WHERE last_seen_at < ?').bind(now - retentionDays * DAY).all();
  for (const u of old.results) await deleteUser(db, u.id);
  return old.results.length;
}
