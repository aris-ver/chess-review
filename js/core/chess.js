// python-chess, as far as chess_review uses it, on top of chessops. The ported modules call these helpers where the
// Python calls `chess.Board` methods, so that the answers match bit for bit:
//  - moves are python-chess moves, {from, to, promotion?}, with castling as the king's two-square step (e1g1); they
//    become chessops' king-takes-rook form only on the way into chessops;
//  - legalMoves() yields moves in python-chess's generation order, which decides ties further on (which hung piece
//    is named first, which mate-in-one threat is drawn);
//  - squares iterate in ascending order wherever a python-chess SquareSet does.
// Positions are chessops `Chess` objects; colours are 'white' | 'black'.

import {
  Chess, SquareSet, attacks as pieceAttacks, between, bishopAttacks, defined, fen as fenIO, kingAttacks, makeSquare,
  normalizeMove, opposite, pawnAttacks, ray, rookAttacks, san as sanIO, squareFile, squareRank,
} from '../vendor/chessops.js';

export { SquareSet, makeSquare, opposite, squareFile, squareRank };

/** @typedef {import('../vendor/chessops.js').Chess} Position */
/** @typedef {'pawn'|'knight'|'bishop'|'rook'|'queen'|'king'} Role */
/** @typedef {{from: number, to: number, promotion?: Role, null?: boolean}} Move */

const PROMOTION = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const PROMOTION_CHAR = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
const PROMOTIONS = ['queen', 'rook', 'bishop', 'knight'];    // python-chess yields them in this order
const SQUARE = /^[a-h][1-8]$/;

export class InvalidMoveError extends Error {}

/** chess.Board(fen): no validation, as python-chess doesn't validate either. */
export function boardFromFen(fen) {
  const pos = Chess.default();
  pos.setupUnchecked(fenIO.parseFen(fen).unwrap());
  return pos;
}

/** board.fen(): the en passant square only when a legal capture exists, counters uncapped. */
export function fen(pos) {
  return fenIO.makeFen({ ...pos.toSetup(), halfmoves: pos.halfmoves, fullmoves: pos.fullmoves });
}

const squareIndex = name => (name.charCodeAt(0) - 97) + 8 * (name.charCodeAt(1) - 49);

/** chess.Move.from_uci: throws InvalidMoveError where python-chess raises. */
export function moveFromUci(uci) {
  if (uci === '0000') return nullMove();
  if (uci.length === 4 && uci[1] === '@') throw new InvalidMoveError(`drops are not supported: ${uci}`);
  if (uci.length < 4 || uci.length > 5) throw new InvalidMoveError(`invalid uci: ${uci}`);
  const a = uci.slice(0, 2), b = uci.slice(2, 4);
  if (!SQUARE.test(a) || !SQUARE.test(b)) throw new InvalidMoveError(`invalid uci: ${uci}`);
  const m = { from: squareIndex(a), to: squareIndex(b) };
  if (uci.length === 5) {
    if (!(uci[4] in PROMOTION)) throw new InvalidMoveError(`invalid uci: ${uci}`);
    m.promotion = PROMOTION[uci[4]];
  }
  if (m.from === m.to) throw new InvalidMoveError(`invalid uci (use 0000 for null moves): ${uci}`);
  return m;
}

export const nullMove = () => ({ from: 0, to: 0, null: true });

/** move.uci() */
export const uci = m => m.null ? '0000' : makeSquare(m.from) + makeSquare(m.to) + (m.promotion ? PROMOTION_CHAR[m.promotion] : '');

/** chess.Move(from, to) */
export const move = (from, to, promotion) => promotion ? { from, to, promotion } : { from, to };

export const moveEquals = (a, b) => a.from === b.from && a.to === b.to && (a.promotion || null) === (b.promotion || null)
  && !a.null === !b.null;

export const copy = pos => pos.clone();
export const pieceAt = (pos, sq) => pos.board.get(sq);
export const pieceTypeAt = (pos, sq) => pos.board.getRole(sq) ?? null;
export const colorAt = (pos, sq) => pos.board.getColor(sq) ?? null;
export const isCheck = pos => pos.isCheck();
export const isCheckmate = pos => pos.isCheckmate();

/** board.is_game_over(): checkmate, insufficient material, stalemate or the 75-move rule. (Fivefold repetition needs
 * the move stack, which no board here has: python-chess only ever asks copies made with stack=False.) */
export function isGameOver(pos) {
  return pos.isCheckmate() || pos.isInsufficientMaterial() || !pos.hasDests() || pos.halfmoves >= 150;
}

/** board.attackers(color, square): every piece of `color` attacking `square`, pinned or not. */
export function attackers(pos, color, sq, occupied = pos.board.occupied) {
  const b = pos.board;
  return kingAttacks(sq).intersect(b.king)
    .union(pieceAttacks({ role: 'knight', color }, sq, occupied).intersect(b.knight))
    .union(rookAttacks(sq, occupied).intersect(b.rooksAndQueens()))
    .union(bishopAttacks(sq, occupied).intersect(b.bishopsAndQueens()))
    .union(pawnAttacks(opposite(color), sq).intersect(b.pawn))
    .intersect(b[color]);
}

export const isAttackedBy = (pos, color, sq) => attackers(pos, color, sq).nonEmpty();

/** board.attacks(square): the squares the piece there attacks. */
export function attacks(pos, sq) {
  const piece = pos.board.get(sq);
  return piece ? pieceAttacks(piece, sq, pos.board.occupied) : SquareSet.empty();
}

/** board.is_pinned(color, square): python-chess's pin_mask, line by line. */
export function isPinned(pos, color, sq) {
  const b = pos.board;
  const king = b.kingOf(color);
  if (!defined(king)) return false;
  const lines = [
    [rookAttacks(king, SquareSet.empty()).intersect(SquareSet.fromFile(squareFile(king))), b.rooksAndQueens()],
    [rookAttacks(king, SquareSet.empty()).intersect(SquareSet.fromRank(squareRank(king))), b.rooksAndQueens()],
    [bishopAttacks(king, SquareSet.empty()), b.bishopsAndQueens()],
  ];
  const only = SquareSet.fromSquare(sq);
  for (const [rays, sliders] of lines) {
    if (!rays.has(sq)) continue;
    for (const sniper of rays.intersect(sliders).intersect(b[opposite(color)]).reversed()) {
      if (between(sniper, king).intersect(b.occupied.with(sq)).equals(only)) return true;
    }
    break;
  }
  return false;
}

/** board.is_en_passant(move), on the raw en passant square as python-chess keeps it. */
export function isEnPassant(pos, m) {
  return pos.epSquare === m.to && pos.board.pawn.has(m.from) && [7, 9].includes(Math.abs(m.to - m.from))
    && !pos.board.occupied.has(m.to);
}

/** board.is_capture(move) */
export const isCapture = (pos, m) => pos.board[opposite(pos.turn)].has(m.to) || isEnPassant(pos, m);

/** board.is_legal(move) */
export function isLegal(pos, m) {
  if (m.null) return false;
  const piece = pos.board.get(m.from);
  if (!piece || piece.color !== pos.turn) return false;
  if (m.promotion && (piece.role !== 'pawn' || squareRank(m.to) !== (pos.turn === 'white' ? 7 : 0))) return false;
  // python-chess only captures en passant from the fifth rank; chessops takes any pawn attacking the square, which
  // matters on a board whose turn was flipped by hand (facts.ideaArrows)
  if (piece.role === 'pawn' && m.to === pos.epSquare && squareFile(m.from) !== squareFile(m.to)
      && !pos.board.occupied.has(m.to) && squareRank(m.from) !== (pos.turn === 'white' ? 4 : 3)) return false;
  return pos.isLegal(normalizeMove(pos, m));
}

export class IllegalMoveError extends Error {}

/** board.parse_uci(uci): a legal move (castling given either as e1g1 or as e1h1) or the null move; throws
 * InvalidMoveError / IllegalMoveError where python-chess raises. */
export function parseUci(pos, str) {
  let m = moveFromUci(str);
  if (m.null) return m;
  if (!m.promotion) {
    for (const back of [0, 56]) {
      if (m.from !== back + 4 || !pos.board.king.has(back + 4)) continue;
      if (m.to === back + 7) m = move(back + 4, back + 6);
      else if (m.to === back) m = move(back + 4, back + 2);
    }
  }
  if (!isLegal(pos, m)) throw new IllegalMoveError(`illegal uci: ${str} in ${fen(pos)}`);
  return m;
}

/** board.push(move): the move is not checked, as in python-chess (pass legal or null moves). */
export function push(pos, m) {
  if (m.null) {
    pos.epSquare = undefined;
    pos.halfmoves += 1;
    if (pos.turn === 'black') pos.fullmoves += 1;
    pos.turn = opposite(pos.turn);
    return;
  }
  pos.play(normalizeMove(pos, m));
}

/** board.san(move) */
export const san = (pos, m) => sanIO.makeSan(pos, normalizeMove(pos, m));

/** A python-chess castling move from the king's square and the castling rook's (chess960 form unless standard). */
function fromChess960(pos, king, rook) {
  const back = pos.turn === 'white' ? 0 : 56;
  if (king === back + 4 && pos.board.king.has(king)) {
    if (rook === back + 7) return move(king, back + 6);
    if (rook === back) return move(king, back + 2);
  }
  return move(king, rook);
}

/** board.generate_castling_moves(): the legal castling moves, h-side first. */
export function castlingMoves(pos, ctx = pos.ctx()) {
  const king = pos.board.kingOf(pos.turn);
  if (!defined(king) || !SquareSet.backrank(pos.turn).has(king)) return [];
  const dests = pos.dests(king, ctx);
  const out = [];
  for (const side of ['h', 'a']) {
    const rook = pos.castles.rook[pos.turn][side];
    if (defined(rook) && dests.has(rook)) out.push(fromChess960(pos, king, rook));
  }
  return out;
}

/** board.has_castling_rights(color) */
export const hasCastlingRights = (pos, color) => pos.castles.castlingRights.intersects(SquareSet.backrank(color));

/** list(board.legal_moves), in python-chess's order: pieces (from the highest square down, each to its targets from
 * the highest down), castling, pawn captures, single then double pushes, en passant. In check the king's moves
 * come first. */
export function legalMoves(pos) {
  const ctx = pos.ctx();
  const turn = pos.turn, b = pos.board, us = b[turn], them = b[opposite(turn)];
  const destsBy = new Map();
  const dests = sq => destsBy.get(sq) ?? destsBy.set(sq, pos.dests(sq, ctx)).get(sq);
  const out = [];
  const add = (from, to) => {
    if (!dests(from).has(to)) return;
    const rank = squareRank(to);
    if (b.pawn.has(from) && (rank === 0 || rank === 7)) for (const p of PROMOTIONS) out.push(move(from, to, p));
    else out.push(move(from, to));
  };
  const inCheck = defined(ctx.king) && ctx.checkers.nonEmpty();
  if (inCheck) for (const to of kingAttacks(ctx.king).diff(us).reversed()) add(ctx.king, to);

  for (const from of us.diff(b.pawn).reversed()) {
    if (inCheck && b.king.has(from)) continue;
    for (const to of pieceAttacks(b.get(from), from, b.occupied).diff(us).reversed()) add(from, to);
  }
  if (!inCheck) out.push(...castlingMoves(pos, ctx));

  const pawns = us.intersect(b.pawn);
  for (const from of pawns.reversed()) {
    for (const to of pawnAttacks(turn, from).intersect(them).reversed()) add(from, to);
  }
  const up = turn === 'white' ? 8 : -8;
  const doubleRanks = turn === 'white' ? [2, 3] : [5, 4];
  const singles = [], doubles = [];
  for (const from of pawns) {
    const one = from + up;
    if (one < 0 || one > 63 || b.occupied.has(one)) continue;
    singles.push(one);
    const two = one + up;
    if (two >= 0 && two <= 63 && !b.occupied.has(two) && doubleRanks.includes(squareRank(two))) doubles.push(two);
  }
  for (const to of singles.sort((x, y) => y - x)) add(to - up, to);
  for (const to of doubles.sort((x, y) => y - x)) add(to - 2 * up, to);

  const ep = pos.epSquare;
  if (ep && !b.occupied.has(ep)) {
    const rank = turn === 'white' ? 4 : 3;
    for (const from of pawns.intersect(pawnAttacks(opposite(turn), ep)).intersect(SquareSet.fromRank(rank)).reversed()) {
      add(from, ep);
    }
  }
  return out;
}

/** board.legal_moves.count() */
export const legalMoveCount = pos => legalMoves(pos).length;

/** board.gives_check(move) */
export function givesCheck(pos, m) {
  const after = pos.clone();
  push(after, m);
  return after.isCheck();
}
