// Game accuracy, lichess style (lila AccuracyPercent).
//
// Per move: 103.1668 * exp(-0.04354 * win%loss) - 3.1669.
// Per game and side: the average of (a) the harmonic mean of the move accuracies and (b) their mean weighted by
// position volatility (stdev of win% over a sliding window), so blunders and sharp positions weigh more than a plain
// mean. Book moves are excluded. Numbers land close to chess.com's, which is unpublished.

import { pstdev, pyRound, pySum } from './py.js';

export const moveAccuracy = wpLoss => Math.max(0.0, Math.min(100.0, 103.1668 * Math.exp(-0.04354 * wpLoss) - 3.1669));

/** White-POV win% after each ply, derived from the mover-POV numbers on classified move rows. */
function wpWhiteSequence(moves, startWpWhite) {
  const seq = [startWpWhite];
  for (const m of moves) {
    const a = m.wp_after;
    seq.push(a == null ? null : (m.side_to_move === 'white' ? a : 100 - a));
  }
  return seq;
}

/** moves: classified rows for one game, ordered by ply. */
export function gameAccuracy(moves, side, startWpWhite = 50.0) {
  const wps = wpWhiteSequence(moves, startWpWhite);
  const n = wps.length;
  const window = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const half = Math.floor(window / 2);
  const vols = [];
  for (let i = 0; i < n; i++) {
    const w = wps.slice(Math.max(0, i - half), Math.min(n, i + half + 1)).filter(x => x !== null);
    vols.push(w.length > 1 ? Math.max(0.5, Math.min(12.0, pstdev(w))) : 0.5);
  }
  const accs = [], weights = [];
  for (const m of moves) {
    if (m.side_to_move !== side || m.wp_loss == null || m.in_book) continue;
    accs.push(moveAccuracy(m.wp_loss));
    weights.push(vols[m.ply]);
  }
  if (!accs.length) return null;
  const weighted = pySum(accs.map((a, i) => a * weights[i])) / pySum(weights);
  const harmonic = accs.length / pySum(accs.map(a => 1 / Math.max(a, 1e-9)));
  return pyRound((weighted + harmonic) / 2, 1);
}
