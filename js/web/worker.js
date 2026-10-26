// The worker every tab starts (web/shim.js), in web/py-worker.js's place: Blundr's JS server answering the page's
// api/... and p/... requests. One of the tabs' workers leads (tabs.js): it opens the SQLite files in OPFS, runs the
// job runner and the Stockfish pool, and answers every tab; the others relay. A module worker, so the same ES
// modules as the desktop's run here unchanged.

import '../../web/config.js';
import { EnginePool, physicalCores } from '../../web/engines.js';
import { opfsFiles, memoryFiles } from '../server/profiles-files.js';
import { answer, consoleLog as log, reclassifyAll, startApp } from './app.js';
import { webSqlite } from './db.js';
import { migrateOnce, within } from './legacy.js';
import { Tabs } from './tabs.js';

const CR_CONFIG = self.CR_CONFIG;
// the site's root: config.js says where it is from the code's (scripts/build_web.js serves the code under v/<version>/)
const site = path => new URL((CR_CONFIG.site ?? '') + path, new URL('../../', import.meta.url)).href;
const web = path => new URL(path, site('web/')).href;                      // config.js's URLs are relative to web/

const tabs = new Tabs({ toPage: msg => postMessage(msg), channel: new BroadcastChannel('blundr'), log });
const progress = (what, done, total, text) => tabs.progress({ what, done, total, text });

// Phones (a worker named "lite": web/shim.js decides): the 95 MB engine compiled once per core is more memory than iOS
// gives a tab, which it then kills and reloads, over and over. One lite engine (2 MB, a smaller net: evals differ a little from the
// full engine's) with a small hash instead. Evals never leave the browser, so the two engines' never mix.
const LITE = self.name === 'lite';
const engineName = (CR_CONFIG.engineName || 'Stockfish') + (LITE ? ' lite' : '');
const pool = () => new EnginePool({
  ...(LITE ? { size: 1, hash: 16, script: web('engine/stockfish-19-lite-single.js'),
               wasmUrl: web(CR_CONFIG.engineLiteWasm || 'engine/stockfish-19-lite-single.wasm'), wasmBytes: CR_CONFIG.engineLiteBytes || 0 }
           : { size: physicalCores(), script: web('engine/stockfish-19-single.js'),
               wasmUrl: web(CR_CONFIG.engineWasm), wasmBytes: CR_CONFIG.engineBytes }),
  onProgress: (done, total) => progress('engine', done, total, engineName),
});

const text = async path => {
  const r = await fetch(site(path));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
};

/** Elected: open the data, start the server, and answer from then on. Requests wait for it. */
function lead() {
  const t0 = performance.now();
  progress('app', 0, 1, 'Loading Blundr');
  const engines = pool();
  const ready = (async () => {
    let driver, files;
    try {
      // another worker still holding the pool's files (a tab that hasn't let go) would make this wait for good
      driver = await within(webSqlite(), 'opening the browser storage', 30);
      files = await opfsFiles('data');
    } catch (e) {     // no OPFS (a private window in some browsers): run, but nothing is kept
      if (e?.name === 'TimeoutError') {
        throw new Error("the browser storage didn't open. Close the other Blundr tabs, then reload this one.");
      }
      log.error('no OPFS: the data stays in memory for this visit', e);
      driver = await webSqlite({ memory: true });
      files = memoryFiles();
    }
    const legacy = CR_CONFIG.legacy && {
      pyodide: CR_CONFIG.legacy.pyodide, wheel: site(CR_CONFIG.legacy.wheel), app: site(CR_CONFIG.legacy.app),
    };
    const moved = legacy ? await migrateOnce({ driver, files, legacy, log, progress: t => progress('app', 0, 1, t) }) : null;
    const out = await startApp({
      driver, files, pool: engines, log, ...(CR_CONFIG.nodes ? { nodes: CR_CONFIG.nodes } : {}),   // nodes: tests only
      site: { book: () => text('book_keys.txt'), puzzles: () => text('puzzles.json'), packs: () => text('packs.json') },
      before: moved && moved.status === 'done' ? async env => {
        progress('app', 0, 1, 'Classifying your games again (once)');
        await reclassifyAll(env, log);
      } : null,
    });
    progress('app', 1, 1, `Ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return out;
  })();
  ready.catch(e => { log.error(e); progress('app', 0, 0, 'Blundr failed to load: ' + (e?.message ?? e)); });
  // the engine once the server answers: it would only share the bandwidth with what the page waits for
  // (failed: the page stops waiting for it, so Start review says why instead of staying grey)
  ready.then(() => engines.load()).catch(e => {
    log.error('engine failed to load', e);
    tabs.progress({ what: 'engine', done: 0, total: 0, text: engineName, failed: true });
  });
  return (req, emit, signal) => answer(ready, req, emit, signal);
}

onmessage = e => {
  const m = e.data;
  if (m?.type === 'abort') tabs.abort(m.id);
  else tabs.request(m);
};
tabs.start(lead).catch(e => log.error('the tabs failed to start', e));
