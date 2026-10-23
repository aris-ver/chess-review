// Blundr's server in the browser: js/server over the browser's adapters, as js/desktop/main.js builds it over the
// data folder. The leading worker (js/web/tabs.js) runs it; answer() turns the router's answers into the messages
// the page's shim (web/shim.js) reads.

import { loadBook } from '../core/book.js';
import { DEFAULT_NODES } from '../core/config.js';
import { Store } from '../server/db.js';
import { rebuild } from '../server/games.js';
import { Packs } from '../server/packs.js';
import { Profiles } from '../server/profiles.js';
import { Pack } from '../server/puzzles.js';
import { serve } from '../server/router.js';
import { build as buildSite } from '../server/site.js';

const enc = new TextEncoder();

/** A logger with the desktop's methods, onto the console. */
export const consoleLog = {
  debug: () => {},
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

export class NotLoaded extends Error {}

/** Every game of every profile classified again from the cached evals, and its site rebuilt: what the first start
 * after the move from Python does once (the JS fingerprints games its own way, docs/js-port.md). */
export async function reclassifyAll(env, log = consoleLog) {
  const withSite = { site: (db, p) => buildSite(db, env.files, p), ...env };
  const done = [];
  for (const p of await env.profiles.list()) {
    try {
      await rebuild(withSite, p);
      done.push(p.id);
    } catch (e) {
      log.error(`reclassifying ${p.id} failed`, e);
    }
  }
  return done;
}

/** The router over driver (js/web/db.js's webSqlite) and files (an opfsFiles adapter), with the engine pool.
 * site: the static files the server reads, as fetch-able texts: { book, puzzles, packs } → Promise<string>
 * (puzzles may come late: puzzle requests wait for `packReady`). before(env): runs once the env is built and before
 * serve() starts anything (the migration's reclassification). Returns { router, env, packReady }. */
export async function startApp({ driver, files, pool, fetch = globalThis.fetch?.bind(globalThis), site, log = consoleLog,
                                 nodes = DEFAULT_NODES, scan = true, before = null }) {
  let packRows = null;
  const packReady = site.puzzles().then(text => { packRows = JSON.parse(text); });
  packReady.catch(e => log.error('the puzzle pack failed to load', e));
  const pack = new Pack(() => {
    if (packRows === null) throw new NotLoaded('the puzzle pack is still loading');
    return packRows;
  });
  const [book, packsText] = await Promise.all([site.book().catch(e => (log.warn('no opening book', e), '')),
                                               site.packs().catch(e => (log.warn('no packs.json', e), null))]);
  if (book) loadBook(book);
  const packs = new Packs(() => {
    if (packsText === null) throw new Error('no packs.json');
    return JSON.parse(packsText);
  });
  const store = new Store(driver);
  const env = { store, files, profiles: new Profiles(files, store), fetch, log, pack, packs };
  if (before) await before(env);
  const router = await serve({ env, pool, nodes, log, scan });
  return { router, env, packReady };
}

const isStream = b => b != null && typeof b !== 'string' && !(b instanceof Uint8Array) && typeof b[Symbol.asyncIterator] === 'function';
const bytes = b => (b == null ? new Uint8Array(0) : typeof b === 'string' ? enc.encode(b) : b);

/** The answer to one request, as messages to emit(): {type:'response', status, headers: [[k, v]], body} or, for a
 * stream, a 'response' with stream: true, its {type:'chunk', body} and {type:'end'}. Waits for `ready`
 * (startApp's result); puzzle requests and POSTs also for the pack. signal: the page gave up (a stream stops its
 * engine). */
export async function answer(ready, { method, path, body = null, contentType = null }, emit, signal) {
  let out;
  try {
    const { router, packReady } = await ready;
    if (path.startsWith('/api/puzzles') || method !== 'GET') await packReady.catch(() => {});
    out = await router.handle(method, path, body, contentType);
  } catch (e) {
    out = { status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e?.message ?? e) }) };
  }
  const headers = Object.entries(out.headers ?? {});
  if (!isStream(out.body)) {
    emit({ type: 'response', status: out.status, headers, body: bytes(out.body) });
    return;
  }
  emit({ type: 'response', status: out.status, headers, stream: true });
  const it = out.body[Symbol.asyncIterator]();
  const stop = () => { it.return?.()?.catch?.(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (!signal?.aborted) {
      const { value, done } = await it.next();
      if (done || signal?.aborted) break;
      emit({ type: 'chunk', body: bytes(value) });
    }
  } catch (e) {
    consoleLog.error('stream failed', e);
  } finally {
    stop();
    emit({ type: 'end' });
  }
}
