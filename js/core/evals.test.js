// Engine output: recorded Stockfish searches (and hand-written UCI oddities) parsed into evals rows, against what
// python-chess and analyse.evaluate / evaluate_multipv made of the same lines (scripts/dump_parity.py's engine.json).
import { test } from 'node:test';

import { load, same } from '../parity.js';
import { analysisFromLines, evaluate, evaluateMultipv } from './evals.js';
import { boardFromFen } from './chess.js';

const CASES = load('engine.json');

test(`analyse: ${CASES.length} searches`, () => {
  for (const c of CASES) {
    const pos = boardFromFen(c.fen);
    if (c.multipv) same(evaluateMultipv(pos, c.lines), [c.main, c.ranks], `${c.fen} multipv`);
    else same(evaluate(pos, c.lines), c.main, `${c.fen} single`);
  }
});

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const top = lines => analysisFromLines(lines, boardFromFen(START)).map(i => [i.score, i.pv]);

test('analyse: a bound line cut off by the node budget keeps the full line of the depth before', () => {
  const exact = 'info depth 16 multipv 1 score cp 25 nodes 800 pv e2e4 e7e5 g1f3 b8c6';
  // same first move: the long pv stays, the score is the bound line's
  same(top([exact, 'info depth 17 multipv 1 score cp 21 lowerbound nodes 1000 pv e2e4 e7e5']),
    [[{ cp: 21 }, ['e2e4', 'e7e5', 'g1f3', 'b8c6']]]);
  same(top([exact, 'info depth 17 multipv 1 score cp 30 upperbound nodes 1000 pv e2e4']),
    [[{ cp: 30 }, ['e2e4', 'e7e5', 'g1f3', 'b8c6']]]);
  // another first move: the bound line replaces
  same(top([exact, 'info depth 17 multipv 1 score cp 21 lowerbound nodes 1000 pv d2d4 d7d5']), [[{ cp: 21 }, ['d2d4', 'd7d5']]]);
  // an exact line after a bound one wins, short or not
  same(top(['info depth 17 multipv 1 score cp 21 lowerbound nodes 1000 pv e2e4 e7e5', 'info depth 17 multipv 1 score cp 22 nodes 1100 pv e2e4 c7c5']),
    [[{ cp: 22 }, ['e2e4', 'c7c5']]]);
});

test('analyse: a mate in one stays one ply', () => {
  const board = boardFromFen('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  const row = evaluate(board, ['info depth 1 multipv 1 score cp 300 nodes 50 pv f3f7', 'info depth 2 multipv 1 score mate 1 nodes 90 pv f3f7']);
  same([row.mate_in, row.pv.length], [1, 1]);
});
