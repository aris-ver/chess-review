// The Python worker: Pyodide running chess_review, answering the page's api/ and p/ requests (web/shim.js) with
// serve.Handler (chess_web/bridge.py), and the engine pool for the analysis. Off the main thread, because Pyodide
// would freeze the page. A module worker: Chrome won't importScripts() Pyodide from its CDN into a classic one.
import './config.js';
import { EnginePool, physicalCores } from './engines.js';

const CR_CONFIG = self.CR_CONFIG;

const progress = (what, done, total, text) => postMessage({ type: 'progress', what, done, total, text });

// What the browser keeps between visits: DATA (profiles, reviews, the eval cache, puzzle progress) on IndexedDB.
let py, bridge, later, persisting = null, again = false;
function persist() {      // debounced: a batch of evals may call it several times a second
  if (persisting) { again = true; return; }
  persisting = new Promise(res => setTimeout(() => py.FS.syncfs(false, err => {
    if (err) console.error('saving to IndexedDB failed', err);
    persisting = null;
    res();
    if (again) { again = false; persist(); }
  }), 500));
}
self.crPersist = persist;

// Phones (?lite, web/shim.js decides): the 95 MB engine compiled once per core is more memory than iOS gives a tab, which
// it then kills and reloads, over and over. One lite engine (2 MB, a smaller net: evals differ a little from the full
// engine's) with a small hash instead. Evals never leave the browser, so the two engines' never mix.
const LITE = new URLSearchParams(location.search).has('lite');
const engineName = (CR_CONFIG.engineName || 'Stockfish') + (LITE ? ' lite' : '');
const engines = new EnginePool({
  ...(LITE ? { size: 1, hash: 16, script: 'engine/stockfish-19-lite-single.js',
               wasmUrl: CR_CONFIG.engineLiteWasm || 'engine/stockfish-19-lite-single.wasm', wasmBytes: CR_CONFIG.engineLiteBytes || 0 }
           : { size: physicalCores(), script: 'engine/stockfish-19-single.js',
               wasmUrl: CR_CONFIG.engineWasm, wasmBytes: CR_CONFIG.engineBytes }),
  onProgress: (done, total) => progress('engine', done, total, engineName),
});

const ready = (async () => {
  const t0 = performance.now();
  progress('python', 0, 3, 'Loading Python');
  const { loadPyodide } = await import(CR_CONFIG.pyodide + 'pyodide.mjs');
  py = await loadPyodide({ indexURL: CR_CONFIG.pyodide });
  progress('python', 1, 3, 'Loading python-chess');
  await py.loadPackage(['requests', new URL(CR_CONFIG.chessWheel, location.href).href]);
  progress('python', 2, 3, 'Loading chess-review');
  py.FS.mkdirTree('/data');
  py.FS.mount(py.FS.filesystems.IDBFS, {}, '/data');
  await new Promise((res, rej) => py.FS.syncfs(true, err => err ? rej(err) : res()));
  const app = await fetch('../app.zip');   // the worker's URLs are relative to web/
  if (!app.ok) throw new Error('app.zip: HTTP ' + app.status);
  py.unpackArchive(await app.arrayBuffer(), 'zip', { extractDir: '/app' });
  py.runPython(`
import logging, os, sys
os.environ["CHESS_REVIEW_DATA"] = "/data"
sys.path.insert(0, "/app")
logging.basicConfig(level=logging.INFO, format="%(name)s %(message)s")
`);
  later = py.pyimport('chess_web.later');
  later.stand_in();
  bridge = py.pyimport('chess_web.bridge');
  bridge.setup.callKwargs('/app', engines, { pack_later: true });
  progress('python', 3, 3, `Ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
})();
ready.catch(e => { console.error(e); progress('python', 0, 0, 'Python failed to load: ' + e); });
// The puzzle pack (8 MB of JSON, under 2 MB as sent) downloads alongside Python instead of inside app.zip, so Python
// answers sooner on a first visit; it's written into /app once both are there. Puzzle requests that come first wait.
const packFile = fetch('../puzzles.json').then(r => { if (!r.ok) throw new Error('puzzles.json: HTTP ' + r.status); return r.arrayBuffer(); });
const pack = Promise.all([ready, packFile]).then(([, buf]) => py.FS.writeFile('/app/puzzles.json', new Uint8Array(buf)));
pack.catch(e => console.error('puzzle pack failed to load', e));
// DuckDB straight after.
const heavy = ready.then(async () => {
  const t0 = performance.now();
  await py.loadPackage('duckdb');
  later.swap_in();
  console.info(`DuckDB in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
});
heavy.catch(e => console.error('DuckDB failed to load', e));
// The 99 MB engine only once it is in: downloading at once halves the bandwidth each gets, and the engine is
// wanted only for a review, which needs DuckDB as well.
heavy.catch(() => {}).then(() => engines.load()).catch(e => console.error('engine failed to load', e));

// The POSTs that never reach DuckDB. The others wait for it, so that none stops halfway (NotLoaded) and then runs
// again. A GET runs at once, and once more after it has loaded if it reached it.
const WITHOUT_HEAVY = /^\/api\/(settings|puzzles\/(attempt|solved|daily))$/;

onmessage = async e => {
  const { id, method, path, body, contentType } = e.data;
  try {
    await ready;
    if (method !== 'GET' && !WITHOUT_HEAVY.test(path.split('?')[0])) await heavy;
    if (method !== 'GET' && path.startsWith('/api/puzzles')) await pack;
    let out;
    for (let tries = 0; ; tries++) {      // a GET may stop at the pack, then at DuckDB: ask again after each
      try {
        out = bridge.handle_js(method, path, body || null, contentType || null);
        break;
      } catch (err) {
        const wait = { NotLoaded: heavy, PackNotLoaded: pack }[err.type];
        if (!wait || tries === 2) throw err;
        await wait;
      }
    }
    const [status, headers, payload] = out.toJs();
    out.destroy();
    postMessage({ type: 'response', id, status, headers, body: payload }, [payload.buffer]);
    if (method !== 'GET') persist();
  } catch (err) {
    postMessage({ type: 'response', id, status: 500, headers: [['Content-Type', 'application/json']],
                  body: new TextEncoder().encode(JSON.stringify({ error: String(err) })) });
  }
};
