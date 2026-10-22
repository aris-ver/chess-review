// The Python worker: Pyodide running chess_review, answering the page's api/ and p/ requests (web/shim.js) with
// serve.Handler (chess_web/bridge.py), and the engine pool for the analysis. Off the main thread, because Pyodide
// would freeze the page. A module worker: Chrome won't importScripts() Pyodide from its CDN into a classic one.
import './config.js';
import { EnginePool, physicalCores } from './engines.js';

const CR_CONFIG = self.CR_CONFIG;

const progress = (what, done, total, text) => postMessage({ type: 'progress', what, done, total, text });

// What the browser keeps between visits: DATA (profiles, reviews, the eval cache, puzzle progress) on IndexedDB.
let py, bridge, persisting = null, again = false;
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

const engines = new EnginePool({
  size: physicalCores(),
  script: 'engine/stockfish-19-single.js',
  wasmUrl: CR_CONFIG.engineWasm,
  wasmBytes: CR_CONFIG.engineBytes,
  onProgress: (done, total) => progress('engine', done, total),
});

const ready = (async () => {
  const t0 = performance.now();
  progress('python', 0, 3, 'Loading Python');
  const { loadPyodide } = await import(CR_CONFIG.pyodide + 'pyodide.mjs');
  py = await loadPyodide({ indexURL: CR_CONFIG.pyodide });
  progress('python', 1, 3, 'Loading DuckDB and python-chess');
  await py.loadPackage(['duckdb', 'pyarrow', 'requests', new URL(CR_CONFIG.chessWheel, location.href).href]);
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
  bridge = py.pyimport('chess_web.bridge');
  bridge.setup('/app', engines);
  progress('python', 3, 3, `Ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
})();
ready.catch(e => { console.error(e); progress('python', 0, 0, 'Python failed to load: ' + e); });
// The 99 MB engine only once Python is up: downloading both at once halves the bandwidth Python gets, and the page
// answers nothing (puzzles included) until Python is ready, while the engine is wanted only for a review.
ready.catch(() => {}).then(() => engines.load()).catch(e => console.error('engine failed to load', e));

onmessage = async e => {
  const { id, method, path, body, contentType } = e.data;
  try {
    await ready;
    const out = bridge.handle_js(method, path, body || null, contentType || null);
    const [status, headers, payload] = out.toJs();
    out.destroy();
    postMessage({ type: 'response', id, status, headers, body: payload }, [payload.buffer]);
    if (method !== 'GET') persist();
  } catch (err) {
    postMessage({ type: 'response', id, status: 500, headers: [['Content-Type', 'application/json']],
                  body: new TextEncoder().encode(JSON.stringify({ error: String(err) })) });
  }
};
