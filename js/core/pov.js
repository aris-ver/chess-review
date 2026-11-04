// Eval sign convention.
//
// Stored evals (`evals.eval_cp`, `evals.mate_in`) are from the SIDE-TO-MOVE point of view, exactly as the engine
// reports them. `mate_in` is signed: +N means the side to move mates in N, -N means the side to move gets mated in
// N, and 0 means the side to move is already checkmated (terminal position).
//
// Everything downstream that wants "how good is this for white" or "for me" goes through the helpers here. Never
// flip signs inline elsewhere.

export const LICHESS_K = 0.00368208;

/** Lichess win-probability formula, 0-100, for a centipawn eval. A smaller `k` flattens the curve. */
export const winPct = (cp, k = LICHESS_K) => 50 + 50 * (2 / (1 + Math.exp(-k * cp)) - 1);

/** Re-sign a stored (side-to-move POV) eval to `pov` ('white' | 'black'). */
export function toPov(evalCp, mateIn, sideToMove, pov) {
  if (sideToMove === pov) return [evalCp ?? null, mateIn ?? null];
  return [evalCp == null ? null : 0 - evalCp, mateIn == null ? null : 0 - mateIn];
}

export const toWhitePov = (evalCp, mateIn, sideToMove) => toPov(evalCp, mateIn, sideToMove, 'white');

/** Win% for `pov`, folding mate scores to 0/100 so they never enter cp arithmetic. */
export function povWinPct(evalCp, mateIn, sideToMove, pov, k = LICHESS_K) {
  const [cp, mate] = toPov(evalCp, mateIn, sideToMove, pov);
  if (mate !== null) {
    if (mate === 0) return sideToMove === pov ? 0.0 : 100.0;
    return mate > 0 ? 100.0 : 0.0;
  }
  return winPct(cp, k);
}
