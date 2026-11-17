// The committed start positions of the Lucena and Philidor drills (js/core/rook-starts.js, built by
// scripts/build_rook_starts.js from the lichess tablebase). No network: shape, legality and counts only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { boardFromFen, isCheck, legalMoves } from './chess.js';
import { ROOK_STARTS } from './rook-starts.js';

const ENDINGS = ['Lucena', 'Philidor'];
/** Squares of a piece letter on a FEN: [[file, rank]], both 0..7. */
const squares = (fen, piece) => {
  const out = [];
  fen.split(' ')[0].split('/').forEach((row, i) => {
    let file = 0;
    for (const c of row) { if (/\d/.test(c)) file += Number(c); else { if (c === piece) out.push([file, 7 - i]); file++; } }
  });
  return out;
};
const MIN_PROMOTE = { L1: 5, L2: 5, L3: 1, L4: 10 };
const GOOD_CAP = { L1: 8, L3: 8, L4: 3 };
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
        assert.ok(e.promote >= MIN_PROMOTE[e.family], `${e.fen}: promote ${e.promote}`);
      } else {
        assert.equal(e.promote, null);
        assert.ok(e.good <= (GOOD_CAP[e.family] ?? Infinity), `${e.fen}: ${e.good} drawing moves`);
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


test('Lucena levels 1 and 2 teach the bridge and the cut: black king two files away, black rook on the far side', () => {
  for (const e of ROOK_STARTS.Lucena.flat().filter(x => x.family === 'L1' || x.family === 'L2')) {
    const [p] = squares(e.fen, 'P'), [bk] = squares(e.fen, 'k'), [br] = squares(e.fen, 'r'), [wr] = squares(e.fen, 'R');
    assert.equal(p[0], 3, `${e.fen}: not a d-pawn`);
    assert.ok(bk[1] >= 6, `${e.fen}: black king below the 7th rank`);
    assert.ok(br[1] <= 3 && Math.abs(br[0] - p[0]) >= 2 && Math.abs(br[0] - p[0]) <= 4, `${e.fen}: black rook off the textbook squares`);
    assert.equal(Math.abs(bk[0] - p[0]), 2, `${e.fen}: black king not two files from the pawn`);
    const side = Math.sign(bk[0] - p[0]);
    assert.equal(Math.sign(br[0] - p[0]), -side, `${e.fen}: black rook on the king's side`);
    if (e.family === 'L1') {
      assert.equal(wr[0], p[0] + side, `${e.fen}: white rook not on the cutting file`);
      assert.ok(wr[1] <= 2, e.fen);
      assert.ok(Math.abs(br[0] - p[0]) >= 2, e.fen);
    } else {
      assert.notEqual(wr[0], p[0] + side, `${e.fen}: white rook already on the cutting file`);
    }
  }
});

test('Philidor level 3: the white rook is neither on the 3rd rank nor behind the pawn', () => {
  for (const e of ROOK_STARTS.Philidor.flat().filter(x => x.family === 'L3')) {
    const [wr] = squares(e.fen, 'R'), [bp] = squares(e.fen, 'p');
    assert.notEqual(wr[1], 2, e.fen);
    assert.ok(wr[1] <= bp[1], `${e.fen}: rook behind the pawn`);
  }
});

test('the committed file is what the cache rebuilds (offline, byte for byte)', async () => {
  const { build } = await import('../../scripts/build_rook_starts.js');
  const built = await build({ offline: true, log: () => {} });
  assert.equal(built.requests, 0);
  const committed = readFileSync(new URL('./rook-starts.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(built.text, committed);
});

test('promote counts white moves up to and including the promoting move on a mainline', async () => {
  const { promoteOnMainline } = await import('../../scripts/build_rook_starts.js');
  assert.equal(promoteOnMainline({ w: 'w', m: 'b1d1 f4f2 d8c7 f2c2 c7d6 c2c1 d1c1 a6a5 d7d8q a5a4' }), 5);
  assert.equal(promoteOnMainline({ w: 'w', m: 'd7d8q a6a5' }), 1);
  assert.equal(promoteOnMainline({ w: 'w', m: 'b1d1 a6a5 d1d2 a7b8q' }), null);   // black's promotion does not count
  assert.equal(promoteOnMainline({ w: 'w', m: '' }), null);
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
