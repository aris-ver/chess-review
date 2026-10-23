// On-the-spot analysis of "what if" moves made on the board in the UI, as chess_review/explore.py: the sandbox's
// moves graded like the game's own, its live engine lines, and the eval of a position with its line in SAN (a
// puzzle's "why not").
//
// Searches go through the engine pool (js/core/engine.js) at the batch's node count, and their `info` lines become
// evals rows in js/core/analyse.js, so a move is graded from the same kind of search as the game's moves. Results
// are kept in memory only; the evals cache is read (when given) but never written.

import { evaluateMultipv, parseInfo } from '../core/analyse.js';
import { boardFromFen, copy, fen, isCheckmate, isGameOver, legalMoves, moveFromUci, parseUci, push, san, uci } from '../core/chess.js';
import { classifyGame } from '../core/classify.js';
import { DEFAULT_NODES, MULTIPV_N } from '../core/config.js';
import { comment } from '../core/explain.js';
import { extract } from '../core/facts.js';
import { fenKey } from '../core/fen.js';
import { povWinPct } from '../core/pov.js';
import { pyRound } from '../core/py.js';
import { evalText } from './site.js';

export const PV_PLIES = 16;     // how much of each engine line the sandbox shows
export const WHY_NOT_PLIES = 6; // how much of the line /api/eval gives (a puzzle's wrong move)
export const CRASH_RETRY_NODES = [100_000, 20_000];   // as analyse.py: Stockfish segfaults on a few rare positions

/** The engine crashed on this position at every node count: there is no evaluation (explore.py's RuntimeError). */
export class NoEvalError extends Error {}

/** An illegal move for the position (explore.py's ValueError). */
export class IllegalMoveError extends Error {}

const sideOf = board => board.turn;

/** analyse._score: [cp, mate] of a parsed info, side-to-move POV. */
const score = info => ('mate' in info.score ? [null, info.score.mate] : [info.score.cp, null]);

/** Up to `limit` moves of a UCI line in SAN, stopping at the first that isn't legal ('--' for a null move). */
function sanLine(board, pv, limit) {
  const out = [], b = copy(board);
  for (const u of pv.slice(0, limit)) {
    try {
      const m = parseUci(b, u);
      out.push(m.null ? '--' : san(b, m));
      push(b, m);
    } catch {
      break;
    }
  }
  return out;
}

const ranksOf = lines => [...lines.keys()].sort((a, b) => a - b);

/** The current top lines of an in-progress MultiPV search, for the client. lines: Map multipv → parsed info. */
export function linesSnapshot(board, lines) {
  const side = sideOf(board);
  const out = [];
  for (const rank of ranksOf(lines)) {
    const info = lines.get(rank);
    const move = info.pv[0];
    const [cp, mate] = score(info);
    // the whole line in SAN (capped: the tail of a deep PV is noise in the UI)
    const pv = sanLine(board, info.pv, PV_PLIES);
    const wpWhite = cp !== null || mate !== null ? povWinPct(cp, mate, side, 'white') : null;
    out.push({
      rank, uci: move, san: pv.length ? pv[0] : move, pv,
      eval: evalText(cp, mate, side),
      wp_white: wpWhite !== null ? pyRound(wpWhite, 1) : null, depth: info.depth ?? null,
    });
  }
  return { lines: out };
}

/** [evals row, evals_multipv rows] from the current lines of a running search: the shape evaluate() returns, so a
 * deep snapshot can stand in for the fixed-budget eval of the same position. */
export function linesRows(lines, nodes) {
  const ranks = ranksOf(lines).map(rank => {
    const info = lines.get(rank);
    const [cp, mate] = score(info);
    return { rank, move: info.pv[0], eval_cp: cp, mate_in: mate, pv: [...info.pv] };
  });
  const top = ranks[0];
  return [{ nodes, eval_cp: top.eval_cp, mate_in: top.mate_in, best_move: top.pv[0], pv: top.pv }, ranks];
}

/** The eval of the position after `move`, read off the search that listed it as a candidate: the line's own score
 * seen from the other side, and the rest of its pv. null when the move wasn't among the lines. */
export function afterFromLine(ranks, move, nodes) {
  for (const r of ranks) {
    if (r.move !== move || (r.eval_cp == null && r.mate_in == null)) continue;
    const m = r.mate_in ?? null;
    // "mate in m" for the mover is, once the first move is on the board, "mated in m-1" for the opponent (0 =
    // checkmated, as evaluate() reports it); "mated in |m|" becomes the opponent's "mate in |m|"
    const mate = m === null ? null : m > 0 ? 1 - m : 0 - m;
    const cp = r.eval_cp == null ? null : 0 - r.eval_cp;
    const pv = r.pv.slice(1);
    return { nodes, eval_cp: cp, mate_in: mate, best_move: pv.length ? pv[0] : null, pv };
  }
  return null;
}

const terminal = board => isCheckmate(board) || board.isStalemate() || board.isInsufficientMaterial();

/** analyse.robust_multipv over the pool: a search that fails (the engine died; the pool restarts it) is retried
 * with fewer nodes, and after that the position has no eval. */
export async function robustMultipv(board, pool, nodes, multipv = MULTIPV_N) {
  if (terminal(board)) return evaluateMultipv(board, []);
  // a game over by the 75-move rule is still searched, single-PV, as python-chess's evaluate() does
  const n = isGameOver(board) ? 1 : multipv;
  for (const k of [nodes, ...CRASH_RETRY_NODES]) {
    let lines;
    try {
      lines = await pool.search(fen(board), k, n);
    } catch {
      continue;
    }
    return evaluateMultipv(board, lines);
  }
  return [{ nodes: 0, eval_cp: null, mate_in: null, best_move: null, pv: [] }, []];
}

export class Explorer {
  /** pool: an EnginePool (js/core/engine.js); evals: the evals cache's Db (Store.evals()), read for positions the
   * batch has already searched, or null. */
  constructor(pool, { nodes = DEFAULT_NODES, evals = null } = {}) {
    this.pool = pool;
    this.nodes = nodes;
    this.evals = evals;
    this.cache = new Map();      // fen_key → [evals row, multipv rows]
    this.lastUsed = 0;
  }

  /** The engine's UCI id, e.g. "Stockfish 17.1" (starts the pool if needed). */
  async name() {
    await this.pool.load();
    return this.pool.name || 'engine';
  }

  legal(fenStr) {
    const board = boardFromFen(fenStr);
    return { turn: board.turn, moves: legalMoves(board).map(uci) };
  }

  /** A cached eval, from this explorer's memory or the evals cache. */
  lookup(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    if (!this.evals) return null;
    try {
      const main = this.evals.get('SELECT nodes, eval_cp, mate_in, best_move, pv FROM evals WHERE fen_key = ?', [key]);
      if (main === undefined) return null;
      return [main, this.evals.all('SELECT * FROM evals_multipv WHERE fen_key = ? AND rank > 0 ORDER BY rank', [key])];
    } catch {
      return null;      // a locked or missing cache is not fatal here
    }
  }

  /** [evals row, multipv rows] of a position; throws NoEvalError when the engine crashes on it. */
  async evaluate(board) {
    const key = fenKey(fen(board));
    const hit = this.lookup(key);
    if (hit !== null) return hit;
    this.lastUsed = Date.now();
    const res = await robustMultipv(board, this.pool, this.nodes);
    if (res[0].eval_cp === null && res[0].mate_in === null) {
      throw new NoEvalError('the engine crashes on this position (Stockfish bug), no evaluation');
    }
    this.cache.set(key, res);
    return res;
  }

  /** The /api/eval answer: the engine's eval and best move in a position, and its line in SAN (a puzzle's "why
   * not"). Throws as evaluate() does. */
  async position(fenStr) {
    const board = boardFromFen(fenStr);
    const [main] = await this.evaluate(board);
    const bestUci = main.best_move ?? null;
    let bestSan = null;
    if (bestUci) {
      try {
        bestSan = san(board, moveFromUci(bestUci));
      } catch {
        bestSan = null;
      }
    }
    const side = sideOf(board);
    const hasEval = main.eval_cp != null || main.mate_in != null;
    const wp = hasEval ? povWinPct(main.eval_cp, main.mate_in, side, 'white') : null;
    return {
      eval: evalText(main.eval_cp, main.mate_in, side),
      wp_white: wp !== null ? pyRound(wp, 1) : null,
      best_uci: bestUci, best_san: bestSan, pv_san: sanLine(board, main.pv || [], WHY_NOT_PLIES),
      mate_in: main.mate_in, eval_cp: main.eval_cp,
    };
  }

  /** Snapshots of the top lines while the engine searches the position indefinitely (`go infinite`, like an analysis
   * board), from `infos`: the raw lines that search prints (an async iterable; whoever runs the search starts it with
   * the MultiPV wanted, and stops it when this generator is closed). explore.analyse_stream's loop:
   *
   * The fixed-budget eval of the position comes first (cached): move() will need it as the "before" side of the next
   * move the user makes. As the search deepens, its snapshots replace that eval in the cache (whenever they have
   * seen more nodes), so the move the user then plays is graded by the same search that drew the arrows.
   *
   * Between depth iterations the engine can be quiet for seconds (only `currmove` infos, no pv), so the last
   * snapshot is re-sent about once a second as a heartbeat. now: the clock, in seconds. */
  async *analyseStream(board, infos, { now = () => Date.now() / 1000 } = {}) {
    let bestNodes;
    try {
      bestNodes = (await this.evaluate(board))[0].nodes;
    } catch (e) {
      if (e instanceof NoEvalError) return;    // the engine crashes on this position; nothing to stream either
      throw e;
    }
    const key = fenKey(fen(board));
    const name = await this.name();
    const lines = new Map();
    let lastEmit = 0, nodes = 0;
    try {
      for await (const line of infos) {
        const head = /^\s*info(?:\s+([\s\S]*))?$/.exec(line);
        if (!head) continue;
        const info = parseInfo(head[1] ?? '', board);
        this.lastUsed = Date.now();
        nodes = Math.max(nodes, info.nodes ?? 0);
        const t = now();
        const fresh = !!(info.pv && info.pv.length && 'multipv' in info && 'score' in info);
        if (fresh) {
          lines.set(info.multipv, info);
          if (lines.has(1) && nodes > bestNodes) {
            this.cache.set(key, linesRows(lines, nodes));
            bestNodes = nodes;
          }
        }
        if (!lines.size || t - lastEmit < (fresh ? 0.12 : 1.0)) continue;   // ~8 snapshots/s while lines change, 1/s heartbeat
        lastEmit = t;
        yield { engine: name, nodes, ...linesSnapshot(board, lines) };
      }
    } catch {
      // the engine died mid-search: the stream just ends (the pool restarts it)
    }
  }

  /** A move tried on the board, graded through the normal classifier so labels and comments match the game's own.
   * ratings: {white, black} of the game it is tried in, for the same rating-dependent curve. */
  async move(fenStr, moveUci, myColour, ply = 0, ratings = null) {
    const board = boardFromFen(fenStr);
    const tried = moveFromUci(moveUci);
    if (!legalMoves(board).some(m => uci(m) === uci(tried))) throw new IllegalMoveError(`illegal move ${moveUci}`);
    const [beforeMain, beforeRanks] = await this.evaluate(board);
    const after = copy(board);
    push(after, tried);
    // A move the search already had a line for is graded by that line (the numbers the user was looking at);
    // anything else gets its own fixed-budget search.
    let afterMain = afterFromLine(beforeRanks, moveUci, beforeMain.nodes) ?? (await this.evaluate(after))[0];
    // The grade comes from that line, but the continuation must not: below rank 1, and wherever the pv was cut
    // short, its tail is a weaker opinion than a search of the new position. That tail draws the arrow at the end of
    // a variation and names the move the coach says to play, so the new position is searched for it.
    const over = isGameOver(after);
    if (!over) {
      try {
        const own = (await this.evaluate(after))[0];
        afterMain = { ...afterMain, best_move: own.best_move, pv: own.pv };
      } catch (e) {
        if (!(e instanceof NoEvalError)) throw e;     // the engine crashes on some positions; keep the tail
      }
    }

    // a two-row "game" through the normal classifier
    const rows = [
      { game_id: 'explore', ply, fen: fen(board), fen_key: fenKey(fen(board)), side_to_move: board.turn,
        move_played: moveUci, clock_remaining: null, ...beforeMain },
      { game_id: 'explore', ply: ply + 1, fen: fen(after), fen_key: fenKey(fen(after)), side_to_move: after.turn,
        move_played: null, clock_remaining: null, ...afterMain },
    ];
    const multipv = { [rows[0].fen_key]: beforeRanks.map(r => ({ fen_key: rows[0].fen_key, ...r })) };
    const theirs = myColour === 'white' ? 'black' : 'white';
    const game = { game_id: 'explore', my_colour: myColour, time_control: null,
      my_rating: ratings?.[myColour] ?? null, opponent_rating: ratings?.[theirs] ?? null };
    const m = classifyGame(game, rows, multipv)[0];
    const facts = extract(m, board, rows[0], rows[1], multipv[rows[0].fen_key] ?? null);
    const hasEval = afterMain.eval_cp != null || afterMain.mate_in != null;
    return {
      san: m.san, uci: moveUci, fen: fen(after), label: m.label, is_mine: m.is_mine,
      wp_white: hasEval ? pyRound(povWinPct(afterMain.eval_cp, afterMain.mate_in, rows[1].side_to_move, 'white'), 1) : null,
      eval: evalText(afterMain.eval_cp, afterMain.mate_in, rows[1].side_to_move),
      wp_loss: m.wp_loss == null ? null : pyRound(m.wp_loss, 1),
      best_san: m.best_san, best_uci: beforeMain.best_move,
      clock: null, spent: null,
      comment: comment(facts), hung: facts.hung_pieces.map(h => h.square),
      reply_uci: facts.refutation_uci.length ? facts.refutation_uci[0] : null, idea: facts.idea,
      threat: facts.threat,
      // the engine's move in the new position, so a variation can be followed move by move
      next_best_uci: afterMain.best_move, next_best_san: facts.refutation.length ? facts.refutation[0] : null,
      game_over: over,
    };
  }
}
