// The endgame drills' routes ("Develop your instinct", docs/training-grounds.md), in the shape of routes-puzzles.js:
//
//   GET  /api/drills/next?ending=KQK[&level=N]   the next drill at the level the record puts the ending at (or the
//                                                level asked for, up to the last clock tier): {drill: {ending, level,
//                                                mode, fen, dtm, budget, counter, hold_moves, post_promo, clock},
//                                                status}. clock is null, or at a timed level {tier, base_ms, inc_ms}
//                                                (core/drill-clock.js), the page's to run. 404 when no start position
//                                                turns up.
//   POST /api/drills/attempt                     {ending, level, fen, dtm, budget, moves_used, result, ms,
//                                                worst_loss, id?, and at a timed level clock, move_ms, paused} ->
//                                                {counted, id, before, status}; `before` is the level the ending
//                                                was at, status the standing after it. A timed attempt's clock must
//                                                be the deal's and its turn times must add up (drills.js parseAttempt).
//   GET  /api/drills/status[?ending=KQK]         one ending's status, or {endings: [...]} for all ten; a status is
//                                                {ending, level, top, tiers, tier, star, clock_star, played, solved,
//                                                run, recent, unavailable}: top the top level without a clock, tiers
//                                                the clock tiers above it, tier the level's (0: untimed); unavailable
//                                                is null, or for Lucena and Philidor why they can't be played here
//                                                ('needs_computer' on phones, 'no_engine').
//   POST /api/drills/move                        {ending, level, fens}: every position from the dealt one to the
//                                                user's last move -> the move judged, the defender's reply and the
//                                                result once the drill is over, with its review (drills.js
//                                                playMove). Stateless: the page sends the whole drill each time.
//                                                Lucena and Philidor: Stockfish's reply (playRookMove), kind, loss,
//                                                dtm_after and dtm null, plus promoted and engine_ms.
//   POST /api/drills/line                        {ending, fen} -> {line: [uci], moves: [{uci, san, fen}]}, the
//                                                table's line from there ("Best from here" in a review).
//   POST /api/drills/hint                        {ending, level, fens}: a finished (or given up) Lucena or Philidor
//                                                attempt, fens from the start to its last position (after a reply
//                                                or not) -> {moves: [{ply, score_before, score_after, pv}], likely,
//                                                pv, hint, approximate: true, ms}: each position where the user was
//                                                to move searched at REVIEW_NODES on the analysis pool (router.pool,
//                                                in parallel), white's view; likely the move the score fell most
//                                                after (drills.js rookHint). 400 for the other endings.
//
// 400 for a bad ending, level or body ({error}); 503 when the tables can't be loaded (they ship with the app; the web
// worker fetches them on first use), and for the rook drills when there is no engine to play them or it failed
// ({error, reason: 'needs_computer' | 'no_engine' | 'engine_failed'}). What they read, from the router's env:
//   env.drillTables  a drills.js DrillTables; none given: one that always says the tables aren't installed
//   env.drillEngine  the rook drills' engine pool (js/core/engine.js EnginePool: size 1, full net, Hash 16), apart
//                    from the analysis pool; none: the rook drills are unavailable ('no_engine')
//   env.drillEngineUnavailable  a reason the rook drills can't be played here even so ('needs_computer': phones)
//   env.rng          random() in [0, 1) for the deal (Math.random)
// The page must send an id with each attempt (any unique string of up to 64 letters, digits, - and _): a retry of the
// same attempt is then recorded once. Without one the server makes an id, and a retry would count twice.
// The record lives in Store.progress(), its times come from the runner's clock (runner.now(), epoch seconds).

import { BadRequest, json, jsonBody } from './http.js';
import { ENDINGS } from '../core/drills.js';
import { isRookEnding } from '../core/rook-drills.js';
import { REVIEW_NODES } from '../core/rook-hint.js';
import { EngineFailed, opponent, scorer } from './drill-opponent.js';
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

const UNAVAILABLE = {
  needs_computer: 'The rook drills need a computer for now: Stockfish plays them with its full engine.',
  no_engine: 'The rook drills need Stockfish, and it is not installed here.',
  engine_failed: 'Stockfish failed to answer.',
};

/** Why the rook drills can't be played here, or null when they can. */
export function rookUnavailable(env) {
  if (env.drillEngineUnavailable) return env.drillEngineUnavailable;
  return env.drillEngine ? null : 'no_engine';
}
const unavailable = (reason, detail = null) => json({ error: UNAVAILABLE[reason] ?? String(reason) + (detail ? `: ${detail}` : ''),
  reason }, 503);

const opponents = new WeakMap();     // pool → its opponent()
function opponentOf(router) {
  const pool = router.env.drillEngine;
  if (!opponents.has(pool)) opponents.set(pool, opponent(pool, { log: router.log }));
  return opponents.get(pool);
}

/** The answer to a drill route, or null when the path isn't one. */
export async function handle(router, method, url, body) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  const what = url.pathname.slice(PREFIX.length);
  if (method === 'GET' && what === 'next') return next(router, url.searchParams);
  if (method === 'GET' && what === 'status') return status(router, url.searchParams);
  if (method === 'POST' && what === 'attempt') return attempt(router, body);
  if (method === 'POST' && what === 'move') return move(router, body);
  if (method === 'POST' && what === 'line') return line(router, body);
  if (method === 'POST' && what === 'hint') return hint(router, body);
  return json({ error: 'not found' }, 404);
}

// the ending's tables, or the 503 answer that says why there are none
async function tablesOrError(router, ending) {
  try {
    return { tables: await tablesOf(router.env).get(ending) };
  } catch (e) {
    router.log?.error?.(`drill tables for ${ending}: ${e?.stack ?? e}`);
    return { error: json({ error: `the ${ending} tables are not available: ${e?.message ?? e}` }, 503) };
  }
}

// the body as an object with a known ending, or the 400 answer
function drillBody(raw) {
  let b;
  try {
    b = jsonBody(raw);
  } catch {
    return { error: bad('a JSON body expected') };
  }
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return { error: bad('a request object expected') };
  if (!D.isEnding(b.ending)) return { error: bad(`ending: one of ${ENDINGS.join(', ')}`) };
  return { b };
}

async function move(router, raw) {
  const { b, error } = drillBody(raw);
  if (error) return error;
  const rook = isRookEnding(b.ending), why = rook ? rookUnavailable(router.env) : null;
  if (why) return unavailable(why);
  const t = await tablesOrError(router, b.ending);
  if (t.error) return t.error;
  let req;
  try {
    req = D.parseMove(t.tables, b);
  } catch (e) {
    if (e instanceof BadRequest) return bad(e.message);
    throw e;
  }
  if (!rook) return json(D.playMove(t.tables, req, router.env.rng ?? Math.random));
  try {
    return json(await D.playRookMove(t.tables, req, opponentOf(router)));
  } catch (e) {
    if (!(e instanceof EngineFailed)) throw e;
    router.log?.error?.(`drill engine: ${e.message}`);
    return json({ error: e.message, reason: 'engine_failed' }, 503);
  }
}

// the review hint of a rook drill: every position of the attempt searched deeper on the analysis pool
async function hint(router, raw) {
  const { b, error } = drillBody(raw);
  if (error) return error;
  if (!isRookEnding(b.ending)) return bad(`${b.ending} has no hint: its review comes from the tables`);
  const why = rookUnavailable(router.env);
  if (why) return unavailable(why);
  const t = await tablesOrError(router, b.ending);
  if (t.error) return t.error;
  let req;
  try {
    req = D.parseMove(t.tables, b, { anyEnd: true });
  } catch (e) {
    if (e instanceof BadRequest) return bad(e.message);
    throw e;
  }
  const t0 = performance.now();
  try {
    const out = await D.rookHint(t.tables, req, scorer(router.pool, { nodes: REVIEW_NODES, log: router.log }));
    return json({ ...out, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    if (!(e instanceof EngineFailed)) throw e;
    router.log?.error?.(`hint engine: ${e.message}`);
    return json({ error: e.message, reason: 'engine_failed' }, 503);
  }
}

async function line(router, raw) {
  const { b, error } = drillBody(raw);
  if (error) return error;
  let req;
  try {
    req = D.parseLine(b);
  } catch (e) {
    if (e instanceof BadRequest) return bad(e.message);
    throw e;
  }
  const t = await tablesOrError(router, b.ending);
  if (t.error) return t.error;
  return json(D.lineFrom(t.tables, req));
}

// a status with whether the ending can be played here
const withAvailability = (env, st) => ({ ...st, unavailable: isRookEnding(st.ending) ? rookUnavailable(env) : null });

async function status({ env }, q) {
  const db = await env.store.progress();
  const ending = q.get('ending');
  if (ending === null) return json({ endings: D.statuses(db).map(st => withAvailability(env, st)) });
  if (!D.isEnding(ending)) return bad(`ending: one of ${ENDINGS.join(', ')}`);
  return json(withAvailability(env, D.status(db, ending)));
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
  const why = isRookEnding(ending) ? rookUnavailable(env) : null;
  if (why) return unavailable(why);
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
