// The database half of chess_review/classify.py: join the evals onto a profile's positions, classify every game
// (js/core/classify.js) and write the moves table, keeping the moves of games whose inputs haven't changed.
//
// `db` is a profile's db.js connection (Store.profile(p)).

import { classifyGame } from '../core/classify.js';
import { fenKey } from '../core/fen.js';
import { MOVES_SCHEMA } from './db.js';

export const POSITIONS_SQL = `
  SELECT p.game_id, p.ply, p.fen, p.fen_key, p.side_to_move, p.move_played, p.clock_remaining,
         e.eval_cp, e.mate_in, e.best_move, e.pv
  FROM positions p LEFT JOIN evals e USING (fen_key)`;

/** fen_key → its MultiPV rows (rank 1 first), for one game's positions or all of them. The rank-0 sentinel of a
 * terminal position is left out. */
export function loadMultipv(db, gameId = null) {
  const where = gameId ? 'WHERE fen_key IN (SELECT fen_key FROM positions WHERE game_id = ?) AND rank > 0' : 'WHERE rank > 0';
  const out = {};
  for (const r of db.all(`SELECT * FROM evals_multipv ${where} ORDER BY fen_key, rank`, gameId ? [gameId] : [])) {
    (out[r.fen_key] ??= []).push(r);
  }
  return out;
}

// --- fingerprints ---------------------------------------------------------------------------------------------

let code = '';

/** What stands in for classify.code_fingerprint: the build's version stamp and the opening book's, set once at
 * startup by whoever knows them (the desktop app: its version; the web worker: its build hash). Changing it makes
 * every game's fingerprint change, so every game is classified again. */
export function setCodeFingerprint(s) {
  code = String(s);
}

/** JSON with every object's keys sorted, so equal values give equal text. */
function canonical(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

/** SHA-1 of a string's UTF-8, as hex. Synchronous (crypto.subtle isn't), and fast enough for a profile's games. */
export function sha1(text) {
  const bytes = new TextEncoder().encode(text);
  const n = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(n);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(n - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(n - 4, (bytes.length * 8) >>> 0);
  let [a0, b0, c0, d0, e0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < n; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + 4 * i);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = [a0, b0, c0, d0, e0];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1]
        : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      [e, d, c, b, a] = [d, c, (b << 30) | (b >>> 2), a, t];
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0; e0 = (e0 + e) >>> 0;
  }
  return [a0, b0, c0, d0, e0].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Everything a game's labels and review are made from: the game, its positions with their evals, their MultiPV
 * lines and the code. Equal fingerprints mean a rebuild would produce the same output, so it can be skipped. (Not
 * Python's digest: the first JS build classifies every game once more.) */
export function gameFingerprint(game, rows, multipv, ...extra) {
  const lines = rows.map(r => [...(multipv[r.fen_key ?? fenKey(r.fen)] ?? [])].sort((a, b) => a.rank - b.rank));
  return sha1(canonical([code, game, rows, lines, extra]));
}

// --- the build ------------------------------------------------------------------------------------------------

/** [every game's moves, game_id → fingerprint]. previous: game_id → [fingerprint, moves] from the last build; a game
 * whose fingerprint hasn't changed keeps those moves instead of being classified again. */
export function classifyAll(db, previous = {}) {
  const games = Object.fromEntries(db.all('SELECT * FROM games').map(g => [g.game_id, g]));
  const rows = db.all(`${POSITIONS_SQL} ORDER BY p.game_id, p.ply`);
  const multipv = loadMultipv(db);
  const byGame = new Map();
  for (const r of rows) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }
  const out = [];
  const fps = {};
  for (const [gid, grows] of byGame) {
    const fp = fps[gid] = gameFingerprint(games[gid], grows, multipv);
    const old = previous[gid];
    out.push(...(old && old[0] === fp ? old[1] : classifyGame(games[gid], grows, multipv)));
  }
  return [out, fps];
}

/** game_id → [fingerprint, moves] as the last build left them. */
export function previousMoves(db) {
  const fps = Object.fromEntries(db.all('SELECT game_id, fp FROM move_fingerprints').map(r => [r.game_id, r.fp]));
  const out = {};
  for (const m of db.all('SELECT * FROM moves ORDER BY game_id, ply')) {
    if (m.game_id in fps) (out[m.game_id] ??= [fps[m.game_id], []])[1].push(m);
  }
  return out;
}

/** Classify the profile into its moves table (as classify.build writes moves.parquet and moves.fp.json):
 * {moves, games, distribution: [[label, n, pct], ...] most common first}. */
export function build(db) {
  const [out, fps] = classifyAll(db, previousMoves(db));
  db.tx(() => {
    db.exec('DELETE FROM moves; DELETE FROM move_fingerprints;');
    db.insert('moves', MOVES_SCHEMA, out);
    db.insert('move_fingerprints', ['game_id', 'fp'], Object.entries(fps).map(([game_id, fp]) => ({ game_id, fp })));
  });
  const distribution = db.all(`
    SELECT label, count(*) n, round(100.0 * count(*) / sum(count(*)) OVER (), 1) pct
    FROM moves GROUP BY label ORDER BY n DESC, label`).map(r => [r.label, r.n, r.pct]);
  return { moves: out.length, games: new Set(out.map(m => m.game_id)).size, distribution };
}
