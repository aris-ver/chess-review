// The Openings tab's routes (docs/openings.md), the explorer's:
//
//   GET /api/openings/position?profile=<id>&moves=e2e4,e7e5[&colour=all|white|black]
//       the position after those moves from the start, with the profile's games from it (openings.js position()):
//       {path, fen, key, turn, in_book, left_at, name, eval, games, score, next}
//   GET /api/openings/games?profile=<id>&moves=...[&move=g1f3][&colour=...]
//       the games that reached it (and played `move` there), newest first: {games: [{id, game_id, played_at,
//       my_colour, result, opponent, opponent_rating, time_class, ply}]}, id being the game's address in the page
//       (site.js slug)
//
// 400 for a bad profile id, move or colour ({error}); 404 for a profile that isn't there; 503 when there is no
// opening tree ({error, reason: 'no_tree'}). The tree comes from env.openingTree (openings.js ensureTree).

import { BadRequest, ID, json } from './http.js';
import { TreeMissing, ensureTree, games, parseMoves, position } from './openings.js';
import { slug } from './site.js';

const PREFIX = '/api/openings/';
const PROFILE = new RegExp(`^${ID}$`);

/** The job kinds this module adds to the Runner: none. */
export const work = {};

export async function handle(router, method, url) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  const what = url.pathname.slice(PREFIX.length);
  if (method !== 'GET' || (what !== 'position' && what !== 'games')) return json({ error: 'not found' }, 404);
  const q = url.searchParams, pid = q.get('profile') || '';
  if (!PROFILE.test(pid)) return json({ error: 'profile: a profile id' }, 400);
  if (!(await router.env.profiles.load(pid))) return json({ error: `no profile ${pid}` }, 404);
  try {
    await ensureTree(router.env);
  } catch (e) {
    if (!(e instanceof TreeMissing)) router.log?.error?.(`opening tree: ${e?.stack ?? e}`);
    return json({ error: `the opening tree isn't available: ${e?.message ?? e}`, reason: 'no_tree' }, 503);
  }
  const db = await router.env.store.profile(pid);
  const moves = parseMoves(q.get('moves')), colour = q.get('colour') || 'all';
  try {
    if (what === 'position') return json(position(db, moves, colour));
    const list = games(db, moves, colour, q.get('move') || null);
    return json({ games: list.map(g => ({ id: slug(g.game_id), ...g })) });
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    throw e;
  }
}
