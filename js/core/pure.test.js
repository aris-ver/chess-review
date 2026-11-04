// The small pure functions against scripts/dump_parity.py's pure.json.
import { test } from 'node:test';

import { load, same } from '../parity.js';
import { moveAccuracy } from './accuracy.js';
import { fen } from './chess.js';
import { base, gradeK, increment, labelFor, moverRating, onlyMove } from './classify.js';
import { band } from './critical.js';
import { clock, line, moveLabel } from './explain.js';
import { boardFromKey, fenKey } from './fen.js';
import { povWinPct, toPov, winPct } from './pov.js';

const P = load('pure.json');

const cases = {
  fen_key: ([f, out]) => same(fenKey(f), out, `fenKey(${f})`),
  board_from_key: ([k, out]) => same(fen(boardFromKey(k)), out, `boardFromKey(${k})`),
  win_pct: ([cp, k, out]) => same(winPct(cp, k), out, `winPct(${cp}, ${k})`),
  to_pov: ([cp, m, s, p, out]) => same(toPov(cp, m, s, p), out, `toPov(${cp}, ${m}, ${s}, ${p})`),
  pov_win_pct: ([cp, m, s, p, k, out]) => same(povWinPct(cp, m, s, p, k), out, `povWinPct(${cp}, ${m}, ${s}, ${p}, ${k})`),
  move_accuracy: ([x, out]) => same(moveAccuracy(x), out, `moveAccuracy(${x})`),
  label_for: ([x, out]) => same(labelFor(x), out, `labelFor(${x})`),
  grade_k: ([r, out]) => same(gradeK(r), out, `gradeK(${r})`),
  increment: ([tc, out]) => same(increment(tc), out, `increment(${tc})`),
  base: ([tc, out]) => same(base(tc), out, `base(${tc})`),
  mover_rating: ([g, m, out]) => same(moverRating(g, m), out, `moverRating(${JSON.stringify(g)}, ${m})`),
  only_move: ([mp, s, out]) => same(onlyMove(mp, s), out, `onlyMove(${JSON.stringify(mp)}, ${s})`),
  band: ([x, out]) => same(band(x), out, `band(${x})`),
  move_label: ([p, s, out]) => same(moveLabel(p, s), out, `moveLabel(${p}, ${s})`),
  line: ([sans, p, out]) => same(line(sans, p), out, `line(${sans}, ${p})`),
  clock: ([s, out]) => same(clock(s), out, `clock(${s})`),
};

for (const [name, check] of Object.entries(cases)) {
  test(`pure: ${name}`, () => {
    if (!P[name]?.length) throw new Error(`no ${name} cases in pure.json`);
    for (const c of P[name]) check(c);
  });
}

test('pure: the dump has no function the test skips', () => {
  same(Object.keys(P).filter(k => !(k in cases)), [], 'untested');
});
