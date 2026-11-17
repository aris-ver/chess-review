// The rook drills' grading (rook-drills.js): table-driven over hand-made move sequences for every result, the
// opponent's turn with a fake engine, and the deal. The cases that end in a 4-piece table (KRKR, KQKR) read
// data/endgames and are skipped without it; the rest use 3-piece tables made here.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { boardFromFen, fen as fenOf, legalMoves, parseUci, push, uci as uciOf } from './chess.js';
import { generate, unpack } from './endgame-table.js';
import { ENDINGS, LEVELS, levelOf, pickStart, positionKey } from './drills.js';
import { HOLD_ROOK, POST_PROMO, RECENT_ROOK, ROOK_RESULTS, ROOK_TABLES, chooseStart, mirrorFen, pickRookStart, promotionIndex,
  rookBudget, rookStart, rookStatus, rookTurn, uciBetween } from './rook-drills.js';
import { ROOK_STARTS } from './rook-starts.js';

const REAL = fileURLToPath(new URL('../../data/endgames/', import.meta.url));
const haveReal = ROOK_TABLES.every(n => existsSync(`${REAL}${n.toLowerCase()}.bin`));
const tables = {};
if (haveReal) for (const n of ROOK_TABLES) tables[n] = unpack(gunzipSync(readFileSync(`${REAL}${n.toLowerCase()}.bin`)));
else for (const n of ['KQK', 'KRK', 'KPK']) tables[n] = generate(n, tables);

/** The FENs from `start` along the UCI moves. */
function line(start, ucis) {
  const board = boardFromFen(start), fens = [fenOf(board)];
  for (const u of ucis) {
    push(board, parseUci(board, u));
    fens.push(fenOf(board));
  }
  return fens;
}

/** `plies` more king moves from the end of `fens`, never a capture and never a placement seen before (the first such
 * move each time): a quiet walk that only the move counts can end. */
function walk(fens, plies) {
  const out = [...fens], seen = new Set(out.map(f => f.split(' ').slice(0, 2).join(' ')));
  for (let k = 0; k < plies; k++) {
    const board = boardFromFen(out[out.length - 1]);
    const next = legalMoves(board).map(m => {
      if (board.board.getRole(m.from) !== 'king' || board.board.occupied.has(m.to)) return null;
      const b = boardFromFen(out[out.length - 1]);
      push(b, m);
      const f = fenOf(b);
      return seen.has(f.split(' ').slice(0, 2).join(' ')) || !legalMoves(b).length ? null : f;
    }).find(Boolean);
    assert.ok(next, `no quiet king move from ${out[out.length - 1]}`);
    seen.add(next.split(' ').slice(0, 2).join(' '));
    out.push(next);
  }
  return out;
}

// [ending, what, start, moves, result, needs the 4-piece tables]
const CASES = [
  ['Lucena', 'black mated on the board', '7k/8/6K1/8/8/8/3P4/R6r w - - 0 1', ['a1a8'], 'won'],
  ['Lucena', 'white mated', '7R/8/8/7P/8/7k/r7/7K w - - 0 1', ['h5h6', 'a2a1'], 'mated'],
  ['Lucena', 'black stalemated, rook gone', '7k/5K2/6P1/8/8/8/8/R7 w - - 0 1', ['a1a2'], 'stalemate'],
  ['Lucena', 'the rook taken, out of reach: K+R+P v K', '3K4/3P4/8/8/k7/8/8/r6R w - - 0 1', ['h1a1'], 'won'],
  ['Lucena', 'K+R+P v K, black can take the rook: on one ply', '3K4/3P4/8/8/8/8/1k6/r6R w - - 0 1', ['h1a1'], null],
  ['Lucena', 'the rook taken back: KPK, white wins', '3K4/3P4/8/8/8/8/1k6/r6R w - - 0 1', ['h1a1', 'b2a1'], 'won'],
  ['Lucena', 'rooks off into a drawn KPK', '4r3/3k4/8/8/1P6/8/8/4R2K w - - 0 1', ['e1e8', 'd7e8'], 'threw'],
  ['Lucena', 'white rook lost, pawn on the 5th', '4r3/7k/8/3P4/8/8/8/K3R3 w - - 0 1', ['a1a2', 'e8e1'], 'piece_lost'],
  ['Lucena', 'white rook lost, pawn on the 7th: on', 'K3r3/3P4/8/7k/8/8/8/4R3 w - - 0 1', ['a8b7', 'e8e1'], null],
  ['Lucena', 'then the promotion into a won KQKR', 'K3r3/3P4/8/7k/8/8/8/4R3 w - - 0 1', ['a8b7', 'e8e1', 'd7d8q'], 'promoted', true],
  ['Lucena', 'the pawn taken: KRKR drawn', '5k2/3r4/8/3P4/8/8/8/K6R w - - 0 1', ['a1a2', 'd7d5'], 'pawn_lost', true],
  // a rook trade the tablebase plays (found by scripts/check_rook_drills.js): taken back, then the table decides
  ['Lucena', 'the rooks traded, taken back: KPK won', '1R6/k2K4/3P3r/8/8/8/8/8 w - - 0 1',
    ['b8b4', 'h6h3', 'd7c6', 'h3c3', 'c6d5', 'c3d3', 'b4d4', 'd3d4', 'd5d4'], 'won'],
  ['Lucena', 'the rook taken, not taken back', '1R6/k2K4/3P3r/8/8/8/8/8 w - - 0 1',
    ['b8b4', 'h6h3', 'd7c6', 'h3c3', 'c6d5', 'c3d3', 'b4d4', 'd3d4', 'd5e6'], 'piece_lost'],
  ['Lucena', 'fifty moves', '3K4/3P1k2/8/8/r7/8/8/4R3 w - - 99 80', ['e1e2'], 'fifty'],
  ['Lucena', 'threefold repetition', '3K4/3P1k2/8/8/r7/8/8/4R3 w - - 0 1',
    ['e1e2', 'a4a3', 'e2e1', 'a3a4', 'e1e2', 'a4a3', 'e2e1', 'a3a4'], 'repetition'],
  ['Philidor', 'black mated on the board', '7k/8/6K1/8/8/1p6/r7/4R3 w - - 0 1', ['e1e8'], 'held'],
  ['Philidor', 'white mated', '7R/8/8/7p/8/7k/r7/7K w - - 0 1', ['h8h6', 'a2a1'], 'mated'],
  ['Philidor', 'black stalemated (K+R v K+P)', 'R7/8/8/8/8/8/5K1p/7k w - - 0 1', ['a8a7'], 'stalemate'],
  ['Philidor', 'rooks off, black king takes back: KPK black wins', '7K/8/8/3r4/1p2k3/8/8/3R4 w - - 0 1', ['d1d5', 'e4d5'], 'threw'],
  ['Philidor', 'the rook won: K+R v K+P', '8/8/r7/8/3p4/7k/8/R3K3 w - - 0 1', ['a1a6'], 'rook_won'],
  ['Philidor', 'the rook lost', '8/4r3/8/k7/2p5/8/4R3/7K w - - 0 1', ['h1g1', 'e7e2'], 'piece_lost'],
  ['Philidor', 'black promotes, nothing takes it', '7K/7R/8/8/8/r1k5/1p6/8 w - - 0 1', ['h7g7', 'b2b1q'], 'promoted'],
  ['Philidor', 'black promotes, the rook can take it: on', '7K/1R6/8/8/r7/3k4/1p6/8 w - - 0 1', ['h8g8', 'b2b1q'], null],
  ['Philidor', 'the new queen left standing', '7K/1R6/8/8/r7/3k4/1p6/8 w - - 0 1', ['h8g8', 'b2b1q', 'g8h8'], 'promoted'],
  ['Philidor', 'the new queen taken: KRKR drawn', '7K/1R6/8/8/r7/3k4/1p6/8 w - - 0 1', ['h8g8', 'b2b1q', 'b7b1'], 'pawn_taken', true],
  ['Philidor', 'the pawn taken: KRKR drawn', '7r/6k1/8/8/1p6/8/8/1R2K3 w - - 0 1', ['b1b4'], 'pawn_taken', true],
  ['Philidor', 'the rooks traded, taken back: KPK held', '8/3r4/2k5/2p5/8/7R/8/4K3 w - - 0 1',
    ['h3b3', 'c5c4', 'b3b1', 'd7d3', 'b1d1', 'd3d1', 'e1d1'], 'held'],
  ['Philidor', 'fifty moves', '7r/6k1/8/8/1p6/8/8/1R2K3 w - - 99 80', ['e1e2'], 'held'],
  ['Philidor', 'threefold repetition', '7r/6k1/8/8/1p6/8/8/1R2K3 w - - 0 1',
    ['e1e2', 'g7g6', 'e2e1', 'g6g7', 'e1e2', 'g7g6', 'e2e1', 'g6g7'], 'held'],
];

test('grading: every result from a hand-made sequence, and nothing earlier', () => {
  for (const [ending, what, start, ucis, want, real] of CASES) {
    if (real && !haveReal) continue;
    const fens = line(start, ucis);
    assert.equal(rookStatus(tables, ending, { fens, budget: 50 }), want, `${ending}: ${what}`);
    for (let k = 2; k < fens.length; k++) {
      assert.equal(rookStatus(tables, ending, { fens: fens.slice(0, k), budget: 50 }), null, `${ending}: ${what}, ply ${k - 1}`);
    }
    const all = [...ROOK_RESULTS[ending].solved, ...ROOK_RESULTS[ending].failed];
    if (want) assert.ok(all.includes(want), `${want} is a ${ending} result`);
  }
});

test('grading: the 4-piece cases ran', { skip: !haveReal && 'no data/endgames' }, () => {
  assert.equal(CASES.filter(c => c[5]).length, 4);
});

test('grading: the budget, before and after a promotion; Philidor held after 30 moves', () => {
  const start = '3K4/3P1k2/8/8/r7/8/8/4R3 w - - 0 1';
  // two quiet moves of a budget of 2: out on the second, not the first
  const two = walk([fenOf(boardFromFen(start))], 3);
  assert.equal(rookStatus(tables, 'Lucena', { fens: two.slice(0, 2), budget: 2 }), null);
  assert.equal(rookStatus(tables, 'Lucena', { fens: two.slice(0, 3), budget: 2 }), null);
  assert.equal(rookStatus(tables, 'Lucena', { fens: two.slice(0, 4), budget: 2 }), 'budget');
  // the promotion on the budget's last move is in time; then POST_PROMO more moves
  const promo = line('1K6/2P5/8/8/5k2/8/r7/7R w - - 0 1', ['h1h2', 'a2a3', 'c7c8q']);
  assert.equal(promotionIndex(promo), 3);
  assert.equal(rookStatus(tables, 'Lucena', { fens: promo, budget: 2 }), null);
  const after = walk(promo, 2 * POST_PROMO);
  for (let k = promo.length + 1; k < after.length; k++) {
    assert.equal(rookStatus(tables, 'Lucena', { fens: after.slice(0, k), budget: 2 }), null, `ply ${k - 1}`);
  }
  assert.equal(rookStatus(tables, 'Lucena', { fens: after, budget: 2 }), 'budget');
  // Philidor: no budget, held after HOLD_ROOK moves
  const hold = walk([fenOf(boardFromFen('7r/6k1/8/8/1p6/8/8/1R2K3 w - - 0 1'))], 2 * HOLD_ROOK - 1);
  assert.equal(rookStatus(tables, 'Philidor', { fens: hold.slice(0, -1) }), null);
  assert.equal(rookStatus(tables, 'Philidor', { fens: hold }), 'held');
});

// an engine that answers from a script: {uci, cp|mate} per call, the calls kept
function scripted(replies) {
  const calls = [];
  const engine = async q => {
    calls.push(q);
    const r = replies.shift();
    if (!r) throw new Error('no more replies');
    return { move: r.move, cp: r.cp ?? null, mate: r.mate ?? null, ms: 7 };
  };
  return { engine, calls };
}

test('rookTurn: the reply played and graded; the history goes to the engine', async () => {
  const start = '3K4/3P4/8/8/8/8/1k6/r6R w - - 0 1';
  const fens = line(start, ['h1a1']);
  const { engine, calls } = scripted([{ move: 'b2a1', cp: -900 }]);
  const out = await rookTurn(tables, 'Lucena', { fens, ucis: ['h1a1'], budget: 9 }, engine);
  assert.deepEqual(calls, [{ fen: fens[0], moves: ['h1a1'] }]);
  assert.deepEqual([out.reply, out.result, out.engine_ms, out.promoted], ['b2a1', 'won', 7, false]);
  assert.deepEqual(out.score, { cp: -900, mate: null });
  assert.equal(out.fen, line(start, ['h1a1', 'b2a1'])[2]);
  // over on the user's move: no engine call
  const done = await rookTurn(tables, 'Lucena', { fens: line('7k/8/6K1/8/8/8/3P4/R6r w - - 0 1', ['a1a8']), ucis: ['a1a8'] },
    scripted([]).engine);
  assert.deepEqual([done.result, done.reply, done.engine_ms], ['won', null, null]);
  // an illegal engine move is an error, not a position
  await assert.rejects(rookTurn(tables, 'Lucena', { fens, ucis: ['h1a1'], budget: 9 }, scripted([{ move: 'a1a8' }]).engine),
    /not legal/);
});

test('rookTurn: after the promotion, the engine seeing mate ends it unplayed; otherwise play goes on', async () => {
  const fens = line('1K6/2P5/8/8/5k2/8/r7/7R w - - 0 1', ['h1h2', 'a2a3', 'c7c8q']);
  const ucis = ['h1h2', 'a2a3', 'c7c8q'];
  const mate = await rookTurn(tables, 'Lucena', { fens, ucis, budget: 9 }, scripted([{ move: 'f4e4', mate: -6 }]).engine);
  assert.deepEqual([mate.result, mate.reply, mate.fen, mate.promoted], ['promoted', null, null, true]);
  const on = await rookTurn(tables, 'Lucena', { fens, ucis, budget: 9 }, scripted([{ move: 'a3c3', cp: -2000 }]).engine);
  assert.deepEqual([on.result, on.reply, on.promoted], [null, 'a3c3', true]);
  // before a promotion a mate score is just a score
  const early = await rookTurn(tables, 'Lucena', { fens: fens.slice(0, 2), ucis: ucis.slice(0, 1), budget: 9 },
    scripted([{ move: 'a2a3', mate: -8 }]).engine);
  assert.deepEqual([early.result, early.reply, early.promoted], [null, 'a2a3', false]);
  // Philidor: promoted tells the page black has a new piece
  const ph = line('7K/1R6/8/8/r7/3k4/1p6/8 w - - 0 1', ['h8g8']);
  const q = await rookTurn(tables, 'Philidor', { fens: ph, ucis: ['h8g8'] }, scripted([{ move: 'b2b1q', mate: 9 }]).engine);
  assert.deepEqual([q.result, q.reply, q.promoted], [null, 'b2b1q', true]);
});

test('starts: found as stored and mirrored, budget promote + slack, the deal never repeats the last 30', () => {
  assert.deepEqual(ENDINGS.slice(-2), ['Lucena', 'Philidor']);
  assert.deepEqual(LEVELS.Lucena.map(l => [l.slack, l.counter]), [[8, false], [6, false], [5, false], [4, false]]);
  assert.equal(LEVELS.Philidor.length, 4);
  assert.equal(levelOf('Philidor', 4).slack, null);
  const e = ROOK_STARTS.Lucena[1][17];
  assert.deepEqual(rookStart(e.fen), { ending: 'Lucena', level: 2, index: 17, entry: e, key: 'Lucena:2:17' });
  assert.equal(rookStart(mirrorFen(e.fen)).key, 'Lucena:2:17');
  assert.equal(positionKey(mirrorFen(e.fen)), 'Lucena:2:17');
  assert.equal(rookStart(e.fen.replace(' w ', ' b ')), null);
  assert.equal(rookStart('8/8/8/8/8/8/8/K6k w - - 0 1'), null);
  assert.equal(rookBudget('Lucena', 2, e), e.promote + 6);
  assert.equal(rookBudget('Philidor', 1, ROOK_STARTS.Philidor[0][0]), null);
  assert.equal(uciBetween(e.fen, line(e.fen, [uciOf(legalMoves(boardFromFen(e.fen))[0])])[1]), uciOf(legalMoves(boardFromFen(e.fen))[0]));

  let seed = 11;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Philidor level 4 has 49: 200 deals in a row, none within 30 of its last
  const recent = [], seen = new Set();
  let mirrored = 0;
  for (let k = 0; k < 200; k++) {
    const s = pickStart(tables, 'Philidor', 4, { rng, recent });
    assert.equal(s.dtm, null);
    assert.equal(s.budget, null);
    assert.equal(rookStart(s.fen).key, s.key);
    if (s.fen !== ROOK_STARTS.Philidor[3][rookStart(s.fen).index].fen) mirrored++;
    assert.ok(!recent.slice(-RECENT_ROOK).includes(s.key), `deal ${k}: ${s.key} again`);
    recent.push(s.key);
    seen.add(s.key);
  }
  assert.ok(mirrored > 50 && mirrored < 150, `${mirrored} mirrored of 200`);
  assert.ok(seen.size > 40);
  // other levels' keys don't count: 30 of level 1 and 59 of level 2 dealt leave 30 of level 1
  const dealt = [...Array.from({ length: 30 }, (_, i) => `Lucena:1:${i}`), ...Array.from({ length: 59 }, (_, i) => `Lucena:2:${i}`)];
  for (let k = 0; k < 50; k++) assert.ok(+pickRookStart('Lucena', 1, { rng, recent: dealt }).key.split(':')[2] >= 30);
  // when every start is recent, the one dealt longest ago (never dealt first)
  assert.equal(chooseStart(4, [0, 1, 2], rng), 3);
  assert.equal(chooseStart(4, [3, 1, 0, 2, 1, 0, 3], rng), 2);
  const l = pickRookStart('Lucena', 3, { rng });
  assert.equal(l.budget, rookStart(l.fen).entry.promote + 5);
});
