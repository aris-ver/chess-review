// Stage 4c: deterministic facts about a critical move, from engine output + board geometry.
//
// Everything here is a pure function of (position, played move, evals, multipv). No prose; see explain.js for the
// format strings. Boards are chessops positions, moves python-chess style (js/core/chess.js).

import {
  attackers, attacks, boardFromFen, castlingMoves, colorAt, copy, givesCheck, hasCastlingRights, isAttackedBy, isCapture, isCheck,
  isCheckmate, isEnPassant, isGameOver, isLegal, isPinned, legalMoves, makeSquare, move, moveEquals, moveFromUci,
  nullMove, opposite, parseSquare, pieceAt, pieceTypeAt, push, san, squareFile, squareRank, uci,
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
const DESCRIBED = new Set(['best', 'excellent', 'good', 'inaccuracy', 'great', 'brilliant']);   // labels whose comment says what a move does

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
    motif_backed: false,       // the refutation bears the motif out: it wins material through it, or mates
    idea: [],                  // UCI arrows illustrating what a good move does
    threat: null,              // UCI, what a good move threatens next (threatMove)
    still_mates: null,         // the move misses a faster mate but still mates, in this many
    best_mate: null,           // the engine's choice mates, in this many
    lost: null,                // the piece the refutation takes, and how the move lost it (lostPiece)
    trade: null,               // material over the move and its refutation, mover POV (settledTrade)
    best_trade: null,          // material over the best line, mover POV
    best_saves: null,          // the engine's choice keeps the lost piece: {piece, square, moved}
    does: null,                // what the move does (describeMove)
    best_does: null,           // what the engine's choice does, when it isn't the move played
    second: null,              // a great move's next best alternative (secondLine)
    offered: null,             // a brilliant move's piece on offer (offered)
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

/** Why a hung piece has no recapture when the move itself is to blame: the moved piece now stands between one of the
 * mover's sliders and the square, so after `hung`'s capture nothing takes back (13.Kf1 with a knight forking the
 * king and the rook on a1: the king shuts Rh1 off). {piece, square, by, by_square} for the cut-off slider and the
 * moved piece, or null. Only when the engine's reply (`reply`, UCI) is that capture: otherwise the line shown under
 * the sentence is about something else. `boardAfter` is the position after `played`, opponent to move. */
export function blockedRecapture(boardAfter, played, hung, reply) {
  const target = parseSquare(hung.square);
  const cap = legalMoves(boardAfter).find(m => m.to === target && san(boardAfter, m) === hung.capture_san);
  if (!cap || played.null || uci(cap) !== reply) return null;
  const by = pieceTypeAt(boardAfter, played.to);
  if (by === 'king' && Math.abs(squareFile(played.to) - squareFile(played.from)) > 1) return null;  // castling
  const b = copy(boardAfter);
  push(b, cap);
  const mover = b.turn;
  if (attackers(b, mover, target).nonEmpty()) return null;                   // something takes back already
  const freed = attackers(b, mover, target, b.board.occupied.without(played.to)).without(played.to);
  const sq = freed.first();
  if (sq === undefined) return null;
  return { piece: NAMES[pieceTypeAt(b, sq)], square: makeSquare(sq), by: NAMES[by], by_square: makeSquare(played.to) };
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

/** The piece on `sq` can be won: the side to move takes it for a pawn or more (SEE). */
function winnable(board, sq) {
  return legalMoves(board).some(c => c.to === sq && isCapture(board, c) && see(board, c) >= 100);
}

/** Tactical pattern created by `reply` (the opponent's best move after the played move): [motif, detail, targets]
 * or [null, null], `targets` the squares of the pieces named other than the king. Pawns are never what a fork, pin or skewer is
 * about, and a fork, pin or skewer by a piece that can simply be won isn't one. `next`: the answer to `reply` in
 * the engine's line, when known -- then the piece counts as won only when that answer takes it for a pawn or more
 * (static exchange misses what taking it walks into; the engine doesn't). */
export function motif(boardAfter, reply, next = null) {
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
  const safe = next && isLegal(b, next) ? !(next.to === to && isCapture(b, next) && see(b, next) >= 100)
    : !winnable(b, to);
  const on = sq => (pieceTypeAt(b, sq) === 'king' ? 'the king' : `the ${NAMES[pieceTypeAt(b, sq)]} on ${makeSquare(sq)}`);
  const named = sqs => sqs.filter(sq => pieceTypeAt(b, sq) !== 'king').map(makeSquare);

  // skewer: slider attacks a valuable piece with another victim piece behind it on the same ray
  if (SLIDERS.includes(apt) && safe) {
    for (const sq of attacked) {
      const front = pieceTypeAt(b, sq);
      if (front !== 'king' && VALUE[front] <= aval) continue;
      const behind = rayBeyond(b, to, sq);
      if (behind !== null && colorAt(b, behind) === victim) {
        const back = pieceTypeAt(b, behind);
        if (back !== 'pawn' && (front === 'king' || VALUE[front] >= VALUE[back])) {
          return ['skewer', `skewers ${on(sq)} against ${on(behind)}`, named([sq, behind])];
        }
      }
    }
  }

  // fork: the moved piece attacks two pieces that aren't pawns (forkOf)
  const prongs = forkSquares(b, to, safe);
  if (prongs) return ['fork', `forks ${prongs.map(on).join(' and ')}`, named(prongs)];

  // pin: a victim piece, not a pawn, is newly pinned to its king
  if (safe) {
    for (const sq of victimSquares) {
      if (pieceTypeAt(b, sq) !== 'pawn' && isPinned(b, victim, sq) && !isPinned(boardAfter, victim, sq)) {
        return ['pin', `pins ${on(sq)}`, named([sq])];
      }
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
      const from = `the ${NAMES[pieceTypeAt(b, a)]} on ${makeSquare(a)}`;
      if (pt === 'king') return ['discovered', `is a discovered check from ${from}`, []];
      return ['discovered', `discovers an attack from ${from} onto ${on(sq)}`, named([sq])];
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

/** What a good move does, as up to two arrows (UCI), drawn orange. The first that applies:
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
 * else the best capture winning at least THREAT_GAIN that the move itself created. The board draws it red with an
 * orange square on its target. null after a check (passing isn't legal) or when
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

// --- what a line wins or loses --------------------------------------------------------------------------------

export const SETTLE_EXTRA = 6;          // most plies settledLength adds to a line
const SETTLE_LIMIT = 16;               // how far tradeOver's `stable` looks for the exchange to end

/** The legal moves of `pvUci` from `board`: {capture, promotion, check} per ply, stopping at the first that isn't. */
function plyKinds(board, pvUci) {
  const b = copy(board);
  const out = [];
  for (const u of pvUci) {
    let m;
    try {
      m = moveFromUci(u);
    } catch {
      break;
    }
    if (m.null || !isLegal(b, m)) break;
    out.push({ capture: isCapture(b, m), promotion: !!m.promotion, check: givesCheck(b, m) });
    push(b, m);
  }
  return out;
}

/** How many plies of `pvUci` to show: `n`, then on while the next ply takes something or promotes, or the last one
 * shown gives check (its point comes after the answer) -- at most SETTLE_EXTRA more. So a line doesn't stop halfway
 * through an exchange, or on a check before what it wins. */
export function settledLength(board, pvUci, n) {
  const k = plyKinds(board, pvUci);
  let len = Math.min(n, k.length);
  while (len > 0 && len < k.length && len < n + SETTLE_EXTRA
         && (k[len].capture || k[len].promotion || k[len - 1].check)) len++;
  return len;
}

/** tradeOver for the first `len` plies of `pvUci`, plus `settled` (the net where the engine's line settles further
 * on: it runs on while a capture, promotion or check follows a capture or check, up to SETTLE_LIMIT plies) and
 * `stable` (the two are within a pawn). A line still winning or losing material when it stops shouldn't be told as
 * "loses a rook". */
export function settledTrade(board, pvUci, len, pov) {
  const t = tradeOver(board, pvUci.slice(0, len), pov);
  const k = plyKinds(board, pvUci);
  let end = Math.min(len, k.length);
  while (end > 0 && end < k.length && end < SETTLE_LIMIT
         && (k[end].capture || k[end].promotion || k[end - 1].capture || k[end - 1].check)) end++;
  t.settled = end <= len ? t.net : tradeOver(board, pvUci.slice(0, end), pov).net;
  // the engine's line running out on a capture: what comes back after it is unknown
  t.stable = Math.abs(t.settled - t.net) <= 100 && !(end > 0 && end === k.length && k[end - 1].capture);
  return t;
}

const MINOR = r => (r === 'bishop' ? 'knight' : r);

/** The material each side takes along `pvUci` (all of it: pass the plies shown), `pov`'s side first:
 * {won: [roles], lost: [roles], net (centipawns), promotes: [{by_mover, file}], first} -- equal pieces taken on both
 * sides cancel out (a bishop for a knight too), so `won` and `lost` say what changed hands. `first` is the square
 * the line's first move captures on, when that move is `pov`'s and the other side takes nothing back. */
export function tradeOver(board, pvUci, pov) {
  const b = copy(board);
  let won = [], lost = [], net = 0, first = null;
  const promotes = [];
  const promoted = new Map();        // square -> the promotes entry of the piece standing there
  for (const [i, u] of pvUci.entries()) {
    const m = moveFromUci(u);
    if (!isLegal(b, m)) break;
    const mine = b.turn === pov;
    if (isCapture(b, m)) {
      const role = isEnPassant(b, m) ? 'pawn' : pieceTypeAt(b, m.to);
      // a promoted piece taken back was a pawn: its promotion is undone and the pawn is what changed hands
      const p = promoted.get(m.to);
      if (p) {
        promotes.splice(promotes.indexOf(p), 1);
        promoted.delete(m.to);
      }
      (mine ? won : lost).push(p ? 'pawn' : role);
      net += mine ? VALUE[role] : -VALUE[role];
      if (i === 0 && mine) first = makeSquare(m.to);
    }
    if (promoted.has(m.from)) {
      promoted.set(m.to, promoted.get(m.from));
      promoted.delete(m.from);
    }
    if (m.promotion) {
      const p = { by_mover: mine, file: 'abcdefgh'[squareFile(m.to)] };
      promotes.push(p);
      promoted.set(m.to, p);
      net += (mine ? 1 : -1) * (VALUE[m.promotion] - VALUE.pawn);
    }
    push(b, m);
  }
  if (lost.length) first = null;     // "wins the bishop on c3" only when nothing is given back
  for (const exact of [true, false]) {
    for (const r of [...lost]) {
      const j = won.findIndex(w => (exact ? w === r : MINOR(w) === MINOR(r)));
      if (j >= 0) {
        won.splice(j, 1);
        lost.splice(lost.indexOf(r), 1);
      }
    }
  }
  const order = (x, y) => VALUE[y] - VALUE[x];
  won = won.sort(order);
  lost = lost.sort(order);
  return { won, lost, net, promotes, first };
}

/** The mover's piece the refutation actually takes, and how the move lost it -- or null when the line shown takes
 * none of the pieces left hanging (then saying one hangs points at the wrong thing).
 *
 *   kind 'moved':     the moved piece itself, put where it is taken
 *   kind 'trade':     the moved piece, after it captured something worth less (`captured`)
 *   kind 'left':      a piece that was already hanging before the move and still is
 *   kind 'unguarded': the moved piece guarded it from where it stood (`guard`)
 *   kind 'exposed':   anything else the move left open (a line opened, a pin, ...)
 *
 * `taker` is the piece that takes it in the line; `blocked` comes over from blockedRecapture's entry. */
export function lostPiece(board, played, hung, refutationUci) {
  if (!hung.length || played.null) return null;
  const mover = board.turn;
  const after = copy(board);
  push(after, played);
  const taken = new Map();           // square -> the role that takes it
  const moved = new Set();           // squares the mover's pieces left before the opponent got to take
  const walk = copy(after);
  for (const [i, u] of refutationUci.entries()) {
    const m = moveFromUci(u);
    if (!isLegal(walk, m)) break;
    if (i % 2 === 0) {
      if (isCapture(walk, m) && !moved.has(m.to) && !taken.has(m.to)) taken.set(m.to, pieceTypeAt(walk, m.from));
    } else {
      moved.add(m.from);
    }
    push(walk, m);
  }
  const h = hung.find(x => taken.has(parseSquare(x.square)));
  if (!h) return null;
  const sq = parseSquare(h.square);
  const out = { piece: h.piece, square: h.square, taker: NAMES[taken.get(sq)], kind: 'exposed' };
  if (h.blocked) out.blocked = h.blocked;
  if (sq === played.to) {
    if (isCapture(board, played)) {
      const captured = isEnPassant(board, played) ? 'pawn' : pieceTypeAt(board, played.to);
      // taking something worth as much and being taken back is a trade, not a loss
      if (VALUE[captured] >= VALUE[h.piece] || MINOR(captured) === MINOR(h.piece)) return null;
      out.kind = 'trade';
      out.captured = NAMES[captured];
    } else {
      out.kind = 'moved';
    }
    return out;
  }
  const passed = copy(board);
  push(passed, nullMove());
  let before = [];
  try {
    before = hungPieces(passed, mover);
  } catch {
    before = [];
  }
  if (before.some(x => x.square === h.square)) out.kind = 'left';
  else if (attacks(board, played.from).has(sq) && !attacks(after, played.to).has(sq)) {
    out.kind = 'unguarded';
    out.guard = NAMES[pieceTypeAt(board, played.from)];
  }
  return out;
}

/** Would the engine's choice have kept `lost` (a piece left hanging, not the one that moved)? {piece, square, moved}
 * where `moved` says the choice moves it away, or null. */
export function bestSaves(board, bestUci, lost) {
  if (!lost || !bestUci || !['left', 'unguarded', 'exposed'].includes(lost.kind)) return null;
  let m;
  try {
    m = moveFromUci(bestUci);
  } catch {
    return null;
  }
  if (!isLegal(board, m)) return null;
  const b = copy(board);
  const mover = b.turn;
  push(b, m);
  const sq = parseSquare(lost.square);
  if (m.from === sq) {
    const there = hungPieces(b, mover).some(x => x.square === makeSquare(m.to));
    return there ? null : { piece: lost.piece, square: lost.square, moved: true };
  }
  if (pieceTypeAt(b, sq) === null || colorAt(b, sq) !== mover) return null;
  if (isGameOver(b) || hungPieces(b, mover).some(x => x.square === lost.square)) return null;
  return { piece: lost.piece, square: lost.square, moved: false };
}

// --- what any move does ---------------------------------------------------------------------------------------

/** The legal moves of `lineUci` from `board`, as [move, board before it] pairs, stopping at the first that isn't. */
function walkLine(board, lineUci) {
  const b = copy(board);
  const out = [];
  for (const u of lineUci) {
    let m;
    try {
      m = moveFromUci(u);
    } catch {
      break;
    }
    if (m.null || !isLegal(b, m)) break;
    out.push([m, copy(b)]);
    push(b, m);
  }
  return out;
}

const pieceOn = (board, sq) => ({ piece: NAMES[pieceTypeAt(board, sq)], square: makeSquare(sq) });

/** The squares of the two most valuable things the piece on `sq` attacks (attackTargets), king first, when that
 * is a fork: two or more targets that aren't pawns, and the piece itself can't be won (a target may take it, at a
 * loss; `safe` says so when the caller knows better). [squares] or null. `board`: opponent to move. */
function forkSquares(board, sq, safe = !winnable(board, sq)) {
  if (!safe) return null;
  const targets = attackTargets(board, sq).filter(t => pieceTypeAt(board, t) !== 'pawn');
  return targets.length < 2 ? null : targets.slice(0, 2);
}

/** forkSquares as [{piece, square}], or null. */
function forkOf(board, sq) {
  return forkSquares(board, sq)?.map(t => pieceOn(board, t)) ?? null;
}

/** What a move does, as data for one short clause (explain.js words it): the first of
 *
 *   mate        {n}                        the move mates, or forces mate in n (counting itself)
 *   promotes    {piece}
 *   wins        {piece, square, for?, forks?}   a capture that wins material per SEE (`for`: the capturer, when
 *                                          it is lost back for less; `forks`: what it then forks, as fork's targets)
 *   recapture   {piece, square}            takes back on the square the opponent just captured on
 *   trade       {piece, gives}             a capture the line answers by taking back, even material
 *   takes       {piece, square}            a capture nothing above describes
 *   fork        {targets: [{piece, square}]}
 *   blocks / escapes {}                    answers a check by stepping in between / moving the king
 *   check       {wins?}                    `wins`: what the line's next move of ours wins (gains' input)
 *   threat      {mate: san} | {piece, square}   what it threatens next (threatMove)
 *   saves       {piece, square, moved}     a piece that was hanging no longer is
 *   castles     {}
 *   attacks     {piece, square}            the moved piece hits one thing worth taking
 *   offers      {piece}                    invites a trade of like pieces the line takes up
 *   castle_prep {}                         clears the way to castle
 *   prepares    {san}                      the pawn push the line follows up with
 *
 * or null. board: the position before; lineUci: the move and the engine's line after it. mate: the mover mates in
 * this many from `board` (the engine says so), or null. prev: the opponent's last move and the board before it
 * ({move, board}), or null when unknown: then a capture is only "takes" (it may be taking back). */
export function describeMove(board, lineUci, { mate = null, prev = null } = {}) {
  const steps = walkLine(board, lineUci);
  if (!steps.length) return null;
  const mover = board.turn;
  const played = steps[0][0];
  const after = copy(board);
  push(after, played);
  if (isCheckmate(after)) return { kind: 'mate', n: 1 };
  if (mate && mate > 0) return { kind: 'mate', n: mate };
  if (isGameOver(after)) return null;
  const replyPv = lineUci.slice(1);
  const reply = steps.length > 1 ? steps[1][0] : null;
  const role = pieceTypeAt(board, played.from);
  const castling = role === 'king' && Math.abs(squareFile(played.to) - squareFile(played.from)) > 1;
  const to = played.to;

  if (played.promotion) return { kind: 'promotes', piece: NAMES[played.promotion] };

  if (isCapture(board, played) && !castling) {
    const ep = isEnPassant(board, played);
    const taken = ep ? 'pawn' : pieceTypeAt(board, to);
    const at = makeSquare(to);
    const retaken = reply && reply.to === to && isCapture(after, reply);
    const back = prev && !prev.move.null && prev.move.to === to && isCapture(prev.board, prev.move);
    if (back) return { kind: 'recapture', piece: NAMES[taken], square: at };
    const s = ep ? 100 : see(board, played);
    if (s >= 100 && prev) {
      const out = { kind: 'wins', piece: NAMES[taken], square: at };
      if (s < VALUE[taken]) out.for = NAMES[role];
      const prongs = forkOf(after, to);
      if (prongs && prongs.some(t => t.piece !== 'king' && VALUE[t.piece] > VALUE[taken])) out.forks = prongs;
      return out;
    }
    if (retaken && Math.abs(s) < 100) return { kind: 'trade', piece: NAMES[taken], gives: NAMES[pieceTypeAt(after, to)] };
    return { kind: 'takes', piece: NAMES[taken], square: at };
  }

  if (!castling && role !== 'king') {
    const prongs = forkOf(after, to);
    if (prongs) return { kind: 'fork', targets: prongs };
  }
  if (isCheck(board)) return { kind: role === 'king' ? 'escapes' : 'blocks' };

  if (isCheck(after)) {
    const n = settledLength(board, lineUci, 3);
    const t = tradeOver(board, lineUci.slice(0, n), mover);
    return { kind: 'check', wins: t.net >= 200 ? t : null };
  }

  const threat = threatMove(board, played, replyPv);
  if (threat) {
    const tb = copy(after);
    push(tb, nullMove());
    const tm = moveFromUci(threat);
    const mated = copy(tb);
    push(mated, tm);
    if (isCheckmate(mated)) return { kind: 'threat', mate: san(tb, tm) };
    return { kind: 'threat', ...pieceOn(tb, tm.to) };
  }

  const passed = copy(board);
  push(passed, nullMove());
  const before = hungPieces(passed, mover);
  if (before.length) {
    const nowHung = new Set(hungPieces(after, mover).map(h => h.square));
    for (const h of before) {
      const sq = parseSquare(h.square);
      if (sq === played.from && !nowHung.has(makeSquare(to))) return { kind: 'saves', piece: h.piece, square: h.square, moved: true };
      if (sq !== played.from && colorAt(after, sq) === mover && !nowHung.has(h.square)) {
        return { kind: 'saves', piece: h.piece, square: h.square, moved: false };
      }
    }
  }

  if (castling) return { kind: 'castles' };

  const idea = ideaArrows(board, played, replyPv);
  if (idea.length) {
    const a = moveFromUci(idea[0]);
    if (a.from === to && colorAt(after, a.to) !== mover) return { kind: 'attacks', ...pieceOn(after, a.to) };
    if (a.to === to && colorAt(after, a.from) === opposite(mover)) {
      // the reply takes the moved piece: a trade offered, when the taker is a like piece and we take back
      const taker = pieceTypeAt(after, a.from);
      if (idea.length > 1 && MINOR(taker) === MINOR(role)) return { kind: 'offers', piece: NAMES[role] };
      return null;
    }
    if (pieceTypeAt(after, a.from) === 'king' && colorAt(after, a.from) === mover) return { kind: 'castle_prep' };
    if (steps.length > 2) {
      const [, b2] = steps[2];
      if (uci(steps[2][0]) === idea[0] && !isCapture(b2, steps[2][0])) return { kind: 'prepares', san: san(b2, steps[2][0]) };
    }
  }
  return null;
}

/** Two describeMove results that say the same thing (both give check, both keep the knight on e5 safe, ...). */
export function sameIdea(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  const key = d => JSON.stringify(d.targets ?? d.forks ?? [d.square ?? null, d.mate ?? null, d.n ?? null, d.san ?? null]);
  return key(a) === key(b);
}

/** The move makes castling possible on a side it wasn't before (it clears the way, or it is a castle). */
export function opensCastling(board, played) {
  const mover = board.turn;
  const b = copy(board);
  push(b, played);
  if (!hasCastlingRights(b, mover)) return false;
  b.turn = mover;
  const before = castlingMoves(board);
  return castlingMoves(b).some(m => !before.some(x => moveEquals(x, m)) && isLegal(b, m));
}

/** The second line of a MultiPV search, as the facts of a great move need it: what the next best move does to the
 * mover's chances. {san, wp (mover's win%), mate (the mover gets mated in this many, or mates: negative), trade
 * (material over its line, mover POV)}, or null. */
export function secondLine(board, multipv) {
  if (!multipv || multipv.length < 2) return null;
  const r = [...multipv].sort((a, b) => a.rank - b.rank)[1];
  let m;
  try {
    m = moveFromUci(r.move);
  } catch {
    return null;
  }
  if (!isLegal(board, m)) return null;
  const side = board.turn;
  const pv = r.pv?.length ? r.pv : [r.move];
  const n = settledLength(board, pv, REFUTATION_PLIES);
  return {
    san: san(board, m), wp: povWinPct(r.eval_cp, r.mate_in, side, side),
    mate: r.mate_in == null ? null : -r.mate_in,
    line: sans(board, pv, n), trade: settledTrade(board, pv, n, side),
  };
}

/** What a sacrifice offers: the mover's piece the opponent can take after the move (the moved piece when it can be
 * taken, else the most valuable one hanging), whether the engine's reply takes it, and what the rest of the
 * engine's line wins back. {piece, square, taken (by the reply), later (further down the line), back (tradeOver after
 * the reply's capture)}, or null. */
export function offered(board, played, replyPv) {
  const mover = board.turn;
  const after = copy(board);
  push(after, played);
  if (isGameOver(after)) return null;
  const hung = hungPieces(after, mover);
  const atTo = hung.find(h => h.square === makeSquare(played.to));
  let h = atTo;
  if (!h) h = [...hung].sort((a, b) => VALUE[b.piece] - VALUE[a.piece])[0];
  if (!h && isCapture(board, played) && see(board, played) <= -200) {
    // a capture that loses the capturer: the piece on the square is on offer
    h = { piece: NAMES[pieceTypeAt(after, played.to)], square: makeSquare(played.to) };
  }
  if (!h) return null;
  const steps = walkLine(after, replyPv);
  const takes = ([m, b]) => makeSquare(m.to) === h.square && isCapture(b, m);
  const taken = steps.length > 0 && takes(steps[0]);
  const later = !taken && steps.some((st, i) => i % 2 === 0 && takes(st));
  let back = null;
  if (taken && steps.length > 1) {
    const b = copy(after);
    push(b, steps[0][0]);
    const rest = replyPv.slice(1);
    back = settledTrade(b, rest, settledLength(b, rest, REFUTATION_PLIES - 1), mover);
  }
  return { piece: h.piece, square: h.square, taken, later, back };
}

/** Does the refutation bear the motif out? It mates, or it wins two pawns' worth that stays won -- and for a fork,
 * pin or skewer the line takes one of the pieces named (`targets`, squares), so the pattern is how it wins. */
function motifBacked(f, boardAfter, targets) {
  if (f.allowed_mate) return true;
  if (!f.trade || f.trade.net > -200 || f.trade.stable === false) return false;
  if (f.motif === 'discovered') return true;
  const taken = new Set();
  for (const [i, [m, b]] of walkLine(boardAfter, f.refutation_uci).entries()) {
    if (i % 2 === 0 && isCapture(b, m)) taken.add(makeSquare(m.to));
  }
  return targets.some(t => taken.has(t));
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
 * prevRow:    the positions row before `board` ({fen, move_played}), or null: tells a recapture from a capture
 */
export function extract(mv, board, evalBefore, evalAfter, multipv = null, prevRow = null) {
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
  const bestPv = evalBefore.pv || [];
  const bestLen = settledLength(board, bestPv, REFUTATION_PLIES);
  f.best_line = sans(board, bestPv, bestLen);
  f.best_trade = settledTrade(board, bestPv, bestLen, mover);
  if ((evalBefore.mate_in ?? 0) > 0) f.best_mate = evalBefore.mate_in;

  if (evalAfter && Object.keys(evalAfter).length) {
    const pv = evalAfter.pv || [];
    const len = settledLength(boardAfter, pv, REFUTATION_PLIES);
    f.refutation_uci = pv.slice(0, len);
    f.refutation = sans(boardAfter, pv, len);
    f.material_swing = materialSwing(boardAfter, pv.slice(0, REFUTATION_PLIES + 3), mover);
    if (!isGameOver(boardAfter)) f.hung_pieces = hungPieces(boardAfter, mover);
    // only set when it applies, so the hung entries of every other move stay as they were
    const blocked = f.hung_pieces.length ? blockedRecapture(boardAfter, played, f.hung_pieces[0], pv[0]) : null;
    if (blocked) f.hung_pieces[0].blocked = blocked;
    let motifTargets = [];
    if (pv.length) {
      const next = pv.length > 1 ? moveFromUci(pv[1]) : null;
      [f.motif, f.motif_detail, motifTargets = []] = motif(boardAfter, moveFromUci(pv[0]), next);
    }
    // a good move's arrows tell one story: its threat if it makes one, else its idea -- and nothing on the move
    // that ends the game
    if (GOOD.has(f.label) && !isGameOver(boardAfter)) {
      f.threat = threatMove(board, played, pv);
      f.idea = f.threat ? [] : ideaArrows(board, played, pv);
    }

    const m0 = evalBefore.mate_in ?? null, m1 = evalAfter.mate_in ?? null;
    if (m0 !== null && m0 > 0 && !(m1 !== null && m1 < 0)) f.missed_mate = m0;
    if (m1 !== null && m1 > 0 && !(m0 !== null && m0 < 0)) f.allowed_mate = m1;
    if (m1 !== null && m1 < 0) f.still_mates = -m1;

    if (!isGameOver(boardAfter)) {
      f.trade = settledTrade(board, [mv.move_played, ...pv], len + 1, mover);   // what the move itself takes counts
      f.lost = lostPiece(board, played, f.hung_pieces, f.refutation_uci);
      f.best_saves = bestSaves(board, bestPv[0], f.lost);
    }
    f.motif_backed = !!f.motif && motifBacked(f, boardAfter, motifTargets);
  }

  let prev = null;
  if (prevRow?.fen && prevRow.move_played) {
    try {
      prev = { board: boardFromFen(prevRow.fen), move: moveFromUci(prevRow.move_played) };
      if (!isLegal(prev.board, prev.move)) prev = null;
    } catch {
      prev = null;
    }
  }
  if (DESCRIBED.has(f.label) && evalAfter && Object.keys(evalAfter).length) {
    const m1 = evalAfter.mate_in ?? null;
    f.does = describeMove(board, [mv.move_played, ...(evalAfter.pv || [])], { mate: m1 !== null && m1 < 0 ? 1 - m1 : null, prev });
    if (bestPv.length && bestPv[0] !== mv.move_played) {
      const d = describeMove(board, bestPv, { mate: f.best_mate, prev });
      const alsoCastles = d?.kind === 'castle_prep' && opensCastling(board, played);
      if (d && !alsoCastles && !sameIdea(d, f.does)) f.best_does = d;
    }
  }
  // a miss says what the move missed does, when it isn't what the move played does too
  if (f.label === 'miss' && bestPv.length && bestPv[0] !== mv.move_played) {
    const d = describeMove(board, bestPv, { mate: f.best_mate, prev });
    const mine = evalAfter && Object.keys(evalAfter).length
      ? describeMove(board, [mv.move_played, ...(evalAfter.pv || [])], { prev }) : null;
    if (d && !sameIdea(d, mine)) f.best_does = d;
  }
  if (f.label === 'great') f.second = secondLine(board, multipv);
  if (f.label === 'brilliant') f.offered = offered(board, played, evalAfter?.pv || []);

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
