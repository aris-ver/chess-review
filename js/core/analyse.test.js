// Engine output: recorded Stockfish searches (and hand-written UCI oddities) parsed into evals rows, against what
// python-chess and analyse.evaluate / evaluate_multipv made of the same lines (scripts/dump_parity.py's engine.json).
import { test } from 'node:test';

import { load, same } from '../parity.js';
import { evaluate, evaluateMultipv } from './analyse.js';
import { boardFromFen } from './chess.js';

const CASES = load('engine.json');

test(`analyse: ${CASES.length} searches`, () => {
  for (const c of CASES) {
    const pos = boardFromFen(c.fen);
    if (c.multipv) same(evaluateMultipv(pos, c.lines), [c.main, c.ranks], `${c.fen} multipv`);
    else same(evaluate(pos, c.lines), c.main, `${c.fen} single`);
  }
});
