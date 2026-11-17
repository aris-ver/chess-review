// The rook ending drills (docs/training-grounds.md "Rook endings (v2)"): Lucena, win king, rook and pawn against king
// and rook, and Philidor, hold king and rook against king, rook and pawn. The user is always white; Stockfish plays
// black (the defender in Lucena, the attacker in Philidor). Pure: the engine is passed in as an async function, so
// tests fake it, and the tables are the drills' {name: table}.
//
// Starts come from ROOK_STARTS (rook-starts.js, verified with the lichess tablebase), four levels of each ending,
// dealt mirrored left and right at random and never one of the last RECENT_ROOK dealt at that level. A start's key
// is `<ending>:<level>:<index>`, the same for an entry and its mirror.
//
// Grading (rookStatus) after every ply, in this order:
//   1. Mate on the board: black mated is 'won' (Lucena) or 'held' (Philidor), white mated is 'mated'. Stalemate:
//      Lucena 'stalemate' (a fail), Philidor 'stalemate' (solved).
//   2. 4 pieces or fewer with a table for the side that matters (white's in Lucena, black's in Philidor, asked by
//      flipping colours and ranks): Lucena, white wins is 'won', or 'promoted' once a promotion was played; otherwise
//      'pawn_lost' when the pawn is gone and nothing was promoted, else 'threw'. Philidor, black wins is 'threw',
//      otherwise 'pawn_taken' (or 'held' when black still has the pawn, as in a drawn king and pawn ending).
//      Philidor, before the table: white's rook gone with black's still on is 'piece_lost'.
//   3. 4 pieces with no table: Lucena K+R+P v K is 'won' unless black is to move and can take the rook (then play
//      goes on one ply); K+P v K+R plays on only while the pawn is on the 7th, else 'piece_lost'. Philidor K+R v K+P
//      is 'rook_won', unless black is to move and can take the rook back (then play goes on one ply, as in Lucena).
//   4. Lucena after a promotion (5 pieces, black to move): rookTurn asks the engine as usual, and a mate score for
//      white ends the drill 'promoted' without playing the reply. Otherwise play goes on, with POST_PROMO more user
//      moves after the promotion, then 'budget'. (The spec asks this right after the promotion; it is asked after
//      every user move while the promoted piece is on, so keeping a queen that was skewered a move later counts too.)
//   5. Philidor, black just promoted: the user may take the new piece with the next move (2 grades it); after any
//      other move, or when no capture exists, 'promoted' (a fail).
//   6. Threefold repetition or the fifty-move rule: Lucena 'repetition', 'fifty' (fails); Philidor 'held'.
//   7. Lucena: the user's moves reach the budget (promote + slack, the promoting move counted) with no promotion:
//      'budget'. Philidor: HOLD_ROOK user moves: 'held'.
// FENs are as the board shows them, white the user; squares 0..63 with a1 = 0.

import { boardFromFen, fen as fenOf, isCheckmate, legalMoves, parseUci, push, uci as uciOf } from './chess.js';
import { ENDING_NAMES, fromFen, probe } from './endgame-table.js';
import { ROOK_STARTS } from './rook-starts.js';

export const ROOK_ENDINGS = ['Lucena', 'Philidor'];
export const ROOK_TABLES = ['KQK', 'KRK', 'KPK', 'KQRK', 'KRRK', 'KQKR', 'KRKR'];
export const ROOK_SLACK = { Lucena: [8, 6, 5, 4], Philidor: [null, null, null, null] };
export const OPPONENT_NODES = 200_000;   // the opponent's search, the same every time (deterministic with the history)
export const POST_PROMO = 10;            // Lucena: user moves after a promotion that hasn't ended the drill
export const HOLD_ROOK = 30;             // Philidor: user moves held is a success
export const RECENT_ROOK = 30;           // a start isn't dealt again within this many deals at its level
export const ROOK_RESULTS = {
  Lucena: { solved: ['promoted', 'won'],
    failed: ['pawn_lost', 'piece_lost', 'threw', 'mated', 'stalemate', 'repetition', 'fifty', 'budget', 'abandoned'] },
  Philidor: { solved: ['held', 'pawn_taken', 'rook_won', 'stalemate'],
    failed: ['promoted', 'piece_lost', 'threw', 'mated', 'abandoned'] },
};

export const isRookEnding = e => e === 'Lucena' || e === 'Philidor';

// ---------- starts ----------

/** The FEN mirrored left and right (files a-h swapped), the rest unchanged. */
export function mirrorFen(fen) {
  const [board, ...rest] = fen.trim().split(/\s+/);
  return [board.split('/').map(r => [...r].reverse().join('')).join('/'), ...rest].join(' ');
}

const placementTurn = f => f.trim().split(/\s+/).slice(0, 2).join(' ');
let startIndex = null;     // placement + turn → {ending, level, index, entry}, mirrors included
function starts() {
  if (!startIndex) {
    startIndex = new Map();
    for (const ending of ROOK_ENDINGS) {
      ROOK_STARTS[ending].forEach((entries, l) => entries.forEach((entry, index) => {
        const at = { ending, level: l + 1, index, entry };
        startIndex.set(placementTurn(entry.fen), at);
        startIndex.set(placementTurn(mirrorFen(entry.fen)), at);
      }));
    }
  }
  return startIndex;
}

/** The ROOK_STARTS entry a FEN is (as stored or mirrored): {ending, level, index, entry, key}, or null. */
export function rookStart(fen) {
  if (typeof fen !== 'string') return null;
  const at = starts().get(placementTurn(fen));
  return at ? { ...at, key: `${at.ending}:${at.level}:${at.index}` } : null;
}

/** A start's budget: Lucena promote + slack (the promoting move counted), null for Philidor. */
export function rookBudget(ending, level, entry) {
  const slack = ROOK_SLACK[ending][level - 1];
  return slack == null ? null : entry.promote + slack;
}

/** Which of n starts to deal, `dealt` being the indices dealt before at the level, oldest first: one at random
 * among those not in the last RECENT_ROOK, or when there are none, among those dealt longest ago. */
export function chooseStart(n, dealt, rng = Math.random) {
  const skip = new Set(dealt.slice(-RECENT_ROOK));
  let pool = [...Array(n).keys()].filter(i => !skip.has(i));
  if (!pool.length) {
    const last = new Map();
    dealt.forEach((i, at) => last.set(i, at));
    const oldest = Math.min(...[...Array(n).keys()].map(i => last.get(i) ?? -1));
    pool = [...Array(n).keys()].filter(i => (last.get(i) ?? -1) === oldest);
  }
  return pool[Math.floor(rng() * pool.length)];
}

/** A start for the level: {fen, dtm: null, budget, key}. `recent` is the keys dealt before, oldest first (any
 * level's; only this level's count): never one of the last RECENT_ROOK, and when every start is that recent, the
 * one dealt longest ago. Mirrored at random. */
export function pickRookStart(ending, level, { rng = Math.random, recent = [] } = {}) {
  const entries = ROOK_STARTS[ending]?.[level - 1];
  if (!entries?.length) return null;
  const prefix = `${ending}:${level}:`;
  const mine = recent.filter(k => typeof k === 'string' && k.startsWith(prefix)).map(k => +k.slice(prefix.length));
  const index = chooseStart(entries.length, mine, rng), entry = entries[index];
  const fen = rng() < 0.5 ? entry.fen : mirrorFen(entry.fen);
  return { fen, dtm: null, budget: rookBudget(ending, level, entry), key: `${prefix}${index}` };
}

// ---------- grading ----------

const count = (fen, letters) => [...fen.split(' ')[0]].filter(c => letters.includes(c)).length;
const PIECES = 'QRBNP', BLACK = 'qrbnp';
const isWon = r => r.result === 'win' || r.result === 'loss' || r.result === 'mate';

// the ply that ends at fens[i] was a promotion by `side` ('w' | 'b'): its pawns one fewer, its pieces one more
function promotedAt(fens, i, side) {
  if (i < 1) return false;
  const [pawn, men] = side === 'w' ? ['P', 'QRBN'] : ['p', 'qrbn'];
  return count(fens[i], pawn) === count(fens[i - 1], pawn) - 1 && count(fens[i], men) === count(fens[i - 1], men) + 1;
}

/** The index in fens of the position after the user's first promotion, or -1. */
export function promotionIndex(fens) {
  for (let i = 1; i < fens.length; i += 2) if (promotedAt(fens, i, 'w')) return i;
  return -1;
}

/** Whether black has promoted somewhere in fens. */
const blackPromoted = fens => fens.some((_, i) => i % 2 === 0 && promotedAt(fens, i, 'b'));

const placementKey = f => f.split(' ').slice(0, 2).join(' ');
const repeated = fens => {
  const last = placementKey(fens[fens.length - 1]);
  return fens.filter(f => placementKey(f) === last).length >= 3;
};

// does white win `fen` by the tables: true, false, or undefined when no table covers it
function whiteWins(tables, fen) {
  if (!count(fen, PIECES)) return false;
  const pos = fromFen(fen);
  return pos && ENDING_NAMES.includes(pos.name) && tables[pos.name] ? isWon(probe(tables, pos)) : undefined;
}

function flip(fen) {
  const [placement, turn] = fen.trim().split(/\s+/);
  const swap = c => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase());
  return `${placement.split('/').reverse().map(r => [...r].map(swap).join('')).join('/')} ${turn === 'w' ? 'b' : 'w'} - - 0 1`;
}
const blackWins = (tables, fen) => (count(fen, BLACK) ? whiteWins(tables, flip(fen)) : false);

// black to move can take the piece on a square of `letters` (white's)
function blackCanTake(board, fen, letters) {
  const at = new Set();
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, r) => {
    let f = 0;
    for (const c of row) {
      if (c >= '1' && c <= '8') f += +c;
      else { if (letters.includes(c)) at.add((7 - r) * 8 + f); f++; }
    }
  });
  return legalMoves(board).some(m => at.has(m.to));
}

// steps 2 and 3, 4 pieces or fewer: the result, or null to play on
function smallLucena(tables, fen, board, fens) {
  const promoted = promotionIndex(fens) >= 0;
  const w = whiteWins(tables, fen);
  if (w !== undefined) return w ? (promoted ? 'promoted' : 'won') : (!count(fen, 'P') && !promoted ? 'pawn_lost' : 'threw');
  const white = fen.split(' ')[0].replace(/[^QRBNP]/g, ''), black = count(fen, BLACK);
  if (!black) return board.turn === 'black' && blackCanTake(board, fen, 'QRBN') ? null : 'won';   // K+R+P (or more) v K
  if (white === 'P') return /P/.test(fen.split(' ')[0].split('/')[1]) ? null : 'piece_lost';   // K+P v K+R: the 7th
  return 'threw';      // a minor piece against the rook, say: no win
}

function smallPhilidor(tables, fen, board) {
  const placement = fen.split(' ')[0];
  if (!/R/.test(placement) && /r/.test(placement)) return 'piece_lost';
  const b = blackWins(tables, fen);
  if (b !== undefined) return b ? 'threw' : /p/.test(placement) ? 'held' : 'pawn_taken';
  if (/r/.test(placement)) return 'piece_lost';
  // K+R v K+P: won, unless black is to move and takes the rook back (as Lucena's K+R+P v K)
  return board.turn === 'black' && blackCanTake(board, fen, 'R') ? null : 'rook_won';
}

/** Where a rook drill stands after `fens` (the start first, white to move; one legal move apart): a result from
 * ROOK_RESULTS, or null while it goes on. budget: the Lucena budget (null for Philidor). Steps 1-3 and 5-7 of the
 * top of the file; step 4 needs the engine (rookTurn). */
export function rookStatus(tables, ending, { fens, budget = null }) {
  const lucena = ending === 'Lucena';
  const last = fens[fens.length - 1], board = boardFromFen(last), users = Math.floor(fens.length / 2);
  // 1. the board
  if (isCheckmate(board)) return board.turn === 'black' ? (lucena ? 'won' : 'held') : 'mated';
  if (!legalMoves(board).length) return 'stalemate';
  // 2, 3. down to 4 pieces
  if (count(last, 'KQRBNPkqrbnp') <= 4) {
    const r = lucena ? smallLucena(tables, last, board, fens) : smallPhilidor(tables, last, board);
    if (r) return r;
  }
  // 5. black's promotion: taken at once, or the drill is lost
  if (!lucena) {
    const n = fens.length - 1;
    if (board.turn === 'white' && promotedAt(fens, n, 'b')) {
      const sq = parseUci(boardFromFen(fens[n - 1]), uciBetween(fens[n - 1], last)).to;
      if (!legalMoves(board).some(m => m.to === sq)) return 'promoted';
    } else if (board.turn === 'black' && n >= 2 && promotedAt(fens, n - 1, 'b')) {
      return 'promoted';     // a capture of it would have left 4 pieces, graded above
    }
  }
  // 6. repetition, fifty moves
  const fifty = +last.split(' ')[4] >= 100;
  if (repeated(fens) || fifty) return lucena ? (fifty && !repeated(fens) ? 'fifty' : 'repetition') : 'held';
  // 7. the budget
  if (lucena) {
    const p = promotionIndex(fens);
    if (p < 0 ? budget != null && users >= budget : users - (p + 1) / 2 >= POST_PROMO) return 'budget';
  } else if (users >= HOLD_ROOK) {
    return 'held';
  }
  return null;
}

/** The UCI of the one legal move from `a` to `b` (FENs), or null. */
export function uciBetween(a, b) {
  const board = boardFromFen(a), want = placementKey(b);
  for (const m of legalMoves(board)) {
    const next = boardFromFen(a);
    push(next, m);
    if (placementKey(fenOf(next)) === want) return uciOf(m);
  }
  return null;
}

/**
 * The opponent's turn in a rook drill, after the user's move: grades it, asks the engine when the drill goes on,
 * plays the reply and grades again. state = {fens, ucis, budget}: fens from the start to the user's last move, ucis
 * the moves between them. engine({fen, moves}) → {move: uci, cp, mate, ms} with the score from black's side (the
 * side to move), fen the start and moves the history (so the engine sees repetitions). Returns {result, reply (uci or
 * null), fen (after the reply, or null), score: {cp, mate} (black's view, or null), engine_ms, promoted}: promoted
 * is whether the user has promoted (Lucena) or black has (Philidor), after the reply.
 */
export async function rookTurn(tables, ending, { fens, ucis, budget = null }, engine) {
  const out = { result: rookStatus(tables, ending, { fens, budget }), reply: null, fen: null, score: null, engine_ms: null,
    promoted: ending === 'Lucena' ? promotionIndex(fens) >= 0 : blackPromoted(fens) };
  if (out.result) return out;
  const last = fens[fens.length - 1];
  const s = await engine({ fen: fens[0], moves: ucis });
  out.engine_ms = s.ms ?? null;
  out.score = { cp: s.cp ?? null, mate: s.mate ?? null };
  // 4. after the user's promotion, the engine seeing itself mated ends it
  if (ending === 'Lucena' && out.promoted && s.mate != null && s.mate < 0 && count(last, 'KQRBNPkqrbnp') >= 5) {
    out.result = 'promoted';
    return out;
  }
  const board = boardFromFen(last);
  let m;
  try {
    m = parseUci(board, s.move);
  } catch {
    m = null;
  }
  if (!m || !legalMoves(board).some(x => uciOf(x) === uciOf(m))) throw new Error(`the engine's move ${s.move} is not legal in ${last}`);
  push(board, m);
  out.reply = uciOf(m);
  out.fen = fenOf(board);
  const all = [...fens, out.fen];
  out.promoted = ending === 'Lucena' ? out.promoted : blackPromoted(all);
  out.result = rookStatus(tables, ending, { fens: all, budget });
  return out;
}
