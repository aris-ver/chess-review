// The account API end to end against a local D1, with Lichess and Google stood in for by a stubbed fetch.
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_VERSION } from '../src/consent.js';
import worker from '../src/index.js';
import * as store from '../src/store.js';

const ORIGIN = 'https://blundr.test';
const GOOGLE = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' };

// who the stubbed provider says signs in next
let lichessUser = { id: 'magnus', username: 'Magnus' };
let googleClaims = {};

function b64url(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

beforeEach(async () => {
  for (const t of ['progress', 'sessions', 'identities', 'logins', 'passwords', 'email_codes', 'login_failures', 'users']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  outbox.length = 0;
  lichessUser = { id: 'magnus', username: 'Magnus' };
  googleClaims = { sub: 'g-1', email: 'magnus@example.com', email_verified: true };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://lichess.org/api/token' && init.method === 'POST') return Response.json({ access_token: 'lt' });
    if (url === 'https://lichess.org/api/token' && init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url === 'https://lichess.org/api/account') return Response.json(lichessUser);
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = { iss: 'https://accounts.google.com', aud: 'gid', exp: Math.floor(Date.now() / 1000) + 600, ...googleClaims };
      return Response.json({ access_token: 'gt', id_token: `x.${b64url(JSON.stringify(claims))}.sig` });
    }
    throw new Error('unexpected fetch ' + url);
  });
});
afterEach(() => vi.restoreAllMocks());

// The email binding: what was sent, so a test can read the code out of it.
const outbox = [];
const EMAIL = { send: async m => { outbox.push(m); return { messageId: String(outbox.length) }; } };
const lastCode = to => outbox.filter(m => m.to === to).at(-1)?.text.match(/\b(\d{6})\b/)?.[1];

// A browser: keeps its cookies between requests, as one would for /account/.
class Browser {
  constructor(extraEnv = {}) { this.jar = {}; this.env = { ...env, LICHESS_URL: '', EMAIL, ...extraEnv }; }   // not .dev.vars' fake
  async req(path, { method = 'GET', body, origin = ORIGIN } = {}) {
    const headers = new Headers();
    const c = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (c) headers.set('Cookie', c);
    if (method === 'POST') headers.set('Origin', origin);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), this.env);
    for (const sc of res.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split('; ');
      const [k, v] = kv.split('=');
      if (attrs.includes('Max-Age=0')) delete this.jar[k]; else this.jar[k] = v;
    }
    return res;
  }
  async json(path, opts) {
    const res = await this.req(path, opts);
    return { status: res.status, body: await res.json() };
  }
  // The whole round trip through the provider; returns the outcome the page is sent back with.
  async signIn(provider = 'lichess', mode = 'login', consent = CONSENT_VERSION) {
    const q = new URLSearchParams({ mode });
    if (mode === 'signup' && consent) q.set('consent', consent);
    const go = await this.req(`/account/login/${provider}?${q}`);
    if (go.status !== 302) return `refused ${go.status}`;
    const state = new URL(go.headers.get('Location')).searchParams.get('state');
    const back = await this.req(`/account/callback/${provider}?code=c&state=${state}`);
    return new URL(back.headers.get('Location'), ORIGIN).searchParams.get('account');
  }
}

const count = async (table, where = '1') => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first()).n;

describe('signing up and in', () => {
  it('sign-up needs the current consent', async () => {
    const b = new Browser();
    expect(await b.signIn('lichess', 'signup', null)).toBe('refused 400');
    expect(await b.signIn('lichess', 'signup', '2000-01-01')).toBe('refused 400');
    expect(await count('users')).toBe(0);
  });

  it('logging in without an account makes none and says so', async () => {
    const b = new Browser();
    expect(await b.signIn('lichess', 'login')).toBe('no-account');
    expect(await count('users')).toBe(0);
    expect((await b.json('/account/me')).body.user).toBeNull();
  });

  it('signs up, keeps the consent, and logs in again elsewhere', async () => {
    const a = new Browser();
    expect(await a.signIn('lichess', 'signup')).toBe('welcome');
    const me = (await a.json('/account/me')).body.user;
    expect(me.consent_version).toBe(CONSENT_VERSION);
    expect(me.identities).toEqual([expect.objectContaining({ provider: 'lichess', name: 'Magnus', email: null })]);
    const b = new Browser();
    expect(await b.signIn('lichess', 'login')).toBe('signed-in');
    expect((await b.json('/account/me')).body.user.id).toBe(me.id);
    expect(await a.signIn('lichess', 'signup')).toBe('signed-in');     // signing up twice is just signing in
    expect(await count('users')).toBe(1);
  });

  it('the session cookie is HttpOnly, Secure, Lax and only for /account/', async () => {
    const b = new Browser();
    const go = await b.req('/account/login/lichess?mode=signup&consent=' + CONSENT_VERSION);
    const state = new URL(go.headers.get('Location')).searchParams.get('state');
    const back = await b.req(`/account/callback/lichess?code=c&state=${state}`);
    const sc = back.headers.getSetCookie().find(c => c.startsWith('blundr_session='));
    expect(sc).toMatch(/Path=\/account\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
    expect(await count('sessions')).toBe(1);
    const stored = await env.DB.prepare('SELECT token_hash FROM sessions').first();
    expect(sc).not.toContain(stored.token_hash);          // only a hash of the token is kept
  });

  it("a callback whose state isn't this browser's is refused", async () => {
    const a = new Browser(), mallory = new Browser();
    const go = await mallory.req('/account/login/lichess?mode=signup&consent=' + CONSENT_VERSION);
    const state = new URL(go.headers.get('Location')).searchParams.get('state');
    const back = await a.req(`/account/callback/lichess?code=c&state=${state}`);
    expect(new URL(back.headers.get('Location'), ORIGIN).searchParams.get('account')).toBe('error');
    expect(await count('users')).toBe(0);
  });

  it('Google shows up only once configured, and can be linked to the account', async () => {
    expect((await new Browser().json('/account/me')).body.providers.map(p => p.id)).toEqual(['lichess']);
    const b = new Browser(GOOGLE);
    expect((await b.json('/account/me')).body.providers.map(p => p.id)).toEqual(['lichess', 'google']);
    await b.signIn('lichess', 'signup');
    expect(await b.signIn('google', 'link')).toBe('linked');
    const me = (await b.json('/account/me')).body.user;
    expect(me.identities.map(i => [i.provider, i.email])).toEqual([['lichess', null], ['google', 'magnus@example.com']]);
    const c = new Browser(GOOGLE);
    expect(await c.signIn('google', 'login')).toBe('signed-in');
    expect((await c.json('/account/me')).body.user.id).toBe(me.id);
    // and a Google account already on another Blundr account can't be linked to this one
    lichessUser = { id: 'hikaru', username: 'Hikaru' };
    const d = new Browser(GOOGLE);
    await d.signIn('lichess', 'signup');
    expect(await d.signIn('google', 'link')).toBe('taken');
  });

  it("the last sign-in method can't be unlinked", async () => {
    const b = new Browser(GOOGLE);
    await b.signIn('lichess', 'signup');
    expect((await b.json('/account/unlink/lichess', { method: 'POST' })).status).toBe(400);
    await b.signIn('google', 'link');
    const r = await b.json('/account/unlink/lichess', { method: 'POST' });
    expect(r.body.user.identities.map(i => i.provider)).toEqual(['google']);
  });

  it('logging out ends the session', async () => {
    const b = new Browser();
    await b.signIn('lichess', 'signup');
    expect((await b.json('/account/logout', { method: 'POST' })).status).toBe(200);
    expect((await b.json('/account/me')).body.user).toBeNull();
    expect(await count('sessions')).toBe(0);
  });
});

const A1 = '{"id": "00008", "ts": 1760000000, "solved": true, "ms": 4100, "hinted": false, "rating": 1520}';
const A2 = '{"id": "0000D", "ts": 1760000100, "solved": false, "ms": 9000, "hinted": false, "rating": 1610}';
const PROFILE = '{"added": "2026-10-01T10:00:00+00:00", "pinned": null, "source": "chesscom", "username": "AlirezaFirouzja"}';
const OWN ='{"id": "own:chesscom-me:abc:31", "ts": 1760000200, "solved": false, "ms": 5000, "hinted": false}';

describe('puzzle progress', () => {
  it('needs an account', async () => {
    expect((await new Browser().json('/account/progress')).status).toBe(401);
  });

  it('adds and removes lines, and adding twice changes nothing', async () => {
    const b = new Browser();
    await b.signIn('lichess', 'signup');
    let r = await b.json('/account/progress', { method: 'POST', body: { add: { 'puzzle_attempts.jsonl': [A1, A2], 'profiles/chesscom-me/puzzle_attempts.jsonl': [OWN] } } });
    expect(r.body.files).toEqual({ 'profiles/chesscom-me/puzzle_attempts.jsonl': [OWN], 'puzzle_attempts.jsonl': [A1, A2] });
    r = await b.json('/account/progress', { method: 'POST', body: { add: { 'puzzle_attempts.jsonl': [A1] } } });
    expect(r.body.files['puzzle_attempts.jsonl']).toEqual([A1, A2]);
    // a rating reset: the lines move to an archive file
    r = await b.json('/account/progress', {
      method: 'POST',
      body: { add: { 'puzzle_attempts.reset-20261021-101500.jsonl': [A1, A2] }, remove: { 'puzzle_attempts.jsonl': [A1, A2] } },
    });
    expect(r.body.files).toEqual({ 'profiles/chesscom-me/puzzle_attempts.jsonl': [OWN], 'puzzle_attempts.reset-20261021-101500.jsonl': [A1, A2] });
  });

  it("two browsers adding at once don't lose each other's lines", async () => {
    const a = new Browser(), b = new Browser();
    await a.signIn('lichess', 'signup');
    await b.signIn('lichess', 'login');
    await Promise.all([
      a.json('/account/progress', { method: 'POST', body: { add: { 'puzzle_attempts.jsonl': [A1] } } }),
      b.json('/account/progress', { method: 'POST', body: { add: { 'puzzle_attempts.jsonl': [A2] } } }),
    ]);
    expect((await a.json('/account/progress')).body.files['puzzle_attempts.jsonl'].sort()).toEqual([A1, A2].sort());
  });

  it('takes only puzzle-progress files of JSON objects', async () => {
    const b = new Browser();
    await b.signIn('lichess', 'signup');
    for (const add of [
      { 'evals.duckdb': [A1] },
      { 'profiles/chesscom-me/games.parquet': [A1] },
      { 'profiles/../puzzle_attempts.jsonl': [A1] },
      { 'puzzle_attempts.jsonl': ['not json'] },
      { 'puzzle_attempts.jsonl': ['[1, 2]'] },
      { 'puzzle_attempts.jsonl': ['{"x": "' + 'a'.repeat(3000) + '"}'] },
      { 'puzzle_attempts.jsonl': 'nope' },
    ]) {
      expect((await b.json('/account/progress', { method: 'POST', body: { add } })).status).toBe(400);
    }
    expect(await count('progress')).toBe(0);
  });

  it('refuses a POST from another site', async () => {
    const b = new Browser();
    await b.signIn('lichess', 'signup');
    const r = await b.json('/account/progress', { method: 'POST', body: { add: { 'puzzle_attempts.jsonl': [A1] } }, origin: 'https://evil.test' });
    expect(r.status).toBe(403);
    expect((await b.json('/account/delete', { method: 'POST', origin: 'https://evil.test' })).status).toBe(403);
    expect(await count('users')).toBe(1);
  });
});

describe('your data', () => {
  async function twoAccounts() {
    const a = new Browser(GOOGLE);
    await a.signIn('lichess', 'signup');
    await a.signIn('google', 'link');
    await a.json('/account/progress', { method: 'POST', body: { add: { 'puzzle_attempts.jsonl': [A1, A2], 'puzzle_daily.jsonl': ['{"date": "2026-10-21", "n": 1}'], 'profiles.jsonl': [PROFILE] } } });
    lichessUser = { id: 'hikaru', username: 'Hikaru' };
    const other = new Browser();
    await other.signIn('lichess', 'signup');
    await other.json('/account/progress', { method: 'POST', body: { add: { 'puzzle_attempts.jsonl': [A1] } } });
    return { a, other };
  }

  it('export holds everything kept about you and nothing about anyone else', async () => {
    const { a } = await twoAccounts();
    const res = await a.req('/account/export');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    const x = await res.json();
    expect(x.account.consent_version).toBe(CONSENT_VERSION);
    expect(x.sign_in_methods.map(i => i.name)).toEqual(['Magnus', 'magnus@example.com']);
    expect(x.puzzle_progress).toEqual({ 'puzzle_attempts.jsonl': [A1, A2], 'puzzle_daily.jsonl': ['{"date": "2026-10-21", "n": 1}'] });
    expect(x.profiles).toEqual([JSON.parse(PROFILE)]);
    expect(JSON.stringify(x)).not.toContain('Hikaru');
    expect(JSON.stringify(x)).not.toContain('token_hash');
  });

  it('delete removes the account, its sign-ins, sessions and progress, and only those', async () => {
    const { a, other } = await twoAccounts();
    const id = (await a.json('/account/me')).body.user.id;
    const r = await a.json('/account/delete', { method: 'POST' });
    expect(r.body).toEqual({ deleted: true });
    for (const t of ['users']) expect(await count(t, `id = '${id}'`)).toBe(0);
    for (const t of ['identities', 'sessions', 'progress']) expect(await count(t, `user_id = '${id}'`)).toBe(0);
    expect((await a.json('/account/me')).body.user).toBeNull();
    // signing in with the same Lichess account later starts from nothing
    lichessUser = { id: 'magnus', username: 'Magnus' };
    expect(await new Browser().signIn('lichess', 'login')).toBe('no-account');
    // the other account is untouched
    expect((await other.json('/account/progress')).body.files).toEqual({ 'puzzle_attempts.jsonl': [A1] });
  });

  it('a session from before the deletion no longer works', async () => {
    const { a } = await twoAccounts();
    const b = new Browser();
    lichessUser = { id: 'magnus', username: 'Magnus' };
    await b.signIn('lichess', 'login');
    await a.json('/account/delete', { method: 'POST' });
    expect((await b.json('/account/progress')).status).toBe(401);
  });

  it('accounts unused past the retention period are deleted by the daily clean-up', async () => {
    const { a } = await twoAccounts();
    const id = (await a.json('/account/me')).body.user.id;
    await env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(1, id).run();
    expect(await store.expire(env.DB, Math.floor(Date.now() / 1000), 730)).toBe(1);
    expect(await count('users')).toBe(1);
    expect(await count('progress', `user_id = '${id}'`)).toBe(0);
  });
});

describe('email and password', () => {
  const PW = 'correct horse battery';
  const post = (b, step, body) => b.json(`/account/email/${step}`, { method: 'POST', body });
  async function emailSignup(b, address = 'Ana@Example.com', password = PW) {
    const r = await post(b, 'signup', { email: address, password, consent: CONSENT_VERSION });
    if (r.status !== 200) return r;
    return post(b, 'verify', { email: address, code: lastCode(address.toLowerCase()), purpose: 'signup' });
  }

  it('signs up only once the emailed code is typed in', async () => {
    const b = new Browser();
    await post(b, 'signup', { email: 'ana@example.com', password: PW, consent: CONSENT_VERSION });
    expect(await count('users')).toBe(0);                          // nothing yet: anyone could type any address
    expect(outbox[0]).toMatchObject({ to: 'ana@example.com', from: { email: 'login@blundr.gr', name: 'Blundr' } });
    expect((await post(b, 'verify', { email: 'ana@example.com', code: '000000', purpose: 'signup' })).status).toBe(400);
    const r = await post(b, 'verify', { email: 'ana@example.com', code: lastCode('ana@example.com'), purpose: 'signup' });
    expect(r.body).toMatchObject({ ok: true, created: true });
    expect(r.body.user.identities).toEqual([expect.objectContaining({ provider: 'email', name: 'ana@example.com' })]);
    expect((await b.json('/account/me')).body.user.consent_version).toBe(CONSENT_VERSION);
    const pw = await env.DB.prepare('SELECT hash FROM passwords').first();
    expect(pw.hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(pw.hash).not.toContain(PW);
  });

  it('needs consent, a real-looking address and a long enough password', async () => {
    const b = new Browser();
    for (const body of [
      { email: 'ana@example.com', password: PW },
      { email: 'not an email', password: PW, consent: CONSENT_VERSION },
      { email: 'ana@example.com', password: 'short', consent: CONSENT_VERSION },
    ]) expect((await post(b, 'signup', body)).status).toBe(400);
    expect(outbox).toEqual([]);
  });

  it('a code works once, for 5 tries at most', async () => {
    const b = new Browser();
    await post(b, 'signup', { email: 'ana@example.com', password: PW, consent: CONSENT_VERSION });
    const code = lastCode('ana@example.com');
    for (let i = 0; i < 5; i++) await post(b, 'verify', { email: 'ana@example.com', code: '999999', purpose: 'signup' });
    expect((await post(b, 'verify', { email: 'ana@example.com', code, purpose: 'signup' })).status).toBe(400);
    expect(await count('users')).toBe(0);
  });

  it('signing up with a taken address answers the same, and mails the owner instead', async () => {
    await emailSignup(new Browser());
    outbox.length = 0;
    const r = await post(new Browser(), 'signup', { email: 'ana@example.com', password: 'another password', consent: CONSENT_VERSION });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(outbox[0].subject).toContain('already have');
    expect(await count('users')).toBe(1);
  });

  it('logs in with the right password only, and slows down guessing', async () => {
    await emailSignup(new Browser());
    const b = new Browser();
    const bad = await post(b, 'login', { email: 'ana@example.com', password: 'wrong password' });
    const nobody = await post(b, 'login', { email: 'bob@example.com', password: PW });
    expect([bad.status, nobody.status]).toEqual([401, 401]);
    expect(bad.body).toEqual(nobody.body);                          // no telling which addresses have accounts
    const ok = await post(b, 'login', { email: ' ANA@example.com ', password: PW });
    expect(ok.body.created).toBe(false);
    expect((await b.json('/account/me')).body.user.identities[0].provider).toBe('email');
    for (let i = 0; i < 10; i++) await post(b, 'login', { email: 'ana@example.com', password: 'x'.repeat(12) });
    expect((await post(b, 'login', { email: 'ana@example.com', password: PW })).status).toBe(429);
  });

  it('a password reset needs the emailed code and signs out every other session', async () => {
    const a = new Browser();
    await emailSignup(a);
    const b = new Browser();
    expect((await post(b, 'forgot', { email: 'nobody@example.com' })).body).toEqual({ ok: true });
    await post(b, 'forgot', { email: 'ana@example.com' });
    expect(outbox.at(-1).subject).toContain('reset');
    expect((await post(b, 'reset', { email: 'ana@example.com', code: '123456', password: 'a new password!' })).status).toBe(400);
    const r = await post(b, 'reset', { email: 'ana@example.com', code: lastCode('ana@example.com'), password: 'a new password!' });
    expect(r.status).toBe(200);
    expect((await a.json('/account/me')).body.user).toBeNull();     // the old session is gone
    expect((await b.json('/account/me')).body.user).not.toBeNull();
    expect((await post(new Browser(), 'login', { email: 'ana@example.com', password: PW })).status).toBe(401);
  });

  it('an email and password can be added to a Lichess account, and removed again', async () => {
    const b = new Browser();
    await b.signIn('lichess', 'signup');
    expect((await post(new Browser(), 'link', { email: 'm@example.com', password: PW })).status).toBe(401);
    await post(b, 'link', { email: 'm@example.com', password: PW });
    const r = await post(b, 'verify', { email: 'm@example.com', code: lastCode('m@example.com'), purpose: 'link' });
    expect(r.body.user.identities.map(i => i.provider)).toEqual(['lichess', 'email']);
    const c = new Browser();
    await post(c, 'login', { email: 'm@example.com', password: PW });
    expect((await c.json('/account/me')).body.user.id).toBe(r.body.user.id);
    await b.json('/account/unlink/email', { method: 'POST' });
    expect(await count('passwords')).toBe(0);
  });

  it('deleting the account removes the password and any codes too', async () => {
    const b = new Browser();
    await emailSignup(b);
    await post(b, 'forgot', { email: 'ana@example.com' });
    const x = await (await b.req('/account/export')).json();
    expect(x.password).toMatchObject({ set: true });
    expect(JSON.stringify(x)).not.toContain('pbkdf2');
    await b.json('/account/delete', { method: 'POST' });
    for (const t of ['users', 'identities', 'passwords', 'email_codes', 'sessions']) expect(await count(t)).toBe(0);
  });

  it('asking for codes is limited to one a minute', async () => {
    const b = new Browser();
    await post(b, 'signup', { email: 'ana@example.com', password: PW, consent: CONSENT_VERSION });
    expect((await post(b, 'signup', { email: 'ana@example.com', password: PW, consent: CONSENT_VERSION })).status).toBe(429);
    expect(outbox.length).toBe(1);
  });
});
