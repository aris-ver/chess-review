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
export const MATE_FROM_LOST_CP = -650;
export const ONLY_MOVE_GAP = 15.0;
export const MISS_BEFORE_MIN = 40.0;
export const MISS_AFTER_MIN = 10.0;
export const MULTIPV_N = 3;
export const OPENING_SKIP_PLIES = 8;
export const CRITICAL_MAX = 5;
