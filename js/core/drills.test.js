// The drills on the 3-piece tables with a seeded RNG: start positions in their band and bucket, no repeats, the
// defender, the kinds of move, every way an attempt ends, the review, and the KPK attack and defence helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardFromFen, fen as fenOf, parseUci, push } from './chess.js';
import {
  LEVELS, ENDINGS, HOLD_MOVES, ZONES, bestLine, budget, candidates, defenceStatus, defenderMove, flipFen, kindOfMove,
  kpkAttackerMove, kpkGrade, onlyMoves, pickStart, positionKey, review, status, zone,
} from './drills.js';
import { fromFen, generate, probe } from './endgame-table.js';

const tables = {};
for (const name of ['KQK', 'KRK', 'KPK']) tables[name] = generate(name, tables);
const at = fen => probe(tables, fromFen(fen));

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const after = (fen, uci) => { const b = boardFromFen(fen); push(b, parseUci(b, uci)); return fenOf(b); };
const fastest = fen => bestLine(tables, fen, 1)[0];

test('levels, endings and zones', () => {
  assert.deepEqual(ENDINGS, ['KQRK', 'KRRK', 'KQK', 'KRK', 'KPK']);
  assert.equal(LEVELS.KQRK.length, 3);
  assert.equal(LEVELS.KRK.length, 5);
  assert.deepEqual(LEVELS.KQK[4], { lo: 9, hi: 10, slack: 1, counter: false });
  assert.equal(LEVELS.KPK.length, 4);
  const count = Object.fromEntries(ZONES.map(z => [z, 0]));
  for (let s = 0; s < 64; s++) count[zone(s)]++;
  assert.deepEqual(count, { corner: 4, edge: 24, ring: 20, centre: 16 });
  assert.equal(zone(0), 'corner');
  assert.equal(zone(27), 'centre');
  assert.equal(budget(7, 3), 10);
});

test('start positions sit in the level band, white to move, black not in check', () => {
  const rand = rng(1);
  for (const ending of ['KQK', 'KRK']) {
    LEVELS[ending].forEach(({ lo, hi, slack }, k) => {
      for (let j = 0; j < 20; j++) {
        const s = pickStart(tables, ending, k + 1, { rng: rand, turn: j });
        const r = at(s.fen);
        assert.equal(r.result, 'win', s.fen);
        assert.ok(r.dtm >= lo && r.dtm <= hi, `${s.fen} ${r.dtm}`);
        assert.equal(s.dtm, r.dtm);
        assert.equal(s.budget, r.dtm + slack);
        assert.equal(s.key, positionKey(s.fen));
      }
    });
  }
});

test('buckets are taken in turn', () => {
  const c = candidates(tables, 'KRK', 2);
  const nonEmpty = ZONES.filter(z => c[z].length);
  assert.equal(nonEmpty.length, 4);
  const rand = rng(2);
  for (let turn = 0; turn < 8; turn++) {
    const s = pickStart(tables, 'KRK', 2, { rng: rand, turn });
    assert.equal(zone(fromFen(s.fen).bk), nonEmpty[turn % 4]);
  }
  // KQK level 5 has no corner positions: three buckets
  const top = candidates(tables, 'KQK', 5);
  assert.equal(top.corner.length, 0);
  const zones = [0, 1, 2, 3].map(turn => zone(fromFen(pickStart(tables, 'KQK', 5, { rng: rand, turn }).fen).bk));
  assert.deepEqual(zones, ['edge', 'ring', 'centre', 'edge']);
  assert.equal(candidates(tables, 'KRK', 2), c);    // memoised
});

test('no position dealt twice in 50, mirrors included', () => {
  const rand = rng(3), recent = [];
  for (let turn = 0; turn < 50; turn++) {
    const s = pickStart(tables, 'KQK', 5, { rng: rand, recent, turn });
    assert.ok(!recent.includes(s.key), s.fen);
    recent.push(s.key);
  }
  // the key ignores mirrors and rotations
  assert.equal(positionKey('7k/8/8/8/8/8/8/R5K1 w - - 0 1'), positionKey('1K5R/8/8/8/8/8/8/k7 w - - 0 1'));
  assert.notEqual(positionKey('7k/8/8/8/8/8/8/R5K1 w - - 0 1'), positionKey('7k/8/8/8/8/8/8/R5K1 b - - 0 1'));
  assert.equal(positionKey('7k/8/8/8/8/8/8/R5K1 w - - 0 1'), positionKey('k7/8/8/8/8/8/8/1K5R w - - 0 1'));
});

test('the defender takes a hanging piece, else keeps mate furthest away', () => {
  assert.equal(defenderMove(tables, 'k7/1R6/8/8/8/8/8/7K b - - 0 1', rng(4)), 'a8b7');
  const fen = '8/8/8/3k4/8/8/8/R3K3 b - - 0 1';
  for (let seed = 0; seed < 10; seed++) {
    const uci = defenderMove(tables, fen, rng(seed));
    const r = at(after(fen, uci));
    assert.equal(r.dtm, at(fen).dtm, uci);
  }
});

test('kinds of move', () => {
  assert.equal(kindOfMove(5, { result: 'loss', dtm: 4 }), 'best');
  assert.equal(kindOfMove(5, { result: 'loss', dtm: 5 }), 'slack');
  assert.equal(kindOfMove(5, { result: 'loss', dtm: 6 }), 'slack');
  assert.equal(kindOfMove(5, { result: 'loss', dtm: 7 }), 'lost');
  assert.equal(kindOfMove(1, { result: 'mate', dtm: 0 }), 'best');
  assert.equal(kindOfMove(5, { result: 'draw', dtm: null }), 'threw');
  assert.equal(kindOfMove(5, { result: 'stalemate', dtm: null }), 'threw');
});

test('every way an attempt ends', () => {
  const start = '7k/8/8/8/8/8/8/R5K1 w - - 0 1';
  const play = { fens: [start], movesUsed: 0, budget: 10 };
  assert.equal(status(play), null);
  assert.equal(status({ ...play, movesUsed: 10 }), 'budget');
  assert.equal(status({ fens: [start, 'k6R/8/1K6/8/8/8/8/8 b - - 0 1'], movesUsed: 10, budget: 10 }), 'solved');
  assert.equal(status({ fens: [start, 'k7/8/1QK5/8/8/8/8/8 b - - 0 1'], movesUsed: 1, budget: 10 }), 'stalemate');
  assert.equal(status({ fens: ['k7/8/8/8/8/8/8/QR4K1 w - - 0 1', 'k7/8/8/8/8/8/8/Q5K1 w - - 0 1'],
    movesUsed: 1, budget: 10 }), 'piece_lost');
  assert.equal(status({ fens: [start, 'k7/1R6/8/8/8/8/8/6K1 b - - 0 1', '8/1k6/8/8/8/8/8/6K1 w - - 0 1'], movesUsed: 1, budget: 10 }),
    'piece_lost');
  const a = '7k/8/8/8/8/8/8/R5K1 w - - 0 1', b = '7k/8/8/8/8/8/R7/6K1 b - - 1 1';
  const c = '6k1/8/8/8/8/8/R7/6K1 w - - 2 2', d = '6k1/8/8/8/8/8/8/R5K1 b - - 3 2';
  assert.equal(status({ fens: [a, b, c, d, a, b, c, d, a], movesUsed: 4, budget: 10 }), 'repetition');
  assert.equal(status({ fens: [a, b, c, d, a], movesUsed: 2, budget: 10 }), null);
  assert.equal(status({ fens: ['7k/8/8/8/8/8/8/R5K1 w - - 100 80'], movesUsed: 5, budget: 90 }), 'fifty');
});

test('a perfect KRK game mates in exactly the start distance', () => {
  for (let seed = 0; seed < 5; seed++) {
    const rand = rng(10 + seed);
    const s = pickStart(tables, 'KRK', 5, { rng: rand });
    let fen = s.fen, moves = 0;
    const fens = [fen];
    while (!status({ fens, movesUsed: moves, budget: s.budget })) {
      fen = after(fen, fastest(fen));
      moves++;
      fens.push(fen);
      if (status({ fens, movesUsed: moves, budget: s.budget })) break;
      fen = after(fen, defenderMove(tables, fen, rand));
      fens.push(fen);
    }
    assert.equal(status({ fens, movesUsed: moves, budget: s.budget }), 'solved');
    assert.equal(moves, s.dtm, s.fen);
    const r = review(tables, fens);
    assert.equal(r.moves.length, s.dtm);
    assert.ok(r.moves.every(m => m.kind === 'best'));
    assert.equal(r.worst, -1);
    assert.equal(r.moves.at(-1).dtm, 0);
  }
});

test('the review marks the costliest move', () => {
  // KQK: a check from afar, then the best move
  const start = '8/8/8/2k5/8/8/8/3QK3 w - - 0 1';
  const fens = [start];
  let fen = after(start, 'd1h5');
  fens.push(fen);
  fen = after(fen, defenderMove(tables, fen, rng(5)));
  fens.push(fen);
  fen = after(fen, fastest(fen));
  fens.push(fen);
  const r = review(tables, fens);
  assert.equal(r.moves.length, 2);
  assert.equal(r.moves[1].kind, 'best');
  assert.equal(r.moves[0].loss, at(fens[1]).dtm - (at(start).dtm - 1));
  assert.equal(r.moves[0].dtm, at(fens[1]).dtm);
  assert.deepEqual(r.moves[0], { dtm: 8, kind: 'lost', loss: 3 });    // mate in 6 became mate in 8 after it
  assert.equal(r.worst, 0);
  // a thrown win is the worst move whatever else happened
  const thrown = review(tables, ['k7/8/2K5/8/8/8/8/1Q6 w - - 0 1', 'k7/8/1QK5/8/8/8/8/8 b - - 0 1']);
  assert.deepEqual(thrown, { moves: [{ dtm: null, kind: 'threw', loss: null }], worst: 0 });
});

test('the best line', () => {
  const fen = '4k3/8/8/8/8/8/8/R3K3 w - - 0 1';
  const line = bestLine(tables, fen);
  assert.equal(line.length, 2 * 12 - 1);
  let f = fen;
  for (const uci of line) f = after(f, uci);
  assert.equal(at(f).result, 'mate');
  assert.deepEqual(bestLine(tables, '8/4k3/8/4K3/4P3/8/8/8 w - - 0 1'), []);
});

test('KPK attack: only-moves, grading, start positions', () => {
  // the pawn alone on e2 with kings on e1 and e8: the table's line needs only-moves
  assert.ok(onlyMoves(tables, '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1') >= 1);
  assert.equal(kpkGrade({ result: 'win' }, { result: 'loss' }), 'ok');
  assert.equal(kpkGrade({ result: 'win' }, { result: 'draw' }), 'threw');
  assert.equal(kpkGrade({ result: 'win' }, { result: 'stalemate' }), 'threw');
  assert.equal(kpkGrade('draw', 'draw'), 'ok');
  assert.equal(kpkGrade('draw', 'win'), 'threw');
  const rand = rng(6);
  for (let level = 1; level <= 4; level++) {
    const s = pickStart(tables, 'KPK', level, { rng: rand });
    assert.equal(at(s.fen).result, 'win');
    assert.equal(s.budget, null);
    const n = onlyMoves(tables, s.fen);
    assert.ok(level === 4 ? n >= 4 : n === level, `${s.fen} ${n}`);
  }
});

test('KPK defence: flipped positions, the attacker, the end', () => {
  assert.equal(flipFen('8/8/8/8/8/8/4P3/4K2k w - - 0 1'), '4k2K/4p3/8/8/8/8/8/8 b - - 0 1');
  assert.equal(flipFen(flipFen('8/8/8/8/8/8/4P3/4K2k w - - 0 1')), '8/8/8/8/8/8/4P3/4K2k w - - 0 1');
  const rand = rng(7);
  for (let level = 1; level <= 4; level++) {
    const s = pickStart(tables, 'KPK', level, { rng: rand, mode: 'defence' });
    assert.match(s.fen, / w /);
    assert.match(s.fen.split(' ')[0], /p/);
    assert.equal(probe(tables, fromFen(flipFen(s.fen))).result, 'draw');
    assert.equal(s.key, positionKey(s.fen));
    const n = onlyMoves(tables, s.fen);
    assert.ok(level === 4 ? n >= 4 : n === level, `${s.fen} ${n}`);
  }
  // the attacker wins when the defender lets it: black's king walks the pawn in
  const won = '8/8/8/8/8/2k5/2p5/K7 b - - 0 1';
  const uci = kpkAttackerMove(tables, won, rng(8));
  const next = after(won, uci);
  assert.ok(['loss', 'mate'].includes(probe(tables, fromFen(flipFen(next))).result), next);
  // the defence ends: pawn taken, stalemate, held
  assert.equal(defenceStatus({ fens: ['8/8/8/8/8/8/8/k1K5 w - - 0 1'] }), 'pawn_taken');
  assert.equal(defenceStatus({ fens: ['8/8/8/8/1k6/8/1p6/1K6 w - - 0 1'] }), null);
  assert.equal(defenceStatus({ fens: ['8/8/8/8/8/1k6/1p6/1K6 w - - 0 1'] }), 'stalemate');
  const moves = n => [...Array(n).keys()].map(i => `placeholder${i} b`).concat('8/8/8/8/1k6/8/1p6/1K6 w - - 0 1');
  assert.equal(defenceStatus({ fens: moves(2 * HOLD_MOVES - 1) }), null);
  assert.equal(defenceStatus({ fens: moves(2 * HOLD_MOVES) }), 'held');
  const a = '8/8/8/8/1k6/8/1p6/1K6 w - - 0 1', b = '8/8/8/8/1k6/8/1p6/2K5 b - - 0 1';
  assert.equal(defenceStatus({ fens: [a, b, a, b, a] }), 'held');    // a threefold repetition
});
