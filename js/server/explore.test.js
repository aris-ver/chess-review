// The sandbox against Python's (scripts/dump_site_parity.py: tests/parity/explore.json): Explorer.move and the
// /api/eval answer on recorded Stockfish searches, replayed by a pool that prints what the engine printed for the
// same position, and the live lines (linesSnapshot, linesRows) along recorded searches, info by info.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { load, same } from '../parity.js';
import { parseInfo } from '../core/analyse.js';
import { setBook } from '../core/book.js';
import { boardFromFen } from '../core/chess.js';
import { fenKey } from '../core/fen.js';
import { Explorer, IllegalMoveError, NoEvalError, afterFromLine, linesRows, linesSnapshot, robustMultipv } from './explore.js';

const DUMP = load('explore.json');

/** A pool that answers each position with the lines recorded for it; anything else fails the test. */
function replayPool(searches, nodes) {
  const asked = [];
  return {
    size: 1, name: 'Stockfish (recorded)', asked,
    async load() {},
    async search(fen, n, multipv) {
      asked.push([fen, n, multipv]);
      assert.equal(n, nodes, `nodes for ${fen}`);
      if (!(fen in searches)) assert.fail(`no recorded search for ${fen}`);
      return searches[fen];
    },
  };
}

test(`explore: legal moves of ${DUMP.legal.length} positions`, () => {
  const ex = new Explorer(replayPool({}, DUMP.nodes), { nodes: DUMP.nodes });
  for (const c of DUMP.legal) same(ex.legal(c.fen), { turn: c.turn, moves: c.moves }, c.fen);
});

test(`explore: ${DUMP.moves.length} moves graded as Python grades them`, async () => {
  for (const c of DUMP.moves) {
    setBook(c.book ?? []);
    const ex = new Explorer(replayPool(c.searches, DUMP.nodes), { nodes: DUMP.nodes });
    const what = `${c.fen} ${c.uci}`;
    if (c.error) {
      await assert.rejects(ex.move(c.fen, c.uci, c.my_colour, c.ply, c.ratings), IllegalMoveError, what);
      continue;
    }
    same(await ex.move(c.fen, c.uci, c.my_colour, c.ply, c.ratings), c.result, what);
    // every recorded search was asked for, once (the explorer caches)
    same(ex.pool.asked.map(a => a[0]).sort(), Object.keys(c.searches).filter(f => c.searches[f].length).sort(), `${what} searches`);
  }
});

test(`explore: ${DUMP.evals.length} /api/eval answers`, async () => {
  setBook([]);
  for (const c of DUMP.evals) {
    const ex = new Explorer(replayPool(c.searches, DUMP.nodes), { nodes: DUMP.nodes });
    same(await ex.position(c.fen), c.answer, c.fen);
  }
});

test(`explore: live lines along ${DUMP.streams.length} searches`, () => {
  for (const c of DUMP.streams) {
    const board = boardFromFen(c.fen);
    const kept = new Map();
    let nodes = 0, i = 0;
    for (const line of c.lines) {
      const head = /^\s*info(?:\s+([\s\S]*))?$/.exec(line);
      if (!head) continue;
      const info = parseInfo(head[1] ?? '', board);
      nodes = Math.max(nodes, info.nodes ?? 0);
      const fresh = !!(info.pv && info.pv.length && 'multipv' in info && 'score' in info);
      if (fresh) kept.set(info.multipv, info);
      const want = c.steps[i++], what = `${c.fen} step ${i}`;
      same({ nodes, fresh }, { nodes: want.nodes, fresh: want.fresh }, what);
      if (kept.size) same(linesSnapshot(board, kept), want.snapshot, `${what} snapshot`);
      if (fresh && kept.has(1)) same(linesRows(kept, nodes), want.rows, `${what} rows`);
    }
    assert.equal(i, c.steps.length, c.fen);
  }
});

test('explore: the eval after a move, off its line', () => {
  for (const c of DUMP.after) same(afterFromLine(c.ranks, c.uci, c.nodes), c.after, c.uci);
});

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('explore: a crashing engine is retried with fewer nodes, then there is no eval', async () => {
  const lines = ['info depth 1 multipv 1 score cp 20 nodes 21 pv e2e4', 'info depth 1 multipv 2 score cp 10 nodes 22 pv d2d4'];
  const calls = [];
  const flaky = fails => ({
    name: 'x', async load() {},
    async search(fen, n) {
      calls.push(n);
      if (calls.length <= fails) throw new Error('engine died');
      return lines;
    },
  });
  const [main] = await robustMultipv(boardFromFen(START), flaky(2), 5000);
  same([calls, main.best_move, main.eval_cp], [[5000, 100_000, 20_000], 'e2e4', 20]);
  calls.length = 0;
  const ex = new Explorer(flaky(3), { nodes: 5000 });
  await assert.rejects(ex.evaluate(boardFromFen(START)), NoEvalError);
  same(calls, [5000, 100_000, 20_000]);
  const out = [];
  for await (const s of ex.analyseStream(boardFromFen(START), (async function* () { yield 'info'; })())) out.push(s);
  same(out, []);      // nothing to stream on a position the engine crashes on
});

test('explore: the live stream throttles, beats once a second and feeds the cache', async () => {
  const fixed = ['info depth 1 multipv 1 score cp 20 nodes 100 pv e2e4', 'info depth 1 multipv 2 score cp 10 nodes 100 pv d2d4'];
  const ex = new Explorer({ name: 'SF', async load() {}, async search() { return fixed; } }, { nodes: 100 });
  const board = boardFromFen(START);
  const script = [   // [clock, line]
    [0.00, 'info depth 5 multipv 1 score cp 30 nodes 500 pv e2e4 e7e5'],
    [0.05, 'info depth 5 multipv 2 score cp 25 nodes 600 pv d2d4 d7d5'],     // too soon after the first
    [0.20, 'info depth 6 currmove g1f3 currmovenumber 3'],                  // no pv: only a heartbeat, not yet due
    [0.30, 'info depth 6 multipv 1 score cp 35 nodes 900 pv e2e4 c7c5 g1f3'],
    [1.40, 'info depth 7 currmove g1f3 currmovenumber 3 nodes 950'],        // a heartbeat, due
    [1.45, 'bestmove e2e4'],
  ];
  let t = 0;
  async function* infos() {
    for (const [at, line] of script) {
      t = at;
      yield line;
    }
  }
  const out = [];
  for await (const s of ex.analyseStream(board, infos(), { now: () => t + 100 })) out.push(s);
  same(out.map(s => [s.engine, s.nodes, s.lines.map(l => `${l.rank}:${l.san}:${l.eval}:${l.depth}`)]), [
    ['SF', 500, ['1:e4:+0.3:5']],
    ['SF', 900, ['1:e4:+0.3:6', '2:d4:+0.2:5']],
    ['SF', 950, ['1:e4:+0.3:6', '2:d4:+0.2:5']],
  ]);
  same(out[1].lines[0].pv, ['e4', 'c5', 'Nf3']);
  // the deepest snapshot replaced the fixed-budget eval, so the next move is graded by it
  const [main, ranks] = ex.lookup(fenKey(START));
  same([main.nodes, main.eval_cp, main.pv, ranks.map(r => r.move)], [900, 35, ['e2e4', 'c7c5', 'g1f3'], ['e2e4', 'd2d4']]);
});

test('explore: the evals cache is read when given', async () => {
  const key = fenKey(START);
  const evals = {
    get: (sql, [k]) => (k === key ? { nodes: 7, eval_cp: 15, mate_in: null, best_move: 'e2e4', pv: ['e2e4', 'e7e5'] } : undefined),
    all: () => [{ fen_key: key, rank: 1, move: 'e2e4', eval_cp: 15, mate_in: null, pv: ['e2e4', 'e7e5'] }],
  };
  const ex = new Explorer({ name: 'SF', async load() {}, async search() { assert.fail('searched'); } }, { evals });
  same((await ex.position(START)).pv_san, ['e4', 'e5']);
});
