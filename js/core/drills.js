// The "Develop your instinct" drills (docs/training-grounds.md): basic endings played against a defender that reads
// the endgame tables (endgame-table.js), within a move budget, from a fresh position each time.
//
// The user always has white. A mate drill (KQRK, KRRK, KQK, KRK) starts from a position whose mate distance is in its
// level's band, white to move; the budget is that distance plus the level's slack, and the attempt fails on the budget,
// a stalemate, a piece lost, a threefold repetition or the 50-move rule. Start positions come from buckets by the black
// king's zone (corner, edge, ring, centre), taken in turn, and never one of the last 50 dealt, mirrors and rotations
// included (positionKey). Each is shown turned by a random symmetry.
//
// KPK has no budget: a level is how many only-moves (the one move that keeps the result) the position needs along the
// table's line, 4 meaning 4 or more. Attack is white's king and pawn to promote and win. Defence gives the user white's
// lone king against black's king and pawn: those positions are flipped (colours and ranks, flipFen) before they're
// probed, so the tables only ever hold white's pawn. A defence is held when the pawn is taken, on a stalemate, or
// after HOLD_MOVES moves; either side's move that changes the result ends the attempt (kpkGrade).
//
// FENs in and out are the board's as the user sees it; squares are 0..63 with a1 = 0. `tables` is {name: table}, the
// endings' tables and their DEPENDS. Randomness comes from `rng` (Math.random unless given), so tests can seed it.

import { boardFromFen, fen as fenOf, isCheck, isCheckmate, legalMoves, makeSquare, parseUci, push } from './chess.js';
import { blackMoves, canonical, decode, fromFen, probe, tableSize, toFen, transform, whiteMoves } from './endgame-table.js';

const lvl = (lo, hi, slack, counter) => ({ lo, hi, slack, counter });
export const LEVELS = {
  KQRK: [lvl(2, 3, 8, true), lvl(3, 4, 5, true), lvl(4, 6, 2, false)],
  KRRK: [lvl(2, 4, 8, true), lvl(4, 5, 5, true), lvl(5, 7, 2, false)],
  KQK: [lvl(3, 5, 10, true), lvl(5, 7, 6, true), lvl(6, 8, 4, false), lvl(8, 10, 3, false), lvl(9, 10, 1, false)],
  KRK: [lvl(5, 8, 12, true), lvl(8, 11, 8, true), lvl(10, 13, 6, false), lvl(12, 15, 4, false), lvl(14, 16, 2, false)],
  // lo and hi count only-moves here; no budget, no counter
  KPK: [lvl(1, 1, null, false), lvl(2, 2, null, false), lvl(3, 3, null, false), lvl(4, Infinity, null, false)],
};
export const ENDINGS = ['KQRK', 'KRRK', 'KQK', 'KRK', 'KPK'];
export const ZONES = ['corner', 'edge', 'ring', 'centre'];
export const RECENT = 50;          // positions never dealt again
export const HOLD_MOVES = 20;      // a KPK defence held this long is a success
const ONLY_CAP = 4;

/** The black king's zone: 'corner' (4 squares), 'edge' (24), 'ring' (the 20 next in) or 'centre' (the middle 16). */
export function zone(sq) {
  const f = sq & 7, r = sq >> 3, d = Math.min(f, 7 - f, r, 7 - r);
  if (d === 0) return (f === 0 || f === 7) && (r === 0 || r === 7) ? 'corner' : 'edge';
  return d === 1 ? 'ring' : 'centre';
}

export const budget = (dtm, slack) => dtm + slack;

/** The FEN with the colours swapped and the board turned top to bottom: black's pawn becomes white's. */
export function flipFen(fen) {
  const [placement, turn] = fen.trim().split(/\s+/);
  const swap = c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());
  return `${placement.split('/').reverse().map(r => [...r].map(swap).join('')).join('/')} ${turn === 'w' ? 'b' : 'w'} - - 0 1`;
}

/** The position in table terms: as it is, or flipped when black has the pawn. */
function tablePos(fen) {
  return fromFen(fen) ?? fromFen(flipFen(fen));
}

/** A key that's the same for a position and its mirrors and rotations, or null for a position no drill has. */
export function positionKey(fen) {
  const pos = tablePos(fen);
  return pos ? `${pos.name}:${pos.turn}:${canonical(pos)}` : null;
}

const won = r => ['win', 'loss', 'mate'].includes(typeof r === 'string' ? r : r.result);
const isWin = m => m.result === 'loss' || m.result === 'mate';
const pick = (list, rng) => list[Math.floor(rng() * list.length)];
const uciOf = (from, to, promotion) => makeSquare(from) + makeSquare(to) + (promotion ?? '');

function play(pos, uci) {
  const board = boardFromFen(toFen(pos));
  push(board, parseUci(board, uci));
  return fromFen(fenOf(board));
}

// --- KPK only-moves ---

const attackMemo = new WeakMap(), defenceMemo = new WeakMap();

// how many times white has exactly one winning move along the line: white's fastest win, black's longest defence
// (the first of equals), up to the promotion; capped at ONLY_CAP
function attackOnly(tables, pos) {
  const data = tables.KPK.data;
  let memo = attackMemo.get(data);
  if (!memo) attackMemo.set(data, memo = new Int8Array(tableSize('KPK')).fill(-1));
  const i = canonical(pos);
  if (memo[i] >= 0) return memo[i];
  const wins = whiteMoves(tables, pos).filter(isWin);
  let n = 0;
  if (wins.length) {
    const only = wins.length === 1 ? 1 : 0;
    const best = wins.reduce((a, m) => (m.dtm < a.dtm ? m : a));
    n = only;
    if (!best.promotion && best.result !== 'mate') {
      const after = afterKpk(pos, best);
      const reply = blackMoves(tables, after).reduce((a, m) => (m.dtm > a.dtm ? m : a));
      n = Math.min(ONLY_CAP, only + attackOnly(tables, { ...after, bk: reply.to, turn: 'w' }));
    }
  }
  memo[i] = n;
  return n;
}

// the KPK position after one of whiteMoves()'s moves other than a promotion, black to move
const afterKpk = (pos, m) => ({ ...pos, wk: m.piece === 'K' ? m.to : pos.wk, pieces: m.piece === 'P' ? [m.to] : pos.pieces,
  turn: 'b' });

// the attacker's choice in a drawn position: the move leaving the defender fewest drawing replies
function squeeze(tables, pos, rng) {
  const moves = whiteMoves(tables, pos).filter(m => !m.promotion || m.promotion === 'q' || m.promotion === 'r');
  const wins = moves.filter(isWin);
  if (wins.length) {
    const d = Math.min(...wins.map(m => m.dtm));
    return pick(wins.filter(m => m.dtm === d), rng);
  }
  let best = [], fewest = Infinity;
  for (const m of moves) {
    const replies = m.promotion ? 99 : blackMoves(tables, afterKpk(pos, m)).filter(r => r.result === 'draw').length;
    if (replies < fewest) { fewest = replies; best = [m]; } else if (replies === fewest) best.push(m);
  }
  return pick(best, rng);
}

// the same count for the defender (black in table terms, to move in a drawn position): positions where only one move
// holds, along the first holding move and the attacker's squeeze, until the pawn can be taken, HOLD_MOVES, or a repeat
function defenceOnly(tables, pos) {
  const data = tables.KPK.data, size = tableSize('KPK');
  let memo = defenceMemo.get(data);
  if (!memo) {
    // count: the answer by start; hold: the black king's first holding move, +64 when it's the only one, -1 where the
    // line ends; reply: the black-to-move index after the attacker's squeeze, -1 where it ends (all by table index)
    memo = { count: new Int8Array(size).fill(-1), hold: new Int8Array(size).fill(-2), reply: new Int32Array(size).fill(-2) };
    defenceMemo.set(data, memo);
  }
  const start = canonical(pos);
  if (memo.count[start] >= 0) return memo.count[start];
  const first = () => 0, seen = new Set();
  let n = 0;
  for (let k = 0, i = start; k < HOLD_MOVES && n < ONLY_CAP && !seen.has(i); k++) {
    seen.add(i);
    if (memo.hold[i] === -2) {
      const holds = blackMoves(tables, { ...decode('KPK', i), turn: 'b' }).filter(m => m.result === 'draw');
      memo.hold[i] = !holds.length || holds.some(m => m.capture) ? -1 : holds[0].to + (holds.length === 1 ? 64 : 0);
    }
    const h = memo.hold[i];
    if (h < 0) break;
    if (h >= 64) n++;
    const j = canonical({ ...decode('KPK', i), bk: h & 63 });
    if (memo.reply[j] === -2) {
      const next = decode('KPK', j), m = squeeze(tables, next, first);
      memo.reply[j] = !m || m.promotion ? -1 : canonical(afterKpk(next, m));    // none: white stalemated
    }
    i = memo.reply[j];
    if (i < 0) break;
  }
  memo.count[start] = n;
  return n;
}

/** The only-moves a KPK position needs: white's to win when white has the pawn, the defender's to hold when black has. */
export function onlyMoves(tables, fen) {
  const pos = tablePos(fen);
  if (!pos || pos.name !== 'KPK') throw new Error(`not a KPK position: ${fen}`);
  return pos.turn === 'w' ? attackOnly(tables, pos) : defenceOnly(tables, pos);
}

/** 'threw' when a move changed who wins (from probe results before and after it, in table terms), else 'ok'. */
export const kpkGrade = (before, after) => (won(before) === won(after) ? 'ok' : 'threw');

/** The attacker's reply in a KPK defence: `fen` has black's king and pawn to move. Wins as fast as the table says,
 * else squeezes; returns UCI on the board as shown. */
export function kpkAttackerMove(tables, fen, rng = Math.random) {
  const pos = fromFen(flipFen(fen));
  if (!pos || pos.name !== 'KPK' || pos.turn !== 'w') throw new Error(`not a KPK defence position: ${fen}`);
  const m = squeeze(tables, pos, rng);
  return uciOf(m.from ^ 56, m.to ^ 56, m.promotion);
}

/** A KPK defence's end, from the FENs as shown (the start first): 'pawn_taken', 'stalemate', 'held' (HOLD_MOVES of
 * the user's moves, or a threefold repetition), or null while it goes on. */
export function defenceStatus({ fens }) {
  const last = fens[fens.length - 1], board = boardFromFen(last);
  if (!legalMoves(board).length && !isCheck(board)) return 'stalemate';
  if (!/[pqrbn]/.test(last.split(' ')[0])) return 'pawn_taken';
  if (repeated(fens)) return 'held';
  return Math.floor((fens.length - 1) / 2) >= HOLD_MOVES ? 'held' : null;
}

// --- start positions ---

const candidateMemo = new WeakMap();

/** The level's start positions as canonical table indices, by the black king's zone ({corner, edge, ring, centre}).
 * Mate drills and KPK attack: white to move; KPK defence (mode 'defence'): black to move in table terms. */
export function candidates(tables, ending, level, mode = 'attack') {
  const data = tables[ending].data;
  let memo = candidateMemo.get(data);
  if (!memo) candidateMemo.set(data, memo = new Map());
  const memoKey = `${mode}:${level}`;
  if (memo.has(memoKey)) return memo.get(memoKey);
  const { lo, hi } = LEVELS[ending][level - 1];
  const buckets = Object.fromEntries(ZONES.map(z => [z, []]));
  const size = tableSize(ending);
  for (let i = 0; i < size; i++) {
    const v = data[i];
    if (ending !== 'KPK' && (v < lo || v > hi)) continue;
    if (ending === 'KPK' && mode === 'attack' && !v) continue;
    const p = decode(ending, i);
    if (canonical(p) !== i) continue;
    let pos = p, count;
    if (ending !== 'KPK') {
      if (probe(tables, p).result !== 'win') continue;
    } else if (mode === 'attack') {
      if (probe(tables, p).result !== 'win') continue;
      count = attackOnly(tables, p);
    } else {
      pos = { ...p, turn: 'b' };
      const r = probe(tables, pos);
      if (r.result !== 'draw' || inCheck(tables, pos)) continue;
      count = defenceOnly(tables, pos);
    }
    if (count !== undefined && (count < lo || count > hi)) continue;
    buckets[zone(pos.bk)].push(i);
  }
  const out = Object.fromEntries(ZONES.map(z => [z, Uint32Array.from(buckets[z])]));
  memo.set(memoKey, out);
  return out;
}

// black in check: the same position with white to move is illegal
const inCheck = (tables, pos) => probe(tables, { ...pos, turn: 'w' }).result === 'illegal';

/** A start position for the level: {fen, dtm, budget, key}. `turn` counts attempts (it picks the zone bucket),
 * `recent` holds the keys dealt before. KPK defence (mode 'defence') deals black's king and pawn, white to move. */
export function pickStart(tables, ending, level, { rng = Math.random, recent = [], turn = 0, mode = 'attack' } = {}) {
  const c = candidates(tables, ending, level, mode);
  const nonEmpty = ZONES.filter(z => c[z].length);
  if (!nonEmpty.length) return null;
  const skip = new Set(recent.slice(-RECENT));
  const keyOf = i => `${ending}:${mode === 'defence' ? 'b' : 'w'}:${i}`;
  let chosen = -1;
  for (let k = 0; k < nonEmpty.length && chosen < 0; k++) {
    const list = c[nonEmpty[(turn + k) % nonEmpty.length]], start = Math.floor(rng() * list.length);
    for (let j = 0; j < list.length; j++) {
      const i = list[(start + j) % list.length];
      if (!skip.has(keyOf(i))) { chosen = i; break; }
    }
  }
  if (chosen < 0) chosen = c[nonEmpty[turn % nonEmpty.length]][0];
  const p = decode(ending, chosen);
  const t = ending === 'KPK' ? Math.floor(rng() * 2) : Math.floor(rng() * 8);
  const pos = { ...p, wk: transform(t, p.wk), bk: transform(t, p.bk), pieces: p.pieces.map(s => transform(t, s)),
    turn: mode === 'defence' ? 'b' : 'w' };
  const r = probe(tables, pos);
  const slack = LEVELS[ending][level - 1].slack;
  const fen = mode === 'defence' ? flipFen(toFen(pos)) : toFen(pos);
  return { fen, dtm: r.dtm, budget: slack == null ? null : budget(r.dtm, slack), key: keyOf(chosen) };
}

// --- playing ---

/** The defender's reply (black to move): a capture if one is legal, else a move that draws, else the one that keeps
 * mate furthest away; equals at random. */
export function defenderMove(tables, fen, rng = Math.random) {
  const pos = fromFen(fen);
  const moves = blackMoves(tables, pos);
  if (!moves.length) return null;
  const caps = moves.filter(m => m.capture), draws = moves.filter(m => m.result === 'draw');
  let list = caps.length ? caps : draws;
  if (!list.length) {
    const d = Math.max(...moves.map(m => m.dtm));
    list = moves.filter(m => m.dtm === d);
  }
  return uciOf(pos.bk, pick(list, rng).to);
}

/** A white move's kind, from the mate distance before it and the probe after it (black to move): 'best' when mate came
 * one move nearer, 'slack' for 1 or 2 moves more than that, 'lost' for 3 or more, 'threw' for a draw. */
export function kindOfMove(dtmBefore, after) {
  if (!won(after)) return 'threw';
  const d = after.dtm - (dtmBefore - 1);
  return d <= 0 ? 'best' : d <= 2 ? 'slack' : 'lost';
}

const placementKey = fen => fen.split(' ').slice(0, 2).join(' ');
function repeated(fens) {
  const last = placementKey(fens[fens.length - 1]);
  return fens.filter(f => placementKey(f) === last).length >= 3;
}

/** A mate drill's end: 'solved', or a fail ('stalemate', 'piece_lost', 'repetition', 'fifty', 'budget'), or null
 * while it goes on. state = {fens: every position from the start, movesUsed: white's moves, budget}. */
export function status({ fens, movesUsed, budget: limit }) {
  const last = fens[fens.length - 1], board = boardFromFen(last);
  if (isCheckmate(board)) return 'solved';
  if (!legalMoves(board).length) return 'stalemate';
  const first = fromFen(fens[0]), now = fromFen(last);
  if (!now || now.pieces.length < first.pieces.length) return 'piece_lost';
  if (repeated(fens)) return 'repetition';
  if (+last.split(' ')[4] >= 100) return 'fifty';
  if (limit != null && movesUsed >= limit) return 'budget';
  return null;
}

/** The review of an attempt: {moves: [{dtm, kind, loss}] for each of white's moves (dtm after it, loss the moves it
 * cost against the best, null for a throw), worst: the index of the costliest move, or -1 when every move was best}. */
export function review(tables, fens) {
  const moves = [];
  let worst = -1, worstLoss = 0;
  for (let k = 0; k + 1 < fens.length; k++) {
    const pos = fromFen(fens[k]);
    if (!pos || pos.turn !== 'w') continue;
    const before = probe(tables, pos), after = probe(tables, fromFen(fens[k + 1]));
    if (before.result !== 'win') break;
    const kind = kindOfMove(before.dtm, after);
    const loss = kind === 'threw' ? null : after.dtm - (before.dtm - 1);
    const cost = loss ?? Infinity;
    if (cost > worstLoss) { worstLoss = cost; worst = moves.length; }
    moves.push({ dtm: after.dtm, kind, loss });
  }
  return { moves, worst };
}

/** The table's line from a position (either side to move): white's fastest mate against the longest defence, the
 * first of equals; UCI moves, empty for a draw. */
export function bestLine(tables, fen, max = 120) {
  let pos = fromFen(fen);
  const line = [];
  while (pos && line.length < max) {
    let uci;
    if (pos.turn === 'w') {
      const wins = whiteMoves(tables, pos).filter(isWin);
      if (!wins.length) break;
      const m = wins.reduce((a, b) => (b.dtm < a.dtm ? b : a));
      uci = uciOf(m.from, m.to, m.promotion);
    } else {
      const moves = blackMoves(tables, pos);
      if (!moves.length || moves.some(m => m.result === 'draw')) break;
      uci = uciOf(pos.bk, moves.reduce((a, b) => (b.dtm > a.dtm ? b : a)).to);
    }
    line.push(uci);
    pos = play(pos, uci);
  }
  return line;
}
