// The drills' clock (docs/training-grounds.md "The clock (phase 6)"): timed levels above each ending's top level.
//
// An ending's levels are LEVELS[ending] (drills.js), 1 to untimedTop, and above them its clock tiers, untimedTop + 1
// to ladderTop: KQK's Clock 1 is level 6. A timed level deals the top level's positions (dealLevel), with the top's
// budget and slack; only the clock is new. The clock is a total for the attempt with an increment, as in a game:
// base = the start's clock moves x the tier's seconds a move (never under MIN_BASE), plus `inc` after each of the
// user's moves. Clock moves are the start's move budget for the mate drills and Lucena, CLOCK_MOVES where there is
// no budget.
//
// The page keeps the clock (only it knows when the board took input); the record route checks the clock is the one
// this table gives for the start, and that the turn times add up (server/drills.js parseAttempt, replayClock).

import { HOLD_MOVES, LEVELS } from './drills.js';
import { HOLD_ROOK, isRookEnding } from './rook-drills.js';

// seconds a move per tier, and the increment after each user move; the only place to tune
export const CLOCK_TIERS = {
  table: { perMove: [4, 3, 2], inc: 1 },     // the mate drills, KPK, KPK-hold
  rook: { perMove: [6, 4], inc: 2 },         // Lucena, Philidor
};
// the endings without a budget: a fixed count of moves. KPK: the p90 of the moves to promotion along the table's
// line at level 4, over 200 deals (p50 15, max 26; measured 2026-11-17)
export const CLOCK_MOVES = { KPK: 20, 'KPK-hold': HOLD_MOVES, Philidor: HOLD_ROOK };
export const MIN_BASE = 10;                  // seconds

const levelsOf = ending => {
  if (!Object.hasOwn(LEVELS, ending)) throw new RangeError(`unknown ending ${ending}`);
  return LEVELS[ending];
};
const tierRow = ending => CLOCK_TIERS[isRookEnding(ending) ? 'rook' : 'table'];

/** The ending's top level without a clock (LEVELS' length). */
export const untimedTop = ending => levelsOf(ending).length;
/** How many clock tiers the ending has (3, or 2 for the rook endings). */
export const tiers = ending => (levelsOf(ending), tierRow(ending).perMove.length);
/** The highest level the record may hold: the untimed levels and the tiers. */
export const ladderTop = ending => untimedTop(ending) + tiers(ending);

/** 0 for an untimed level, else its tier (1 = Clock 1); a RangeError outside 1..ladderTop. */
export function tierOf(ending, level) {
  const top = untimedTop(ending), last = ladderTop(ending);
  if (!Number.isInteger(level) || level < 1 || level > last) throw new RangeError(`${ending} has levels 1 to ${last}, not ${level}`);
  return level <= top ? 0 : level - top;
}

/** The level whose positions, band, slack and starts are dealt: the level itself, or the top for a timed one. */
export const dealLevel = (ending, level) => Math.min(level, untimedTop(ending));

/** The clock of an attempt at the level: null when untimed, else {tier, base_ms, inc_ms} (integers). budget: the
 * start's move budget (needed for the mate drills and Lucena; a RangeError without one). */
export function clockFor(ending, level, { budget = null } = {}) {
  const tier = tierOf(ending, level);
  if (!tier) return null;
  const row = tierRow(ending);
  const moves = CLOCK_MOVES[ending] ?? budget;
  if (!Number.isInteger(moves) || moves < 1) throw new RangeError(`${ending} needs the start's budget for its clock`);
  return { tier, base_ms: Math.max(MIN_BASE, moves * row.perMove[tier - 1]) * 1000, inc_ms: row.inc * 1000 };
}

/** The ms on the clock at the end of each turn of moveMs (the think time of each user turn, in order), before that
 * turn's increment: each turn starts from the last one's end plus the increment. The page keeps the same running
 * value as it plays (index.html clockStop): a turn ends at left - ms, and a move made adds inc_ms. */
export function replayClock(clock, moveMs) {
  let left = clock.base_ms;
  return moveMs.map((ms, i) => {
    if (i) left += clock.inc_ms;
    left -= ms;
    return left;
  });
}
