// The endgame drills' routes ("Develop your instinct", docs/training-grounds.md), in the shape of routes-puzzles.js:
//
//   GET  /api/drills/next?ending=KQK[&level=N]   the next drill at the level the record puts the ending at (or the
//                                                level asked for): {drill: {ending, level, mode, fen, dtm, budget,
//                                                counter, hold_moves}, status}. 404 when no start position turns up.
//   POST /api/drills/attempt                     {ending, level, fen, dtm, budget, moves_used, result, ms,
//                                                worst_loss, id?} -> {counted, id, before, status}; `before` is the
//                                                level the ending was at, status the standing after it.
//   GET  /api/drills/status[?ending=KQK]         one ending's status, or {endings: [...]} for all six; a status is
//                                                {ending, level, top, star, played, solved, run, recent}.
//
// 400 for a bad ending, level or body ({error}); 503 when the tables can't be loaded (they ship with the app; the web
// worker fetches them on first use). What they read, from the router's env:
//   env.drillTables  a drills.js DrillTables; none given: one that always says the tables aren't installed
//   env.rng          random() in [0, 1) for the deal (Math.random)
// The record lives in Store.progress(), its times come from the runner's clock (runner.now(), epoch seconds).

import { json, jsonBody } from './http.js';
import { ENDINGS } from '../core/drills.js';
import * as D from './drills.js';

const PREFIX = '/api/drills/';

/** The job kinds this module adds to the Runner: none. */
export const work = {};

const missing = new WeakMap();     // Store → the default DrillTables

function tablesOf(env) {
  if (env.drillTables) return env.drillTables;
  if (!missing.has(env.store)) {
    missing.set(env.store, new D.DrillTables(async () => { throw new Error('the endgame tables are not installed'); }));
  }
  return missing.get(env.store);
}

const bad = message => json({ error: message }, 400);

/** The answer to a drill route, or null when the path isn't one. */
export async function handle(router, method, url, body) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  const what = url.pathname.slice(PREFIX.length);
  if (method === 'GET' && what === 'next') return next(router, url.searchParams);
  if (method === 'GET' && what === 'status') return status(router, url.searchParams);
  if (method === 'POST' && what === 'attempt') return attempt(router, body);
  return json({ error: 'not found' }, 404);
}

async function status({ env }, q) {
  const db = await env.store.progress();
  const ending = q.get('ending');
  if (ending === null) return json({ endings: D.statuses(db) });
  if (!D.isEnding(ending)) return bad(`ending: one of ${ENDINGS.join(', ')}`);
  return json(D.status(db, ending));
}


async function next(router, q) {
  const { env } = router, ending = q.get('ending');
  if (!D.isEnding(ending)) return bad(`ending: one of ${ENDINGS.join(', ')}`);
  let level = null;
  if (q.has('level')) {
    const s = q.get('level');
    level = /^\d{1,3}$/.test(s) ? Number(s) : NaN;
    if (!(level >= 1 && level <= D.topLevel(ending))) return bad(`${ending} has levels 1 to ${D.topLevel(ending)}, not ${s}`);
  }
  let tables;
  try {
    tables = await tablesOf(env).get(ending);
  } catch (e) {
    router.log?.error?.(`drill tables for ${ending}: ${e?.stack ?? e}`);
    return json({ error: `the ${ending} tables are not available: ${e?.message ?? e}` }, 503);
  }
  const db = await env.store.progress();
  let out;
  try {
    out = D.nextDrill(db, tables, ending, { level, rng: env.rng ?? Math.random });
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;      // a table the ending needs that the loader didn't give
    router.log?.error?.(`drill ${ending}: ${e.message}`);
    return json({ error: `the ${ending} tables are not usable: ${e.message}` }, 503);
  }
  if (!out.drill) return json({ error: `no start position found for ${ending} level ${out.level}`, status: out.status }, 404);
  return json({ drill: out.drill, status: out.status });
}

async function attempt(router, raw) {
  const { env, runner } = router;
  let b;
  try {
    b = jsonBody(raw);
  } catch {
    return bad('a JSON body expected');
  }
  let a;
  try {
    a = D.parseAttempt(b);
  } catch (e) {
    return bad(e.message);
  }
  const out = D.record(await env.store.progress(), a, runner.now());
  return json(out);
}
