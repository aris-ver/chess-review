// Endgame tables for the "Develop your instinct" drills (docs/training-grounds.md): for every position of a basic
// ending, how many moves white needs to mate, or that it's a draw. Pure, no imports, the same in the browser and in
// Node.
//
// Squares are 0..63 with a1 = 0. An ending is named by its pieces, white's first ('KQK', 'KRK', 'KPK', 'KQRK',
// 'KRRK', 'KBBK', 'KBNK'); the black side is always the lone king, and a position is {name, wk, bk, pieces: [sq],
// turn: 'w'|'b'}, the pieces in the name's order.
//
// A table holds white-to-move positions only, one byte each: 0 a draw, N a mate in N moves. The index puts the white
// king in the a1-d1-d4 triangle by one of the board's 8 symmetries, ((tri(wk)*64 + bk)*64 + p1)[*64 + p2]; KPK only
// mirrors left and right, so that the pawn is on files a-d, (pawnIdx*64 + wk)*64 + bk. Duplicates (a king on the
// diagonal, two rooks swapped) stay in on purpose: each is worked out forward like any other entry. Illegal entries
// hold the byte before them, which is what makes the files pack small, so probe() checks legality itself. Black to
// move is a one-ply search over the table: the longest of the black king's moves, the smaller ending's table after a
// capture, a draw when a move draws.
//
// generate() works it all out by retrograde analysis, both sides in scratch arrays: mates and stalemates first, then
// level by level, white-to-move positions with a move to a black position lost in L-1 plies, then black-to-move ones
// whose every move is lost within L-1. Captures and promotions (to a queen or rook) read the smaller tables, given as
// `subs` (DEPENDS). A 3-piece table takes well under a second; the 4-piece ones ten seconds to a minute, so those are
// built offline (scripts/build_endgame_tables.js) and shipped as gzipped files, pack()'s 8-byte header ('EGT1', the
// name padded to 4) followed by the bytes.

const Q = 1, R = 2, B = 3, N = 4, P = 5;
const TYPE = { Q, R, B, N, P };
const LETTER = ['', 'Q', 'R', 'B', 'N', 'P'];
const ILLEGAL = 255, STALE = 254;    // scratch markers; other scratch values are plies + 1, 0 not yet known

export const ENDING_NAMES = ['KQK', 'KRK', 'KPK', 'KQRK', 'KRRK', 'KBBK', 'KBNK'];
// a bishop or knight taken leaves KBK or KNK, a draw, so KBBK and KBNK need no smaller table
export const DEPENDS = {
  KQK: [], KRK: [], KPK: ['KQK', 'KRK'], KQRK: ['KQK', 'KRK'], KRRK: ['KRK'], KBBK: [], KBNK: [],
};
// endings that can't be won: a capture or promotion into one of these is a draw, and they need no table
const DRAWN = new Set(['KK', 'KBK', 'KNK']);

// --- geometry ---

const KADJ = new Uint8Array(4096), KNIGHT = new Uint8Array(4096), LINE = new Uint8Array(4096);
const BLO = new Int32Array(4096), BHI = new Int32Array(4096);    // squares strictly between, as two 32-bit masks
const KING_TO = [], KNIGHT_TO = [], RAYS = [];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const SLIDES = { [Q]: [0, 1, 2, 3, 4, 5, 6, 7], [R]: [0, 1, 2, 3], [B]: [4, 5, 6, 7] };

for (let a = 0; a < 64; a++) {
  const f = a & 7, r = a >> 3;
  KING_TO[a] = []; KNIGHT_TO[a] = []; RAYS[a] = [];
  for (let b = 0; b < 64; b++) {
    const df = Math.abs((b & 7) - f), dr = Math.abs((b >> 3) - r);
    if (a !== b && df <= 1 && dr <= 1) { KADJ[a * 64 + b] = 1; KING_TO[a].push(b); }
    if ((df === 1 && dr === 2) || (df === 2 && dr === 1)) { KNIGHT[a * 64 + b] = 1; KNIGHT_TO[a].push(b); }
  }
  for (let d = 0; d < 8; d++) {
    const ray = [];
    let lo = 0, hi = 0;
    for (let x = f + DIRS[d][0], y = r + DIRS[d][1]; x >= 0 && x < 8 && y >= 0 && y < 8; x += DIRS[d][0], y += DIRS[d][1]) {
      const b = y * 8 + x;
      ray.push(b);
      LINE[a * 64 + b] = d < 4 ? 1 : 2;
      BLO[a * 64 + b] = lo; BHI[a * 64 + b] = hi;
      if (b < 32) lo |= 1 << b; else hi |= 1 << (b - 32);
    }
    RAYS[a].push(ray);
  }
}

// the 8 symmetries: bit 0 flips the files, bit 1 the ranks, bit 2 swaps files and ranks (after the flips)
const T = new Uint8Array(512);
for (let t = 0; t < 8; t++) {
  for (let s = 0; s < 64; s++) {
    let f = s & 7, r = s >> 3;
    if (t & 1) f = 7 - f;
    if (t & 2) r = 7 - r;
    if (t & 4) [f, r] = [r, f];
    T[t * 64 + s] = r * 8 + f;
  }
}
const TRI = new Int8Array(64).fill(-1), TRI_SQ = [];
for (let s = 0; s < 64; s++) if ((s & 7) <= 3 && (s >> 3) <= (s & 7)) { TRI[s] = TRI_SQ.length; TRI_SQ.push(s); }
const SYM = new Uint8Array(64);    // the first symmetry that takes a white king there into the triangle
for (let s = 0; s < 64; s++) for (let t = 7; t >= 0; t--) if (TRI[T[t * 64 + s]] >= 0) SYM[s] = t;

/** The symmetry t applied to a square (0 leaves it, 1 mirrors left and right). */
export const transform = (t, sq) => T[t * 64 + sq];

const typesOf = name => [...name.slice(1, -1)].map(c => TYPE[c]);
const hasPawn = name => name.includes('P');

/** Entries in the ending's table. */
export function tableSize(name) {
  const n = name.length - 2;
  return hasPawn(name) ? 24 * 64 * 64 * 64 ** (n - 1) : 10 * 64 * 64 ** n;
}

// ending left after the piece at position i is taken
const without = (name, i) => 'K' + name.slice(1, -1).slice(0, i) + name.slice(1, -1).slice(i + 1) + 'K';

function indexRaw(pawn, wk, bk, sq, n) {
  if (pawn) {
    const m = (sq[0] & 7) >= 4 ? 7 : 0, p = sq[0] ^ m;
    return ((((p >> 3) - 1) * 4 + (p & 7)) * 64 + (wk ^ m)) * 64 + (bk ^ m);
  }
  const o = SYM[wk] * 64;
  let i = TRI[T[o + wk]] * 64 + T[o + bk];
  for (let j = 0; j < n; j++) i = i * 64 + T[o + sq[j]];
  return i;
}

/** The table index of a white-to-move position (no legality check). */
export const index = pos => indexRaw(hasPawn(pos.name), pos.wk, pos.bk, pos.pieces, pos.pieces.length);

/** The position at a table index, white to move (it may be illegal). */
export function decode(name, i) {
  const n = name.length - 2, pieces = new Array(n);
  if (hasPawn(name)) {
    const bk = i & 63, wk = (i >> 6) & 63, pi = i >> 12;
    return { name, wk, bk, pieces: [((pi >> 2) + 1) * 8 + (pi & 3)], turn: 'w' };
  }
  for (let j = n - 1; j >= 0; j--) { pieces[j] = i & 63; i >>= 6; }
  const bk = i & 63;
  return { name, wk: TRI_SQ[i >> 6], bk, pieces, turn: 'w' };
}

// --- attacks and black's moves ---

/** Whether a white piece (not the king, not the one at `skip`) attacks x, with lo/hi the occupied squares. */
function pieceAttacks(x, types, sq, n, skip, lo, hi) {
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    const s = sq[i], t = types[i];
    if (t === P) {
      if ((x === s + 7 && (s & 7) !== 0) || (x === s + 9 && (s & 7) !== 7)) return true;
    } else if (t === N) {
      if (KNIGHT[s * 64 + x]) return true;
    } else {
      const k = s * 64 + x, l = LINE[k];
      if (l && (t === Q || (t === R ? l === 1 : l === 2)) && !((BLO[k] & lo) | (BHI[k] & hi))) return true;
    }
  }
  return false;
}

let OLO = 0, OHI = 0;
function occupy(wk, sq, n, extra) {
  OLO = 0; OHI = 0;
  const add = s => { if (s < 0) return; if (s < 32) OLO |= 1 << s; else OHI |= 1 << (s - 32); };
  add(wk); add(extra);
  for (let i = 0; i < n; i++) add(sq[i]);
}

// black's legal king moves into BTO, with the piece taken (or -1) in BCAP; returns how many
const BTO = new Int8Array(8), BCAP = new Int8Array(8);
function blackGen(wk, bk, types, sq, n) {
  occupy(wk, sq, n, -1);
  const lo = OLO, hi = OHI, km = KING_TO[bk];
  let c = 0;
  for (let k = 0; k < km.length; k++) {
    const x = km[k];
    if (x === wk || KADJ[wk * 64 + x]) continue;
    let cap = -1;
    for (let i = 0; i < n; i++) if (sq[i] === x) cap = i;
    if (pieceAttacks(x, types, sq, n, cap, lo, hi)) continue;
    BTO[c] = x; BCAP[c] = cap; c++;
  }
  return c;
}

function distinct(wk, bk, sq, n) {
  if (wk === bk) return false;
  for (let i = 0; i < n; i++) {
    if (sq[i] === wk || sq[i] === bk) return false;
    for (let j = 0; j < i; j++) if (sq[j] === sq[i]) return false;
  }
  return true;
}

// --- generation ---

/** Works out an ending's table. `subs` holds the tables DEPENDS names for it ({name: table}). In stats, wins and
 * drawsW count white-to-move entries, lossesB and drawsB black-to-move ones, mates black's, stalemates either side's
 * (KPK has two with white's pawn blocked by its own king), hist[N] the mates in N. */
export function generate(name, subs = {}) {
  const types = typesOf(name), n = types.length, pawn = hasPawn(name), size = tableSize(name);
  for (const d of DEPENDS[name] ?? []) if (!subs[d]) throw new Error(`${name} needs the ${d} table`);
  const W = new Uint8Array(size), Bl = new Uint8Array(size);
  const sq = new Int32Array(n), rest = new Int32Array(Math.max(n - 1, 1));
  const capName = types.map((_, i) => without(name, i));
  let wk = 0, bk = 0;

  const load = i => {
    if (pawn) {
      bk = i & 63; wk = (i >> 6) & 63;
      const pi = i >> 12;
      sq[0] = ((pi >> 2) + 1) * 8 + (pi & 3);
      return;
    }
    for (let j = n - 1; j >= 0; j--) { sq[j] = i & 63; i >>= 6; }
    bk = i & 63; wk = TRI_SQ[i >> 6];
  };
  const occupied = x => {
    if (x === wk || x === bk) return true;
    for (let i = 0; i < n; i++) if (sq[i] === x) return true;
    return false;
  };
  // plies to mate after black takes piece i on x (white to move in the smaller ending), -1 for a draw
  const capturePlies = (i, x) => {
    const sub = capName[i];
    if (DRAWN.has(sub)) return -1;
    let m = 0;
    for (let j = 0; j < n; j++) if (j !== i) rest[m++] = sq[j];
    const v = subs[sub].data[indexRaw(hasPawn(sub), wk, x, rest, m)];
    return v ? 2 * v - 1 : -1;
  };
  // plies to mate after a promotion on y, black to move, -1 for a draw
  const promoPlies = (y, t) => {
    const r = probe(subs, { name: 'K' + LETTER[t] + 'K', wk, bk, pieces: [y], turn: 'b' });
    return r.result === 'mate' ? 0 : r.result === 'loss' ? 2 * r.dtm : -1;
  };
  // whether white has a move to a black-to-move position lost within L - 1 plies
  const whiteReaches = L => {
    for (const y of KING_TO[wk]) {
      if (y === bk || KADJ[bk * 64 + y] || occupied(y)) continue;
      const v = Bl[indexRaw(pawn, y, bk, sq, n)];
      if (v && v <= L) return true;
    }
    for (let i = 0; i < n; i++) {
      const s = sq[i], t = types[i];
      const visit = y => {
        sq[i] = y;
        const v = Bl[indexRaw(pawn, wk, bk, sq, n)];
        sq[i] = s;
        return v && v <= L;
      };
      if (t === P) {
        const y = s + 8;
        if (occupied(y)) continue;
        if (y >= 56) {
          for (const pt of [Q, R]) { const p = promoPlies(y, pt); if (p >= 0 && p <= L - 1) return true; }
          continue;
        }
        if (visit(y)) return true;
        if (s < 16 && !occupied(s + 16) && visit(s + 16)) return true;
      } else if (t === N) {
        for (const y of KNIGHT_TO[s]) if (!occupied(y) && visit(y)) return true;
      } else {
        for (const d of SLIDES[t]) {
          for (const y of RAYS[s][d]) {
            if (occupied(y)) break;
            if (visit(y)) return true;
          }
        }
      }
    }
    return false;
  };
  // whether white has no legal move at all
  const whiteStuck = () => {
    for (const y of KING_TO[wk]) if (!(y === bk || KADJ[bk * 64 + y] || occupied(y))) return false;
    for (let i = 0; i < n; i++) {
      const s = sq[i], t = types[i];
      if (t === P) { if (!occupied(s + 8)) return false; } else if (t === N) {
        for (const y of KNIGHT_TO[s]) if (!occupied(y)) return false;
      } else {
        for (const d of SLIDES[t]) if (RAYS[s][d].length && !occupied(RAYS[s][d][0])) return false;
      }
    }
    return true;
  };
  // whether every black move goes to a position lost within L - 1 plies
  const blackLost = L => {
    const c = blackGen(wk, bk, types, sq, n);
    for (let k = 0; k < c; k++) {
      if (BCAP[k] >= 0) {
        const p = capturePlies(BCAP[k], BTO[k]);
        if (p < 0 || p > L - 1) return false;
      } else {
        const v = W[indexRaw(pawn, wk, BTO[k], sq, n)];
        if (v === 0 || v > L) return false;
      }
    }
    return true;
  };

  let mates = 0, stalemates = 0;
  for (let i = 0; i < size; i++) {
    load(i);
    if (!distinct(wk, bk, sq, n) || KADJ[wk * 64 + bk]) { W[i] = Bl[i] = ILLEGAL; continue; }
    occupy(wk, sq, n, bk);
    const check = pieceAttacks(bk, types, sq, n, -1, OLO, OHI);
    if (check) W[i] = ILLEGAL;
    else if (whiteStuck()) stalemates++;    // a pawn blocked by its own king (K7/P1k5): a draw with no move to look at
    if (blackGen(wk, bk, types, sq, n) === 0) {
      if (check) { Bl[i] = 1; mates++; } else { Bl[i] = STALE; stalemates++; }
    }
  }

  let subMax = 0;
  for (const d of DEPENDS[name] ?? []) for (const v of subs[d].data) if (2 * v > subMax) subMax = 2 * v;
  for (let L = 1, idle = 0; ; L++) {
    let changed = 0;
    if (L & 1) {
      for (let i = 0; i < size; i++) if (W[i] === 0) { load(i); if (whiteReaches(L)) { W[i] = L + 1; changed++; } }
    } else {
      for (let i = 0; i < size; i++) if (Bl[i] === 0) { load(i); if (blackLost(L)) { Bl[i] = L + 1; changed++; } }
    }
    idle = changed ? 0 : idle + 1;
    if (idle >= 2 && L > subMax + 3) break;
  }

  const data = new Uint8Array(size), hist = [];
  let prev = 0, maxMoves = 0, wins = 0, drawsW = 0, lossesB = 0, drawsB = 0, illegal = 0;
  for (let i = 0; i < size; i++) {
    const w = W[i], b = Bl[i];
    if (w === ILLEGAL) { data[i] = prev; illegal++; } else {
      const m = w >> 1;
      data[i] = prev = m;
      if (m) { wins++; hist[m] = (hist[m] ?? 0) + 1; if (m > maxMoves) maxMoves = m; } else drawsW++;
    }
    if (b !== ILLEGAL) { if (b && b !== STALE) lossesB++; else drawsB++; }
  }
  for (let m = 0; m <= maxMoves; m++) hist[m] ??= 0;
  return { name, data, stats: { maxMoves, wins, drawsW, lossesB, drawsB, mates, stalemates, illegal, hist } };
}

// --- files ---

const MAGIC = 'EGT1';

/** The table as file bytes (before gzip): the 8-byte header and the payload. */
export function pack(table) {
  const out = new Uint8Array(8 + table.data.length);
  const head = MAGIC + table.name.padEnd(4);
  for (let i = 0; i < 8; i++) out[i] = head.charCodeAt(i);
  out.set(table.data, 8);
  return out;
}

/** pack() undone: {name, data}. */
export function unpack(bytes) {
  const head = String.fromCharCode(...bytes.subarray(0, 8));
  if (head.slice(0, 4) !== MAGIC) throw new Error('not an endgame table');
  const name = head.slice(4).trim();
  const data = bytes.slice(8);
  if (data.length !== tableSize(name)) throw new Error(`${name}: ${data.length} bytes, expected ${tableSize(name)}`);
  return { name, data };
}

/** Gunzips bytes with the platform's DecompressionStream (browsers, Node 18+). */
export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- probing ---

const RESULT_ILLEGAL = { result: 'illegal', dtm: null };

function lookup(tables, name, wk, bk, sq) {
  if (DRAWN.has(name)) return 0;
  const t = tables[name];
  if (!t) throw new Error(`no ${name} table`);
  return t.data[indexRaw(hasPawn(name), wk, bk, sq, sq.length)];
}

function legal(pos) {
  const { name, wk, bk, pieces } = pos, n = pieces.length;
  if (n !== name.length - 2 || !distinct(wk, bk, pieces, n) || KADJ[wk * 64 + bk]) return false;
  const types = typesOf(name);
  for (let i = 0; i < n; i++) if (types[i] === P && (pieces[i] < 8 || pieces[i] >= 56)) return false;
  return true;
}

const inCheck = pos => {
  occupy(pos.wk, pos.pieces, pos.pieces.length, pos.bk);
  return pieceAttacks(pos.bk, typesOf(pos.name), pos.pieces, pos.pieces.length, -1, OLO, OHI);
};

/** The table's verdict on a position: {result: 'win'|'draw' (white to move), 'loss'|'draw'|'mate'|'stalemate' (black
 * to move), or 'illegal'; dtm: the moves white still needs to mate, 0 for mate, null for a draw}. */
export function probe(tables, pos) {
  if (!legal(pos)) return RESULT_ILLEGAL;
  const check = inCheck(pos);
  if (pos.turn === 'w') {
    if (check) return RESULT_ILLEGAL;
    const v = lookup(tables, pos.name, pos.wk, pos.bk, pos.pieces);
    return v ? { result: 'win', dtm: v } : { result: 'draw', dtm: null };
  }
  const moves = blackMoves(tables, pos);
  if (!moves.length) return check ? { result: 'mate', dtm: 0 } : { result: 'stalemate', dtm: null };
  let max = 0;
  for (const m of moves) {
    if (m.result !== 'win') return { result: 'draw', dtm: null };
    if (m.dtm > max) max = m.dtm;
  }
  return { result: 'loss', dtm: max };
}

/** Black's legal moves (black to move): [{to, capture, result: 'win'|'draw' for white after it, dtm}]. */
export function blackMoves(tables, pos) {
  const { name, wk, bk, pieces } = pos, types = typesOf(name), n = pieces.length;
  const c = blackGen(wk, bk, types, pieces, n);
  const tos = Array.from(BTO.subarray(0, c)), caps = Array.from(BCAP.subarray(0, c));
  return tos.map((to, k) => {
    const cap = caps[k];
    const after = cap < 0 ? { name, wk, bk: to, pieces, turn: 'w' }
      : { name: without(name, cap), wk, bk: to, pieces: pieces.filter((_, j) => j !== cap), turn: 'w' };
    const v = lookup(tables, after.name, after.wk, after.bk, after.pieces);
    return { to, capture: cap >= 0, result: v ? 'win' : 'draw', dtm: v || null };
  });
}

/** The position after a white move ({piece index, to, promotion letter}), black to move. */
function afterWhite(pos, i, to, promotion) {
  if (i < 0) return { ...pos, wk: to, turn: 'b' };
  const pieces = pos.pieces.slice();
  pieces[i] = to;
  if (!promotion) return { ...pos, pieces, turn: 'b' };
  const letters = [...pos.name.slice(1, -1)];
  letters[i] = promotion.toUpperCase();
  // only KPK promotes, and its pawn is its one piece, so the new piece keeps the pawn's place
  return { name: 'K' + letters.join('') + 'K', wk: pos.wk, bk: pos.bk, pieces, turn: 'b' };
}

/** White's legal moves (white to move): [{piece: 'K'|'Q'|'R'|'B'|'N'|'P', from, to, promotion: null|'q'|'r'|'b'|'n',
 * result and dtm of the position after it, black to move}]. */
export function whiteMoves(tables, pos) {
  const { wk, bk, pieces } = pos, types = typesOf(pos.name), n = pieces.length;
  const occupied = x => x === wk || x === bk || pieces.includes(x);
  const out = [];
  const add = (i, from, to, promotion = null) => {
    const r = probe(tables, afterWhite(pos, i, to, promotion));
    out.push({ piece: i < 0 ? 'K' : LETTER[types[i]], from, to, promotion, result: r.result, dtm: r.dtm });
  };
  for (const y of KING_TO[wk]) if (!(KADJ[bk * 64 + y] || occupied(y))) add(-1, wk, y);
  for (let i = 0; i < n; i++) {
    const s = pieces[i], t = types[i];
    if (t === P) {
      const y = s + 8;
      if (occupied(y)) continue;
      if (y >= 56) { for (const p of 'qrbn') add(i, s, y, p); continue; }
      add(i, s, y);
      if (s < 16 && !occupied(s + 16)) add(i, s, s + 16);
    } else if (t === N) {
      for (const y of KNIGHT_TO[s]) if (!occupied(y)) add(i, s, y);
    } else {
      for (const d of SLIDES[t]) for (const y of RAYS[s][d]) { if (occupied(y)) break; add(i, s, y); }
    }
  }
  return out;
}

// --- FEN ---

const ORDER = 'QRBNP';

/** The position in a FEN, or null when it isn't white's king and up to two pieces against the lone black king. */
export function fromFen(fen) {
  const [placement, turn = 'w'] = fen.trim().split(/\s+/);
  const rows = placement.split('/');
  if (rows.length !== 8) return null;
  let wk = -1, bk = -1;
  const white = [];
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const c of rows[r]) {
      if (c >= '1' && c <= '8') { f += +c; continue; }
      const s = (7 - r) * 8 + f++;
      if (c === 'K') { if (wk >= 0) return null; wk = s; } else if (c === 'k') { if (bk >= 0) return null; bk = s; } else if (ORDER.includes(c)) white.push([c, s]);
      else return null;
    }
    if (f !== 8) return null;
  }
  if (wk < 0 || bk < 0 || white.length > 2 || (turn !== 'w' && turn !== 'b')) return null;
  white.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]) || a[1] - b[1]);
  return { name: 'K' + white.map(p => p[0]).join('') + 'K', wk, bk, pieces: white.map(p => p[1]), turn };
}

/** The position as a FEN: no castling, no en passant, counters at 0 and 1. */
export function toFen(pos) {
  const board = new Array(64).fill('');
  board[pos.wk] = 'K'; board[pos.bk] = 'k';
  const letters = pos.name.slice(1, -1);
  pos.pieces.forEach((s, i) => { board[s] = letters[i]; });
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', empty = 0;
    for (let f = 0; f < 8; f++) {
      const c = board[r * 8 + f];
      if (!c) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += c;
    }
    rows.push(row + (empty || ''));
  }
  return `${rows.join('/')} ${pos.turn} - - 0 1`;
}

/** The same key for a position and every mirror or rotation of it: the smallest index among them, with identical
 * pieces sorted. */
export function canonical(pos) {
  const pieces = pos.pieces.slice();
  const pawn = hasPawn(pos.name);
  if (pawn) return indexRaw(true, pos.wk, pos.bk, pieces, pieces.length);
  const letters = pos.name.slice(1, -1);
  let best = Infinity;
  for (let t = 0; t < 8; t++) {
    const wk = T[t * 64 + pos.wk];
    if (TRI[wk] < 0) continue;
    const sq = pieces.map(s => T[t * 64 + s]);
    for (let i = 1; i < sq.length; i++) if (letters[i] === letters[i - 1] && sq[i] < sq[i - 1]) [sq[i], sq[i - 1]] = [sq[i - 1], sq[i]];
    const k = indexRaw(false, wk, T[t * 64 + pos.bk], sq, sq.length);
    if (k < best) best = k;
  }
  return best;
}
