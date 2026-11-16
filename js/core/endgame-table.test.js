// The endgame tables against what's known of them: the longest mates, the position counts the generator gave when
// checked against the lichess tablebase (and, for KPK, Stockfish's bitbase: 111,282 won positions over both sides
// to move), a few positions by hand, and chess.js on legality, mate, stalemate and the moves themselves.
// The 4-piece tables take about ten seconds, so they run only with ENDGAME_FULL=1.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardFromFen, isCheck, isCheckmate, legalMoves } from './chess.js';
import {
  blackMoves, canonical, decode, generate, gunzip, pack, probe, tableSize, toFen, transform, unpack, whiteMoves,
  fromFen,
} from './endgame-table.js';
import { gzipSync } from 'node:zlib';

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

const moved = (pos, t) => ({ ...pos, wk: transform(t, pos.wk), bk: transform(t, pos.bk),
  pieces: pos.pieces.map(s => transform(t, s)) });

test('longest mates', () => {
  assert.equal(tables.KQK.stats.maxMoves, 10);
  assert.equal(tables.KRK.stats.maxMoves, 16);
  assert.equal(tables.KPK.stats.maxMoves, 28);
});

test('KQK counts', () => {
  const s = tables.KQK.stats;
  assert.equal(s.wins, 22589);
  assert.equal(s.drawsW, 0);
  assert.equal(s.mates, 55);
  assert.equal(s.stalemates, 132);
  assert.equal(s.hist[1], 375);
  assert.equal(s.hist[2], 805);
  assert.equal(s.hist[10], 2);
});

test('KRK counts', () => {
  const s = tables.KRK.stats;
  assert.equal(s.wins, 27352);
  assert.equal(s.mates, 32);
  assert.equal(s.stalemates, 9);
  assert.equal(s.hist[16], 199);
});

test('KPK counts match the Stockfish bitbase', () => {
  const s = tables.KPK.stats;
  assert.equal(s.wins, 62480);
  assert.equal(s.lossesB, 48802);
  assert.equal(s.wins + s.lossesB, 111282);
  // 9 with black to move, and 2 with white's pawn blocked by its own king (K7/P1k5 w, K1k5/P7 w)
  assert.equal(s.stalemates, 11);
  assert.equal(s.mates, 0);
});

test('positions by hand', () => {
  assert.deepEqual(at('4k3/8/8/8/8/8/8/3QK3 w - - 0 1'), { result: 'win', dtm: 8 });
  assert.deepEqual(at('4k3/8/8/8/8/8/8/R3K3 w - - 0 1'), { result: 'win', dtm: 12 });
  assert.deepEqual(at('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1'), { result: 'win', dtm: 22 });
  assert.deepEqual(at('4k3/8/4K3/4P3/8/8/8/8 w - - 0 1'), { result: 'win', dtm: 11 });
  assert.deepEqual(at('4k3/8/4K3/4P3/8/8/8/8 b - - 0 1'), { result: 'loss', dtm: 12 });
  assert.deepEqual(at('8/4k3/8/4K3/4P3/8/8/8 w - - 0 1'), { result: 'draw', dtm: null });
  assert.deepEqual(at('8/4k3/8/4K3/4P3/8/8/8 b - - 0 1'), { result: 'loss', dtm: 14 });
  assert.deepEqual(at('k7/8/8/8/8/8/P7/K7 w - - 0 1'), { result: 'draw', dtm: null });
  assert.deepEqual(at('k7/8/1QK5/8/8/8/8/8 b - - 0 1'), { result: 'stalemate', dtm: null });
  assert.equal(at('kQ6/8/8/8/8/8/8/7K b - - 0 1').result, 'draw');               // the queen hangs
  assert.equal(at('4k3/8/8/8/8/8/8/3QK3 w').result, 'win');                     // no counters needed
  assert.equal(at('4k3/4Q3/8/8/8/8/8/4K3 w - - 0 1').result, 'illegal');        // black in check, white to move
  assert.equal(at('8/8/8/8/8/8/3kK3/7Q w - - 0 1').result, 'illegal');          // kings touching
  assert.equal(fromFen('4k3/8/8/8/8/8/8/3qK3 w - - 0 1'), null);
});

test('every symmetry probes the same', () => {
  const rand = rng(7);
  for (const name of ['KQK', 'KRK', 'KPK']) {
    let n = 0;
    while (n < 300) {
      const p = decode(name, Math.floor(rand() * tableSize(name)));
      for (const turn of ['w', 'b']) {
        const pos = { ...p, turn }, want = probe(tables, pos);
        if (want.result === 'illegal') continue;
        n++;
        for (const t of name === 'KPK' ? [0, 1] : [0, 1, 2, 3, 4, 5, 6, 7]) {
          const q = moved(pos, t);
          assert.deepEqual(probe(tables, q), want, toFen(q));
          assert.equal(canonical(q), canonical(pos), toFen(q));
        }
      }
    }
  }
});

test('pack, gzip and unpack round trip', async () => {
  const t = unpack(await gunzip(gzipSync(pack(tables.KRK))));
  assert.equal(t.name, 'KRK');
  assert.deepEqual(t.data, tables.KRK.data);
  assert.equal(unpack(pack(tables.KPK)).name, 'KPK');
  assert.throws(() => unpack(new Uint8Array(20)), /not an endgame table/);
});

test('500 random positions agree with chess.js', () => {
  const rand = rng(42);
  const names = ['KQK', 'KRK', 'KPK'];
  let n = 0;
  while (n < 500) {
    const name = names[n % 3];
    const pos = { ...decode(name, Math.floor(rand() * tableSize(name))), turn: rand() < 0.5 ? 'w' : 'b' };
    const fen = toFen(pos), r = probe(tables, pos);
    const board = boardFromFen(fen);
    // legal: kings apart, no pawn on the back ranks, the side not to move not in check
    const other = boardFromFen(fen.replace(/ [wb] /, pos.turn === 'w' ? ' b ' : ' w '));
    const kingsApart = Math.max(Math.abs((pos.wk & 7) - (pos.bk & 7)), Math.abs((pos.wk >> 3) - (pos.bk >> 3))) > 1;
    const onBoard = new Set([pos.wk, pos.bk, ...pos.pieces]).size === pos.pieces.length + 2;
    const pawnOk = !(name === 'KPK' && (pos.pieces[0] < 8 || pos.pieces[0] >= 56));
    const ok = kingsApart && onBoard && pawnOk && !isCheck(other);
    assert.equal(r.result !== 'illegal', ok, fen);
    if (!ok) continue;
    n++;
    const moves = legalMoves(board);
    if (pos.turn === 'b') {
      assert.equal(r.result === 'mate', isCheckmate(board), fen);
      assert.equal(r.result === 'stalemate', !moves.length && !isCheck(board), fen);
      const bm = blackMoves(tables, pos);
      assert.deepEqual(bm.map(m => m.to).sort(), moves.map(m => m.to).sort(), fen);
      if (r.result === 'loss') assert.equal(r.dtm, Math.max(...bm.map(m => m.dtm)), fen);
      if (r.result === 'draw') assert.ok(bm.some(m => m.result === 'draw'), fen);
    } else {
      const wm = whiteMoves(tables, pos);
      const key = m => `${m.from}-${m.to}-${m.promotion ?? ''}`;
      assert.deepEqual(wm.map(key).sort(),
        moves.map(m => key({ ...m, promotion: m.promotion && { queen: 'q', rook: 'r', bishop: 'b', knight: 'n' }[m.promotion] })).sort(), fen);
      const won = wm.filter(m => m.result === 'loss' || m.result === 'mate');
      if (r.result === 'win') assert.equal(r.dtm, 1 + Math.min(...won.map(m => m.dtm)), fen);
      else assert.equal(won.length, 0, fen);
    }
  }
});

test('4-piece tables', { skip: !process.env.ENDGAME_FULL && 'set ENDGAME_FULL=1 (about ten seconds)' }, () => {
  const all = { ...tables };
  all.KQRK = generate('KQRK', all);
  all.KRRK = generate('KRRK', all);
  const q = all.KQRK.stats, r = all.KRRK.stats;
  assert.equal(q.maxMoves, 6);
  assert.equal(q.wins, 1080257);
  assert.equal(q.mates, 35617);
  assert.equal(q.hist[6], 12);
  assert.equal(r.maxMoves, 7);
  assert.equal(r.wins, 1299964);
  assert.equal(r.mates, 22644);
  assert.equal(r.hist[7], 4186);
  assert.deepEqual(probe(all, fromFen('4k3/8/8/8/8/8/8/R2QK3 w - - 0 1')), { result: 'win', dtm: 2 });
  assert.deepEqual(probe(all, fromFen('4k3/8/8/8/8/8/8/R3K2R w - - 0 1')), { result: 'win', dtm: 2 });
  // black takes a hanging rook into KQK
  const pos = fromFen('4k3/5R2/8/8/8/8/8/3QK3 b - - 0 1');
  const take = blackMoves(all, pos).find(m => m.capture);
  assert.equal(take.to, 53);
  assert.equal(take.dtm, probe(all, fromFen('8/5k2/8/8/8/8/8/3QK3 w - - 0 1')).dtm);
  // the rooks swapped, or the board turned, give the same key
  const rr = fromFen('4k3/8/8/8/8/8/8/R3K2R w - - 0 1');
  assert.equal(canonical({ ...rr, pieces: [rr.pieces[1], rr.pieces[0]] }), canonical(rr));
  assert.equal(canonical(moved(rr, 3)), canonical(rr));
});
