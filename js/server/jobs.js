// The job runner: serve.Runner (and web/py/chess_web/runner.py's WebRunner, its asyncio twin) over the engine pool
// of js/core/engine.js and the js/server modules. One job at a time, since analysis uses every engine; an analysis
// asked for while another foreground job runs waits its turn in `queue`, and a background job (a puzzle build)
// gives way to anything the user asks for.
//
// Jobs here: analyse (one game, its review rewritten as results come in), analyse_all, and the fetches ingest,
// older and refresh. The puzzle jobs (build, puzzles) are round 3b's: their bookkeeping is here (builds, status,
// cancelBuild), and their work plugs in through `work` (kind → async (runner, job) => void). Until it does, a
// leftover build in puzzle_builds.json just waits, untouched.

import { boardFromKey } from '../core/fen.js';
import { isBook } from '../core/book.js';
import { pyRound } from '../core/py.js';
import { build as buildAggregates } from './aggregates.js';
import { pendingKeys, writeResults } from './analyse.js';
import { build as classify } from './classify.js';
import { robustMultipv } from './explore.js';
import { countNew, fetchProfile, gameIds, rebuild } from './games.js';
import { NoSuchPlayer } from './ingest.js';
import { build as buildSite, slug, updateIndex, writeGame } from './site.js';

export const BACKGROUND = ['puzzles', 'build'];      // jobs that give way to anything the user asks for
export const FETCHES = ['ingest', 'refresh', 'older'];
export const LIVE_WRITE_S = 0.3;                     // a game analysed on demand: its review rewritten at most this often
export const BUILDS_FILE = 'puzzle_builds.json';
const ACTIVE = ['queued', 'running', 'finishing'];

const seconds = () => Date.now() / 1000;
const monotonic = () => performance.now() / 1000;

export class Job {
  constructor(id, kind, profile, gameId = null, slug = null, now = seconds) {
    Object.assign(this, { id, kind, profile, gameId, slug, now });
    this.status = 'queued';         // queued | running | finishing | done | error | stopped
    this.done = 0; this.total = 0;
    this.error = null;
    this.started = now();
    this.stopRequested = false;
    this.preempted = false;         // stopped to make way for another job: it comes back once that one is done
    this.gameDone = 0; this.gameTotal = 0;
    this.phase = null; this.puzzles = null; this.note = null;
  }

  toDict() {
    return {
      id: this.id, kind: this.kind, profile: this.profile.id, username: this.profile.username,
      game: this.slug, status: this.status,
      done: this.done, total: this.total, game_done: this.gameDone, game_total: this.gameTotal,
      error: this.error, elapsed: pyRound(this.now() - this.started, 1),
      phase: this.phase, puzzles: this.puzzles, note: this.note,
    };
  }
}

/** analyse.LivePace: when the results of a game someone is watching are written out, so the board follows the
 * analysis without writing taking much of the engines' time. */
export class LivePace {
  static COST_X = 4;
  constructor(minS, clock = monotonic) {
    Object.assign(this, { minS, clock, last: 0, cost: 0, first: null });
  }
  got() {
    if (this.first === null) this.first = this.clock();
  }
  /** Seconds until the results in hand are due; null when there are none. */
  wait() {
    if (this.first === null) return null;
    return Math.max(0, Math.max(this.first + this.minS, this.last + LivePace.COST_X * this.cost) - this.clock());
  }
  wrote(started) {
    this.last = this.clock();
    this.cost = this.last - started;
    this.first = null;
  }
}

/** analyse.Analyser.run over the engine pool (WebRunner's BrowserAnalyser): one lane per engine, results written
 * every `batch` (or as `live` paces them), what is in hand kept when stopped. */
export class Analyser {
  constructor(pool, nodes) {
    this.pool = pool;
    this.nodes = nodes;
    this.lastUsed = 0;
  }

  get workers() {
    return Math.max(1, this.pool.size | 0);
  }

  async evaluate(key) {
    const [main, ranks] = await robustMultipv(boardFromKey(key), this.pool, this.nodes);
    return [key, main, ranks];
  }

  /** Returns the count analysed. onProgress(done, total) may be async; flushes never overlap. */
  async run(keys, db, { onProgress = null, batch = 20, shouldStop = null, live = null } = {}) {
    keys = [...keys];
    if (!keys.length) return 0;
    const buf = [];
    let next = 0, done = 0, stop = false, timer = null, chain = Promise.resolve();
    const flush = () => {
      chain = chain.then(async () => {
        if (!buf.length) return;
        const started = monotonic();
        writeResults(db, buf.splice(0));
        if (onProgress) await onProgress(done, keys.length);
        live?.wrote(started);
      });
      return chain;
    };
    const due = () => {
      const w = live.wait();
      if (w === null) { timer = null; return; }
      if (w > 0) { timer = setTimeout(due, w * 1000); return; }
      timer = null;
      flush();
    };
    const lane = async () => {
      while (!stop && next < keys.length) {
        buf.push(await this.evaluate(keys[next++]));
        done += 1;
        this.lastUsed = Date.now();
        live?.got();
        if (buf.length >= batch || done === keys.length) await flush();
        else if (live && timer === null) due();
        if (shouldStop?.()) stop = true;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(this.workers, keys.length) }, lane));
    } finally {
      if (timer !== null) clearTimeout(timer);
      await flush();      // stopped: what is in hand is kept
    }
    return done;
  }
}

/** serve.live_order: a game's pending positions in the order its review wants them, game order but the positions
 * book moves are played from last. db: the profile's connection. */
export function liveOrder(db, gameId, keys) {
  const plies = db.column('SELECT fen_key FROM positions WHERE game_id = ? ORDER BY ply', [gameId]);
  const order = new Map();
  plies.forEach((k, i) => { if (!order.has(k)) order.set(k, i); });
  const later = new Set(plies.slice(0, -1).filter((k, i) => isBook(plies[i + 1])));
  const rank = k => [later.has(k) ? 1 : 0, order.get(k) ?? 2 ** 30];
  return [...keys].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1];
  });
}

/** serve.NewGames: once per launch, how many games each chess.com or lichess profile's site has that aren't on disk
 * yet (the home screen's badge). */
export class NewGames {
  constructor(env) {
    this.env = env;
    this.counts = new Map();
    this.state = 'idle';      // idle | running | done
  }

  start() {
    this.state = 'running';
    this.done = this.run();
    return this.done;
  }

  async run() {
    for (const p of await this.env.profiles.list()) {
      if (!['chesscom', 'lichess'].includes(p.source) || !(await this.env.files.exists(p.rawDir))) continue;
      try {
        const n = await countNew(this.env, p);
        if (n) this.counts.set(p.id, n);
      } catch (e) {     // offline, rate-limited, renamed account: no badge, nothing else
        this.env.log?.info?.(`new-games scan for ${p.id} failed: ${e.message}`);
      }
    }
    this.state = 'done';
  }

  clear(pid) {
    this.counts.delete(pid);
  }
}

export class Runner {
  /** env: games.js's env (store, files, profiles, fetch, …); pool: the EnginePool; nodes: per position;
   * work: extra job kinds (round 3b's build and puzzles); now: seconds, for the job clock. */
  constructor(env, { pool, nodes, work = {}, newGames = null, now = seconds } = {}) {
    this.env = { site: (db, p) => buildSite(db, env.files, p), ...env };
    this.analyser = new Analyser(pool, nodes);
    this.newGames = newGames ?? new NewGames(this.env);
    this.work = work;
    this.now = now;
    this.ids = 0;
    this.job = null;
    this.running = null;          // the promise of the job in hand
    this.queue = [];
    this.builds = [];             // profiles whose puzzles are being made, the current one first
    this.buildState = new Map();  // profile → its build's last progress
    this.finished = new Map();    // profile → how its last build ended
    this.recent = [];             // the last 8 jobs that ended
  }

  newJob(kind, profile, gameId = null, slug = null) {
    return new Job(++this.ids, kind, profile, gameId, slug, this.now);
  }

  /** The builds still to do from the last run (puzzle_builds.json). */
  async loadBuilds() {
    try {
      const ids = JSON.parse(await this.env.files.readText(BUILDS_FILE) ?? '[]');
      this.builds = ids.filter(i => typeof i === 'string');
    } catch {
      this.builds = [];
    }
  }

  async saveBuilds() {
    try {
      await this.env.files.writeText(BUILDS_FILE, JSON.stringify(this.builds));
    } catch (e) {
      this.env.log?.warn?.(`could not save the puzzle builds: ${e.message}`);
    }
  }

  busy() {
    return this.job !== null && ACTIVE.includes(this.job.status);
  }

  /** serve.Runner.start: the job doing the work (this one, or the same one already running or queued), or null when
   * another foreground job runs and this one can't wait. thenBuild: make the profile's puzzles afterwards. */
  start(job, thenBuild = false) {
    const out = this._start(job);
    if (out !== null && thenBuild && !this.builds.includes(job.profile.id)) {
      this.builds.push(job.profile.id);
      this.saveBuilds();
    }
    return out;
  }

  _start(job) {
    let before = null;
    if (this.busy()) {
      const cur = this.job;
      if (BACKGROUND.includes(cur.kind) && (!BACKGROUND.includes(job.kind) || (job.kind === 'build' && cur.kind === 'puzzles'))) {
        cur.stopRequested = cur.preempted = true;
        before = this.running;
      } else if (FETCHES.includes(job.kind) && cur.kind === job.kind && cur.profile.id === job.profile.id) {
        return cur;
      } else if (job.kind === 'analyse') {
        const same = [cur, ...this.queue].find(j => j.kind === 'analyse' && j.profile.id === job.profile.id && j.gameId === job.gameId);
        if (same) return same;
        this.queue.push(job);
        return job;
      } else {
        return null;
      }
    }
    this.job = job;
    this.running = this._run(job, before);
    return job;
  }

  async _run(job, before) {
    if (before) await before.catch(() => {});
    else await new Promise(r => setTimeout(r, 0));   // off the request: it answers with the job still queued, as Python does
    try {
      job.status = 'running';
      await this._work(job);
      job.status = job.stopRequested ? 'stopped' : 'done';
    } catch (e) {
      await this._failed(job, e);
    }
    await this._ended(job);
  }

  _work(job) {
    if (this.work[job.kind]) return this.work[job.kind](this, job);
    switch (job.kind) {
      case 'analyse': return this._analyse(job);
      case 'analyse_all': return this._analyseAll(job);
      case 'ingest': case 'older': return this._ingest(job);
      case 'refresh': return this._refresh(job);
      default: throw new Error(`${job.kind} isn't in this version yet`);
    }
  }

  async _failed(job, e) {
    this.env.log?.error?.(`job failed: ${e?.stack ?? e}`);
    job.status = 'error';
    job.error = String(e?.message ?? e);
    // a typo shouldn't linger on the home screen; any other failure (offline, a timeout) keeps the profile
    if (job.kind === 'ingest' && e instanceof NoSuchPlayer && !(await this.env.files.exists(`${job.profile.siteDir}/games.json`))) {
      await this.env.profiles.remove(job.profile.id);
    }
  }

  async _ended(job) {
    this.recent.push(job.toDict());
    if (this.recent.length > 8) this.recent.shift();
    if (job.kind === 'build') await this._buildEnded(job);
    if (this.job === job) await this.kick();
  }

  async _buildEnded(job) {
    const pid = job.profile.id;
    if (job.preempted && job.status === 'stopped') {
      this.buildState.set(pid, { ...job.toDict(), status: 'paused' });
      return;
    }
    if (this.builds.includes(pid)) {
      this.builds.splice(this.builds.indexOf(pid), 1);
      await this.saveBuilds();
    }
    this.buildState.delete(pid);
    if (job.status === 'done' || job.status === 'error') {
      this.finished.set(pid, { ...job.toDict(), username: job.profile.username, ended: this.now() });
    }
  }

  /** Start what waits once the way is clear: a queued analysis first, then the next puzzle build. */
  async kick() {
    if (this.busy() && this.job.kind !== 'puzzles') return;
    if (this.queue.length && !this.busy()) {
      this._start(this.queue.shift());
      return;
    }
    if (!this.work.build) return;     // round 3b: builds wait until their job is in
    while (this.builds.length) {
      const p = await this.env.profiles.load(this.builds[0]);
      if (p !== null && await this.env.files.exists(`${p.siteDir}/games.json`)) {
        this._start(this.newJob('build', p));
        return;
      }
      this.builds.shift();      // removed, or its games never came (an unknown username)
      await this.saveBuilds();
    }
  }

  async requestBuild(profile) {
    this.finished.delete(profile.id);
    if (!this.builds.includes(profile.id)) {
      this.builds.push(profile.id);
      await this.saveBuilds();
    }
    await this.kick();
  }

  async cancelBuild(pid) {
    let had = this.builds.includes(pid);
    if (had) {
      this.builds.splice(this.builds.indexOf(pid), 1);
      await this.saveBuilds();
    }
    this.buildState.delete(pid);
    if (this.busy() && this.job.kind === 'build' && this.job.profile.id === pid) {
      this.job.stopRequested = true;
      this.job.preempted = false;
      had = true;
    }
    return had;
  }

  async buildsStatus() {
    const out = [];
    for (const [i, pid] of this.builds.entries()) {
      const cur = this.busy() ? this.job : null;
      let d;
      if (cur !== null && cur.profile.id === pid && (cur.kind === 'build' || cur.kind === 'ingest')) {
        d = cur.toDict();
        d.state = cur.kind === 'build' ? 'running' : 'fetching';
        if (cur.kind === 'ingest') d.phase = 'fetching';
      } else {
        d = { ...(this.buildState.get(pid) ?? { profile: pid, phase: null, done: 0, total: 0, puzzles: null }) };
        d.state = i === 0 && cur !== null ? 'paused' : 'waiting';
        d.game = null;
      }
      const p = await this.env.profiles.load(pid);
      d.username = p ? p.username : pid;
      out.push(d);
    }
    return out;
  }

  async status() {
    return {
      job: this.job ? this.job.toDict() : null, queue: this.queue.map(j => j.toDict()),
      recent: [...this.recent], builds: await this.buildsStatus(), finished: [...this.finished.values()],
    };
  }

  /** Until the running job (and whatever it kicks off) has ended: tests, and quitting. */
  async idle() {
    while (this.running) {
      const r = this.running;
      await r;
      if (this.running === r && !this.busy()) break;
    }
  }

  // --- the jobs -----------------------------------------------------------------------------------------------

  async _analyse(job) {
    const { env } = this, p = job.profile;
    const db = await env.store.profile(p);
    let [keys, stats] = pendingKeys(db, job.gameId);
    job.total = keys.length;
    env.log?.info?.(`analyse ${p.id}/${job.slug}: ${JSON.stringify(stats)}`);
    keys = liveOrder(db, job.gameId, keys);
    const write = async () => updateIndex(env.files, p, await writeGame(db, env.files, p, job.gameId));
    // the review is on screen, following the analysis: rewritten as results come in, not in batches
    await this.analyser.run(keys, db, {
      onProgress: async done => { job.done = done; await write(); },
      batch: this.analyser.workers, shouldStop: () => job.stopRequested, live: new LivePace(LIVE_WRITE_S),
    });
    job.status = 'finishing';
    await write();
    classify(db);
    await buildAggregates(db, env.files, p);
  }

  /** (games, [[game id, its pending keys in game order]] for the ones not fully analysed), newest first. */
  static todo(db) {
    const games = db.column('SELECT game_id FROM games ORDER BY played_at DESC');
    const pending = new Map();
    for (const { game_id: g, fen_key: k } of db.all(`
        SELECT k.game_id, k.fen_key FROM (SELECT game_id, fen_key, min(ply) ply FROM positions GROUP BY 1, 2) k
        LEFT JOIN evals e ON e.fen_key = k.fen_key
        WHERE e.fen_key IS NULL OR NOT EXISTS (SELECT 1 FROM evals_multipv m WHERE m.fen_key = k.fen_key)
        ORDER BY k.game_id, k.ply`)) {
      if (!pending.has(g)) pending.set(g, []);
      pending.get(g).push(k);
    }
    return [games.length, games.filter(g => pending.has(g)).map(g => [g, pending.get(g)])];
  }

  /** One game of a batch, its positions in game order, then its review page. */
  async analyseGame(job, db, gid, keys) {
    const { env } = this, p = job.profile;
    job.slug = slug(gid);
    job.gameDone = 0;
    job.gameTotal = keys.length;
    await this.analyser.run(keys, db, {
      onProgress: done => { job.gameDone = done; },
      batch: this.analyser.workers * 2, shouldStop: () => job.stopRequested,
    });
    await updateIndex(env.files, p, await writeGame(db, env.files, p, gid));
  }

  async _analyseAll(job) {
    const p = job.profile;
    const db = await this.env.store.profile(p);
    const [, todo] = Runner.todo(db);
    job.done = 0;
    job.total = todo.length;
    for (const [gid, keys] of todo) {
      if (job.stopRequested) break;
      await this.analyseGame(job, db, gid, keys);
      job.done += 1;
    }
    job.status = 'finishing';
    classify(db);
    await buildAggregates(db, this.env.files, p);
  }

  /** ingest (a new profile's newest page of games) and older (the page before the oldest), then the rebuild.
   * done/total count the page's games while fetching, plus the rebuild's 3 steps. */
  async _ingest(job) {
    const stats = await fetchProfile(this.env, job.profile, {
      older: job.kind === 'older',
      onProgress: (done, total) => { job.done = done; job.total = total + 3; },
      onWait: note => { job.note = note; },
    });
    this.env.log?.info?.(`ingest ${job.profile.id}: ${JSON.stringify(stats)}`);
    this.newGames.clear(job.profile.id);
    job.total = Math.max(job.total, 3);
    job.done = job.total - 3;
    await this._rebuild(job);
  }

  async _refresh(job) {
    const { env } = this, p = job.profile;
    job.total = 4;
    const had = await gameIds(env, p);
    const stats = await fetchProfile(env, p, { refresh: true, onWait: note => { job.note = note; } });
    env.log?.info?.(`refresh ${p.id}: ${JSON.stringify(stats)}`);
    this.newGames.clear(p.id);
    job.done = 1;
    await this._rebuild(job);
    // what the refresh brought in: flagged in the list until opened
    await env.profiles.addUnseen(p.id, [...(await gameIds(env, p))].filter(id => !had.has(id)).sort());
  }

  _rebuild(job) {
    return rebuild(this.env, job.profile, { onStep: () => { job.done += 1; } });
  }
}
