// Stage 4a: classify every move of a game from its positions joined with their evals.
//
// The labels and their thresholds are chess_review/classify.py's, copied as they are (see its docstring for what
// each label means and how the curve was fitted). Classification is on WIN% loss from the mover's point of view,
// never on centipawns, graded on a curve that depends on the mover's rating (gradeK); wp_before/wp_after/wp_loss,
// and so the graph, accuracy and key moments, stay on the Lichess curve.

import { isBook } from './book.js';
import { boardFromFen, copy, fen, isCapture, isCheckmate, isGameOver, isLegal, legalMoveCount, legalMoves, moveFromUci, pieceTypeAt, push, san, uci } from './chess.js';
import {
  BLUNDER, CP_BLUNDER, CP_MISTAKE, EXCELLENT, GRADE_DEFAULT_RATING, GRADE_K_HIGH, GRADE_K_LOW, GRADE_RATING_HIGH,
  GRADE_RATING_LOW, INACCURACY, LOSING_MATERIAL_CP, MATE_FROM_LOST_CP, MATERIAL_MISTAKE, MISS_AFTER_MIN,
  MISS_BEFORE_MIN, MISTAKE, ONLY_MOVE_GAP,
} from './config.js';
import { materialSwing, see } from './facts.js';
import { moveAccuracy } from './accuracy.js';
import { fenKey } from './fen.js';
import { povWinPct } from './pov.js';
import { pyInt } from './py.js';

export const SACRIFICE_PLIES = 8;     // how far along the engine's line a sacrifice has to stay a sacrifice to be brilliant

/** Loss-only label, for moves that are not the engine's choice. */
export function labelFor(wpLoss) {
  if (wpLoss > BLUNDER) return 'blunder';
  if (wpLoss > MISTAKE) return 'mistake';
  if (wpLoss > INACCURACY) return 'inaccuracy';
  if (wpLoss > EXCELLENT) return 'good';
  return 'excellent';
}

/** The moved piece (knight or better) can be won by the opponent per SEE, or the move is a capture that loses
 * material per SEE. */
export function isSacrifice(board, m) {
  const pt = pieceTypeAt(board, m.from);
  if (pt === null || pt === 'pawn' || pt === 'king') return false;
  if (isCapture(board, m)) return see(board, m) <= -200;   // a recapture/trade is not a sacrifice; only a net loss on the exchange is
  const after = copy(board);
  push(after, m);
  if (isGameOver(after)) return false;
  let best = 0;
  for (const cap of legalMoves(after)) {
    if (cap.to === m.to && isCapture(after, cap)) best = Math.max(best, see(after, cap));
  }
  return best >= 100;
}

/** A sacrifice is only one if the material stays given: over the engine's line after the move the mover is still
 * down at least a pawn, or the line ends in mate. A piece offered to a pawn and won back two moves later by a fork
 * is a tactic, not a sacrifice. */
export function sacrificeHolds(boardAfter, replyPv, mover, replyMate) {
  if (replyMate != null && replyMate < 0) return true;     // the opponent (to move) gets mated: the material is beside the point
  return materialSwing(boardAfter, replyPv.slice(0, SACRIFICE_PLIES), mover) <= -100;
}

/** The move leaves its piece to be taken (per SEE), the engine's reply takes it, and along the engine's line the
 * mover stays at least MATERIAL_MISTAKE down on where the best move's line leaves them. Stockfish's eval flattens out
 * in a decided position, so a rook dropped at -8 can cost barely a pawn of eval; the material count doesn't. */
export function givesAway(board, m, bestPv, replyPv) {
  if (!replyPv.length || !isSacrifice(board, m)) return false;
  const after = copy(board);
  push(after, m);
  const reply = moveFromUci(replyPv[0]);
  if (reply.to !== m.to || !isCapture(after, reply)) return false;
  const line = [uci(m), ...replyPv];
  const n = Math.min(line.length, SACRIFICE_PLIES);
  const mover = board.turn;
  return materialSwing(board, bestPv.slice(0, n), mover) - materialSwing(board, line.slice(0, n), mover) >= MATERIAL_MISTAKE;
}

/** Centipawns of material the move loses against the best move, comparing the engine's two lines over the same few
 * plies (any piece, not only the moved one), mover POV. */
export function materialLost(board, m, bestPv, replyPv, plies = 4) {
  const line = [uci(m), ...replyPv];
  const n = Math.min(plies, line.length, bestPv.length);
  if (n < 2) return 0;
  return materialSwing(board, bestPv.slice(0, n), board.turn) - materialSwing(board, line.slice(0, n), board.turn);
}

/** Steepness of the grading curve for a player of `rating`: GRADE_K_LOW up to GRADE_RATING_LOW, GRADE_K_HIGH from
 * GRADE_RATING_HIGH, log-linear between. */
export function gradeK(rating) {
  const r = rating == null ? GRADE_DEFAULT_RATING : rating;
  const t = Math.min(1.0, Math.max(0.0, (r - GRADE_RATING_LOW) / (GRADE_RATING_HIGH - GRADE_RATING_LOW)));
  return Math.exp(Math.log(GRADE_K_LOW) + t * (Math.log(GRADE_K_HIGH) - Math.log(GRADE_K_LOW)));
}

export const moverRating = (game, mover) => (mover === game.my_colour ? game.my_rating : game.opponent_rating) ?? null;

export function onlyMove(multipv, side) {
  if (!multipv || !multipv.length) return null;
  const ranked = [...multipv].sort((a, b) => a.rank - b.rank);
  if (ranked.length < 2) return true;
  const w1 = povWinPct(ranked[0].eval_cp, ranked[0].mate_in, side, side);
  const w2 = povWinPct(ranked[1].eval_cp, ranked[1].mate_in, side, side);
  return w1 - w2 > ONLY_MOVE_GAP;
}

export function increment(timeControl) {
  if (!timeControl || !timeControl.includes('+')) return 0;
  return pyInt(timeControl.split('+')[1]) ?? 0;
}

export function base(timeControl) {
  if (!timeControl || timeControl.includes('/')) return null;
  return pyInt(timeControl.split('+')[0]);
}

const has = (obj, key) => obj != null && Object.hasOwn(obj, key);
const among = (label, ...labels) => labels.includes(label);

/** rows: positions joined with evals for one game, ordered by ply (terminal row last).
 * multipv: fen_key -> evals_multipv rows (optional). */
export function classifyGame(game, rows, multipv = null) {
  const board = boardFromFen(rows[0].fen);
  const out = [];
  const inc = increment(game.time_control), start = base(game.time_control);
  const lastClock = { white: start, black: start };
  const myColour = game.my_colour;
  let prevLoss = null;
  let lastCapture = null;      // the square the previous move captured on
  multipv = multipv || {};

  for (let i = 0; i < rows.length - 1; i++) {
    const r = rows[i], nxt = rows[i + 1];
    const mover = r.side_to_move;
    const m = moveFromUci(r.move_played);
    const nLegal = legalMoveCount(board);
    const sanPlayed = san(board, m);
    let bestSan = null;
    if (r.best_move) {
      try {
        const best = moveFromUci(r.best_move);
        bestSan = isLegal(board, best) ? san(board, best) : null;
      } catch {
        bestSan = null;
      }
    }

    const hasEvals = r.eval_cp != null || r.mate_in != null;
    const nxtHas = nxt.eval_cp != null || nxt.mate_in != null;
    const wpBefore = hasEvals ? povWinPct(r.eval_cp, r.mate_in, mover, mover) : null;
    const wpAfter = nxtHas ? povWinPct(nxt.eval_cp, nxt.mate_in, nxt.side_to_move, mover) : null;
    const wpLoss = wpBefore !== null && wpAfter !== null ? Math.max(0.0, wpBefore - wpAfter) : null;
    const k = gradeK(moverRating(game, mover));
    const loss = wpLoss === null ? null : Math.max(0.0, povWinPct(r.eval_cp, r.mate_in, mover, mover, k)
      - povWinPct(nxt.eval_cp, nxt.mate_in, nxt.side_to_move, mover, k));
    // mover POV: eval before, and the mate the opponent has after (null if none)
    const cpBefore = r.eval_cp ?? null;
    const cpAfter = nxt.eval_cp == null ? null : 0 - nxt.eval_cp;
    const matedInAfter = (nxt.mate_in || 0) > 0 ? nxt.mate_in : null;
    const isBest = Boolean(r.best_move) && r.best_move === r.move_played;
    const key = r.fen_key || fenKey(r.fen);
    const only = hasEvals ? onlyMove(has(multipv, key) ? multipv[key] : null, mover) : null;
    // mate was available and the played move no longer forces one
    const missedMate = (r.mate_in || 0) > 0 && !((nxt.mate_in || 0) < 0);

    const boardBefore = copy(board);
    const capture = isCapture(board, m);
    const recapture = capture && m.to === lastCapture;
    push(board, m);
    const inBook = isBook(fenKey(fen(board)));
    const rPv = r.pv || [], nxtPv = nxt.pv || [];

    let label;
    if (inBook) label = 'book';
    else if (nLegal === 1) label = 'forced';
    else if (loss === null) label = null;
    else if (isBest || loss <= EXCELLENT) {
      if (10 < wpBefore && wpBefore < 90 && wpAfter >= 35 && isSacrifice(boardBefore, m)
          && sacrificeHolds(board, nxtPv, boardBefore.turn, nxt.mate_in)) label = 'brilliant';
      else if (isBest && only && !recapture && 10 < wpBefore && wpBefore < 95) label = 'great';
      else if (isBest || (cpBefore !== null && cpAfter !== null && cpAfter >= cpBefore)) label = 'best';
      else label = 'excellent';
    } else {
      label = labelFor(loss);
      const opportunity = (prevLoss !== null && prevLoss > MISTAKE) || missedMate;
      if (opportunity && wpBefore >= MISS_BEFORE_MIN && wpAfter >= MISS_AFTER_MIN
          && (among(label, 'mistake', 'blunder') || (missedMate && among(label, 'good', 'inaccuracy')))) label = 'miss';
    }

    if (among(label, 'best', 'excellent', 'good', 'inaccuracy', 'great', 'mistake') && !isBest
        && r.eval_cp != null && nxt.eval_cp != null) {
      const cpDrop = r.eval_cp - (0 - nxt.eval_cp);      // both mover POV
      if (cpDrop >= CP_MISTAKE && isSacrifice(boardBefore, m)) label = cpDrop >= CP_BLUNDER ? 'blunder' : 'mistake';
    }
    if (among(label, 'best', 'excellent', 'good', 'inaccuracy', 'great') && !isBest
        && r.mate_in == null && nxt.mate_in == null && givesAway(boardBefore, m, rPv, nxtPv)) label = 'mistake';

    if (r.mate_in === 1 && !isCheckmate(board) && among(label, 'best', 'excellent', 'good', 'inaccuracy')) label = 'miss';
    if (r.mate_in != null && r.mate_in < 0 && matedInAfter !== null
        && matedInAfter < -r.mate_in - 1 && among(label, 'best', 'excellent', 'good')) {
      label = 'inaccuracy';                                 // walked into a faster mate than the one coming
    }
    if (cpBefore !== null && matedInAfter !== null) {
      if (cpBefore <= MATE_FROM_LOST_CP && among(label, 'best', 'excellent', 'good', 'inaccuracy', 'great', 'mistake', 'blunder')) {
        label = matedInAfter <= 3 ? 'mistake' : 'inaccuracy';   // lost already, now mated
      } else if (cpBefore <= LOSING_MATERIAL_CP && label === 'blunder') {
        label = 'mistake';
      }
    }
    if (among(label, 'best', 'excellent', 'good', 'inaccuracy', 'great') && !isBest
        && cpBefore !== null && cpBefore <= LOSING_MATERIAL_CP
        && materialLost(boardBefore, m, rPv, nxtPv) >= MATERIAL_MISTAKE) {
      label = 'mistake';                                    // the losing side gives more away
    }

    const clk = r.clock_remaining ?? null;
    let spent = null;
    if (clk !== null && lastClock[mover] != null) spent = Math.max(0, lastClock[mover] - clk + inc);
    if (clk !== null) lastClock[mover] = clk;

    out.push({
      game_id: r.game_id, ply: r.ply, side_to_move: mover, is_mine: mover === myColour,
      move_played: r.move_played, san: sanPlayed, best_move: r.best_move ?? null, best_san: bestSan,
      n_legal: nLegal, is_forced: nLegal === 1, in_book: inBook,
      wp_before: wpBefore, wp_after: wpAfter, wp_loss: wpLoss,
      accuracy: wpLoss !== null ? moveAccuracy(wpLoss) : null,
      label, only_move: only, clock_remaining: clk, time_spent: spent,
    });
    prevLoss = loss;
    lastCapture = capture ? m.to : null;
  }
  return out;
}
