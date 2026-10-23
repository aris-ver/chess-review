// Stage 4c: deterministic facts about a critical move, from engine output + board geometry.
//
// Everything here is a pure function of (position, played move, evals, multipv). No prose; see explain.js for the
// format strings. Boards are chessops positions, moves python-chess style (js/core/chess.js).

import {
  attackers, attacks, castlingMoves, colorAt, copy, givesCheck, hasCastlingRights, isAttackedBy, isCapture, isCheck,
  isCheckmate, isEnPassant, isGameOver, isLegal, isPinned, legalMoves, makeSquare, move, moveEquals, moveFromUci,
  nullMove, opposite, pieceAt, pieceTypeAt, push, san, squareFile, squareRank, uci,
} from './chess.js';
import { ONLY_MOVE_GAP } from './config.js';
import { povWinPct } from './pov.js';
import { IntSet } from './py.js';

export const VALUE = { pawn: 100, knight: 300, bishop: 300, rook: 500, queen: 900, king: 10_000 };
export const NAMES = { pawn: 'pawn', knight: 'knight', bishop: 'bishop', rook: 'rook', queen: 'queen', king: 'king' };
export const REFUTATION_PLIES = 5;
export const GOOD = new Set(['best', 'excellent', 'good', 'great', 'brilliant']);   // labels whose move gets its idea drawn (see ideaArrows)
export const THREAT_GAIN = 200;                                                      // least SEE a threatened capture must win (threatMove)

const SLIDERS = ['bishop', 'rook', 'queen'];

/** MoveFacts, field for field and in the order of the Python dataclass. */
export function moveFacts(f) {
  return {
    game_id: f.game_id, ply: f.ply, side: f.side, is_mine: f.is_mine, san: f.san, best_san: f.best_san, label: f.label,
    wp_before: f.wp_before, wp_after: f.wp_after, wp_loss: f.wp_loss,
    refutation: [],            // SAN, opponent's best line after the move
    refutation_uci: [],
    best_line: [],             // SAN, engine's line from before the move
    material_swing: null,      // mover POV, centipawns, over the refutation
    hung_pieces: [],           // [{piece, square, capture_san, see}]
    missed_mate: null,
    allowed_mate: null,
    was_only_move: null,       // best was the only move (MultiPV gap) and was missed
    motif: null,               // fork | pin | discovered | skewer, on the reply
    motif_detail: null,
    idea: [],                  // UCI arrows illustrating what a good move does
    threat: null,              // UCI, what a good move threatens next (threatMove)
    clock_remaining: f.clock_remaining ?? null,
    time_spent: f.time_spent ?? null,
  };
}

// --- board geometry -------------------------------------------------------------------------------------------

function leastValuableAttacker(board, colour, target) {
  let best = null, bestVal = null;
  for (const sq of attackers(board, colour, target)) {
    if (!isLegal(board, move(sq, target))) continue;
    const v = VALUE[pieceTypeAt(board, sq)];
    if (bestVal === null || v < bestVal) [best, bestVal] = [sq, v];
  }
  return best;
}

/** Static exchange evaluation of `m` (a capture) from the mover's POV, centipawns.
 *
 * Swap-off algorithm on a scratch board; making the captures for real means x-rays and pins fall out of legality
 * checks instead of special cases. */
export function see(board, m) {
  const b = copy(board);
  const target = m.to;
  const captured = pieceTypeAt(b, target);
  const gain = [captured ? VALUE[captured] : 0];
  let onTarget = VALUE[pieceTypeAt(b, m.from)];
  push(b, m);
  for (;;) {
    const atk = leastValuableAttacker(b, b.turn, target);
    if (atk === null) break;
    gain.push(onTarget - gain[gain.length - 1]);
    onTarget = VALUE[pieceTypeAt(b, atk)];
    push(b, move(atk, target));
  }
  for (let d = gain.length - 2; d >= 0; d--) gain[d] = 0 - Math.max(-gain[d], gain[d + 1]);
  return gain[0];
}

/** Pieces of `victim` (not to move) that the side to move can win outright (SEE >= a pawn). */
export function hungPieces(board, victim) {
  if (board.turn === victim) throw new Error('hungPieces: the victim is to move');
  let out = [];
  for (const mv of legalMoves(board)) {
    if (!isCapture(board, mv) || isEnPassant(board, mv)) continue;
    const pt = pieceTypeAt(board, mv.to);
    if (pt === 'king') continue;
    const s = see(board, mv);
    if (s < 100) continue;
    const sq = makeSquare(mv.to);
    const existing = out.find(h => h.square === sq) ?? null;
    if (existing === null || s > existing.see) {
      const entry = { piece: NAMES[pt], square: sq, capture_san: san(board, mv), see: s };
      if (existing) out = out.filter(h => h !== existing);
      out.push(entry);
    }
  }
  return out.sort((a, b) => b.see - a.see);
}

export function material(board, colour) {
  let total = 0;
  for (const role of ['pawn', 'knight', 'bishop', 'rook', 'queen']) total += VALUE[role] * board.board.pieces(colour, role).size();
  return total;
}

export function materialSwing(board, pvUci, pov) {
  const b = copy(board);
  const start = material(b, pov) - material(b, opposite(pov));
  for (const u of pvUci) {
    const mv = moveFromUci(u);
    if (!isLegal(b, mv)) break;
    push(b, mv);
  }
  return (material(b, pov) - material(b, opposite(pov))) - start;
}

/** Next occupied square continuing the line frm -> through, or null. */
function rayBeyond(board, frm, through) {
  const df = squareFile(through) - squareFile(frm);
  const dr = squareRank(through) - squareRank(frm);
  if (df === 0 && dr === 0) return null;
  if (!(df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr))) return null;
  const stepF = Math.sign(df), stepR = Math.sign(dr);
  let f = squareFile(through) + stepF, r = squareRank(through) + stepR;
  while (f >= 0 && f < 8 && r >= 0 && r < 8) {
    const sq = f + 8 * r;
    if (pieceAt(board, sq)) return sq;
    f += stepF;
    r += stepR;
  }
  return null;
}

/** Tactical pattern created by `reply` (the opponent's best move after the played move): [motif, detail]. */
export function motif(boardAfter, reply) {
  const victim = opposite(boardAfter.turn);       // the side that just moved
  const attacker = boardAfter.turn;
  if (!isLegal(boardAfter, reply)) return [null, null];
  const b = copy(boardAfter);
  push(b, reply);
  const to = reply.to;
  const apt = pieceTypeAt(b, to);
  if (apt === null) return [null, null];
  const aval = VALUE[apt];
  const victimSquares = b.board[victim];
  const attacked = attacks(b, to).intersect(victimSquares);

  // skewer: slider attacks a valuable piece with another victim piece behind it on the same ray
  if (SLIDERS.includes(apt)) {
    for (const sq of attacked) {
      const front = pieceTypeAt(b, sq);
      if (front !== 'king' && VALUE[front] <= aval) continue;
      const behind = rayBeyond(b, to, sq);
      if (behind !== null && colorAt(b, behind) === victim) {
        const back = pieceTypeAt(b, behind);
        if (back !== 'pawn' && (front === 'king' || VALUE[front] >= VALUE[back])) {
          return ['skewer', `skewers the ${NAMES[front]} on ${makeSquare(sq)} against the ${NAMES[back]} on ${makeSquare(behind)}`];
        }
      }
    }
  }

  // fork: the moved piece attacks >= 2 victim pieces worth more than it (or the king, or undefended)
  const targets = [];
  for (const sq of attacked) {
    const pt = pieceTypeAt(b, sq);
    if (pt === 'king' || VALUE[pt] > aval || !isAttackedBy(b, victim, sq)) targets.push(`${NAMES[pt]} on ${makeSquare(sq)}`);
  }
  if (targets.length >= 2) return ['fork', `forks the ${targets.join(' and ')}`];

  // pin: a victim piece is newly pinned to its king
  for (const sq of victimSquares) {
    if (isPinned(b, victim, sq) && !isPinned(boardAfter, victim, sq)) {
      return ['pin', `pins the ${NAMES[pieceTypeAt(b, sq)]} on ${makeSquare(sq)}`];
    }
  }

  // discovered attack: a slider other than the moved piece now attacks something valuable it didn't before
  for (const sq of victimSquares) {
    const pt = pieceTypeAt(b, sq);
    if (!['queen', 'rook', 'king'].includes(pt)) continue;
    const now = new IntSet([...attackers(b, attacker, sq)].filter(a => a !== to && SLIDERS.includes(pieceTypeAt(b, a))));
    const before = new IntSet(attackers(boardAfter, attacker, sq));
    const fresh = now.difference(before);
    if (fresh.size) {
      const a = fresh[Symbol.iterator]().next().value;
      return ['discovered', `discovers an attack from the ${NAMES[pieceTypeAt(b, a)]} on ${makeSquare(a)} onto the ${NAMES[pt]} on ${makeSquare(sq)}`];
    }
  }
  return [null, null];
}

/** Enemy pieces the piece on `sq` attacks and could profitably take: worth more than it, undefended, or the king.
 * Most valuable first. */
export function attackTargets(board, sq) {
  const piece = pieceAt(board, sq);
  if (!piece) return [];
  const enemy = opposite(piece.color);
  const out = [];
  for (const t of attacks(board, sq).intersect(board.board[enemy])) {
    const pt = pieceTypeAt(board, t);
    if (pt === 'king' || VALUE[pt] > VALUE[piece.role] || !isAttackedBy(board, enemy, t)) out.push(t);
  }
  return out.sort((a, b) => VALUE[pieceTypeAt(board, b)] - VALUE[pieceTypeAt(board, a)]);
}

/** What a good move does, as up to two arrows (UCI) -- chess.com's orange illustrations. The first that applies:
 * the trade it starts, the pieces it attacks, the castling it makes possible, the pawn push the engine's line
 * follows up with (only when the line really continues that way, and the move supports it).
 *
 * board: the position before the move; replyPv: the engine's line from the position after it. */
export function ideaArrows(board, played, replyPv) {
  const mover = board.turn;
  const b = copy(board);
  push(b, played);
  const to = played.to;
  const pv = [];
  const walk = copy(b);
  for (const u of replyPv.slice(0, 2)) {     // the reply and our move after it, validated as we go
    let m;
    try {
      m = moveFromUci(u);
    } catch {
      break;
    }
    if (!isLegal(walk, m)) break;
    pv.push(m);
    push(walk, m);
  }

  // trade: the reply takes the moved piece, and we take back -- "Rd8+ Rxd8 Rxd8"
  if (pv.length && pv[0].to === to && isCapture(b, pv[0])) {
    const out = [uci(pv[0])];
    if (pv.length > 1 && pv[1].to === to) out.push(uci(pv[1]));
    return out;
  }

  // attacks: the moved piece hits something worth taking -- one arrow per target, a fork shows both prongs
  const targets = attackTargets(b, to);
  if (targets.length) return targets.slice(0, 2).map(t => uci(move(to, t)));

  // castling: the move cleared the way (or the king is now allowed) on a side it couldn't castle before
  if (hasCastlingRights(b, mover)) {
    const mine = copy(b);
    mine.turn = mover;
    const before = castlingMoves(board);
    const fresh = castlingMoves(mine).filter(m => !before.some(x => moveEquals(x, m)) && isLegal(mine, m));
    if (fresh.length) return [uci(fresh[0])];
  }

  // prepares: our next move in the line is a pawn push the moved piece supports, or that our move (not the reply)
  // made possible -- e.g. e6 and then ...d5, or a rook move that unblocks a pawn
  if (pv.length > 1) {
    const nxt = pv[1];
    const afterReply = copy(b);
    push(afterReply, pv[0]);
    if (nxt.from !== to && pieceTypeAt(afterReply, nxt.from) === 'pawn' && colorAt(afterReply, nxt.from) === mover) {
      const supported = attacks(b, to).has(nxt.to);
      const mine = copy(b);
      mine.turn = mover;
      const newOption = !isLegal(board, nxt) && isLegal(mine, nxt);
      if (supported || newOption) return [uci(nxt)];
    }
  }
  return [];
}

/** What a good move threatens (UCI): the move the mover would play next if the opponent passed -- mate in one, or
 * else the best capture winning at least THREAT_GAIN that the move itself created. chess.com draws it red with an
 * orange square on its target (docs/chesscom-review/spec.md, R7). null after a check (passing isn't legal) or when
 * the reply takes the moved piece (a trade in progress, not a threat).
 *
 * board: the position before the move; replyPv: the engine's line from the position after it. */
export function threatMove(board, played, replyPv) {
  const b = copy(board);
  push(b, played);
  if (isCheck(b) || isGameOver(b)) return null;
  if (replyPv.length) {
    let r;
    try {
      r = moveFromUci(replyPv[0]);
    } catch {
      r = null;
    }
    if (r && !r.null && r.to === played.to && isCapture(b, r)) return null;
  }
  push(b, nullMove());
  for (const m of legalMoves(b)) {
    if (givesCheck(b, m)) {
      const after = copy(b);
      push(after, m);
      if (isCheckmate(after)) return uci(m);
    }
  }
  const already = new Map();      // what the mover could already win before the move, per target
  for (const m of legalMoves(board)) {
    if (isCapture(board, m) && !isEnPassant(board, m)) already.set(m.to, Math.max(already.get(m.to) ?? 0, see(board, m)));
  }
  let best = null, bestGain = THREAT_GAIN - 1;
  for (const m of legalMoves(b)) {
    if (!isCapture(b, m) || isEnPassant(b, m) || pieceTypeAt(b, m.to) === 'king') continue;
    const s = see(b, m);
    if (s > bestGain && s > (already.get(m.to) ?? 0)) [best, bestGain] = [m, s];
  }
  return best ? uci(best) : null;
}

// --- assembly -------------------------------------------------------------------------------------------------

export function sans(board, pvUci, limit) {
  const b = copy(board);
  const out = [];
  for (const u of pvUci.slice(0, limit)) {
    const mv = moveFromUci(u);
    if (!isLegal(b, mv)) break;
    out.push(san(b, mv));
    push(b, mv);
  }
  return out;
}

/**
 * move:       row from moves (classify output)
 * board:      position BEFORE the move
 * evalBefore: evals row for that position (side-to-move POV = mover)
 * evalAfter:  evals row for the position after the move (side-to-move = opponent), or null
 * multipv:    evals_multipv rows for the position before, or null
 */
export function extract(mv, board, evalBefore, evalAfter, multipv = null) {
  const mover = board.turn;
  const played = moveFromUci(mv.move_played);
  const boardAfter = copy(board);
  push(boardAfter, played);

  const f = moveFacts({
    game_id: mv.game_id, ply: mv.ply, side: mv.side_to_move, is_mine: mv.is_mine,
    san: mv.san, best_san: mv.best_san, label: mv.label,
    wp_before: mv.wp_before, wp_after: mv.wp_after, wp_loss: mv.wp_loss,
    clock_remaining: mv.clock_remaining, time_spent: mv.time_spent,
  });
  f.best_line = sans(board, evalBefore.pv || [], REFUTATION_PLIES);

  if (evalAfter && Object.keys(evalAfter).length) {
    const pv = evalAfter.pv || [];
    f.refutation_uci = pv.slice(0, REFUTATION_PLIES);
    f.refutation = sans(boardAfter, pv, REFUTATION_PLIES);
    f.material_swing = materialSwing(boardAfter, pv.slice(0, REFUTATION_PLIES + 3), mover);
    if (!isGameOver(boardAfter)) f.hung_pieces = hungPieces(boardAfter, mover);
    if (pv.length) [f.motif, f.motif_detail] = motif(boardAfter, moveFromUci(pv[0]));
    // a good move's arrows tell one story: its threat if it makes one, else its idea -- and nothing on the move
    // that ends the game (spec R13)
    if (GOOD.has(f.label) && !isGameOver(boardAfter)) {
      f.threat = threatMove(board, played, pv);
      f.idea = f.threat ? [] : ideaArrows(board, played, pv);
    }

    const m0 = evalBefore.mate_in ?? null, m1 = evalAfter.mate_in ?? null;
    if (m0 !== null && m0 > 0 && !(m1 !== null && m1 < 0)) f.missed_mate = m0;
    if (m1 !== null && m1 > 0 && !(m0 !== null && m0 < 0)) f.allowed_mate = m1;
  }

  if (multipv && multipv.length) {
    const ranked = [...multipv].sort((a, b) => a.rank - b.rank);
    if (ranked.length >= 2) {
      const side = mv.side_to_move;
      const w1 = povWinPct(ranked[0].eval_cp, ranked[0].mate_in, side, side);
      const w2 = povWinPct(ranked[1].eval_cp, ranked[1].mate_in, side, side);
      f.was_only_move = (w1 - w2 > ONLY_MOVE_GAP) && ranked[0].move !== mv.move_played;
    } else {
      f.was_only_move = false;
    }
  }
  return f;
}
