// The browser's one-time hand-over from Pyodide's data (IDBFS in IndexedDB, mounted at /data) to the SQLite files in
// OPFS. The old Python stack loads one last time, as web/py-worker.js loads it now (Pyodide, /data mounted and synced
// in, app.zip unpacked, CHESS_REVIEW_DATA=/data, DuckDB loaded); then
//
//     const report = await migratePyodide(py, driver, files);
//
// runs chess_review/migrate_sqlite.py into Pyodide's memory file system, copies each SQLite file into the OPFS pool
// (driver: webSqlite(), from js/web/db.js; nothing may have them open yet), checks them against the export's counts and
// writes the marker into files (an opfsFiles adapter, profiles-files.js). The rest of /data that the JS app keeps as
// files (meta.json, site/, raw/, pgn/, settings.json, ...) is copyFiles()'s, which the switch calls with the same
// adapter. /data itself is left as it was: deleting the IndexedDB is for later, once the new app has run on it.

import { MARKER, verify } from '../server/migrate.js';

export { MARKER } from '../server/migrate.js';

export const OUT = '/tmp/sqlite-export';

/** What the export replaces (read only by it, so not copied as files): the DuckDB cache and its snapshot, the
 * parquet tables and fingerprints, the puzzle records. */
const EXPORTED = /(^|\/)(evals\.duckdb(\.wal)?|evals\.parquet|[^/]+\.parquet|moves\.fp\.json|puzzle_attempts[^/]*\.jsonl|puzzle_solved\.jsonl|puzzle_daily\.jsonl|sqlite-export\.json)$/;

const isDir = (FS, path) => FS.isDir(FS.stat(path).mode);

/** Every file under dir in Pyodide's FS, as paths relative to it. */
export function walk(FS, dir) {
  const out = [];
  const go = rel => {
    for (const name of FS.readdir(rel ? `${dir}/${rel}` : dir)) {
      if (name === '.' || name === '..') continue;
      const r = rel ? `${rel}/${name}` : name;
      if (isDir(FS, `${dir}/${r}`)) go(r);
      else out.push(r);
    }
  };
  if (FS.analyzePath(dir).exists) go('');
  return out.sort();
}

function rmTree(FS, path) {
  if (!FS.analyzePath(path).exists) return;
  if (isDir(FS, path)) {
    for (const name of FS.readdir(path)) if (name !== '.' && name !== '..') rmTree(FS, `${path}/${name}`);
    FS.rmdir(path);
  } else FS.unlink(path);
}

/** Whether there is Python data to bring over: anything the export reads, under data. */
export function hasPythonData(FS, data = '/data') {
  return walk(FS, data).some(p => EXPORTED.test(p) && !p.endsWith(MARKER));
}

/** Runs the Python export in Pyodide (data → out, in its file system) and returns its report: { status, files, ... }.
 * Loads the sqlite3 package (Pyodide ships Python's sqlite3 apart from the standard library) and DuckDB if needed. */
export async function exportInPyodide(py, { data = '/data', out = OUT } = {}) {
  await py.loadPackage(['duckdb', 'sqlite3']);
  rmTree(py.FS, out);
  const text = py.runPython(`
import json
from pathlib import Path
from chess_review import migrate_sqlite
_r = migrate_sqlite.migrate(Path(${JSON.stringify(data)}), Path(${JSON.stringify(out)}), force=True)
json.dumps({k: v for k, v in _r.items() if k != "sources"})
`);
  return JSON.parse(text);
}

/** The export's SQLite files into the driver's pool (driver.importFile), checked against its marker, and the marker
 * into files when given. Returns { marker, imported: [name], problems: verify()'s list }. Throws when the export has
 * no marker (it didn't finish). */
export async function importExport(FS, driver, files = null, out = OUT) {
  const markerPath = `${out}/${MARKER}`;
  if (!FS.analyzePath(markerPath).exists) throw new Error('the SQLite export did not finish: no marker');
  const marker = JSON.parse(FS.readFile(markerPath, { encoding: 'utf8' }));
  const imported = [];
  for (const name of Object.keys(marker.files)) {
    await driver.importFile(name, FS.readFile(`${out}/${name}`));
    imported.push(name);
  }
  const problems = await verify(driver, marker);
  if (files && !problems.length) await files.writeText(MARKER, JSON.stringify(marker));
  return { marker, imported, problems };
}

/** Copy what the JS app keeps as files from Pyodide's data into a files adapter, every file but those the export
 * replaces. skip(path) leaves out more (the web-switch's call: web-cache, logs, whatever it doesn't want). Returns
 * the paths copied. */
export async function copyFiles(FS, files, { data = '/data', skip = () => false } = {}) {
  const copied = [];
  for (const path of walk(FS, data)) {
    if (EXPORTED.test(path) || skip(path)) continue;
    await files.writeBytes(path, FS.readFile(`${data}/${path}`));
    copied.push(path);
  }
  return copied;
}

/** All of it: the export in Pyodide, the SQLite files into the pool, the other files into files (copyFiles, with
 * skip), and last the marker, so that a marker means everything is there. The memory copy is removed afterwards.
 * Returns importExport()'s result with the export's report and the files copied; problems not empty means the
 * SQLite files are not to be trusted (no marker is written, so the switch can try again). */
export async function migratePyodide(py, driver, files, { data = '/data', out = OUT, skip = () => false } = {}) {
  const report = await exportInPyodide(py, { data, out });
  try {
    const res = await importExport(py.FS, driver, null, out);
    if (res.problems.length) return { report, ...res, copied: [] };
    const copied = await copyFiles(py.FS, files, { data, skip });
    await files.writeText(MARKER, JSON.stringify(res.marker));
    return { report, ...res, copied };
  } finally {
    rmTree(py.FS, out);
  }
}
