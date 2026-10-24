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
//
// The desktop app (chess_review/account.py) has no cookie jar: it sends X-Blundr-App: 1 and gets the session token in
// the body instead of a cookie, then sends it back as Authorization: Bearer. Its provider sign-ins run in the system
// browser and come back to the app's loopback port:
//   POST /account/app/start              {provider, mode, consent, challenge, port} -> {url}: a path, to open in the browser
//   GET  /account/login/<provider>?resume=<state>   the browser's way in to that sign-in
//   POST /account/app/token              {code, verifier} -> {token, user}: the code the loopback address was sent

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

// The session token: the cookie from a browser, the Authorization header from the desktop app.
function sessionToken(req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{20,})$/);
  return m ? m[1] : cookies(req)[SESSION];
}
const fromApp = req => req.headers.get('X-Blundr-App') === '1';

async function currentUser(req, env) {
  const token = sessionToken(req);
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

// A sign-in about to go to the provider: kept in D1 with a fresh state and PKCE verifier. Returns the state.
async function beginLogin(req, env, id, mode, consent, app = {}) {
  if (!['login', 'signup', 'link'].includes(mode)) throw new HttpError(400, 'mode: login, signup or link');
  if (mode === 'signup' && consent !== CONSENT_VERSION) {
    throw new HttpError(400, 'sign-up needs agreement to the current terms and privacy policy');
  }
  const linkUser = mode === 'link' ? await requireUser(req, env) : null;
  const state = randomToken(24), verifier = randomToken(48);
  await store.startLogin(env.DB, { state, provider: id, verifier, mode, linkUser, appChallenge: app.challenge, appPort: app.port, now: now() });
  return { state, verifier };
}

// Off to the provider, with the cookie that ties the way back to this browser.
async function toProvider(env, url, id, state, verifier) {
  const to = provider(env, id).authorizeUrl(env, { redirectUri: redirectUri(url, id), state, challenge: await sha256(verifier) });
  return redirect(to, [cookie(url, LOGIN, state, 900)]);
}

async function login(req, env, url, id) {
  provider(env, id);
  const resume = url.searchParams.get('resume');
  if (resume) {                    // the desktop app's sign-in (appStart), opened in the system browser
    const l = await store.appLogin(env.DB, resume, now());
    if (!l || l.provider !== id) return redirect('/?account=error');
    return toProvider(env, url, id, resume, l.verifier);
  }
  const { state, verifier } = await beginLogin(req, env, id, url.searchParams.get('mode') || 'login', url.searchParams.get('consent'));
  return toProvider(env, url, id, state, verifier);
}

const B64URL = /^[A-Za-z0-9_-]{43}$/;      // a SHA-256 in base64url

async function body(req) {
  let b;
  try { b = await req.json(); } catch { throw new HttpError(400, 'JSON expected'); }
  if (!b || typeof b !== 'object') throw new HttpError(400, 'JSON expected');
  return b;
}

async function appStart(req, env, url) {
  const b = await body(req);
  const id = String(b.provider || '');
  provider(env, id);
  const port = Number(b.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new HttpError(400, 'port: 1024 to 65535');
  if (!B64URL.test(String(b.challenge))) throw new HttpError(400, 'challenge: a base64url SHA-256');
  const { state } = await beginLogin(req, env, id, String(b.mode || 'login'), b.consent, { challenge: b.challenge, port });
  return json({ url: `/account/login/${id}?resume=${state}` });      // on the site the app talks to
}

async function appToken(req, env, url) {
  const b = await body(req);
  const c = await store.takeAppCode(env.DB, await sha256(String(b.code || '')), now());
  // only the app that started the sign-in knows the verifier: a code read off the loopback redirect is no use alone
  if (!c || c.challenge !== await sha256(String(b.verifier || ''))) throw new HttpError(400, 'that sign-in code is wrong or has expired');
  const token = await newSession(env, c.user_id, now());
  return json({ token, user: await store.account(env.DB, c.user_id) });
}

async function callback(req, env, url, id) {
  let app = null;        // the desktop app's sign-in: the outcome goes to its loopback address, not to the site
  const done = async (outcome, userId) => {
    const clear = cookie(url, LOGIN, '', 0);
    if (app) {
      const to = new URL(`http://127.0.0.1:${app.app_port}/account/callback`);
      to.searchParams.set('account', outcome);
      to.searchParams.set('state', state);
      if (userId) {
        const code = randomToken();
        await store.putAppCode(env.DB, await sha256(code), userId, app.app_challenge, now());
        to.searchParams.set('code', code);
      }
      return redirect(to.href, [clear]);
    }
    return redirect(`/?account=${outcome}`, [clear, ...(userId ? [await startSession(env, url, userId, now())] : [])]);
  };
  const p = provider(env, id);
  const state = url.searchParams.get('state') || '';
  // the state must be the one this browser was sent off with, or someone else's sign-in could land here
  if (!state || cookies(req)[LOGIN] !== state) return done('error');
  const l = await store.takeLogin(env.DB, state, now());
  if (!l || l.provider !== id) return done('error');
  if (l.app_challenge) app = l;
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
  return done(outcome, userId);
}

// A new session for userId: its token.
async function newSession(env, userId, t) {
  const token = randomToken();
  await store.createSession(env.DB, await sha256(token), userId, t, SESSION_DAYS);
  return token;
}

// A new session for userId: its Set-Cookie header.
async function startSession(env, url, userId, t) {
  return cookie(url, SESSION, await newSession(env, userId, t), SESSION_DAYS * 86400);
}

const EMAIL_STEPS = ['signup', 'verify', 'login', 'forgot', 'reset', 'link'];

async function emailStep(req, env, url, step) {
  const b = await body(req);
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
  const answer = { ok: true, created: Boolean(out.created), user: await store.account(env.DB, out.userId) };
  if (fromApp(req)) return json({ ...answer, token: await newSession(env, out.userId, t) });
  return json(answer, 200, { 'Set-Cookie': await startSession(env, url, out.userId, t) });
}

async function route(req, env, url) {
  const path = url.pathname;
  const m = path.match(/^\/account\/(login|callback|unlink)\/([a-z]+)$/);
  if (req.method === 'POST') {
    // A cookie-carrying POST from another site must not act for you (SameSite=Lax stops most; this stops the rest).
    // The desktop app sends no Origin but a header of its own, which no page on another site can send: a browser asks
    // first (CORS preflight), and nothing here says yes.
    if (req.headers.get('Origin') !== url.origin && !fromApp(req)) throw new HttpError(403, 'cross-site request');
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
  if (req.method === 'POST' && path === '/account/app/start') return appStart(req, env, url);
  if (req.method === 'POST' && path === '/account/app/token') return appToken(req, env, url);
  if (req.method === 'POST' && path === '/account/logout') {
    const token = sessionToken(req);
    if (token) await store.deleteSession(env.DB, await sha256(token));
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(url, SESSION, '', 0) });
  }
  if (path === '/account/progress' && (req.method === 'GET' || req.method === 'POST')) {
    const u = await requireUser(req, env);
    if (req.method === 'POST') {
      const b = await body(req);
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
    if (!url.pathname.startsWith('/account/')) {
      // A file the site doesn't have comes here. Under /v/ (the code, kept a year: _headers) that is a version gone
      // with a deploy, and its 404 would carry the year too; asked for again it may be there (a deploy in between)
      const res = await env.ASSETS.fetch(req);
      if (res.status !== 404 || !url.pathname.startsWith('/v/')) return res;
      return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
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
