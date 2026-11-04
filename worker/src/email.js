// Signing in with an email address and a password (migrations/0002_email_password.sql).
//
//   POST /account/email/signup   {email, password, consent}  -> a code goes to the address; nothing exists yet
//   POST /account/email/verify   {email, code, purpose}      -> signup: the account is made and you're signed in;
//                                                               link: the address joins the signed-in account
//   POST /account/email/login    {email, password}
//   POST /account/email/forgot   {email}                     -> a code goes to the address, if it has an account
//   POST /account/email/reset    {email, code, password}     -> new password, every other session signed out
//   POST /account/email/link     {email, password}           -> (signed in) a code goes to the address
//
// No answer tells a stranger whether an address has an account: sign-up and forgot always say "code sent", and a
// wrong address or a wrong password are the same error. Passwords are PBKDF2-SHA256 with a random salt (the Workers
// runtime allows up to 100,000 iterations); codes are 6 digits, kept hashed, for 15 minutes and 5 tries.

export class EmailError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ITERATIONS = 100000;
const CODE_MINUTES = 15;
const CODE_TRIES = 5;
const RESEND_SECONDS = 60;
const FAIL_LIMIT = 10;
const FAIL_WINDOW = 900;
export const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function normalEmail(e) {
  const s = String(e || '').trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new EmailError(400, "That doesn't look like an email address");
  return s;
}

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) throw new EmailError(400, `Use a password of at least ${MIN_PASSWORD} characters`);
  if (p.length > MAX_PASSWORD) throw new EmailError(400, 'That password is too long');
  return p;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, ITERATIONS))}`;
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export async function checkHash(password, stored) {
  const [kind, it, salt, hash] = String(stored || '').split('$');
  if (kind !== 'pbkdf2-sha256') return false;
  return same(await pbkdf2(password, unb64url(salt), Number(it)), unb64url(hash));
}

// a hash to check against when there's no account, so a wrong address takes as long as a wrong password
const DUMMY = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function codeHash(email, purpose, code) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${purpose}:${email}:${code}`))));
}

function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

// ---------- sending ----------

const MESSAGES = {
  signup: code => ({
    subject: `${code} is your Blundr code`,
    text: `Your code to finish signing up to Blundr is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't try to sign up, ignore this email: no account is made without the code.`,
  }),
  exists: () => ({
    subject: 'You already have a Blundr account',
    text: 'Someone (probably you) tried to sign up to Blundr with this address, but it already has an account. Log in instead, or use "Forgot password?" on the log-in screen to set a new password.\n\nIf it wasn\'t you, ignore this email: nothing has changed.',
  }),
  reset: code => ({
    subject: `${code} is your Blundr password reset code`,
    text: `Your code to set a new Blundr password is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this email: your password stays as it is.`,
  }),
  link: code => ({
    subject: `${code} is your Blundr code`,
    text: `Your code to add this address to your Blundr account is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
  }),
};

function sender(env) {
  const m = String(env.MAIL_FROM || 'Blundr <login@blundr.gr>').match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { email: m[2], name: m[1] } : { email: String(env.MAIL_FROM) };
}

// Brevo's transactional API (blundr.gr is authenticated there): Cloudflare's own Email Sending only reaches arbitrary
// addresses on the Workers Paid plan, Brevo's free tier sends 300 a day.
async function brevo(env, to, m) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: sender(env), to: [{ email: to }], subject: m.subject, textContent: m.text }),
  });
  if (!r.ok) throw Object.assign(new Error(await r.text()), { code: r.status });
}

export async function sendMail(env, to, kind, code) {
  const m = MESSAGES[kind](code);
  if (!env.BREVO_API_KEY && !env.EMAIL) {     // no sender (plain local runs): the message goes to the console instead
    console.log(`[email to ${to}] ${m.subject}\n${m.text}`);
    return;
  }
  try {
    if (env.BREVO_API_KEY) await brevo(env, to, m);
    else await env.EMAIL.send({ to, from: sender(env), subject: m.subject, text: m.text });
  } catch (e) {
    console.error('sending email failed', e.code, e.message);
    throw new EmailError(503, "The email couldn't be sent. Please try again later.");
  }
}

// ---------- codes ----------

async function issueCode(env, email, purpose, extra, now) {
  const old = await env.DB.prepare('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ?').bind(email, purpose).first();
  if (old && old.created_at > now - RESEND_SECONDS) throw new EmailError(429, 'A code was just sent. Wait a minute before asking for another.');
  const code = newCode();
  await env.DB.prepare('INSERT OR REPLACE INTO email_codes (email, purpose, code_hash, password_hash, user_id, tries, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(email, purpose, await codeHash(email, purpose, code), extra.passwordHash || null, extra.userId || null, now).run();
  await sendMail(env, email, purpose, code);
}

// The pending code's row once the code matches (and then it's used up), else an error.
async function takeCode(env, email, purpose, code, now) {
  const row = await env.DB.prepare('SELECT * FROM email_codes WHERE email = ? AND purpose = ?').bind(email, purpose).first();
  const bad = new EmailError(400, 'That code is wrong or has expired. Ask for a new one.');
  if (!row || row.created_at <= now - CODE_MINUTES * 60 || row.tries >= CODE_TRIES) throw bad;
  if (row.code_hash !== await codeHash(email, purpose, String(code || '').trim())) {
    await env.DB.prepare('UPDATE email_codes SET tries = tries + 1 WHERE email = ? AND purpose = ?').bind(email, purpose).run();
    throw bad;
  }
  await env.DB.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').bind(email, purpose).run();
  return row;
}

const emailUser = async (env, email) =>
  (await env.DB.prepare("SELECT user_id FROM identities WHERE provider = 'email' AND subject = ?").bind(email).first())?.user_id || null;

// ---------- the routes; each returns {userId} to sign in, or {} ----------

export async function signup(env, b, { consentVersion, now }) {
  if (b.consent !== consentVersion) throw new EmailError(400, 'Sign-up needs agreement to the current terms and privacy policy');
  const email = normalEmail(b.email);
  const password = checkPassword(b.password);
  if (await emailUser(env, email)) {
    await sendMail(env, email, 'exists');      // the answer below is the same either way
    return {};
  }
  await issueCode(env, email, 'signup', { passwordHash: await hashPassword(password) }, now);
  return {};
}

export async function verify(env, b, { now, signedIn, createUser, addIdentity }) {
  const email = normalEmail(b.email);
  const purpose = b.purpose === 'link' ? 'link' : 'signup';
  const row = await takeCode(env, email, purpose, b.code, now);
  if (await emailUser(env, email)) throw new EmailError(409, 'That address already belongs to a Blundr account. Log in instead.');
  const who = { subject: email, name: email, email };
  if (purpose === 'link') {
    if (!signedIn || signedIn !== row.user_id) throw new EmailError(401, 'Log in to the account first');
    await addIdentity(row.user_id, 'email', who);
    await setPassword(env, row.user_id, row.password_hash, now);
    return { userId: row.user_id, linked: true };
  }
  const userId = crypto.randomUUID();
  await createUser(userId, 'email', who);
  await setPassword(env, userId, row.password_hash, now);
  return { userId, created: true };
}

async function setPassword(env, userId, hash, now) {
  await env.DB.prepare('INSERT OR REPLACE INTO passwords (user_id, hash, updated_at) VALUES (?, ?, ?)').bind(userId, hash, now).run();
}

export async function login(env, b, { now }) {
  const email = normalEmail(b.email);
  const f = await env.DB.prepare('SELECT count, first_at FROM login_failures WHERE email = ?').bind(email).first();
  const recent = f && f.first_at > now - FAIL_WINDOW;
  if (recent && f.count >= FAIL_LIMIT) throw new EmailError(429, 'Too many tries. Wait 15 minutes, or reset your password.');
  const userId = await emailUser(env, email);
  const pw = userId && await env.DB.prepare('SELECT hash FROM passwords WHERE user_id = ?').bind(userId).first();
  const ok = await checkHash(String(b.password || ''), pw ? pw.hash : DUMMY) && Boolean(pw);
  if (!ok) {
    await env.DB.prepare(recent
      ? 'UPDATE login_failures SET count = count + 1 WHERE email = ?'
      : 'INSERT OR REPLACE INTO login_failures (email, count, first_at) VALUES (?, 1, ?)')
      .bind(...(recent ? [email] : [email, now])).run();
    throw new EmailError(401, 'Wrong email or password');
  }
  await env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(email).run();
  return { userId };
}

export async function forgot(env, b, { now }) {
  const email = normalEmail(b.email);
  if (await emailUser(env, email)) await issueCode(env, email, 'reset', {}, now);
  return {};
}

export async function reset(env, b, { now }) {
  const email = normalEmail(b.email);
  const password = checkPassword(b.password);
  await takeCode(env, email, 'reset', b.code, now);
  const userId = await emailUser(env, email);
  if (!userId) throw new EmailError(400, 'That code is wrong or has expired. Ask for a new one.');
  await setPassword(env, userId, await hashPassword(password), now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),       // whoever knew the old one is out
    env.DB.prepare('DELETE FROM login_failures WHERE email = ?').bind(email),
  ]);
  return { userId };
}

export async function link(env, b, { now, signedIn }) {
  const email = normalEmail(b.email);
  const password = checkPassword(b.password);
  if (await emailUser(env, email)) throw new EmailError(409, 'That address already belongs to a Blundr account');
  await issueCode(env, email, 'link', { passwordHash: await hashPassword(password), userId: signedIn }, now);
  return {};
}
