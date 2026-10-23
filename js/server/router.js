// serve.Handler's routes: handle(method, path, body, contentType) → { status, headers, body }, with serve.py's paths,
// status codes, JSON and error messages. `body` is the request's bytes (a Uint8Array, Buffer or string). The answer's
// body is a string, a Uint8Array, or for /api/eval_stream an async iterable of NDJSON lines (whoever sends it calls
// its return() when the client goes away, which stops the engine).
//
// Round 3a has the profiles, games and analysis; the rest answers 501 until round 3b ports it (NOT_YET below).

import { boardFromFen, fen } from '../core/chess.js';
import { MULTIPV_N } from '../core/config.js';
import { Explorer, IllegalMoveError, NoEvalError } from './explore.js';
import { addPgn, rebuild } from './games.js';
import { Runner } from './jobs.js';
import { profileId } from './profiles.js';
import { slug as gameSlug } from './site.js';
import { InvalidMoveError, IllegalMoveError as IllegalUciError } from '../core/chess.js';

export const PGN_PROFILE_NAME = 'Pasted games';   // every pasted PGN lands in profile pgn-pasted-games

const ID = '[A-Za-z0-9_.-]+';
const PROFILE_PATH = new RegExp(`^/p/(${ID})/(.*)$`);

// serve.Handler.extensions_map, the types the page's files come in
const TYPES = {
  '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css',
  '.txt': 'text/plain', '.csv': 'text/csv',
};

/** Round 3b's routes, answered 501 meanwhile: [method, path regex]. */
export const NOT_YET = [
  ['*', /^\/account\//],
  ['POST', /^\/api\/sync\//],
  ['GET', /^\/api\/fetch_image$/],
  ['*', /^\/api\/settings$/],
  ['*', /^\/api\/puzzles\//],
  ['*', /^\/api\/update(\/|$)/],
];

/** index.html's /*__PIECES__*\/ placeholder filled with the board's pieces (python-chess's chess.svg.PIECES, kept in
 * js/desktop/pieces.json), as site.write_static does. */
export function fillPieces(html, pieces) {
  return html.replace('/*__PIECES__*/', JSON.stringify(pieces));
}

const json = (obj, status = 200) => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const notFound = () => ({ status: 404, headers: { 'Content-Type': 'text/html;charset=utf-8' }, body: 'File not found' });

/** Python's repr() of a str, for the messages that quote one. */
const pyRepr = s => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

/** Python's int() of a JSON value: ints, floats (truncated) and numeric strings; anything else is a ValueError. */
function pyInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[-+]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new BadRequest(`invalid literal for int() with base 10: ${pyRepr(String(v))}`);
}

/** Python's truthiness, for bool(b.get(...)). */
const truthy = v => !(v === undefined || v === null || v === false || v === 0 || v === '' ||
  (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length));

/** A request the handler refuses with 400 (Python's ValueError or KeyError). */
class BadRequest extends Error {}

const badInput = e => e instanceof BadRequest || e instanceof IllegalMoveError || e instanceof InvalidMoveError ||
  e instanceof IllegalUciError || e?.name === 'FenError' || e instanceof TypeError;

function parseBoard(fenStr) {
  try {
    return boardFromFen(fenStr);
  } catch (e) {
    throw new BadRequest(e.message ? `invalid fen: ${fenStr} (${e.message})` : `invalid fen: ${fenStr}`);
  }
}

/** serve._side_of_saved_player: the side a saved profile's username played in a pasted PGN, else white. */
async function sideOfSavedPlayer(profiles, pgn) {
  const mine = new Set((await profiles.list()).filter(p => p.source !== 'pgn').map(p => p.username.toLowerCase()));
  for (const side of ['White', 'Black']) {
    const m = new RegExp(`^\\[${side} "([^"]*)"\\]`, 'm').exec(pgn);
    if (m && mine.has(m[1].trim().toLowerCase())) return side.toLowerCase();
  }
  return 'white';
}

const decoder = new TextDecoder();
const text = body => (body == null ? '' : typeof body === 'string' ? body : decoder.decode(body));

/** posixpath.normpath('/' + rel).lstrip('/'): '.' and '..' resolved, never above the root. */
function normRel(rel) {
  const out = [];
  for (const part of rel.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

export class Router {
  /** env: games.js's env (store, files, profiles, fetch, …); runner: a jobs.js Runner; explorer: an explore.js
   * Explorer; pool: the engine pool (its stream() runs /api/eval_stream). */
  constructor({ env, runner, explorer, pool, log = null }) {
    Object.assign(this, { env, runner, explorer, pool, log });
    this.handle = this.handle.bind(this);
  }

  async handle(method, path, body = null, contentType = null) {
    try {
      const url = new URL(path, 'http://x');
      for (const [m, re] of NOT_YET) {
        if ((m === '*' || m === method) && re.test(url.pathname)) {
          return json({ error: `not in this version yet: ${method} ${url.pathname}` }, 501);
        }
      }
      if (method === 'GET' || method === 'HEAD') return await this.get(url);
      if (method === 'POST') return await this.post(url.pathname, body);
      return json({ error: `Unsupported method (${pyRepr(method)})` }, 501);
    } catch (e) {     // the desktop server would log it and drop the connection; the bridge answers this
      this.log?.error?.(`${method} ${path} failed: ${e?.stack ?? e}`);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  }

  /** The JSON body, {} when there is none (serve.Handler._body). */
  body(raw) {
    const t = text(raw);
    return t ? JSON.parse(t) : {};
  }

  async start(job, thenBuild = false) {
    const out = this.runner.start(job, thenBuild);
    if (out === null) return json({ error: 'busy', job: this.runner.job.toDict() }, 409);
    return json({ job: out.toDict() });
  }

  async get(url) {
    const { runner, env } = this, path = url.pathname, q = url.searchParams;
    if (path === '/api/status') return json(await runner.status());
    if (path === '/api/profiles') {
      const out = [];
      for (const p of await env.profiles.list()) {
        out.push({ ...(await env.profiles.summary(p)), new_games: runner.newGames.counts.get(p.id) ?? 0 });
      }
      return json({ profiles: out, scan: runner.newGames.state });
    }
    let m = new RegExp(`^/api/profiles/(${ID})/unseen$`).exec(path);
    if (m) {
      const p = await env.profiles.load(m[1]);
      const unseen = p ? (await env.profiles.summary(p)).unseen : [];
      await env.profiles.markShown(m[1], unseen);     // the list is about to show them: flags come off at the next launch
      return json({ unseen });
    }
    if (path === '/api/legal') {
      try {
        const fenStr = q.get('fen') ?? '';
        parseBoard(fenStr);
        return json(this.explorer.legal(fenStr));
      } catch (e) {
        return json({ error: e.message }, 400);
      }
    }
    if (path === '/api/eval') {
      try {
        const fenStr = q.get('fen') ?? '';
        parseBoard(fenStr);
        return json(await this.explorer.position(fenStr));
      } catch (e) {
        if (e instanceof NoEvalError || !badInput(e)) {
          this.log?.error?.(`eval failed: ${e?.stack ?? e}`);
          return json({ error: e.message }, 500);
        }
        return json({ error: e.message }, 400);
      }
    }
    if (path === '/api/engine') {
      try {
        return json({ name: await this.explorer.name(), nodes: this.explorer.nodes, multipv: MULTIPV_N });
      } catch (e) {
        return json({ error: String(e.message ?? e) }, 500);
      }
    }
    if (path === '/api/eval_stream') {
      let multipv = 3;
      try {
        multipv = Math.max(1, Math.min(5, pyInt(q.get('multipv') ?? '3')));
      } catch { /* 3 */ }
      let board;
      try {
        board = parseBoard(q.get('fen') ?? '');
      } catch (e) {
        return json({ error: e.message }, 400);
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson', 'X-Content-Type-Options': 'nosniff' },
        body: this.stream(board, multipv),
      };
    }
    m = PROFILE_PATH.exec(path);
    if (m) return this.file(m[1], m[2]);
    return notFound();
  }

  /** serve.Handler._stream_eval: a snapshot per line as the engine deepens, until the client goes away. */
  async *stream(board, multipv) {
    const gen = this.explorer.analyseStream(board, this.pool.stream(fen(board), multipv));
    try {
      for await (const snapshot of gen) yield JSON.stringify(snapshot) + '\n';
    } catch (e) {
      this.log?.error?.(`eval_stream failed: ${e?.stack ?? e}`);
    }
  }

  /** /p/<id>/<file>: from that profile's site folder (serve.Handler.translate_path). */
  async file(pid, rest) {
    const p = await this.env.profiles.load(pid);
    if (p === null) return notFound();
    let rel;
    try {
      rel = normRel(decodeURIComponent(rest));
    } catch {
      rel = normRel(rest);
    }
    const bytes = rel ? await this.env.files.readBytes(`${p.siteDir}/${rel}`) : null;
    if (bytes === null) return notFound();
    const ext = /\.[^./]*$/.exec(rel)?.[0].toLowerCase() ?? '';
    return { status: 200, headers: { 'Content-Type': TYPES[ext] ?? 'application/octet-stream' }, body: bytes };
  }

  async post(path, raw) {
    const { runner: r, env } = this;
    if (path === '/api/pgn') return this.pgn(this.body(raw));
    if (path === '/api/profiles') {
      const b = this.body(raw);
      const source = 'source' in b ? b.source : 'chesscom', username = String(b.username || '').trim();
      if (source !== 'chesscom' && source !== 'lichess') return json({ error: 'profiles come from chess.com or lichess' }, 400);
      try {
        profileId(source, username);
      } catch {
        return json({ error: `bad profile: source=${pyRepr(source)} username=${pyRepr(username)}` }, 400);
      }
      const p = await env.profiles.create(source, username);
      const want = truthy(b.puzzles);     // from Personal puzzles: make its puzzles once its games are in
      if (await env.files.exists(`${p.siteDir}/games.json`)) {
        if (want) await r.requestBuild(p);
        return json({ profile: await env.profiles.summary(p), job: null });   // already set up: just open it
      }
      return this.start(r.newJob('ingest', p), want);
    }
    let m = new RegExp(`^/api/profiles/(${ID})/seen$`).exec(path);
    if (m) {
      r.newGames.clear(m[1]);
      return json({ ok: true });
    }
    m = new RegExp(`^/api/profiles/(${ID})/games/([^/]+)/seen$`).exec(path);
    if (m) {
      await env.profiles.markSeen(m[1], m[2]);
      return json({ ok: true });
    }
    m = new RegExp(`^/api/profiles/(${ID})/pin$`).exec(path);
    if (m) {
      const b = this.body(raw);
      const out = await env.profiles.setPinned(m[1], truthy('pinned' in b ? b.pinned : true));
      return out ? json({ profile: out }) : json({ error: 'unknown profile' }, 404);
    }
    m = new RegExp(`^/api/profiles/(${ID})/delete$`).exec(path);
    if (m) {
      if (r.busy() && r.job.profile.id === m[1]) return json({ error: 'busy', job: r.job.toDict() }, 409);
      await r.cancelBuild(m[1]);
      return json({ ok: await env.profiles.remove(m[1]) });
    }
    m = new RegExp(`^/api/p/(${ID})/(analyse_all|refresh|older|analyse/([^/]+))$`).exec(path);
    if (m) {
      const p = await env.profiles.load(m[1]);
      if (p === null) return json({ error: 'unknown profile' }, 404);
      const action = m[2];
      if (action.startsWith('analyse/')) {
        const gameId = await this.gameIdFor(p, m[3]);
        if (gameId === null) return json({ error: 'unknown game' }, 404);
        return this.start(r.newJob('analyse', p, gameId, m[3]));
      }
      return this.start(r.newJob(action, p));
    }
    if (path.startsWith('/api/explore')) {
      try {
        const b = this.body(raw);
        for (const k of ['fen', 'uci']) if (!(k in b)) throw new BadRequest(`'${k}'`);
        const ply = pyInt('ply' in b ? b.ply : 0);
        return json(await this.explorer.move(b.fen, b.uci, 'my_colour' in b ? b.my_colour : 'white', ply, b.ratings || {}));
      } catch (e) {
        if (badInput(e) && !(e instanceof NoEvalError)) return json({ error: e.message }, 400);
        this.log?.error?.(`explore failed: ${e?.stack ?? e}`);
        return json({ error: String(e?.message ?? e) }, 500);
      }
    }
    if (path.startsWith('/api/stop')) {
      if (r.job && r.job.kind === 'build') await r.cancelBuild(r.job.profile.id);
      else if (r.job) r.job.stopRequested = true;
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  /** POST /api/pgn: the PGN stored in the "Pasted games" profile and its site rebuilt, so it is reviewable at once. */
  async pgn(b) {
    const { runner: r, env } = this;
    const pgn = String(b.pgn || '').trim();
    if (!pgn) return json({ error: 'empty PGN' }, 400);
    const reviewAs = b.review_as || await sideOfSavedPlayer(env.profiles, pgn);
    const p = await env.profiles.create('pgn', PGN_PROFILE_NAME);
    if (r.busy() && r.job.profile.id === p.id) return json({ error: 'busy', job: r.job.toDict() }, 409);
    const { gameIds } = await addPgn(env, p, pgn, reviewAs);
    const slugs = gameIds.map(gameSlug);
    if (!slugs.length) return json({ error: 'no standard game found in that PGN' }, 400);
    try {
      await rebuild(r.env, p);
    } catch (e) {
      this.log?.error?.(`pgn rebuild failed: ${e?.stack ?? e}`);
      return json({ error: String(e?.message ?? e) }, 500);
    }
    return json({ profile: await env.profiles.summary(p), games: slugs });
  }

  /** serve._game_id_for: the game a review file belongs to. */
  async gameIdFor(p, slug) {
    if (slug.includes('/') || slug.includes('..')) return null;
    const t = await this.env.files.readText(`${p.siteDir}/games/${slug}.json`);
    return t === null ? null : JSON.parse(t).url;
  }
}

/** Everything serve.main sets up before serving, over the given adapters: the profiles' start-up chores, the job
 * runner (carrying on the builds the last run left), the explorer and the new-games scan. Returns the Router.
 * env: games.js's env; pool: the engine pool; nodes: per position. */
export async function serve({ env, pool, nodes, log = null, scan = true, work = {} }) {
  await env.profiles.migrateLegacy();
  await env.profiles.expireShown();     // "new" flags the list displayed in an earlier run: seen
  const runner = new Runner(env, { pool, nodes, work });
  await runner.loadBuilds();
  await runner.kick();
  const explorer = new Explorer(pool, { nodes, evals: await env.store.evals() });
  if (scan) runner.newGames.start();
  return new Router({ env, runner, explorer, pool, log });
}
