// Dev-only (not shipped): repair the desktop engine cache's main lines cut short by the node budget. A search that
// ran out mid aspiration re-search ended on a bound line whose pv was the move and at most one reply, and that
// stub was stored (js/core/evals.js keepPv now keeps the full line). This re-runs those positions the way the app
// does (packaging/bin/stockfish.exe, Threads 1, Hash 64, MultiPV 3, ucinewgame, go nodes DEFAULT_NODES) and
// rewrites only the pv column, and only where move, eval_cp and mate_in come out exactly as stored.
//
//   node scripts/repair_short_pv.mjs [data dir] [--apply] [--limit N]
//
// Default data dir %LOCALAPPDATA%\chess-review. Without --apply it is a dry run: it only counts. --apply wants the
// app closed (for its own data dir) and first backs up evals.sqlite next to it.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { DEFAULT_NODES } from '../js/core/config.js';
import { boardFromKey } from '../js/core/fen.js';
import { EnginePool } from '../js/desktop/engines.js';
import { robustMultipv } from '../js/server/explore.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP_DATA = process.env.CHESS_REVIEW_DATA || join(process.env.LOCALAPPDATA || '', 'chess-review');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
const dir = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit') ?? APP_DATA);
const file = join(dir, 'evals.sqlite');
if (!existsSync(file)) throw new Error(`no ${file}`);

const SHORT = `json_array_length(coalesce(pv, '[]')) <= 2`;
const db = new DatabaseSync(file, { readOnly: !apply });
const mainKeys = db.prepare(`SELECT fen_key FROM evals WHERE nodes > 0 AND mate_in IS NULL AND ${SHORT}`).all().map(r => r.fen_key);
const rankRows = db.prepare(`
  SELECT m.fen_key FROM evals_multipv m JOIN evals e ON e.fen_key = m.fen_key
  WHERE m.rank > 0 AND e.nodes > 0 AND m.mate_in IS NULL AND ${SHORT.replace('pv', 'm.pv')}`).all().map(r => r.fen_key);
const keys = [...new Set([...mainKeys, ...rankRows])];
console.log(`${file}\nshort lines: ${mainKeys.length} evals rows, ${rankRows.length} evals_multipv rows, ${keys.length} positions`);
if (!apply) {
  console.log('dry run: nothing changed (--apply to repair)');
  process.exit(0);
}

if (resolve(dir).toLowerCase() === resolve(APP_DATA).toLowerCase() && process.platform === 'win32') {
  const running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Blundr.exe', '/NH'], { encoding: 'utf8' });
  if (/Blundr\.exe/i.test(running)) throw new Error('Blundr is running: close it first');
}
const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`backed up to ${backup}`);

const todo = keys.slice(0, limit);
const pool = new EnginePool({ path: join(ROOT, 'packaging', 'bin', 'stockfish.exe'), hash: 64 });
const getMain = db.prepare('SELECT best_move, eval_cp, mate_in, pv FROM evals WHERE fen_key = ?');
const getRanks = db.prepare('SELECT rank, move, eval_cp, mate_in, pv FROM evals_multipv WHERE fen_key = ? AND rank > 0');
const setMain = db.prepare('UPDATE evals SET pv = ? WHERE fen_key = ?');
const setRank = db.prepare('UPDATE evals_multipv SET pv = ? WHERE fen_key = ? AND rank = ?');
const n = { searched: 0, updated: 0, longer: 0, same: 0, mismatch: 0 };
const fix = (stored, move, fresh, write) => {
  const had = JSON.parse(stored.pv ?? '[]');
  if (stored.mate_in !== null || had.length > 2) return;      // only the short lines are touched
  if (stored.move !== move || stored.eval_cp !== fresh.eval_cp || stored.mate_in !== fresh.mate_in) return n.mismatch++;
  if (JSON.stringify(fresh.pv) === JSON.stringify(had)) return n.same++;
  if (fresh.pv.length > had.length) n.longer++;
  write(JSON.stringify(fresh.pv));
  n.updated++;
};
let next = 0;
async function worker() {
  while (next < todo.length) {
    const key = todo[next++];
    const [main, ranks] = await robustMultipv(boardFromKey(key), pool, DEFAULT_NODES);
    n.searched++;
    const m = getMain.get(key);
    fix({ ...m, move: m.best_move }, main.best_move, main, pv => setMain.run(pv, key));
    for (const r of getRanks.all(key)) {
      const fresh = ranks.find(x => x.rank === r.rank) ?? { eval_cp: undefined };
      fix(r, fresh.move, fresh, pv => setRank.run(pv, key, r.rank));
    }
    if (n.searched % 50 === 0) console.log(`${n.searched}/${todo.length}`, JSON.stringify(n));
  }
}
await Promise.all(Array.from({ length: pool.size }, worker));
await pool.close();
db.close();
console.log(`done: ${JSON.stringify(n)} (rows: updated = changed pv, longer = of those got a longer one, same = searched pv no different, mismatch = move or score differ, left alone)`);
process.exit(0);
