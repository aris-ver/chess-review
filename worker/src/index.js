// Blundr's Worker. Every request but /account/* is a file of the static site (web-dist/), which Cloudflare serves
// without running this code. /account/* is the optional account: sign in with Lichess or Google, keep puzzle
// progress, download it, delete it. docs/accounts.md has the design; reviewed games never come here.
//
//   GET  /account/me                     {user, providers}: who is signed in (user is null for a guest)
//   GET  /account/login/<provider>?mode= login | signup (needs consent=<CONSENT_VERSION>) | link
//   GET  /account/callback/<provider>    back from the provider: sets the session cookie, returns to /?account=...
//   POST /account/logout
//   GET  /account/progress               {files: {file: [line, ...]}}
//   POST /account/progress               {add: {file: [lines]}, remove: {file: [lines]}} -> {files}
//   POST /account/email/<step>           email and password: signup, verify, login, forgot, reset, link (email.js)
//   POST /account/unlink/<provider>      drop a sign-in method (not the last one)
//   GET  /account/export                 everything kept about you, as a JSON download
//   POST /account/delete                 the account and all its data, at once

import { CONSENT_VERSION } from './consent.js';
import * as email from './email.js';
import { providers, SignInError } from './providers.js';
import * as store from './store.js';
const SESSION = 'blundr_session';
const LOGIN = 'blundr_login';
const SESSION_DAYS = 90;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => Math.floor(Date.now() / 1000);

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Strictly necessary cookies only: the session, and the few minutes a sign-in spends at the provider. HttpOnly, so
// no script on the page can read them; Lax, so they come back from the provider's redirect but not on other sites'
// requests. Secure everywhere but plain-http localhost (wrangler dev).
function cookie(url, name, value, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${name}=${value}; Path=/account/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const redirect = (location, setCookies = []) => {
  const h = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const c of setCookies) h.append('Set-Cookie', c);
  return new Response(null, { status: 302, headers: h });
};

async function currentUser(req, env) {
  const token = cookies(req)[SESSION];
  return token ? store.sessionUser(env.DB, await sha256(token), now(), SESSION_DAYS) : null;
}

async function requireUser(req, env) {
  const u = await currentUser(req, env);
  if (!u) throw new HttpError(401, 'not signed in');
  return u;
}

// What's on offer: Lichess always, Google once its client id and secret are set.
function available(env) {
  return Object.entries(providers).filter(([, p]) => p.configured(env)).map(([id, p]) => ({ id, name: p.name }));
}

function provider(env, id) {
  const p = Object.hasOwn(providers, id) ? providers[id] : null;
  if (!p || !p.configured(env)) throw new HttpError(404, 'no such sign-in method');
  return p;
}

const redirectUri = (url, id) => `${url.origin}/account/callback/${id}`;

async function login(req, env, url, id) {
  const p = provider(env, id);
  const mode = url.searchParams.get('mode') || 'login';
  if (!['login', 'signup', 'link'].includes(mode)) throw new HttpError(400, 'mode: login, signup or link');
  if (mode === 'signup' && url.searchParams.get('consent') !== CONSENT_VERSION) {
    throw new HttpError(400, 'sign-up needs agreement to the current terms and privacy policy');
  }
  const linkUser = mode === 'link' ? await requireUser(req, env) : null;
  const state = randomToken(24), verifier = randomToken(48);
  await store.startLogin(env.DB, { state, provider: id, verifier, mode, linkUser, now: now() });
  const to = p.authorizeUrl(env, { redirectUri: redirectUri(url, id), state, challenge: await sha256(verifier) });
  return redirect(to, [cookie(url, LOGIN, state, 900)]);
}

async function callback(req, env, url, id) {
  const done = (outcome, extra = []) => redirect(`/?account=${outcome}`, [cookie(url, LOGIN, '', 0), ...extra]);
  const p = provider(env, id);
  const state = url.searchParams.get('state') || '';
  // the state must be the one this browser was sent off with, or someone else's sign-in could land here
  if (!state || cookies(req)[LOGIN] !== state) return done('error');
  const l = await store.takeLogin(env.DB, state, now());
  if (!l || l.provider !== id) return done('error');
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return done('cancelled');
  let who;
  try {
    who = await p.identify(env, { code: url.searchParams.get('code'), verifier: l.verifier, redirectUri: redirectUri(url, id) });
  } catch (e) {
    if (!(e instanceof SignInError)) throw e;
    console.error(e.message);
    return done('error');
  }
  const t = now();
  let userId = await store.identityUser(env.DB, id, who.subject);
  let outcome = 'signed-in';
  if (l.mode === 'link') {
    if (userId && userId !== l.link_user) return done('taken');
    if (!userId) await store.addIdentity(env.DB, l.link_user, id, who, t);
    userId = l.link_user;
    outcome = 'linked';
  } else if (userId) {
    await store.refreshIdentity(env.DB, id, who);
  } else if (l.mode === 'signup') {
    userId = crypto.randomUUID();
    await store.createUser(env.DB, { id: userId, now: t, consentVersion: CONSENT_VERSION }, id, who);
    outcome = 'welcome';
  } else {
    return done('no-account');     // logging in to an account that doesn't exist: the page offers to sign up
  }
  return done(outcome, [await startSession(env, url, userId, t)]);
}

// A new session for userId: its Set-Cookie header.
async function startSession(env, url, userId, t) {
  const token = randomToken();
  await store.createSession(env.DB, await sha256(token), userId, t, SESSION_DAYS);
  return cookie(url, SESSION, token, SESSION_DAYS * 86400);
}

const EMAIL_STEPS = ['signup', 'verify', 'login', 'forgot', 'reset', 'link'];

async function emailStep(req, env, url, step) {
  let b;
  try { b = await req.json(); } catch { throw new HttpError(400, 'JSON expected'); }
  if (!b || typeof b !== 'object') throw new HttpError(400, 'JSON expected');
  const t = now();
  const signedIn = await currentUser(req, env);
  if (step === 'link' && !signedIn) throw new HttpError(401, 'not signed in');
  let out;
  try {
    out = await email[step](env, b, {
      now: t, signedIn, consentVersion: CONSENT_VERSION,
      createUser: (id, provider, who) => store.createUser(env.DB, { id, now: t, consentVersion: CONSENT_VERSION }, provider, who),
      addIdentity: (id, provider, who) => store.addIdentity(env.DB, id, provider, who, t),
    });
  } catch (e) {
    if (e instanceof email.EmailError) throw new HttpError(e.status, e.message);
    throw e;
  }
  if (!out.userId || out.linked) {
    return json({ ok: true, user: out.linked ? await store.account(env.DB, out.userId) : undefined });
  }
  const sc = await startSession(env, url, out.userId, t);
  return json({ ok: true, created: Boolean(out.created), user: await store.account(env.DB, out.userId) }, 200, { 'Set-Cookie': sc });
}

async function route(req, env, url) {
  const path = url.pathname;
  const m = path.match(/^\/account\/(login|callback|unlink)\/([a-z]+)$/);
  if (req.method === 'POST') {
    // A cookie-carrying POST from another site must not act for you (SameSite=Lax stops most; this stops the rest).
    if (req.headers.get('Origin') !== url.origin) throw new HttpError(403, 'cross-site request');
  }
  if (req.method === 'GET' && path === '/account/me') {
    const u = await currentUser(req, env);
    return json({ user: u && await store.account(env.DB, u), providers: available(env), consent_version: CONSENT_VERSION,
                  min_password: email.MIN_PASSWORD });
  }
  const em = path.match(/^\/account\/email\/([a-z]+)$/);
  if (req.method === 'POST' && em && EMAIL_STEPS.includes(em[1])) return emailStep(req, env, url, em[1]);
  if (req.method === 'GET' && m && m[1] === 'login') return login(req, env, url, m[2]);
  if (req.method === 'GET' && m && m[1] === 'callback') return callback(req, env, url, m[2]);
  if (req.method === 'POST' && path === '/account/logout') {
    const token = cookies(req)[SESSION];
    if (token) await store.deleteSession(env.DB, await sha256(token));
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(url, SESSION, '', 0) });
  }
  if (path === '/account/progress' && (req.method === 'GET' || req.method === 'POST')) {
    const u = await requireUser(req, env);
    if (req.method === 'POST') {
      let b;
      try { b = await req.json(); } catch { throw new HttpError(400, 'JSON expected'); }
      try {
        await store.applyProgress(env.DB, u, store.checkLines(b.add, 'add'), store.checkLines(b.remove, 'remove'), now());
      } catch (e) {
        if (e instanceof store.BadRequest) throw new HttpError(400, e.message);
        throw e;
      }
    }
    return json({ files: await store.progress(env.DB, u) });
  }
  if (req.method === 'POST' && m && m[1] === 'unlink') {
    const u = await requireUser(req, env);
    try { await store.removeIdentity(env.DB, u, m[2]); } catch (e) {
      if (e instanceof store.BadRequest) throw new HttpError(400, e.message);
      throw e;
    }
    return json({ user: await store.account(env.DB, u) });
  }
  if (req.method === 'GET' && path === '/account/export') {
    const u = await requireUser(req, env);
    const body = { exported_at: new Date().toISOString(), ...await store.exportAll(env.DB, u) };
    return json(body, 200, { 'Content-Disposition': 'attachment; filename="blundr-account.json"' });
  }
  if (req.method === 'POST' && path === '/account/delete') {
    const u = await requireUser(req, env);
    await store.deleteUser(env.DB, u);
    return json({ deleted: true }, 200, { 'Set-Cookie': cookie(url, SESSION, '', 0) });
  }
  throw new HttpError(404, 'not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/account/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(store.expire(env.DB, now(), Number(env.RETENTION_DAYS) || 730));
  },
};
