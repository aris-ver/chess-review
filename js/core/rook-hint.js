// The rook drills' review hint (docs/training-grounds.md "Rook endings (v2)"): no table grades a rook ending move by
// move, so after an attempt a deeper engine search scores every position where the user was to move, and the move
// after which the score fell the most is "probably" where it went wrong. Pure: the scores come in, and the named
// hints read only the positions. An estimate by design; the page always says so.
//
// Scores are white's view (the user's), in centipawns, mates and everything else clamped to +-HINT_CLAMP.
// A user move k goes from the position before it (white to move) to the one after Stockfish's reply (white to move
// again), or, for a last move with no reply, to the position just after it; its fall is score_before - score_after
// in both endings (white's view: Lucena losing the win, Philidor letting black win both fall).

import { boardFromFen, legalMoves, parseUci, push } from './chess.js';

export const REVIEW_NODES = 400_000;     // per position; the opponent plays at 200,000
export const HINT_MOVES = 20;            // the last 20 user moves are scored, earlier ones get null
export const HINT_FALL = 100;            // a fall smaller than this marks no move ("no single move stands out")
export const HINT_CLAMP = 1000;          // mates and big scores, white's view
export const HINT_PV = 8;                // plies of the engine's line from a position

/** The search's score ({cp, mate}, the side to move's view) as white's, clamped; null when there is none. */
export function whiteScore(turn, { cp = null, mate = null } = {}) {
  const sign = turn === 'w' ? 1 : -1;
  if (mate != null) return sign * (mate > 0 ? HINT_CLAMP : -HINT_CLAMP);     // mate 0: the side to move is mated
  if (cp == null) return null;
  return Math.max(-HINT_CLAMP, Math.min(HINT_CLAMP, sign * cp));
}

/** Which user move the score fell most after: k, or null when no fall reaches HINT_FALL (earliest on a tie). moves
 * is [{score_before, score_after}], either null when not scored. */
export function likelyMove(moves) {
  let best = null, fall = HINT_FALL - 1;
  moves.forEach((m, k) => {
    if (m.score_before == null || m.score_after == null) return;
    const f = m.score_before - m.score_after;
    if (f > fall) { fall = f; best = k; }
  });
  return best;
}

// ---------- named hints ----------

const squaresOf = (fen, letter) => {
  const out = [];
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const c of row) {
      if (c >= '1' && c <= '8') f += +c;
      else { if (c === letter) out.push({ file: f, rank: 7 - r, sq: (7 - r) * 8 + f }); f++; }
    }
  });
  return out;
};
const one = (fen, letter) => squaresOf(fen, letter)[0] ?? null;
const between = (x, a, b) => x > Math.min(a, b) && x < Math.max(a, b);

// the piece letter on a square in a FEN
function letterAt(fen, sq) {
  for (const c of 'KQRBNPkqrbnp') if (squaresOf(fen, c).some(p => p.sq === sq)) return c;
  return null;
}

// black, to move in `fen`, can take the white pawn and white can't take back on that square
function pawnHangs(fen) {
  const p = one(fen, 'P');
  if (!p) return false;
  const board = boardFromFen(fen);
  return legalMoves(board).some(m => {
    if (m.to !== p.sq) return false;
    const next = boardFromFen(fen);
    push(next, m);
    return !legalMoves(next).some(x => x.to === p.sq);
  });
}

/**
 * The named hint for a user move, or null for the generic line. before: the position the move was played in (white
 * to move), uci the move, after: the position after it, reply: Stockfish's answer (UCI, or null when the drill ended
 * on the move). Lucena: 'pawn_hanging', 'rook_cut' (the rook stopped cutting the black king off), 'king_shelter' (the
 * king left its shelter before the rook was on the 4th rank to block checks). Philidor: 'king_path' (the king left
 * the pawn's path), 'rook_third' (the rook left the 3rd rank before the pawn reached it), 'rook_behind' (the pawn
 * reached the 3rd rank and the rook didn't go to the far end to check from behind).
 */
export function namedHint(ending, { before, uci, after, reply = null }) {
  const board = boardFromFen(before), m = parseUci(board, uci);
  const piece = letterAt(before, m.from);
  const from = { file: m.from & 7, rank: m.from >> 3 }, to = { file: m.to & 7, rank: m.to >> 3 };
  if (ending === 'Lucena') {
    const pawn = one(before, 'P'), bk = one(before, 'k'), rook = one(before, 'R');
    if (!pawn || m.promotion) return null;
    const replyTook = reply && one(after, 'P') && parseUci(boardFromFen(after), reply).to === one(after, 'P').sq;
    if (one(after, 'P') && (replyTook || pawnHangs(after))) return 'pawn_hanging';
    if (piece === 'R' && rook && bk && between(rook.file, bk.file, pawn.file) && !between(to.file, bk.file, pawn.file)) return 'rook_cut';
    if (piece === 'K' && Math.abs(from.file - pawn.file) <= 1 && from.rank > pawn.rank && to.rank <= pawn.rank
        && !(rook && (rook.rank === 3 || rook.rank === 4))) {
      if (!reply) return 'king_shelter';
      const next = boardFromFen(after);
      push(next, parseUci(next, reply));
      if (next.isCheck()) return 'king_shelter';
    }
    return null;
  }
  const pawn = one(before, 'p');
  if (!pawn) return null;
  if (piece === 'K' && from.file === pawn.file && from.rank < pawn.rank && to.file !== pawn.file) return 'king_path';
  if (piece === 'R' && from.rank === 2 && pawn.rank > 2 && to.rank !== 2) return 'rook_third';
  if (pawn.rank <= 2) {
    const rook = one(after, 'R');
    if (rook && rook.rank < 5) return 'rook_behind';
  }
  return null;
}
