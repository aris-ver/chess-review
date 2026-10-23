// The database half of chess_review/analyse.py: which positions still need the engine, and the engine cache's
// reads and writes. The search itself (js/core/analyse.js parses its output) runs in the engine pool.
//
// `db` is a db.js connection that has evals and evals_multipv: Store.evals(), or a profile's (Store.profile(p)),
// which also has the positions pending_keys asks about.

import { EVALS_MULTIPV_SCHEMA, EVALS_SCHEMA } from './db.js';
import { pyRound } from '../core/py.js';

/** [fen_key, evals row, evals_multipv rows] per position searched (what evaluateMultipv returns, with its key) into
 * the cache. A position already there keeps its row. Terminal positions have no lines: a rank-0 sentinel marks
 * them as done so they are never queued again. */
export function writeResults(db, results) {
  db.tx(() => {
    db.insert('evals', EVALS_SCHEMA, results.map(([k, m]) => ({ ...m, fen_key: k })), 'IGNORE');
    const rows = results.flatMap(([k, , ranks]) => ranks.map(r => ({ ...r, fen_key: k })));
    for (const [k, m, ranks] of results) {
      if (!ranks.length) rows.push({ fen_key: k, rank: 0, move: null, eval_cp: m.eval_cp, mate_in: m.mate_in, pv: [] });
    }
    if (rows.length) db.insert('evals_multipv', EVALS_MULTIPV_SCHEMA, rows, 'IGNORE');
  });
}

/** Distinct position keys of the profile (optionally of one game) that lack an eval or MultiPV rows, in the order
 * they first come in the games, and the counts analyse.pending_keys logs. db: a profile's connection. */
export function pendingKeys(db, gameId = null) {
  const where = gameId ? 'WHERE game_id = ?' : '';
  const params = gameId ? [gameId] : [];
  const total = db.value(`SELECT count(*) FROM positions ${where}`, params);
  const distinct = db.value(`SELECT count(DISTINCT fen_key) FROM positions ${where}`, params);
  const keys = db.column(`
    SELECT k.fen_key FROM (SELECT fen_key, min(rowid) first FROM positions ${where} GROUP BY fen_key) k
    LEFT JOIN evals e ON e.fen_key = k.fen_key
    WHERE e.fen_key IS NULL OR NOT EXISTS (SELECT 1 FROM evals_multipv m WHERE m.fen_key = k.fen_key)
    ORDER BY k.first`, params);
  const stats = {
    position_rows: total, distinct_positions: distinct,
    dedupe_pct: total ? pyRound(100 * (1 - distinct / total), 1) : 0.0,
    already_cached: distinct - keys.length, pending: keys.length,
  };
  return [keys, stats];
}

const placeholders = n => Array(n).fill('?').join(', ');

/** Run fn over keys in chunks small enough for one statement's parameters. */
function chunked(keys, fn, size = 500) {
  const out = [];
  for (let i = 0; i < keys.length; i += size) out.push(...fn(keys.slice(i, i + size)));
  return out;
}

/** fen_key → evals row, for the keys in the cache. */
export function readEvals(db, keys) {
  keys = [...new Set(keys)];
  const rows = chunked(keys, ks => db.all(`SELECT * FROM evals WHERE fen_key IN (${placeholders(ks.length)})`, ks));
  return Object.fromEntries(rows.map(r => [r.fen_key, r]));
}

/** fen_key → its MultiPV rows {rank, move, eval_cp, mate_in, pv} (the rank-0 sentinel too), as
 * own_puzzles.cached_lines reads them; keys without any are left out. */
export function cachedLines(db, keys) {
  keys = [...new Set(keys)];
  const out = {};
  const rows = chunked(keys, ks => db.all(
    `SELECT fen_key, rank, move, eval_cp, mate_in, pv FROM evals_multipv WHERE fen_key IN (${placeholders(ks.length)}) ORDER BY fen_key, rank`, ks));
  for (const { fen_key: k, ...r } of rows) (out[k] ??= []).push({ ...r, pv: r.pv ?? [] });
  return out;
}
