// The worker every tab starts (web/shim.js), in web/py-worker.js's place: Blundr's JS server answering the page's
// api/... and p/... requests. One of the tabs' workers leads (tabs.js): it opens the SQLite files in OPFS, runs the
// job runner and the Stockfish pool, and answers every tab; the others relay. A module worker, so the same ES
// modules as the desktop's run here unchanged.

import '../../web/config.js';
import { EnginePool, physicalCores, pruneEngines } from '../../web/engines.js';
import { DrillTables, tablesFromFiles } from '../server/drills.js';
import { opfsFiles, memoryFiles } from '../server/profiles-files.js';
import { answer, consoleLog as log, reclassifyAll, startApp } from './app.js';
import { webSqlite } from './db.js';
import { dropOldData, migrateOnce, within } from './legacy.js';
import { Tabs } from './tabs.js';

const CR_CONFIG = self.CR_CONFIG;
// the site's root: config.js says where it is from the code's (scripts/build_web.js serves the code under v/<version>/)
const site = path => new URL((CR_CONFIG.site ?? '') + path, new URL('../../', import.meta.url)).href;
const web = path => new URL(path, site('web/')).href;                      // config.js's URLs are relative to web/
// the build's version: the v/<version>/ this code is served from (a hash of the code, new with every deploy that
// changes it); '' when it is served from the checkout
const BUILD = new URL(import.meta.url).pathname.match(/\/v\/([0-9a-f]+)\/js\/web\/worker\.js$/)?.[1] ?? '';

const tabs = new Tabs({ toPage: msg => postMessage(msg), channel: new BroadcastChannel('blundr'), log });
const progress = (what, done, total, text) => tabs.progress({ what, done, total, text });

// Phones (a worker named "lite": web/shim.js decides): the 95 MB engine compiled once per core is more memory than iOS
// gives a tab, which it then kills and reloads, over and over. One lite engine (2 MB, a smaller net: evals differ a little from the
// full engine's) with a small hash instead. Evals never leave the browser, so the two engines' never mix.
const LITE = self.name === 'lite';
const LITE_WASM = 'engine/stockfish-19-lite-single.wasm';
const engineName = (CR_CONFIG.engineName || 'Stockfish') + (LITE ? ' lite' : '');
const pool = () => new EnginePool({
  ...(LITE ? { size: 1, hash: 16, script: web('engine/stockfish-19-lite-single.js'),
               wasmUrl: web(CR_CONFIG.engineLiteWasm || LITE_WASM), wasmBytes: CR_CONFIG.engineLiteBytes || 0,
               wasmSha256: CR_CONFIG.engineLiteSha256 }
           : { size: physicalCores(), script: web('engine/stockfish-19-single.js'),
               wasmUrl: web(CR_CONFIG.engineWasm), wasmBytes: CR_CONFIG.engineBytes, wasmSha256: CR_CONFIG.engineSha256 }),
  onProgress: (done, total) => progress('engine', done, total, engineName),
});

// The rook drills' opponent: one full-net engine of its own (Hash 16), so a review never delays a reply. Desktop
// browsers only: on phones the rook drills say "needs a computer" this phase (no 99 MB download is offered). It
// fetches nothing until the first rook drill's move, and then only after the analysis pool's load (which keeps the
// wasm in Cache Storage), so the 99 MB never downloads twice at once.
const drillPool = engines => {
  if (LITE) return null;
  const pool = new EnginePool({ size: 1, hash: 16, script: web('engine/stockfish-19-single.js'), wasmUrl: web(CR_CONFIG.engineWasm),
    wasmBytes: CR_CONFIG.engineBytes, wasmSha256: CR_CONFIG.engineSha256, onProgress: () => {} });
  return {
    size: 1, get name() { return pool.name; },
    load: () => engines.load().then(() => pool.load()),
    async search(...args) {
      await engines.load();
      return pool.search(...args);
    },
  };
};

const text = async path => {
  const r = await fetch(site(path));
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
};
// the endgame drills' tables (endgames/*.bin beside the code, scripts/build_web.js), fetched the first time a drill
// asks for one; a failed fetch is asked again next time
const drillTables = () => new DrillTables(tablesFromFiles(async path => {
  const r = await fetch(site(path));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}, 'endgames'));

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
    dropOldData({ files, log }).catch(e => log.error('deleting the old app\'s data failed', e));     // not waited on
    const out = await startApp({
      driver, files, pool: engines, log, build: BUILD, ...(CR_CONFIG.nodes ? { nodes: CR_CONFIG.nodes } : {}),   // nodes: tests only
      // a fast analysis: half the nodes, on the full engine only (the phones' lite one offers no choice)
      fastNodes: LITE ? null : (CR_CONFIG.nodes ? Math.max(1, CR_CONFIG.nodes >> 1) : undefined),
      site: { book: () => text('book_keys.txt'), puzzles: () => text('puzzles.json'), packs: () => text('packs.json'),
              tree: () => text('book_tree.json') },
      drillTables: drillTables(),
      drillEngine: drillPool(engines), drillEngineUnavailable: LITE ? 'needs_computer' : null,
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
  // What earlier builds left on the device and nothing reads any more: engines of another version (once this one's
  // is in, so nothing is deleted under a download) and, a month after the move, the old app's IndexedDB.
  ready.then(() => engines.load())
    .then(() => pruneEngines([web(CR_CONFIG.engineWasm), web(CR_CONFIG.engineLiteWasm || LITE_WASM)]))
    .then(gone => gone.length && log.info('deleted engines of earlier builds', gone))
    .catch(e => log.error('deleting earlier builds\' engines failed', e));
  return (req, emit, signal) => answer(ready, req, emit, signal);
}

onmessage = e => {
  const m = e.data;
  if (m?.type === 'abort') tabs.abort(m.id);
  else tabs.request(m);
};
tabs.start(lead).catch(e => log.error('the tabs failed to start', e));
