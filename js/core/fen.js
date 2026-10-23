import { boardFromFen } from './chess.js';

/** FEN with halfmove clock and fullmove number stripped.
 *
 * Positions repeat across games at different move numbers; the engine evaluation does not depend on the counters,
 * so the cache must not either. */
export const fenKey = fen => fen.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');

export const boardFromKey = key => boardFromFen(key + ' 0 1');
