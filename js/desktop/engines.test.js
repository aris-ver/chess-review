// The native Stockfish pool against bin/stockfish (or $STOCKFISH); skipped when there is none. Its info lines have to
// read with js/core/analyse.js, and a fixed node count after `ucinewgame` has to give the same answer on any engine.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { load } from '../parity.js';
import { evaluateMultipv } from '../core/analyse.js';
import { boardFromFen } from '../core/chess.js';
import { EnginePool } from './engines.js';
import { stockfishPath } from './paths.js';

const PATH = stockfishPath({ packaged: false });
const skip = existsSync(PATH) ? false : `no engine at ${PATH}`;
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const TACTIC = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';   // Qxf7#
const NODES = 50_000;

const pool = new EnginePool({ size: 2, path: PATH, hash: 16 });
after(() => pool.close());

test('engines: MultiPV 3 lines parse into evals rows', { skip }, async () => {
  const lines = await pool.search(START, NODES);
  assert.ok(lines.every(l => l.startsWith('info ')));
  assert.match(pool.name, /^Stockfish/);
  const [main, ranks] = evaluateMultipv(boardFromFen(START), lines);
  assert.deepEqual(ranks.map(r => r.rank), [1, 2, 3]);
  assert.ok(main.nodes >= NODES && main.nodes < NODES * 1.1, `nodes ${main.nodes}`);
  assert.equal(main.best_move, ranks[0].move);
  assert.ok(Math.abs(main.eval_cp) < 100, `eval ${main.eval_cp}`);

  const [mate] = evaluateMultipv(boardFromFen(TACTIC), await pool.search(TACTIC, NODES));
  assert.equal(mate.best_move, 'h5f7');
  assert.equal(mate.mate_in, 1);
});

// scripts/dump_parity.py recorded these through python-chess (Hash 16, 30k nodes, MultiPV 3). The same Stockfish
// build gives the same rows; another build gives other ones everywhere, and then there is nothing to compare.
test('engines: the recorded MultiPV searches come out as python-chess got them', { skip }, async t => {
  // (only real recordings: the hand-written UCI oddities in SYNTHETIC_LINES print no time on some lines)
  const cases = load('engine.json').filter(c => c.multipv === 3 && c.lines.length
    && c.lines.every(l => !l.startsWith('info depth') || / time \d+ /.test(l)));
  assert.ok(cases.length >= 20);
  const rows = await Promise.all(cases.map(async c => evaluateMultipv(boardFromFen(c.fen), await pool.search(c.fen, 30_000, 3))));
  const same = cases.map((c, i) => isDeepStrictEqual(rows[i], [c.main, c.ranks]));
  if (!same.some(Boolean)) return t.skip(`${pool.name} is not the build the dumps were recorded with`);
  for (const [i, c] of cases.entries()) assert.deepEqual(rows[i], [c.main, c.ranks], c.fen);
});

test('engines: the same search gives the same lines on every engine, also when they queue', { skip }, async () => {
  const runs = await Promise.all(Array.from({ length: 5 }, () => pool.search(TACTIC, NODES, 2)));
  const rows = runs.map(lines => evaluateMultipv(boardFromFen(TACTIC), lines));
  for (const r of rows) assert.deepEqual(r, rows[0]);
  assert.equal(rows[0][1].length, 2);
});

test('engines: close() stops them and the next search starts them again', { skip }, async () => {
  await pool.close();
  assert.equal(pool.engines.length, 0);
  const lines = await pool.search(START, 10_000, 1);
  assert.equal(evaluateMultipv(boardFromFen(START), lines)[1].length, 1);
});

test('engines: a crash fails the search in hand and the engine comes back', { skip }, async () => {
  const one = new EnginePool({ size: 1, path: PATH, hash: 16 });
  try {
    await one.load();
    const engine = one.engines[0];
    const search = one.search(START, 50_000_000);
    setTimeout(() => engine.proc.kill(), 200);
    await assert.rejects(search, /engine crashed/);
    const [main] = evaluateMultipv(boardFromFen(TACTIC), await one.search(TACTIC, NODES));
    assert.equal(main.mate_in, 1);
  } finally {
    await one.close();
  }
});

test('engines: a missing executable fails load() with its path', async () => {
  const none = new EnginePool({ size: 2, path: '/nonexistent/stockfish' });
  await assert.rejects(none.load(), /nonexistent\/stockfish/);
  assert.equal(none.engines.length, 0);
});
