// The engine pool the job runner talks to: Stockfish as WASM workers in the browser (web/engines.js, later
// js/web) or as native processes on the desktop (js/desktop/engines.js). Types only, no logic: both pools match
// this, so the runner takes either.
//
// Every pool runs its engines the way chess_review/analyse.py does: Threads=1, a fixed Hash, `ucinewgame` (hash
// cleared) and MultiPV set before every position, then `go nodes N`. So a search gives the same lines whichever
// engine of the pool gets it, and js/core/analyse.js's evaluateMultipv(board, lines) turns them into the evals rows.

/**
 * @typedef {object} EnginePool
 * @property {number} size  engines in the pool (one per physical core by default)
 * @property {string} name  the engine's `id name` once load() has resolved (a placeholder before)
 * @property {() => Promise<void>} load  start the engines (fetch the WASM, spawn the processes); idempotent. A
 *   search loads the pool itself, so calling this first only decides when the cost is paid.
 * @property {(fen: string, nodes: number, multipv?: number) => Promise<string[]>} search  one search of `fen`
 *   for `nodes` nodes with `multipv` lines (default 3): the `info …` lines the engine printed, in order, without
 *   the `bestmove`. Searches beyond `size` wait for a free engine. Rejects if the engine died during the search
 *   (it is restarted for the next one): retrying with fewer nodes is the caller's call, as in analyse.py.
 * @property {() => Promise<void>} [close]  stop every engine (the desktop's idle shutdown and quit). A later
 *   load() or search() starts them again. Only the native pool has it so far.
 */

export {};
