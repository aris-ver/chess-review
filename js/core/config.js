// The grading thresholds of chess_review/config.py, the same numbers: they decide the labels, so a change goes in
// both places until Python is retired (and the parity dumps are regenerated).

export const DEFAULT_NODES = 1_000_000;

export const GRADE_K_LOW = 0.002;
export const GRADE_RATING_LOW = 1000;
export const GRADE_K_HIGH = 0.007;
export const GRADE_RATING_HIGH = 3000;
export const GRADE_DEFAULT_RATING = 1500;
export const BLUNDER = 20.0;
export const MISTAKE = 8.0;
export const INACCURACY = 5.0;
export const EXCELLENT = 1.5;
export const CP_MISTAKE = 300;
export const CP_BLUNDER = 800;
export const MATERIAL_MISTAKE = 300;
export const LOSING_MATERIAL_CP = -400;
export const LOSING_MATERIAL_DROP_CP = 150;   // ...but only if the eval drops this much too: lines that merely cut a trade off at different plies leave it flat
export const MATE_FROM_LOST_CP = -650;
// A move that loses a rook or more against the best move is a blunder whichever piece it leaves (hangsMaterial):
export const HANGS_LOST = 500;       // material behind the best move's line at 4, 6 and 8 plies
export const HANGS_DOWN = 300;       // ...and behind where the mover started, so a capture the best move had isn't "lost"
export const HANGS_DROP_CP = 500;    // the eval drops this much
export const HANGS_UP_TO_CP = 400;   // the mover isn't still this far ahead after it (and wasn't below LOSING_MATERIAL_CP before)
export const ONLY_MOVE_GAP = 15.0;
export const MISS_BEFORE_MIN = 40.0;
export const MISS_AFTER_MIN = 10.0;
export const MULTIPV_N = 3;
export const OPENING_SKIP_PLIES = 8;
export const CRITICAL_MAX = 5;
