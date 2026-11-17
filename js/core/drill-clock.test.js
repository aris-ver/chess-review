// The drills' clock (drill-clock.js): the tiers of every ending, the size of each clock from the levels' budgets and
// the rook starts, and the running value the page and the record route both keep.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLOCK_MOVES, CLOCK_TIERS, MIN_BASE, clockFor, dealLevel, ladderTop, replayClock, tierOf, tiers, untimedTop } from './drill-clock.js';
import { ENDINGS, HOLD_MOVES, LEVELS } from './drills.js';
import { HOLD_ROOK, rookBudget } from './rook-drills.js';
import { ROOK_STARTS } from './rook-starts.js';

const MATES = ['KQRK', 'KRRK', 'KQK', 'KRK', 'KBBK', 'KBNK'];

test('the ladder: untimed levels, then 3 clock tiers (2 for the rook endings)', () => {
  for (const e of ENDINGS) {
    const rook = e === 'Lucena' || e === 'Philidor', top = LEVELS[e].length;
    assert.equal(untimedTop(e), top);
    assert.equal(tiers(e), rook ? 2 : 3);
    assert.equal(ladderTop(e), top + (rook ? 2 : 3));
    for (let l = 1; l <= ladderTop(e); l++) {
      assert.equal(tierOf(e, l), l <= top ? 0 : l - top);
      assert.equal(dealLevel(e, l), Math.min(l, top));
    }
    assert.throws(() => tierOf(e, ladderTop(e) + 1), RangeError);
    assert.throws(() => tierOf(e, 0), RangeError);
    assert.throws(() => tierOf(e, 1.5), RangeError);
    assert.equal(clockFor(e, top, { budget: 10 }), null, 'the top level has no clock');
  }
  assert.deepEqual([untimedTop('KQK'), ladderTop('KQK'), tierOf('KQK', 6)], [5, 8, 1]);
  assert.throws(() => untimedTop('KNNK'), RangeError);
  assert.throws(() => tierOf('toString', 1), RangeError);
});

test('the clock of a mate drill: the top level budget x seconds a move, plus 1 s a move', () => {
  // the table in p6-spec.md: base ranges at each tier from the top level's band and slack
  const want = { KQRK: [6, 8], KRRK: [7, 9], KQK: [10, 11], KRK: [16, 18], KBBK: [20, 22], KBNK: [32, 37] };
  for (const e of MATES) {
    const top = LEVELS[e].at(-1), lo = top.lo + top.slack, hi = top.hi + top.slack;
    assert.deepEqual([lo, hi], want[e], `${e} top budgets`);
    CLOCK_TIERS.table.perMove.forEach((s, i) => {
      for (const budget of [lo, hi]) {
        assert.deepEqual(clockFor(e, untimedTop(e) + i + 1, { budget }),
          { tier: i + 1, base_ms: Math.max(MIN_BASE, budget * s) * 1000, inc_ms: 1000 });
      }
    });
    assert.throws(() => clockFor(e, untimedTop(e) + 1), RangeError, 'a mate drill needs its budget');
  }
  assert.deepEqual(clockFor('KQK', 6, { budget: 11 }), { tier: 1, base_ms: 44000, inc_ms: 1000 });
  assert.deepEqual(clockFor('KQK', 8, { budget: 10 }), { tier: 3, base_ms: 20000, inc_ms: 1000 });
  assert.deepEqual(clockFor('KBNK', 8, { budget: 37 }), { tier: 3, base_ms: 74000, inc_ms: 1000 });
  assert.deepEqual(clockFor('KQRK', 6, { budget: 6 }), { tier: 3, base_ms: 12000, inc_ms: 1000 });
  // the floor: a short budget at the fastest tier is still 10 s
  assert.deepEqual(clockFor('KQRK', 6, { budget: 4 }), { tier: 3, base_ms: MIN_BASE * 1000, inc_ms: 1000 });
});

test('the clock without a budget: a fixed count of moves', () => {
  assert.deepEqual(CLOCK_MOVES, { KPK: 20, 'KPK-hold': HOLD_MOVES, Philidor: HOLD_ROOK });
  assert.deepEqual([4, 3, 2].map((s, i) => clockFor('KPK', 5 + i).base_ms), [80000, 60000, 40000]);
  assert.deepEqual([4, 3, 2].map((s, i) => clockFor('KPK-hold', 5 + i).base_ms), [80000, 60000, 40000]);
  assert.deepEqual([clockFor('Philidor', 5), clockFor('Philidor', 6)],
    [{ tier: 1, base_ms: 180000, inc_ms: 2000 }, { tier: 2, base_ms: 120000, inc_ms: 2000 }]);
  // a budget given anyway changes nothing there
  assert.equal(clockFor('KPK', 5, { budget: 3 }).base_ms, 80000);
});

test('Lucena: the top level start budget (promote + 8) x 6 s and 4 s, plus 2 s a move', () => {
  const budgets = ROOK_STARTS.Lucena[3].map(entry => rookBudget('Lucena', 4, entry));
  const lo = Math.min(...budgets), hi = Math.max(...budgets);
  assert.ok(lo >= 15 && hi <= 30, `Lucena top budgets ${lo}-${hi}`);
  for (const budget of [lo, hi]) {
    assert.deepEqual(clockFor('Lucena', 5, { budget }), { tier: 1, base_ms: budget * 6000, inc_ms: 2000 });
    assert.deepEqual(clockFor('Lucena', 6, { budget }), { tier: 2, base_ms: budget * 4000, inc_ms: 2000 });
  }
  assert.throws(() => clockFor('Lucena', 5), RangeError);
  assert.throws(() => clockFor('Lucena', 7, { budget: 20 }), RangeError);
});

test('replayClock: each turn ends at the last end plus the increment, less its think time', () => {
  const clock = { tier: 1, base_ms: 10000, inc_ms: 1000 };
  assert.deepEqual(replayClock(clock, []), []);
  assert.deepEqual(replayClock(clock, [3000, 4000, 500]), [7000, 4000, 4500]);
  // a flag: the last turn takes exactly what was left
  assert.deepEqual(replayClock(clock, [6000, 5000]), [4000, 0]);
  // the page's own running value, as index.html clockStop keeps it: left -= ms at the end of a turn, += inc for a move
  let left = clock.base_ms;
  const ends = [2500, 1200, 3300].map(ms => {
    left -= ms;
    const end = left;
    left += clock.inc_ms;
    return end;
  });
  assert.deepEqual(replayClock(clock, [2500, 1200, 3300]), ends);
});
