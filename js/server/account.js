// The desktop app's way to the Blundr account, as chess_review/account.py (docs/accounts.md). static/account.js is
// the same page code on the website and here: on the website its account/* requests reach the Worker with the
// session cookie; here they come to the local server, which hands them to handle(), and go on to the Worker at
// `site` with the session token kept in DATA/account_token.json. Only this module sees the token; the page never does.
//
//     GET  /account/me                  the Worker's answer, plus {app: true, site, outcome}: outcome is how a sign-in
//                                       in the browser ended (once), for the page that waits for it
//     POST /account/app/login/<p>       {mode, consent}: a Lichess or Google sign-in, opened in the system browser
//     GET  /account/callback            the browser, back from blundr.gr: its one-time code swapped for the token
//     POST /account/app/export          everything the account keeps, saved to the Downloads folder
//     anything else under /account/     passed on as it is (email and password, progress, logout, unlink, delete)
//
// Through what the constructor is given: fetch, files (the data directory), site (BLUNDR_URL), port() (the local
// server's, which the Worker sends the browser back to), openBrowser(url) (the system browser) and saveExport(bytes)
// → the path it was saved at. Only from the app's own page: the Host/Origin check is the local server's
// (js/desktop/server.js).

import { BadRequest, json } from './http.js';
import { pyDumps } from './profiles.js';
import { USER_AGENT } from './updater.js';

export const SITE = 'https://blundr.gr';
export const TOKEN_FILE = 'account_token.json';
export const TIMEOUT_MS = 20_000;

/** blundr.gr can't be reached (requests.RequestException): the route answers 502. */
export class Unreachable extends Error {}

const enc = new TextEncoder(), dec = new TextDecoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** parse_qs(query) with its first values: blank values are dropped, as Python drops them. */
function parseQs(query) {
  const out = {};
  for (const [k, v] of new URLSearchParams(query)) if (v !== '' && !(k in out)) out[k] = v;
  return out;
}

/** d[key] as Python's d[key]: a missing key is a KeyError, which the route answers with a 400. */
function need(d, key) {
  if (d === null || typeof d !== 'object' || !(key in d)) throw new BadRequest(`'${key}'`);
  return d[key];
}

// What the browser tab says once it's back, by outcome (the page in the app says the rest).
export const DONE = {
  'signed-in': "You're logged in. Go back to the Blundr app: your puzzle progress and profiles sync from there.",
  welcome: 'Welcome to Blundr! Go back to the app: your puzzle progress and profiles are saved to your account.',
  linked: 'Done: you can sign in that way too. Go back to the Blundr app.',
  'no-account': 'There is no Blundr account for that sign-in yet. Go back to the Blundr app to sign up.',
  taken: 'That sign-in already belongs to another Blundr account. Go back to the Blundr app.',
  cancelled: 'Sign-in cancelled. Go back to the Blundr app to try again.',
  error: "Signing in didn't work. Go back to the Blundr app and try again.",
};

export function page(text) {
  const html = '<!doctype html><meta charset=utf-8><title>Blundr</title>' +
    '<body style="font:16px system-ui,sans-serif;background:#302e2b;color:#e8e6e3;display:grid;place-items:center;' +
    'height:90vh;margin:0"><div style="max-width:420px;text-align:center"><h2>Blundr</h2>' +
    `<p>${text}</p><p style="color:#9c9893">You can close this tab.</p></div>`;
  return { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
}

export class Account {
  constructor({ fetch = globalThis.fetch, files, site = SITE, port = () => null, openBrowser = null, saveExport = null,
                random = n => crypto.getRandomValues(new Uint8Array(n)), log = null } = {}) {
    Object.assign(this, { fetch, files, port, openBrowser, saveExport, random, log });
    this.site = site.replace(/\/+$/, '');
    this.pending = null;        // the provider sign-in open in the browser: {state, verifier}
    this.outcome = null;        // how the last one ended, until the page asks
  }

  /** The session token for this site, if signed in (one kept for another site doesn't count). */
  async loadToken() {
    try {
      const d = JSON.parse(await this.files.readText(TOKEN_FILE));
      return d.site === this.site ? d.token ?? null : null;
    } catch {
      return null;
    }
  }

  async saveToken(token) {
    if (!token) {
      await this.files.remove(TOKEN_FILE);
      return;
    }
    await this.files.writeText('account_token.tmp', pyDumps({ site: this.site, token }));
    await this.files.rename('account_token.tmp', TOKEN_FILE);
  }

  /** The Worker's answer to one request, as the app: its own header (the Worker's stand-in for the site's Origin), and
   * the token if there is one. {status, ok, type, bytes, json()} */
  async call(method, path, body = null) {
    const headers = { 'X-Blundr-App': '1', 'User-Agent': USER_AGENT, Accept: 'application/json' };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const token = await this.loadToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let r, bytes;
    try {
      r = await this.fetch(this.site + path, { method, headers, body: body === null ? undefined : body, redirect: 'manual',
                                               signal: AbortSignal.timeout(TIMEOUT_MS) });
      bytes = new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      throw new Unreachable(String(e?.message ?? e));
    }
    if (r.status === 401 && token) await this.saveToken(null);     // the session ended elsewhere
    return { status: r.status, ok: r.status < 400, type: r.headers.get('Content-Type'), bytes, json: () => JSON.parse(dec.decode(bytes)) };
  }

  passed(r) {
    return { status: r.status, headers: { 'Content-Type': r.type ?? 'application/json' }, body: r.bytes };
  }

  /** The answer to the page's account/* request. Throws Unreachable when blundr.gr can't be reached, and BadRequest or
   * SyntaxError for a request it can't make sense of. body: the POST's bytes (null for a GET). */
  async handle(method, path, query, body) {
    if (body !== null && typeof body === 'string') body = enc.encode(body);
    if (method === 'GET' && path === '/account/me') {
      const r = await this.call('GET', path);
      if (!r.ok) return this.passed(r);
      const d = r.json();
      if ((d.user ?? null) === null) await this.saveToken(null);
      Object.assign(d, { app: true, site: this.site, outcome: this.outcome });
      this.outcome = null;
      return json(d);
    }

    if (method === 'POST' && path.startsWith('/account/app/login/')) {
      const b = JSON.parse(body && body.length ? dec.decode(body) : '{}');
      const verifier = b64url(this.random(48));
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
      const r = await this.call('POST', '/account/app/start', enc.encode(pyDumps({
        provider: path.split('/').at(-1), mode: b.mode ?? null, consent: b.consent ?? null, port: this.port() ?? null, challenge })));
      if (!r.ok) return this.passed(r);
      const url = this.site + need(r.json(), 'url');
      const state = need(parseQs(new URL(url).search.slice(1)), 'resume');
      this.pending = { state, verifier };
      this.outcome = null;
      if (this.openBrowser) await this.openBrowser(url);
      else this.log?.warn?.(`no browser to open ${url}`);
      return json({ url });
    }

    if (method === 'GET' && path === '/account/callback') {
      const q = parseQs(query);
      const p = this.pending;
      if (!p || q.state !== p.state) return page("This isn't the sign-in Blundr is waiting for. Start again from the app.");
      this.pending = null;
      let outcome = q.account || 'error';
      if (q.code) {
        const t = await this.call('POST', '/account/app/token', enc.encode(pyDumps({ code: q.code, verifier: p.verifier })));
        if (t.ok) {
          await this.saveToken(need(t.json(), 'token'));
        } else {
          this.log?.warn?.(`sign-in code refused: ${t.status} ${dec.decode(t.bytes).slice(0, 200)}`);
          outcome = 'error';
        }
      }
      this.outcome = outcome;
      return page(Object.hasOwn(DONE, outcome) ? DONE[outcome] : DONE.error);
    }

    if (method === 'POST' && path === '/account/app/export') {
      const r = await this.call('GET', '/account/export');
      if (!r.ok) return this.passed(r);
      if (!this.saveExport) throw new Error('nowhere to save the export');
      return json({ path: await this.saveExport(r.bytes) });
    }

    if (path === '/account/logout') {
      let r = null;
      try {
        r = await this.call(method, path, body);
      } catch (e) {
        if (!(e instanceof Unreachable)) throw e;   // offline: the token goes all the same (the session expires on its own)
      }
      await this.saveToken(null);
      return r !== null ? this.passed(r) : json({ ok: true });
    }
    const r = await this.call(method, path, body);
    if (path === '/account/delete' && r.ok) await this.saveToken(null);
    if (r.ok && path.startsWith('/account/email/') && (r.type ?? '').includes('application/json')) {
      const d = r.json();
      if (d.token) {          // signed in by email: the token stays here, the page gets the rest
        await this.saveToken(d.token);
        delete d.token;
      }
      return json(d);
    }
    return this.passed(r);
  }
}
