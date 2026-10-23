// serve.Handler's puzzle routes: GET /api/puzzles/<what> (_puzzles_get) and the POSTs under /api/puzzles/ (build,
// build/stop, reset, attempt, solved, daily). Round 3b's routes-puzzles ports them; until then they answer 501.

import { notYet } from './http.js';

/** The job kinds this module adds to the Runner (serve.Runner._build, _puzzles): kind → async (runner, job) => void. */
export const work = {};

/** The answer to a puzzle route, or null when the path isn't one. */
export async function handle(router, method, url, body, contentType) {
  if (url.pathname.startsWith('/api/puzzles/')) return notYet(method, url);
  return null;
}
