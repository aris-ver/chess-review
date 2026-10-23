// The one-time hand-over from the Python apps' data: chess_review/migrate_sqlite.py writes the SQLite files in db.js's
// layout (evals.sqlite, progress.sqlite, profiles/<id>/games.sqlite, and the same under .accounts/<who>/ for an account
// set aside) and then MARKER, a JSON file beside them:
//
//     { format, schema_version, at, seconds, files: { name: { table: rows } }, sources: { old file: [size, mtime] } }
//
// On the desktop the bridge release writes them in the data directory itself; in the browser js/web/migrate.js has
// Pyodide write them and copies them into OPFS. Either way the JS app checks the files against the marker's counts
// before it trusts them (verify), and never runs the export itself: that needs the Python stack.

import { EVALS, EVALS_DDL, PROFILE_DDL, PROGRESS, PROGRESS_DDL, SCHEMA_VERSION, Store } from './db.js';

export const MARKER = 'sqlite-export.json';

/** The marker as a files adapter (profiles-files.js) reads it, or null when there is none (or it's unreadable). */
export async function readMarker(files) {
  try {
    const text = await files.readText(MARKER);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** 'none' (no export: whether there is Python data waiting for one is the caller's to tell), 'done', or
 * 'newer-schema' (exported for a later db.js than this one). */
export function markerState(marker) {
  if (!marker) return 'none';
  return marker.schema_version > SCHEMA_VERSION ? 'newer-schema' : 'done';
}

const ddlFor = name => (name.endsWith(EVALS) ? EVALS_DDL : name.endsWith(PROGRESS) ? PROGRESS_DDL : PROFILE_DDL);

/** Every file the marker lists, opened through driver (nodeSqlite, webSqlite) on a Store of its own, its tables
 * counted against the marker's. Returns the differences, [] when everything is there:
 *     [{ name, table, expected, found }]   (found null: the file or table isn't there) */
export async function verify(driver, marker) {
  const out = [];
  const store = new Store(driver);
  try {
    for (const [name, tables] of Object.entries(marker.files ?? {})) {
      if (!(await driver.exists(name))) {
        for (const [table, expected] of Object.entries(tables)) out.push({ name, table, expected, found: null });
        continue;
      }
      const db = await store.connect(name, ddlFor(name));
      for (const [table, expected] of Object.entries(tables)) {
        let found = null;
        try {
          found = db.value(`SELECT count(*) FROM "${table}"`);
        } catch {
          // no such table
        }
        if (found !== expected) out.push({ name, table, expected, found });
      }
    }
  } finally {
    await store.close();
  }
  return out;
}
