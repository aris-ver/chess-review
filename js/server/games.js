// A profile's games from the site to rows in its database: what serve.py's jobs and __main__.py's stages do from
// "fetch" to "rows in the database", as plain async functions for the routes and the job runner to call.
//
//   ingest.fetch     -> fetchProfile    the newest page (or the one before the oldest, or what's new) into raw/
//   normalise.build  -> normaliseProfile raw/ and pgn/ into the games and positions tables
//   rebuild_profile  -> rebuild         normalise -> site -> classify -> aggregates (no engine work)
//   Runner._ingest / _older / _refresh  -> ingestProfile, refreshProfile (fetch, then rebuild)
//   ingest.count_new -> countNew;  ingest.store_pgn + the pasted game's ids -> addPgn
//
// Everything goes through an env the caller builds once:
//
//   env.store       the db.js Store
//   env.files       the profiles-files.js adapter, rooted at the data directory
//   env.profiles    profiles.js's Profiles over the same files and store
//   env.fetch       the WHATWG fetch;  env.sleep, env.userAgent, env.log as ingest.js's ctx has them (optional)
//   env.site        (db, profile) => Promise: the site build (site.build), until the site module is in; optional
//
// Not here: the job bookkeeping (done/total, the "new games" badge, deleting a profile whose first fetch found no
// such player); those stay with the runner.

import { normalise, parsePgnText } from '../core/normalise.js';
import { build as buildAggregates } from './aggregates.js';
import { build as classify } from './classify.js';
import { writeGames } from './db.js';
import { countNew as ingestCountNew, fetchGames, storePgn } from './ingest.js';

/** ingest.js's ctx.files over a profiles-files adapter: list() gives the names of the files in a directory. */
export function ingestFiles(files) {
  return {
    list: async dir => (await files.list(dir)).filter(e => !e.dir).map(e => e.name),
    exists: path => files.exists(path),
    async read(path) {
      const text = await files.readText(path);
      if (text === null) throw new Error(`no such file: ${path}`);
      return text;
    },
    write: (path, text) => files.writeText(path, text),
    append: (path, text) => files.appendText(path, text),
    mkdir: dir => files.mkdir(dir),
  };
}

/** ingest.js's ctx for env: the files, and older/played into the profile's meta.json. */
export function ingestCtx(env, { onWait = null } = {}) {
  return {
    fetch: env.fetch,
    files: ingestFiles(env.files),
    sleep: env.sleep,
    setOlder: (pid, older) => env.profiles.setOlder(pid, older),
    setPlayed: (pid, played) => env.profiles.setPlayed(pid, played),
    onWait,
    userAgent: env.userAgent,
    log: env.log,
  };
}

async function texts(files, dir, test) {
  const out = [];
  for (const e of await files.list(dir)) {
    if (!e.dir && test(e.name)) out.push({ name: e.name, text: await files.readText(`${dir}/${e.name}`) });
  }
  return out;
}

/** What normalise reads of a profile: {chesscom: raw/*.json, lichess: raw/*.ndjson, pgn: pgn/*.pgn}, each
 * [{name, text}]. */
export async function rawFiles(files, profile) {
  return {
    chesscom: await texts(files, profile.rawDir, n => n.endsWith('.json')),
    lichess: await texts(files, profile.rawDir, n => n.endsWith('.ndjson')),
    pgn: await texts(files, profile.pgnDir, n => n.endsWith('.pgn')),
  };
}

/** normalise.build: the profile's games and positions rebuilt from its raw/ and pgn/. Returns normalise's stats. */
export async function normaliseProfile(env, profile, { onSkip = null } = {}) {
  const { games, positions, stats } = normalise(await rawFiles(env.files, profile), profile.username, onSkip);
  await env.files.mkdir(profile.dir);
  writeGames(await env.store.profile(profile), games, positions);
  return stats;
}

/** serve.rebuild_profile: normalise -> site -> classify -> aggregates, no engine work. onStep(name) after each, for
 * a job's progress. Returns each step's result. */
export async function rebuild(env, profile, { onStep = null } = {}) {
  const out = { normalise: await normaliseProfile(env, profile) };
  onStep?.('normalise');
  const db = await env.store.profile(profile);
  if (env.site) out.site = await env.site(db, profile);
  onStep?.('site');
  out.classify = classify(db);
  out.aggregates = await buildAggregates(db, env.files, profile);
  onStep?.('aggregates');
  return out;
}

/** ingest.fetch: the profile's games from its site into raw/, a page at a time: the newest page for a new profile,
 * the page before the oldest on disk with `older`, what's new since the newest with `refresh`. */
export function fetchProfile(env, profile, { refresh = false, older = false, onProgress = null, onWait = null } = {}) {
  return fetchGames(ingestCtx(env, { onWait }), profile, { refresh, older, onProgress });
}

/** Runner._ingest (and _older with `older`): a page of games, then the profile rebuilt. Returns {fetch, ...rebuild}. */
export async function ingestProfile(env, profile, { older = false, onProgress = null, onWait = null, onStep = null } = {}) {
  const fetched = await fetchProfile(env, profile, { older, onProgress, onWait });
  return { fetch: fetched, ...(await rebuild(env, profile, { onStep })) };
}

/** The ids of the profile's games in its database. */
export async function gameIds(env, profile) {
  return new Set((await env.store.profile(profile)).column('SELECT game_id FROM games'));
}

/** Runner._refresh: what's new on the site, the profile rebuilt, and the games it brought flagged "new" until
 * opened. Python takes the before/after ids from site/games.json; they're the database's here (the same games,
 * without waiting for the site). Returns {fetch, ...rebuild, added: [ids]}. */
export async function refreshProfile(env, profile, { onWait = null, onStep = null } = {}) {
  const had = await gameIds(env, profile);
  const fetched = await fetchProfile(env, profile, { refresh: true, onWait });
  const out = { fetch: fetched, ...(await rebuild(env, profile, { onStep })) };
  out.added = [...(await gameIds(env, profile))].filter(id => !had.has(id)).sort();
  await env.profiles.addUnseen(profile.id, out.added);
  return out;
}

/** ingest.count_new: games the site has that aren't on disk yet (the home screen's badge). Read-only. */
export function countNew(env, profile) {
  return ingestCountNew(ingestCtx(env), profile);
}

/** POST /api/pgn's first half: the PGN filed under its digest in the profile's pgn/, and the ids of the standard
 * games normalise finds in it (none: the caller says "no standard game found"). The rebuild is the caller's. */
export async function addPgn(env, profile, text, reviewAs = null) {
  const digest = await storePgn(ingestCtx(env), profile, text, reviewAs);
  const stored = await env.files.readText(`${profile.pgnDir}/${digest}.pgn`);
  return { digest, gameIds: [...parsePgnText(stored, profile.username, digest)].map(([row]) => row.game_id) };
}
