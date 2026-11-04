// The one time the old Python stack loads: a browser that used Blundr before the JS port has its data in Pyodide's
// IDBFS (an IndexedDB database named "/data"). Before the Store opens anything, the leading worker loads Pyodide as
// web/py-worker.js used to (from its CDN, with the legacy app.zip, which holds only what chess_review/migrate_sqlite.py
// needs), runs migratePyodide (js/web/migrate.js) into the SQLite pool and the OPFS files, and writes DONE. From then on
// neither Pyodide nor the legacy files are fetched again. IndexedDB is left as it was (deleting it is for later).

import { copyFiles, hasPythonData, migratePyodide } from './migrate.js';

export const DONE = 'pyodide-migration.json';
export const IDB_NAME = '/data';
const TRIES = 3;      // a migration that keeps failing stops being tried, so a visit isn't slowed for good
const STEP_S = 180;   // a step of it that takes longer is given up for this visit (the app starts; the next visit tries again)

/** p, or a rejection once it has taken more than s seconds: nothing waits on a step that never ends. what: its name,
 * or a function giving the name it has by then. */
export function within(p, what, s = STEP_S) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const name = typeof what === 'function' ? what() : what;
      reject(Object.assign(new Error(`${name}: no answer in ${s} s`), { name: 'TimeoutError' }));
    }, s * 1000);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Whether this browser holds Pyodide's data, without loading Pyodide: is there an IndexedDB database "/data"? */
export async function hasPyodideData(idb = globalThis.indexedDB) {
  if (!idb) return false;
  if (idb.databases) {
    try {
      return (await idb.databases()).some(d => d.name === IDB_NAME);
    } catch { /* fall through */ }
  }
  // no databases() (older Firefox): opening it creates it, unless the upgrade that would is aborted
  return new Promise(resolve => {
    const req = idb.open(IDB_NAME);
    req.onupgradeneeded = () => { req.transaction.abort(); resolve(false); };
    req.onsuccess = () => { req.result.close(); resolve(true); };
    req.onerror = () => resolve(false);
  });
}

/** What the migration leaves out of the files: caches, logs and the desktop's pid file. */
const skip = path => /^web-cache\//.test(path) || /\.log$/.test(path) || path === 'serve.pid';

/** Pyodide with /data mounted from IndexedDB and the legacy chess_review on sys.path. legacy: { pyodide: the CDN's
 * index URL, wheel: python-chess's wheel URL, app: the legacy app.zip's URL }. */
export async function loadLegacyPython(legacy, step = () => {}) {
  step('loading the old app');
  const { loadPyodide } = await import(legacy.pyodide + 'pyodide.mjs');
  const py = await loadPyodide({ indexURL: legacy.pyodide });
  await py.loadPackage([legacy.wheel]);
  step('reading your old data');
  py.FS.mkdirTree('/data');
  py.FS.mount(py.FS.filesystems.IDBFS, {}, '/data');
  await new Promise((res, rej) => py.FS.syncfs(true, err => (err ? rej(err) : res())));
  const app = await fetch(legacy.app);
  if (!app.ok) throw new Error(`${legacy.app}: HTTP ${app.status}`);
  py.unpackArchive(await app.arrayBuffer(), 'zip', { extractDir: '/app' });
  py.runPython(`
import os, sys
os.environ["CHESS_REVIEW_DATA"] = "/data"
sys.path.insert(0, "/app")
`);
  return py;
}

/** The migration, if this browser needs it: returns null when it doesn't (done before, or no old data), else
 * { status: 'done' | 'empty' | 'failed', ... }. 'done' and 'empty' mean the games are to be classified again
 * (reclassify). driver: webSqlite(), nothing open yet; files: opfsFiles(); load: loadLegacyPython, or a stand-in. */
export async function migrateOnce({ driver, files, legacy, load = loadLegacyPython, idb = globalThis.indexedDB,
                                    log = console, progress = () => {}, stepS = STEP_S }) {
  const done = await files.readText(DONE);
  if (done !== null && JSON.parse(done).status !== 'retry') return null;
  if (!(await hasPyodideData(idb))) return null;
  const tries = done === null ? 0 : JSON.parse(done).tries ?? 0;
  const t0 = Date.now();
  let at = 'starting';
  const step = what => {
    at = what;
    progress(`Moving your data to the new Blundr (once): ${what}…`);
  };
  step(at);
  let out;
  try {
    const py = await within(load(legacy, step), () => at, stepS);
    if (!hasPythonData(py.FS)) {      // profiles without games, settings: files only
      step('copying your files');
      out = { status: 'empty', copied: (await within(copyFiles(py.FS, files, { skip }), () => at, stepS)).length };
    } else {
      step('converting your games and puzzles');
      const r = await within(migratePyodide(py, driver, files, { skip }), () => at, stepS);
      if (r.problems.length) throw new Error('the SQLite files do not match the export: ' + JSON.stringify(r.problems));
      out = { status: 'done', files: r.marker.files, copied: r.copied.length };
    }
  } catch (e) {
    log.error(`moving the old data failed (${at})`, e);
    out = { status: tries + 1 >= TRIES ? 'failed' : 'retry', tries: tries + 1, step: at, error: String(e?.message ?? e) };
  }
  out.ms = Date.now() - t0;
  out.at = new Date().toISOString();
  await files.writeText(DONE, JSON.stringify(out));
  log.info?.('moved the old data', out);
  return out;
}

