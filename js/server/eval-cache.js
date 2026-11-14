// The database half of chess_review/analyse.py: which positions still need the engine, and the engine cache's
// reads and writes. The search itself (js/core/evals.js parses its output) runs in the engine pool.
//
// `db` is a db.js connection that has evals and evals_multipv: Store.evals(), or a profile's (Store.profile(p)),
// which also has the positions pending_keys asks about.
//
// A fast analysis searches at FAST_NODES rather than the full DEFAULT_NODES, and marks what it wrote in evals_fast.
// A full search of a marked position replaces its rows and drops the mark; a fast one never replaces anything, and
// takes a position the cache has from a full search as it is. A game is a fast one while any of its positions is
// marked (fastGames).

import { EVALS_FAST_SCHEMA, EVALS_MULTIPV_SCHEMA, EVALS_SCHEMA } from './db.js';
import { pyRound } from '../core/py.js';

const placeholders = n => Array(n).fill('?').join(', ');

/** Run fn over keys in chunks small enough for one statement's parameters. */
function chunked(keys, fn, size = 500) {
  const out = [];
  for (let i = 0; i < keys.length; i += size) out.push(...fn(keys.slice(i, i + size)));
  return out;
}

/** [fen_key, evals row, evals_multipv rows] per position searched (what evaluateMultipv returns, with its key) into
 * the cache. A position already there keeps its row, unless a fast search wrote it and this one is full: then this
 * one replaces it, unless the engine gave it no eval (it failed every try): the fast rows and mark are kept. fast:
 * these were searched at FAST_NODES, and are marked so. Terminal positions have no lines: a rank-0 sentinel marks
 * them as done so they are never queued again. */
export function writeResults(db, results, { fast = false } = {}) {
  db.tx(() => {
    const keys = [...new Set(results.map(([k]) => k))];
    let had = null;
    if (!fast) {
      let marked = chunked(keys, ks => db.column(`SELECT fen_key FROM evals_fast WHERE fen_key IN (${placeholders(ks.length)})`, ks));
      const failed = new Set(results.filter(([, m]) => m.eval_cp == null && m.mate_in == null).map(([k]) => k));
      const keep = new Set(marked.filter(k => failed.has(k)));
      if (keep.size) {
        results = results.filter(([k]) => !keep.has(k));
        marked = marked.filter(k => !keep.has(k));
      }
      chunked(marked, ks => {
        for (const t of ['evals', 'evals_multipv', 'evals_fast']) db.run(`DELETE FROM ${t} WHERE fen_key IN (${placeholders(ks.length)})`, ks);
        return [];
      });
    } else {
      // what the cache has in full already (another search wrote it meanwhile) keeps its rows, and stays unmarked
      had = new Set(chunked(keys, ks => db.column(`SELECT e.fen_key FROM evals e WHERE e.fen_key IN (${placeholders(ks.length)})
        AND EXISTS (SELECT 1 FROM evals_multipv m WHERE m.fen_key = e.fen_key)
        AND NOT EXISTS (SELECT 1 FROM evals_fast f WHERE f.fen_key = e.fen_key)`, ks)));
    }
    db.insert('evals', EVALS_SCHEMA, results.map(([k, m]) => ({ ...m, fen_key: k })), 'IGNORE');
    const rows = results.flatMap(([k, , ranks]) => ranks.map(r => ({ ...r, fen_key: k })));
    for (const [k, m, ranks] of results) {
      if (!ranks.length) rows.push({ fen_key: k, rank: 0, move: null, eval_cp: m.eval_cp, mate_in: m.mate_in, pv: [] });
    }
    if (rows.length) db.insert('evals_multipv', EVALS_MULTIPV_SCHEMA, rows, 'IGNORE');
    if (fast) db.insert('evals_fast', EVALS_FAST_SCHEMA, keys.filter(k => !had.has(k)).map(fen_key => ({ fen_key })), 'IGNORE');
  });
}

/** Distinct position keys of the profile (optionally of one game) that lack an eval or MultiPV rows, in the order
 * they first come in the games, and the counts analyse.pending_keys logs. full: for a full analysis, which searches
 * again the positions a fast one did (false: a fast analysis, which takes what the cache has). db: a profile's
 * connection. */
export function pendingKeys(db, gameId = null, { full = true } = {}) {
  const where = gameId ? 'WHERE game_id = ?' : '';
  const params = gameId ? [gameId] : [];
  const total = db.value(`SELECT count(*) FROM positions ${where}`, params);
  const distinct = db.value(`SELECT count(DISTINCT fen_key) FROM positions ${where}`, params);
  const keys = db.column(`
    SELECT k.fen_key FROM (SELECT fen_key, min(rowid) first FROM positions ${where} GROUP BY fen_key) k
    LEFT JOIN evals e ON e.fen_key = k.fen_key
    WHERE e.fen_key IS NULL OR NOT EXISTS (SELECT 1 FROM evals_multipv m WHERE m.fen_key = k.fen_key)${
      full ? '\n      OR EXISTS (SELECT 1 FROM evals_fast f WHERE f.fen_key = k.fen_key)' : ''}
    ORDER BY k.first`, params);
  const stats = {
    position_rows: total, distinct_positions: distinct,
    dedupe_pct: total ? pyRound(100 * (1 - distinct / total), 1) : 0.0,
    already_cached: distinct - keys.length, pending: keys.length,
  };
  return [keys, stats];
}

/** The games of the profile a fast analysis searched (some of their positions at least): a Set of game ids.
 * db: a profile's connection. */
export function fastGames(db) {
  return new Set(db.column('SELECT DISTINCT p.game_id FROM positions p JOIN evals_fast f USING (fen_key)'));
}

/** Whether a fast analysis searched any of the game's positions. */
export function isFastGame(db, gameId) {
  return !!db.value('SELECT EXISTS (SELECT 1 FROM positions p JOIN evals_fast f USING (fen_key) WHERE p.game_id = ?) x', [gameId]);
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
