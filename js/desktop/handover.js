// The hand-over from the Python app's data (docs/js-port.md, step 6). The last Python release (the bridge) writes
// the SQLite files beside its old ones with chess_review/migrate_sqlite.py, and sqlite-export.json says what they
// hold. Before the app opens anything in the data folder it checks: no Python data, or the export there and
// complete (js/server/migrate.js's verify), and only then does the Store open the files. Otherwise nothing is
// opened or written and the window says why; the old files are only ever read by the export, so nothing is lost.
//
// verify counts rows against the marker, which only holds until the app writes its first row, so a pass is
// remembered in ACCEPTED (with the marker's time): later starts trust the same export without counting. It counts
// a copy of the files: opening one turns on WAL, and migrate_sqlite.py takes a file changed after its marker for one
// the JS app has used and won't export over it, so checking the real files would stop the bridge from trying again.

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { markerState, readMarker, verify } from '../server/migrate.js';

export const ACCEPTED = 'sqlite-accepted.json';

/** The Python app's own data files: any of these and no export means the export hasn't run. */
async function pythonData(files) {
  if (await files.exists('evals.duckdb')) return true;
  for (const f of ['puzzle_attempts.jsonl', 'puzzle_solved.jsonl', 'puzzle_daily.jsonl']) if (await files.exists(f)) return true;
  for (const e of await files.list('profiles')) {
    if (e.dir && (await files.exists(`profiles/${e.name}/games.parquet`))) return true;
  }
  return false;
}

/** Data this app has written already (it ran here before, so there is nothing to hand over). */
async function ownData(files) {
  return (await files.exists('evals.sqlite')) || (await files.exists('progress.sqlite'));
}

/** { ok: true, how } to go on (how: 'fresh' | 'own' | 'accepted' | 'verified'), or { ok: false, title, detail,
 * problems } to stop with nothing opened. files: profiles-files.js at the data folder (dataDir); driverAt(dir): a
 * db driver (nodeSqlite) over a folder, the copy verify counts. */
export async function checkData(files, dataDir, driverAt) {
  const marker = await readMarker(files);
  const state = markerState(marker);
  if (state === 'none') {
    if ((await ownData(files)) || !(await pythonData(files))) return { ok: true, how: (await ownData(files)) ? 'own' : 'fresh' };
    return {
      ok: false, title: 'Your games and puzzles from the previous version have not been converted yet.',
      detail: 'This version keeps its data in a new format. Blundr 0.7 converts it: start that version once (it ' +
        'updates itself to this one afterwards), or download it from the releases page. Nothing has been changed.',
      problems: [],
    };
  }
  if (state === 'newer-schema') {
    return {
      ok: false, title: 'Your data was written for a newer version of Blundr.',
      detail: 'Install the latest version. Nothing has been changed.', problems: [],
    };
  }
  let accepted = null;
  try { accepted = JSON.parse((await files.readText(ACCEPTED)) ?? 'null'); } catch { /* checked again */ }
  if (accepted && accepted.at === marker.at) return { ok: true, how: 'accepted' };
  const problems = await verifyCopy(dataDir, marker, driverAt);
  if (problems.length) {
    return {
      ok: false, title: 'The converted data is incomplete, so this version has not opened it.',
      detail: 'Start Blundr 0.7 again to convert it once more. Nothing has been changed: the previous version\'s ' +
        'files are all still there.',
      problems,
    };
  }
  await files.writeText(ACCEPTED, JSON.stringify({ at: marker.at, verified: new Date().toISOString() }));
  return { ok: true, how: 'verified' };
}

/** verify over a copy of the marker's files in a temporary folder, removed afterwards. */
export async function verifyCopy(dataDir, marker, driverAt) {
  const tmp = mkdtempSync(join(tmpdir(), 'blundr-verify-'));
  try {
    for (const name of Object.keys(marker.files ?? {})) {
      try {
        cpSync(join(dataDir, ...name.split('/')), join(tmp, ...name.split('/')));
      } catch {
        // missing: verify says so
      }
    }
    return await verify(driverAt(tmp), marker);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
