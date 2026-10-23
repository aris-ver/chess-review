// The rest of serve.Handler: /account/* (account.handle), POST /api/sync/* (sync.handle), GET /api/fetch_image,
// GET and POST /api/settings, and the updater's GET /api/update, POST /api/update/download and /api/update/apply.
// Round 3b's routes-rest ports them; until then they answer 501.

import { notYet } from './http.js';

/** The job kinds this module adds to the Runner: kind → async (runner, job) => void. */
export const work = {};

const PATHS = [
  ['*', /^\/account\//],
  ['POST', /^\/api\/sync\//],
  ['GET', /^\/api\/fetch_image$/],
  ['*', /^\/api\/settings$/],
  ['*', /^\/api\/update(\/|$)/],
];

/** The answer to one of these routes, or null when the path isn't one. */
export async function handle(router, method, url, body, contentType) {
  for (const [m, re] of PATHS) {
    if ((m === '*' || m === method) && re.test(url.pathname)) return notYet(method, url);
  }
  return null;
}
