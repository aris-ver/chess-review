// The rook drills' opponent (core/rook-drills.js): Stockfish as black, on a pool of its own (env.drillEngine), so a
// review job never delays a reply. Desktop: one native engine, Hash 16 (js/desktop/main.js); desktop browsers: one
// full-net WASM engine in the leader worker (js/web/worker.js); phones have none this phase ("needs a computer").
// Every search is the same: `ucinewgame`, MultiPV 1, `position fen <start> moves <history>`, `go nodes N`, so the
// same binary gives the same reply to the same game every time.
//
// A crash on a position (Stockfish has a few) is retried at fewer nodes, as explore.js does; a pool that fails every
// time (no Stockfish file, the WASM failed) is an EngineFailed, which the routes answer with a 503.

import { EngineFailed, OPPONENT_NODES } from '../core/rook-drills.js';
import { CRASH_RETRY_NODES } from './explore.js';

export { EngineFailed };     // core/rook-drills.js has it, so an illegal engine move there is one too

/** The best move and its score in a search's `info` lines (the last exact line with a pv, multipv 1): {move, cp,
 * mate, pv}, the score from the side to move's view and pv the line (UCI), or null when there is none. */
export function bestOf(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!/ pv /.test(l) || / (lower|upper)bound/.test(l)) continue;
    const mpv = l.match(/ multipv (\d+)/);
    if (mpv && mpv[1] !== '1') continue;
    const pv = l.match(/ pv (.+)$/)[1].trim().split(/\s+/);
    const cp = l.match(/ score cp (-?\d+)/), mate = l.match(/ score mate (-?\d+)/);
    return { move: pv[0], cp: cp ? +cp[1] : null, mate: mate ? +mate[1] : null, pv };
  }
  return null;
}

/** The opponent over a pool (js/core/engine.js EnginePool): async ({fen, moves}) → {move, cp, mate, nodes, ms}, as
 * rook-drills.js rookTurn takes it. Throws EngineFailed when no search gives a move. */
export function opponent(pool, { nodes = OPPONENT_NODES, now = () => performance.now(), log = null } = {}) {
  return async ({ fen, moves }) => {
    const t0 = now();
    let last = null;
    for (const n of [nodes, ...CRASH_RETRY_NODES.filter(x => x < nodes)]) {
      try {
        const best = bestOf(await pool.search(fen, n, 1, moves));
        if (best) return { ...best, nodes: n, ms: Math.round(now() - t0) };
        last = new Error('no move in the engine output');
      } catch (e) {
        last = e;
        log?.warn?.(`drill engine at ${n} nodes: ${e?.message ?? e}`);
      }
    }
    throw new EngineFailed(`the engine failed: ${last?.message ?? last}`);
  };
}

/** A search for the rook drills' review hint over a pool (the analysis pool: a review can use every engine): async
 * ({fen, moves}) → {move, cp, mate, pv} or null when every try failed (retried at fewer nodes as above). */
export function scorer(pool, { nodes, log = null } = {}) {
  return async ({ fen, moves }) => {
    for (const n of [nodes, ...CRASH_RETRY_NODES.filter(x => x < nodes)]) {
      try {
        const best = bestOf(await pool.search(fen, n, 1, moves));
        if (best) return best;
      } catch (e) {
        log?.warn?.(`hint search at ${n} nodes: ${e?.message ?? e}`);
      }
    }
    return null;
  };
}
