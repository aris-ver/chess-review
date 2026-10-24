// serve.Handler's puzzle routes: GET /api/puzzles/<what> (_puzzles_get) and the POSTs under /api/puzzles/ (build,
// build/stop, reset, attempt, solved, daily), with serve.py's status codes, JSON and messages; and serve.Runner's
// puzzle jobs (build: _build, _refresh_puzzles; puzzles: _puzzles, started by extendPuzzles), which plug into the
// Runner through `work`. The bookkeeping of builds (requestBuild, cancelBuild, buildsStatus, _buildEnded) is
// jobs.js's.
//
// What the routes read, from the router's env (games.js's env):
//   env.pack         the Lichess pack (puzzles.js Pack); none given: an empty one, as Python without its parquet
//   env.packs        packs.json (packs.js Packs); none given: no packs
//   env.ownPuzzles   the own-game puzzles (own-puzzles.js Pool); none given: one per Store, shared with the jobs
//   env.rng          random() in [0, 1) for the deal (Math.random)
// The library's record lives in Store.progress(), a profile's in Store.profile(p). Times come from the runner's
// clock (runner.now(), epoch seconds), and today is the local date at that time.

import { build as buildAggregates } from './aggregates.js';
import { build as classify } from './classify.js';
import { json, jsonBody, pyInt, truthy } from './http.js';
import { Runner } from './jobs.js';
import * as O from './own-puzzles.js';
import * as K from './packs.js';
import * as P from './puzzles.js';

export const PUZZLE_REFRESH_S = 20;   // a build reclassifies the profile (its puzzles) at most this often, after a game

const PREFIX = '/api/puzzles/';

// ---------- what the routes and jobs share ----------

const shared = new WeakMap();     // Store → the defaults below, so the routes and the jobs see one Pool

/** The pack, the packs and the own-puzzle pool for this env. */
export function library(env) {
  let lib = shared.get(env.store);
  if (!lib) {
    lib = {
      pack: new P.Pack(() => []),
      packs: new K.Packs(() => { throw new Error('no packs.json'); }),
      pool: new O.Pool(env.store),
    };
    shared.set(env.store, lib);
  }
  return { pack: env.pack ?? lib.pack, packs: env.packs ?? lib.packs, pool: env.ownPuzzles ?? lib.pool };
}

/** sync._invalidate: the own-puzzle pool forgets every profile, which have just changed hands (a sync switch). */
export function forget(env) {
  library(env).pool.cache.clear();
}

const linesTried = new WeakMap();   // Runner → Map(profile id → the classified moves' stamp the puzzles job last ran for)

function tried(runner) {
  if (!linesTried.has(runner)) linesTried.set(runner, new Map());
  return linesTried.get(runner);
}

/** str() of a JSON value, for the ids the routes look up. */
function pyStr(v) {
  if (v === undefined) return '';
  if (v === null) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v);
}

/** int(ms) when it is a number (bools included, as isinstance(ms, (int, float)) has it), else null. */
const msOf = ms => (typeof ms === 'number' || typeof ms === 'boolean' ? pyInt(ms) : null);

// ---------- the jobs ----------

/** serve.Runner.extend_puzzles: start the puzzles job for `profile` if some of its puzzles wait for engine lines.
 * Once per change of its classified moves, so a job that can't finish isn't retried at each request. */
export async function extendPuzzles(runner, profile) {
  if (runner.busy() || runner.builds.length) return;
  const { pool } = library(runner.env);
  const stamp = pool.stamp(await runner.env.store.profile(profile));
  if (tried(runner).get(profile.id) === stamp || !(await pool.waiting(profile))) return;
  runner.start(runner.newJob('puzzles', profile));
}

/** serve.Runner._puzzles: settle the lines of the profile's own-game puzzles, MultiPV searches of the positions they
 * wait on, a ply at a time, into the shared cache (own-puzzles.js extend). */
async function puzzlesJob(runner, job) {
  const p = job.profile, { pool } = library(runner.env);
  const db = await runner.env.store.profile(p);
  tried(runner).set(p.id, pool.stamp(db));
  try {
    const search = async keys => {
      await runner.analyser.run(keys, db, { batch: runner.analyser.workers * 2, shouldStop: () => job.stopRequested });
      pool.invalidate(p.id);
    };
    const stats = await O.extend(db, search, () => job.stopRequested, (done, total) => { job.done = done; job.total = total; });
    runner.env.log?.info?.(`puzzle lines ${p.id}: ${JSON.stringify(stats)}`);
    if (job.stopRequested) tried(runner).delete(p.id);     // given way to another job: try again later
    else job.status = 'finishing';
  } finally {
    pool.invalidate(p.id);
  }
}

/** serve.Runner._refresh_puzzles: reclassify, so the puzzles of the games analysed so far can be played. */
async function refreshPuzzles(runner, job, db) {
  const p = job.profile, { pool } = library(runner.env);
  classify(db);
  pool.invalidate(p.id);
  job.puzzles = (await pool.puzzles(p)).length;
  runner.buildState.set(p.id, job.toDict());
}

/** serve.Runner._build: make a profile's puzzles. Analyse the games that aren't yet, newest first, reclassifying
 * after each game (at most every PUZZLE_REFRESH_S) so its puzzles can be played while the rest are analysed; then
 * settle their lines. done/total count the profile's games, all of them. Stopped to make way for another job, it
 * skips the bookkeeping: it comes back and does it then. */
async function buildJob(runner, job) {
  const p = job.profile, { env } = runner, { pool } = library(env);
  job.phase = 'analysing';
  job.puzzles = runner.buildState.get(p.id)?.puzzles ?? null;
  if (job.puzzles === null) job.puzzles = (await pool.puzzles(p)).length;   // the ones its analysed games already have
  const db = await env.store.profile(p);
  const [n, todo] = Runner.todo(db);
  job.total = n;
  job.done = n - todo.length;
  env.log?.info?.(`build ${p.id}: ${todo.length} of ${n} games to analyse`);
  let last = 0;
  for (const [gid, keys] of todo) {
    if (job.stopRequested) break;
    await runner.analyseGame(job, db, gid, keys);
    if (job.stopRequested) break;     // cut short: not done (what it searched is cached)
    job.done += 1;
    if (runner.now() - last >= PUZZLE_REFRESH_S) {
      await refreshPuzzles(runner, job, db);
      last = runner.now();
    }
  }
  job.slug = null;
  if (job.preempted) return;
  await refreshPuzzles(runner, job, db);
  await buildAggregates(db, env.files, p);
  if (job.stopRequested) return;
  job.phase = 'lines';
  job.done = 0;
  job.total = 0;
  await puzzlesJob(runner, job);
}

/** The job kinds this module adds to the Runner: kind → async (runner, job) => void. */
export const work = { build: buildJob, puzzles: puzzlesJob };

// ---------- the routes ----------

/** The answer to a puzzle route, or null when the path isn't one (other POSTs fall through to the router's 404). */
export async function handle(router, method, url, body, contentType) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (method === 'GET') return get(router, url.pathname.slice(PREFIX.length), url.searchParams);
  if (method === 'POST') return post(router, url.pathname, body);
  return null;
}

function context(router) {
  const { env, runner } = router;
  const now = runner.now();
  return { env, runner, now, day: K.today(new Date(now * 1000)), rng: env.rng ?? Math.random, ...library(env) };
}

/** serve.Handler._puzzles_get. */
async function get(router, what, q) {
  const { env, runner, now, day, rng, pack, packs, pool } = context(router);
  const progress = await env.store.progress();
  const libStats = () => P.stats(P.attempts(progress));
  if (what === 'themes') return json({ themes: pack.themes(), total: pack.rows().length, stats: libStats() });
  if (what === 'sources') {
    const out = [{ id: 'lichess', name: 'Lichess puzzles', count: pack.rows().length }];
    for (const p of await env.profiles.list()) {
      const s = await env.profiles.summary(p);
      if (!s.games) continue;
      const st = await O.summary(pool, p, now);
      out.push({ id: `mine:${p.id}`, profile: p.id, name: p.username, source: p.source, count: st.total, stats: st,
        games: s.games, analysed: s.analysed });
      if (st.total) await extendPuzzles(runner, p);
    }
    return json({ sources: out });
  }
  if (what === 'next') {
    const source = q.get('source') || 'lichess', skip = q.get('skip') || null;
    if (source.startsWith('mine:')) {
      const prof = await env.profiles.load(source.slice(5));
      if (prof === null) return json({ error: 'unknown profile' }, 404);
      const [p, st] = await O.nextPuzzle(pool, prof, skip, now, rng);
      await extendPuzzles(runner, prof);
      if (p === null) {
        const msg = !st.total ? 'no puzzles from these games yet: analyse some games first' : 'all caught up with your games';
        return json({ error: msg, stats: st }, 404);
      }
      return json({ puzzle: p, stats: st });
    }
    const themes = new Set((q.get('themes') ?? '').split(',').filter(Boolean));
    const [p, st] = P.nextPuzzle(progress, pack, themes.size ? themes : null, skip, rng);
    if (p === null) return json({ error: 'no puzzles left with those themes', stats: st }, 404);
    return json({ puzzle: p, stats: st });
  }
  if (what === 'packs') {
    const st = libStats();
    return json({ packs: K.shelf(packs, st, progress, i => pack.get(i)), stats: st, daily: K.daily(packs, progress, day) });
  }
  if (what === 'pack') {
    const p = packs.get(q.get('id') ?? '');
    if (p === null) return json({ error: 'unknown pack' }, 404);
    const st = libStats();
    const ratings = new Map(p.stages.flatMap(s => s.ids.map(i => [i, pack.get(i)?.rating ?? null])));
    const first = K.firstTries(progress), later = K.solvedLater(progress);
    return json({ pack: K.ladder(p, first, later, st, ratings, K.credit(p, first, later, i => pack.get(i))), stats: st });
  }
  if (what === 'daily') return json(K.daily(packs, progress, day));
  if (what === 'get') {
    const pid = q.get('id') ?? '';
    if (O.isOwnId(pid)) {
      const p = await pool.find(pid, await env.profiles.list());
      if (p === null) return json({ error: 'unknown puzzle' }, 404);
      return json({ puzzle: p, stats: await O.summary(pool, await env.profiles.load(p.profile), now) });
    }
    const row = pack.get(pid);
    if (row === null) return json({ error: 'unknown puzzle' }, 404);
    return json({ puzzle: P.line(row), stats: libStats() });
  }
  return json({ error: 'not found' }, 404);
}

/** The puzzle POSTs of serve.Handler.do_POST; null for any other path. */
async function post(router, path, raw) {
  const { env, runner: r, now, day, pack, packs, pool } = context(router);
  if (path === '/api/puzzles/build' || path === '/api/puzzles/build/stop') {
    const p = await env.profiles.load(pyStr(jsonBody(raw).profile));
    if (p === null) return json({ error: 'unknown profile' }, 404);
    if (path.endsWith('/stop')) await r.cancelBuild(p.id);
    else await r.requestBuild(p);
    return json(await r.status());
  }
  if (path === '/api/puzzles/reset') {
    const b = jsonBody(raw);
    if (b.what === 'rating') {
      const progress = await env.store.progress();
      const archived = P.reset(progress, now);
      return json({ archived, stats: P.stats(P.attempts(progress)) });
    }
    if (b.what === 'schedule') {
      const p = await env.profiles.load(pyStr(b.profile));
      if (p === null) return json({ error: 'unknown profile' }, 404);
      const archived = await O.reset(pool, p, now);
      return json({ archived, stats: await O.summary(pool, p, now) });
    }
    return json({ error: 'what: rating or schedule' }, 400);
  }
  if (path === '/api/puzzles/attempt') {
    const b = jsonBody(raw);
    const pid = pyStr(b.id), ms = msOf(b.ms);
    if (O.isOwnId(pid)) {
      const p = await pool.find(pid, await env.profiles.list());
      if (p === null) return json({ error: 'unknown puzzle' }, 404);
      return json(await O.record(pool, await env.profiles.load(p.profile), pid, truthy(b.solved), ms, truthy(b.hinted), now));
    }
    const row = pack.get(pid);
    if (row === null) return json({ error: 'unknown puzzle' }, 404);
    const progress = await env.store.progress();
    const st = P.record(progress, row.id, row.rating, truthy(b.solved), ms, truthy(b.hinted), now);
    return json({ stats: st ?? P.stats(P.attempts(progress)), counted: st !== null });
  }
  if (path === '/api/puzzles/solved') {
    const b = jsonBody(raw), pid = pyStr(b.id);
    if (pack.get(pid) === null) return json({ error: 'unknown puzzle' }, 404);
    K.markSolved(await env.store.progress(), pid, now, truthy(b.clean));
    return json({ ok: true });
  }
  if (path === '/api/puzzles/daily') {
    const b = jsonBody(raw);
    return json(K.recordDaily(packs, await env.store.progress(), day, pyStr(b.id), truthy(b.solved), truthy(b.clean),
      msOf(b.ms), Array.isArray(b.marks) ? b.marks : []));
  }
  return null;
}
