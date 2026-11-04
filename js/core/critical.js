// Stage 4b: pick the 3-5 moves per game that decided it (selected live by the review).
//
// Candidates are unforced moves (either side) losing >= MISTAKE win%, ignoring the first OPENING_SKIP_PLIES unless
// the move is already a blunder. Ranked by whether the move crossed a decision boundary (winning / equal / losing
// bands of the mover's win%), then by win% loss. A game may have zero.

import { BLUNDER, CRITICAL_MAX, MISTAKE, OPENING_SKIP_PLIES } from './config.js';

export const WINNING = 65.0;
export const LOSING = 35.0;

export function band(wp) {
  if (wp >= WINNING) return 'winning';
  if (wp <= LOSING) return 'losing';
  return 'equal';
}

/** moves: classified rows for one game, any order. Returns ranked critical rows. */
export function select(moves) {
  const cands = [];
  for (const m of moves) {
    if (m.wp_loss == null || m.is_forced || m.in_book) continue;
    if (m.wp_loss < MISTAKE) continue;
    if (m.ply < OPENING_SKIP_PLIES && m.wp_loss <= BLUNDER) continue;
    const b0 = band(m.wp_before), b1 = band(m.wp_after);
    cands.push({ game_id: m.game_id, ply: m.ply, band_before: b0, band_after: b1, crosses_boundary: b0 !== b1, loss: m.wp_loss });
  }
  cands.sort((a, b) => (Number(!a.crosses_boundary) - Number(!b.crosses_boundary)) || (b.loss - a.loss));
  return cands.slice(0, CRITICAL_MAX).map(({ loss, ...c }, i) => ({ ...c, rank: i + 1 }));
}
