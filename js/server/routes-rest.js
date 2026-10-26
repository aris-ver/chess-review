// The rest of serve.Handler: /account/* (account.js), POST /api/sync/* (sync.js), GET /api/fetch_image, GET and
// POST /api/settings (settings.js), and the updater's GET /api/update, POST /api/update/download and
// /api/update/apply (updater.js). Same status codes, JSON and messages as serve.py.
//
// What they work through comes from the router's env, each made with defaults when it isn't there:
//     env.account    an account.js Account (default: over env.fetch and env.files, no browser to open, no port)
//     env.updater    an updater.js Updater (default: disabled, as outside the packaged desktop app)
//     env.sync       a sync.js Sync (default: over env.files, env.store, the router's runner and the own-puzzle pool)
//     env.onSwitch   called after a sync switch or release moved the profiles (own puzzles' cache)
//     env.fetch      for /api/fetch_image
// The account's Host/Origin check (serve.Handler._account's) is the local server's: js/desktop/server.js.

import { Account, Unreachable } from './account.js';
import { BadRequest, json, jsonBody } from './http.js';
import { BACKGROUND } from './jobs.js';
import { library } from './routes-puzzles.js';
import { loadSettings, saveSettings, validSettings } from './settings.js';
import { Sync } from './sync.js';
import { USER_AGENT, Updater, raiseForStatus } from './updater.js';

/** The job kinds this module adds to the Runner: kind → async (runner, job) => void. */
export const work = {};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const defaults = new WeakMap();     // router → the adapters made for it

function parts(router) {
  let d = defaults.get(router);
  if (!d) {
    const { env } = router;
    d = {};
    defaults.set(router, d);
    d.account = new Account({ fetch: env.fetch, files: env.files, log: router.log });
    d.updater = new Updater({ fetch: env.fetch, files: env.files, log: router.log });
    d.sync = new Sync({ files: env.files, store: env.store, runner: router.runner, log: router.log,
                        onSwitch: () => env.onSwitch?.(), ownPuzzles: id => library(env).pool.load({ id }) });
  }
  const { env } = router;
  return { account: env.account ?? d.account, updater: env.updater ?? d.updater, sync: env.sync ?? d.sync };
}

const bytes = body => (body == null ? new Uint8Array(0) : typeof body === 'string' ? new TextEncoder().encode(body) : body);

/** The answer to one of these routes, or null when the path isn't one. */
export async function handle(router, method, url, body, contentType) {
  const path = url.pathname;
  if (path.startsWith('/account/') && (method === 'GET' || method === 'POST')) return account(router, method, url, body);
  if (method === 'POST' && path.startsWith('/api/sync/')) return sync(router, path, body);
  if (method === 'GET' && path === '/api/fetch_image') return fetchImage(router, url.searchParams.get('url') ?? '');
  if (path === '/api/settings') {
    if (method === 'GET') return json(await loadSettings(router.env.files));
    if (method === 'POST') {
      const b = jsonBody(body);
      if (!validSettings(b)) return json({ error: '{key: string | null} expected' }, 400);
      await saveSettings(router.env.files, b);
      return json({ ok: true });
    }
  }
  if (method === 'GET' && path === '/api/update') {
    const { updater } = parts(router);
    await updater.check(url.searchParams.get('check') === '1');
    return json(updater.status());
  }
  if (method === 'POST' && path === '/api/update/download') {
    const { updater } = parts(router);
    await updater.check();
    return json({ ok: updater.download(), ...updater.status() });
  }
  if (method === 'POST' && path === '/api/update/apply') {
    const r = router.runner;
    if (r.busy() && !BACKGROUND.includes(r.job.kind)) return json({ error: 'busy', job: r.job.toDict() }, 409);   // these carry on after the restart
    try {
      await parts(router).updater.apply();
    } catch (e) {
      return json({ error: String(e?.message ?? e) }, 400);
    }
    return json({ ok: true });
  }
  return null;
}

async function account(router, method, url, body) {
  try {
    return await parts(router).account.handle(method, url.pathname, url.search.slice(1), method === 'POST' ? bytes(body) : null);
  } catch (e) {
    if (e instanceof Unreachable) {
      router.log?.info?.(`account ${url.pathname}: ${e.message}`);
      return json({ error: "Blundr can't be reached. Check the internet connection and try again." }, 502);
    }
    if (e instanceof BadRequest || e instanceof SyntaxError) return json({ error: `bad account request: ${e.message}` }, 400);
    throw e;
  }
}

async function sync(router, path, body) {
  let out;
  try {
    out = await parts(router).sync.handle(path, jsonBody(body));
  } catch (e) {
    if (!(e instanceof BadRequest || e instanceof SyntaxError)) throw e;
    out = null;
  }
  return out !== null ? json(out) : json({ error: 'bad sync request' }, 400);
}

/** The browser reads the board off a canvas, and a cross-origin image would taint it: fetched here instead. */
async function fetchImage(router, target) {
  if (!target.startsWith('http://') && !target.startsWith('https://')) return json({ error: 'http(s) URL required' }, 400);
  let ctype, out;
  try {
    const resp = await router.env.fetch(target, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    raiseForStatus(resp, target);
    ctype = resp.headers.get('Content-Type') ?? '';
    if (!ctype.startsWith('image/')) {
      await resp.body?.cancel().catch(() => {});
      return json({ error: `not an image (${ctype || 'unknown type'})` }, 415);
    }
    out = await readAtMost(resp, MAX_IMAGE_BYTES + 1);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 502);
  }
  if (out.length > MAX_IMAGE_BYTES) return json({ error: 'image larger than 10 MB' }, 413);
  return { status: 200, headers: { 'Content-Type': ctype }, body: out };
}

/** Up to n bytes of a response's body (resp.raw.read(n)). */
async function readAtMost(resp, n) {
  const chunks = [];
  let got = 0;
  const reader = resp.body?.getReader();
  while (reader && got < n) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  if (reader && got >= n) await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(got, n));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at);
    all.set(part, at);
    at += part.length;
    if (at >= all.length) break;
  }
  return all;
}
