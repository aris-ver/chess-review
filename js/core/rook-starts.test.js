// The committed start positions of the Lucena and Philidor drills (js/core/rook-starts.js, built by
// scripts/build_rook_starts.js from the lichess tablebase). No network: shape, legality and counts only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardFromFen, isCheck, legalMoves } from './chess.js';
import { ROOK_STARTS } from './rook-starts.js';

const ENDINGS = ['Lucena', 'Philidor'];
const mirror = fen => {
  const [board, ...rest] = fen.split(' ');
  return [board.split('/').map(r => [...r].reverse().join('')).join('/'), ...rest].join(' ');
};
const pieces = fen => fen.split(' ')[0].replace(/[\d/]/g, '').split('').sort().join('');

test('four levels per ending, 60 starts each (Philidor level 4 has the 49 lichess verified)', () => {
  assert.deepEqual(Object.keys(ROOK_STARTS), ENDINGS);
  for (const ending of ENDINGS) {
    assert.equal(ROOK_STARTS[ending].length, 4);
    ROOK_STARTS[ending].forEach((level, i) => {
      assert.equal(level.length, ending === 'Philidor' && i === 3 ? 49 : 60, `${ending} level ${i + 1}`);
      for (const e of level) assert.equal(e.family, `L${i + 1}`);
    });
  }
});

test('every start is legal, white to move, nobody in check, with the right pieces', () => {
  for (const ending of ENDINGS) {
    const want = ending === 'Lucena' ? 'KPRkr' : 'KRkpr';
    for (const e of ROOK_STARTS[ending].flat()) {
      const pos = boardFromFen(e.fen);
      assert.equal(pos.turn, 'white', e.fen);
      assert.ok(!isCheck(pos), e.fen);
      assert.equal(legalMoves(pos).length, e.legal, e.fen);
      assert.equal(pieces(e.fen), [...want].sort().join(''), e.fen);
    }
  }
});

test('no start twice, mirrors included, and the pawn is on file b to d', () => {
  for (const ending of ENDINGS) {
    const fens = ROOK_STARTS[ending].flat().map(e => e.fen);
    const set = new Set(fens);
    assert.equal(set.size, fens.length);
    for (const f of fens) assert.ok(!set.has(mirror(f)), `${f} and its mirror`);
    for (const f of fens) {
      const rows = f.split(' ')[0].split('/');
      const pawn = ending === 'Lucena' ? 'P' : 'p';
      const files = [];
      rows.forEach(row => {
        let file = 0;
        for (const c of row) { if (/\d/.test(c)) file += Number(c); else { if (c === pawn) files.push(file); file++; } }
      });
      assert.equal(files.length, 1);
      assert.ok(files[0] >= 1 && files[0] <= 3, `${f}: pawn on file ${files[0]}`);
    }
  }
});

test('verified flags: some move changes the result, Lucena has a promotion, level 4 is far from one', () => {
  for (const ending of ENDINGS) {
    for (const e of ROOK_STARTS[ending].flat()) {
      assert.ok(Number.isInteger(e.good) && e.good >= 0 && e.good < e.legal, `${e.fen}: good ${e.good} of ${e.legal}`);
      assert.ok(Number.isInteger(e.dtz), e.fen);
      if (ending === 'Lucena') {
        assert.ok(e.good >= 1, e.fen);
        assert.ok(Number.isInteger(e.promote) && e.promote >= 1, e.fen);
        if (e.family === 'L4') assert.ok(e.promote >= 10, `${e.fen}: promote ${e.promote}`);
      } else {
        assert.equal(e.promote, null);
        if (e.family === 'L4') assert.ok(e.good <= 3, `${e.fen}: ${e.good} drawing moves`);
      }
    }
  }
});

test('Lucena pawns stand on the rank of their family, Philidor pawns on theirs', () => {
  const rank = (fen, pawn) => {
    const rows = fen.split(' ')[0].split('/');
    return 8 - rows.findIndex(r => r.includes(pawn));
  };
  const lucena = { L1: [7], L2: [7], L3: [6], L4: [5] };
  const philidor = { L1: [4], L2: [3], L3: [4, 5], L4: [4, 5] };
  for (const e of ROOK_STARTS.Lucena.flat()) assert.ok(lucena[e.family].includes(rank(e.fen, 'P')), e.fen);
  for (const e of ROOK_STARTS.Philidor.flat()) assert.ok(philidor[e.family].includes(rank(e.fen, 'p')), e.fen);
});

test('the build script walks the line to the first promotion', async () => {
  const { promoteByWalk, after } = await import('../../scripts/build_rook_starts.js');
  // a tablebase that knows one line: white Kc8-d8?? is not needed, only that white's first move is taken and black
  // answers with its longest resistance
  const start = '3K4/3P2k1/8/8/r7/8/8/5R2 w - - 0 1';
  const seen = [];
  const fake = async fen => {
    seen.push(fen);
    if (fen === start) return { moves: [['f1f4', 'loss', 12], ['f1f5', 'loss', 12]] };
    if (fen === after(start, 'f1f4')) return { moves: [['a4a1', 'win', 2], ['a4a8', 'win', 20], ['g7h7', 'win', 8]] };
    return { moves: [['d7d8q', 'loss', 5]] };
  };
  assert.equal(await promoteByWalk(start, fake), 2);
  assert.equal(seen.length, 3);
  assert.equal(seen[2], after(after(start, 'f1f4'), 'a4a8'));
  assert.equal(await promoteByWalk(start, async () => null), undefined);
  assert.equal(await promoteByWalk(start, async () => ({ moves: [] })), null);
});
