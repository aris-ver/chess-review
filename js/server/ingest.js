// chess_review/ingest.py: a profile's games from chess.com (monthly archives) and lichess (the streamed export)
// into its raw/ folder, and pasted PGNs into pgn/. Python's request generators are async functions here, over
// what the caller hands in:
//
//   ctx.fetch       the WHATWG fetch (the browser's, Node's, or a fake in the tests)
//   ctx.files       the profile's folders: {list(dir), exists(path), read(path), write(path, text),
//                   append(path, text), mkdir(dir)}, each possibly async; ingest-node.js has Node's
//   ctx.sleep       (seconds) => Promise, setTimeout by default
//   ctx.setOlder    (profileId, bool), ctx.setPlayed (profileId, n): profiles.set_older / set_played
//   ctx.onWait      (note | null): a site asked to slow down, then the wait is over (fetch's on_wait)
//   ctx.userAgent   sent when set (the desktop; the browser sends its own, and asking costs a CORS preflight)
//   ctx.log         (level, message), optional
//
// A profile is {id, source, username, rawDir, pgnDir}: the paths are profiles.py's, which the storage layer ports.
// Requests behave as web/py/chess_web/runner.py's drive: each with its timeout, to the reply's first byte and then
// between chunks of its body, so a fetch ends one way or the other.

import { formatG } from '../core/py.js';

export const API = 'https://api.chess.com/pub/player/{username}/games/archives';
export const STATS = 'https://api.chess.com/pub/player/{username}/stats';
export const CHESSCOM_KINDS = ['chess_bullet', 'chess_blitz', 'chess_rapid', 'chess_daily'];   // standard chess, as on its profile
export const LICHESS_USER = 'https://lichess.org/api/user/{username}';
export const LICHESS_GAMES = 'https://lichess.org/api/games/user/{username}';
// Standard chess only: the speeds, not the variants (chess960, atomic, ...), which this app can't review.
export const LICHESS_PERFS = 'ultraBullet,bullet,blitz,rapid,classical,correspondence';
export const PAGE = 20;         // games a page of the app's fetch brings in (at least, on chess.com: whole months)
// after a 429 without a Retry-After (chess.com's isn't readable cross-origin, so always in the browser)
export const BACKOFF = [2, 5, 15, 30, 60];
export const NDJSON = { Accept: 'application/x-ndjson' };

/** The site has no player by that name (a typo, a closed account). */
export class NoSuchPlayer extends Error {
  name = 'NoSuchPlayer';
}

/** A reply of 400 or more, worded as requests words it: a 404 is told apart by it (serve.Runner._failed). */
export class HTTPError extends Error {
  name = 'HTTPError';

  constructor(status, url) {
    super(`${status} ${status < 500 ? 'Client' : 'Server'} Error for url: ${url}`);
    this.status = status;
  }
}

export class TimeoutError extends Error {
  name = 'TimeoutError';
}

export class ConnectionError extends Error {
  name = 'ConnectionError';
}

const fill = (template, username) => template.replace('{username}', username);
const join = (dir, name) => `${dir}/${name}`;
const noop = () => {};

/** urllib.parse.urlencode(params): quote_plus on keys and str(values). */
function urlencode(params) {
  const q = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
  return Object.entries(params).map(([k, v]) => `${q(k)}=${q(v)}`).join('&');
}

function within(promise, seconds, message, onTimeout = noop) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new TimeoutError(message));
      }, seconds * 1000);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A fetch's answer as ingest reads a requests.Response: status, headers, text/json() once read, lines() while
 * streaming. */
class Reply {
  constructor(url, response, timeout, abort) {
    this.url = url;
    this.status = response.status;
    this.headers = response.headers;
    this.timeout = timeout;
    this.reader = response.body ? response.body.getReader() : null;
    this.decoder = new TextDecoder('utf-8');
    this.text = '';
    this.rest = '';
    this.ended = false;
    this.abort = abort;
  }

  /** The body's next text, '' at its end. */
  async chunk() {
    if (!this.reader) return '';
    const host = new URL(this.url).host;
    const { done, value } = await within(this.reader.read(), this.timeout,
      `${host} stopped answering (${formatG(this.timeout)} s without data)`, this.abort);
    return done ? this.decoder.decode() : this.decoder.decode(value, { stream: true });
  }

  /** The next whole lines of a streamed body: a list (maybe empty), null once it has ended. */
  async lines() {
    if (this.ended) return null;
    const data = await this.chunk();
    if (!data) {
      this.ended = true;
      return this.rest ? [this.rest] : null;
    }
    const out = (this.rest + data).split('\n');
    this.rest = out.pop();
    return out;
  }

  json() {
    return JSON.parse(this.text);
  }

  raiseForStatus() {
    if (this.status >= 400) throw new HTTPError(this.status, this.url);
  }

  close() {
    if (!this.ended) {
      this.ended = true;
      this.reader?.cancel().catch(noop);
    }
  }
}

/** One GET (runner._send): the reply within `timeout`, its body read unless `stream`. */
export async function send(ctx, { url, params = {}, headers = {}, stream = false, timeout = 60 }) {
  const full = Object.keys(params).length ? `${url}?${urlencode(params)}` : url;
  const host = new URL(full).host;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const sent = { ...headers };
  if (ctx.userAgent) sent['User-Agent'] = ctx.userAgent;
  let response;
  try {
    response = await within(ctx.fetch(full, { headers: sent, signal: controller.signal }), timeout,
      `${host} didn't answer within ${formatG(timeout)} s`, abort);
  } catch (e) {
    if (e instanceof TimeoutError) throw e;
    throw new ConnectionError(`couldn't reach ${host}: ${e.message ?? e}`);     // offline, blocked, refused by CORS
  }
  const r = new Reply(full, response, timeout, abort);
  if (!stream) {
    const parts = [];
    let part;
    while ((part = await r.chunk())) parts.push(part);
    r.text = parts.join('');
    r.ended = true;
  }
  return r;
}

async function pause(ctx, seconds, note = '') {
  if (note) ctx.onWait?.(note);
  await (ctx.sleep ?? (s => new Promise(resolve => setTimeout(resolve, s * 1000))))(seconds);
  if (note) ctx.onWait?.(null);
}

/** ctx.log is log(level, message), or a logger object with info/warn/error as the rest of js/server passes. */
const log = (ctx, level, message) => (typeof ctx.log === 'function' ? ctx.log(level, message)
  : ctx.log?.[level === 'warning' ? 'warn' : level]?.(message));

/** Retry-After in whole seconds; 0 when absent (or not a number of seconds, where Python would raise). */
function retryAfter(r) {
  const v = r.headers.get('Retry-After');
  return v !== null && /^\s*\d+\s*$/.test(v) ? Number(v) : 0;
}

async function get(ctx, url, { maxRetries = 6, missing = null } = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const r = await send(ctx, { url });
    if (r.status === 404 && missing) throw new NoSuchPlayer(missing);
    if (r.status === 429) {
      if (attempt === maxRetries - 1) break;
      const wait = retryAfter(r) || BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      log(ctx, 'warning', `429 on ${url}, sleeping ${wait}s`);
      await pause(ctx, wait, `chess.com asked to slow down: trying again in ${wait} s`);
      continue;
    }
    r.raiseForStatus();
    return r;
  }
  throw new Error('chess.com kept asking to slow down: try again in a few minutes');
}

// a 404 here is the player; one for a month is chess.com's own trouble (it has had whole days of those)
const archiveList = (ctx, profile) =>
  get(ctx, fill(API, profile.username), { missing: `chess.com has no user called ${profile.username}` });

function month(url) {
  const [year, m] = url.replace(/\/+$/, '').split('/').slice(-2);
  return `${year}-${m}`;
}

const stems = async (ctx, dir, ext) =>
  (await ctx.files.list(dir)).filter(f => f.endsWith(ext)).map(f => f.slice(0, -ext.length)).sort();

const monthsOnDisk = (ctx, profile) => stems(ctx, profile.rawDir, '.json');

const gamesIn = text => (JSON.parse(text).games ?? []).length;

/** Every month not on disk (since: only from that month on, a refresh of a profile fetched a page at a time). */
export async function fetchArchives(ctx, profile, { force = false, only = null, delay = 1.0, refreshLatest = false,
  since = null, onProgress = null } = {}) {
  await ctx.files.mkdir(profile.rawDir);
  let archiveUrls = (await archiveList(ctx, profile)).json().archives;
  log(ctx, 'info', `${archiveUrls.length} archives listed for ${profile.username}`);
  if (since) archiveUrls = archiveUrls.filter(u => month(u) >= since);

  const stats = { listed: archiveUrls.length, fetched: 0, skipped: 0 };
  for (const [i, url] of archiveUrls.entries()) {
    onProgress?.(i, archiveUrls.length);
    const key = month(url);
    const out = join(profile.rawDir, `${key}.json`);
    if (only && key !== only) {
      stats.skipped += 1;
      continue;
    }
    const isLatest = url === archiveUrls.at(-1) || key === since;     // (the newest month on disk may have been partial)
    if (await ctx.files.exists(out) && !force && !(refreshLatest && isLatest)) {
      stats.skipped += 1;
      continue;
    }
    if (delay) await pause(ctx, delay);     // between requests only: a refresh asks for one month and passes delay=0
    const body = (await get(ctx, url)).text;
    const n = gamesIn(body);
    await ctx.files.write(out, body);
    stats.fetched += 1;
    log(ctx, 'info', `${key}: ${n} games`);
  }
  return stats;
}

/** A page of chess.com months, newest first, until they hold PAGE games: the latest months for a new profile
 * (months already on disk count without being fetched again: a first fetch cut short picks up where it stopped),
 * with `older` the months before the oldest on disk. Sets the profile's "older" flag. */
async function archivePage(ctx, profile, { older = false, delay = 1.0, onProgress = null } = {}) {
  await ctx.files.mkdir(profile.rawDir);
  const archiveUrls = (await archiveList(ctx, profile)).json().archives;
  let have = await monthsOnDisk(ctx, profile);
  const todo = [...archiveUrls].reverse().filter(u => !(older && have.length) || month(u) < have[0]);
  const stats = { listed: archiveUrls.length, fetched: 0, skipped: 0, games: 0 };
  for (const url of todo) {
    if (stats.games >= PAGE) break;
    onProgress?.(stats.games, PAGE);
    const out = join(profile.rawDir, `${month(url)}.json`);
    let body;
    if (await ctx.files.exists(out)) {
      body = await ctx.files.read(out);
      stats.skipped += 1;
    } else {
      if (delay && stats.fetched) await pause(ctx, delay);     // between months only: a page is often one request
      body = (await get(ctx, url)).text;
      await ctx.files.write(out, body);
      stats.fetched += 1;
    }
    stats.games += gamesIn(body);
  }
  have = await monthsOnDisk(ctx, profile);
  stats.older = have.length > 0 && archiveUrls.some(u => month(u) < have[0]);
  await ctx.setOlder?.(profile.id, stats.older);
  log(ctx, 'info', `chess.com ${profile.username}, a page${older ? ' back' : ''}: ${JSON.stringify(stats)}`);
  return stats;
}

/** The player's games on chess.com in all (its stats' win/loss/draw records), into the profile's "played". Only a
 * count for the screen: if the stats don't come, the fetch goes on without it. */
async function chesscomPlayed(ctx, profile) {
  let played;
  try {
    const stats = (await get(ctx, fill(STATS, profile.username), { maxRetries: 1 })).json();
    played = 0;
    for (const k of CHESSCOM_KINDS) for (const r of ['win', 'loss', 'draw']) played += stats[k]?.record?.[r] ?? 0;
  } catch (e) {      // offline, a 404 or 429, an odd body: the count waits for the next fetch
    log(ctx, 'info', `no chess.com stats for ${profile.username}: ${e.message}`);
    return;
  }
  if (played) await ctx.setPlayed?.(profile.id, played);
}

/** How many games chess.com has for this profile that aren't in its raw archives yet: the latest month's games
 * minus those already in the same month's file on disk, plus whole months newer than anything on disk. Read-only:
 * nothing is written, a refresh does that. Looks at most maxMonths back. */
export async function countNewGames(ctx, profile, { delay = 1.0, maxMonths = 3 } = {}) {
  const archiveUrls = (await archiveList(ctx, profile)).json().archives;
  let fresh = 0;
  for (const [i, url] of archiveUrls.slice(-maxMonths).reverse().entries()) {
    const local = join(profile.rawDir, `${month(url)}.json`);
    const exists = await ctx.files.exists(local);
    if (exists && i > 0) break;     // everything older than the latest month is fetched once and never changes
    await pause(ctx, delay);
    const remote = (await get(ctx, url)).json().games ?? [];
    let have = new Set();
    if (exists) {
      try {
        have = new Set((JSON.parse(await ctx.files.read(local)).games ?? []).map(g => g.url));
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    fresh += remote.filter(g => !have.has(g.url)).length;
  }
  return fresh;
}

/** onGame(each game of the export). Lichess asks for a full minute's pause after a 429. */
async function lichessStream(ctx, username, params, onGame, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const r = await send(ctx, { url: fill(LICHESS_GAMES, username), params: { perfType: LICHESS_PERFS, ...params },
      headers: NDJSON, stream: true });
    if (r.status === 429) {
      r.close();
      if (attempt === maxRetries - 1) break;
      log(ctx, 'warning', '429 from lichess, sleeping 60s');
      await pause(ctx, 60, 'lichess asked to slow down: trying again in a minute');
      continue;
    }
    try {
      r.raiseForStatus();
      let lines;
      while ((lines = await r.lines()) !== null) {
        for (const line of lines) {
          const l = line.replace(/\r$/, '');
          if (l) await onGame(JSON.parse(l));
        }
      }
      return;
    } finally {
      r.close();
    }
  }
  throw new Error('lichess kept asking to slow down: try again in a few minutes');
}

// str.splitlines() over an .ndjson file, blank lines dropped
const ndjsonLines = text => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).filter(l => l.trim());

/** json.dumps(g, separators=(",", ":")): ASCII only, as Python writes it. */
export const dumpLine = g => JSON.stringify(g).replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

/** [newest createdAt, oldest createdAt, number of games] over the profile's raw/*.ndjson; 0s when there's none. */
async function lichessOnDisk(ctx, profile) {
  let newest = 0, oldest = 0, n = 0;
  for (const f of (await ctx.files.list(profile.rawDir)).filter(f => f.endsWith('.ndjson'))) {
    for (const line of ndjsonLines(await ctx.files.read(join(profile.rawDir, f)))) {
      const t = JSON.parse(line).createdAt ?? 0;
      [newest, oldest, n] = [Math.max(newest, t), n ? Math.min(oldest, t) : t, n + 1];
    }
  }
  return [newest, oldest, n];
}

const utcMonth = ms => new Date(ms).toISOString().slice(0, 7);

/** Without `page`: every game, or those since the newest on disk. page="new": the newest PAGE games;
 * page="older": the PAGE before the oldest on disk. A page sets the profile's "older" flag. */
async function lichess(ctx, profile, { onProgress = null, page = null } = {}) {
  await ctx.files.mkdir(profile.rawDir);
  const r = await send(ctx, { url: fill(LICHESS_USER, profile.username), headers: { Accept: 'application/json' },
    timeout: 30 });
  if (r.status === 404) throw new NoSuchPlayer(`no lichess player called ${profile.username}`);
  r.raiseForStatus();
  const user = r.json();
  if (user.disabled) throw new NoSuchPlayer(`lichess account ${profile.username} is closed`);
  const all = user.count?.all ?? 0;
  if (all) await ctx.setPlayed?.(profile.id, all);
  const [newest, oldest, had] = await lichessOnDisk(ctx, profile);
  const params = { clocks: 'true', opening: 'true', pgnInJson: 'true', sort: 'dateAsc' };
  let total;
  if (page) {
    total = PAGE;
    Object.assign(params, { sort: 'dateDesc', max: PAGE });
    if (page === 'older' && oldest) params.until = oldest - 1;
  } else {
    // the total is every game, variants included, so a rough bar: it stops short and jumps at the end
    total = Math.max(all - had, 1);
    if (newest) params.since = newest;
  }

  const seen = new Map();       // month -> ids already in that file
  const stats = { fetched: 0, skipped: 0 };
  const take = async g => {
    const i = stats.fetched + stats.skipped;
    if (onProgress && (page || i % 20 === 0)) onProgress(Math.min(i, total), total);
    const m = utcMonth(g.createdAt);
    const out = join(profile.rawDir, `${m}.ndjson`);
    if (!seen.has(m)) {
      seen.set(m, await ctx.files.exists(out)
        ? new Set(ndjsonLines(await ctx.files.read(out)).map(l => JSON.parse(l).id)) : new Set());
    }
    if (seen.get(m).has(g.id)) {
      stats.skipped += 1;
      return;
    }
    await ctx.files.append(out, dumpLine(g) + '\n');
    seen.get(m).add(g.id);
    stats.fetched += 1;
  };

  await lichessStream(ctx, profile.username, params, take);
  if (page) {       // a full page: there may be more before it (a page that ends exactly at the first game says so too)
    stats.older = stats.fetched + stats.skipped >= PAGE;
    await ctx.setOlder?.(profile.id, stats.older);
  }
  log(ctx, 'info', `lichess ${profile.username}${page ? `, a page (${page})` : ''}: ${JSON.stringify(stats)}`);
  return stats;
}

/** Every standard game the player has on lichess, with clocks and the opening, appended to raw/YYYY-MM.ndjson.
 * Only games started at or after the newest one on disk are asked for, and ids already there are skipped. */
export const fetchLichess = (ctx, profile, { onProgress = null } = {}) => lichess(ctx, profile, { onProgress });

/** How many games lichess has for this profile that aren't on disk yet. Read-only, ids only. */
export async function countNewLichess(ctx, profile) {
  const [newest] = await lichessOnDisk(ctx, profile);
  const ids = new Set();
  for (const f of (await ctx.files.list(profile.rawDir)).filter(f => f.endsWith('.ndjson'))) {
    for (const line of ndjsonLines(await ctx.files.read(join(profile.rawDir, f)))) ids.add(JSON.parse(line).id);
  }
  const params = newest ? { moves: 'false', tags: 'false', since: newest } : { moves: 'false', tags: 'false' };
  let fresh = 0;
  await lichessStream(ctx, profile.username, params, g => { if (!ids.has(g.id)) fresh += 1; });
  return fresh;
}

/** ingest.fetch: the profile's games from wherever it lives, a page at a time: the newest page for a new profile,
 * the page before the oldest on disk with `older`, what's new since the newest on a refresh. */
export async function fetchGames(ctx, profile, { refresh = false, onProgress = null, older = false } = {}) {
  if (profile.source === 'chesscom') {
    const have = await monthsOnDisk(ctx, profile);
    let stats;
    if (refresh && have.length) {
      // the latest month again and any newer. chess.com only rate-limits parallel requests: no pause
      stats = await fetchArchives(ctx, profile, { refreshLatest: true, since: have.at(-1), delay: 0 });
    } else {
      stats = await archivePage(ctx, profile, { older, onProgress });
    }
    await chesscomPlayed(ctx, profile);     // after the games: a player who isn't there is told by the archives
    return stats;
  }
  if (profile.source === 'lichess') {
    if (refresh && (await lichessOnDisk(ctx, profile))[2]) return lichess(ctx, profile);
    return lichess(ctx, profile, { onProgress, page: older ? 'older' : 'new' });
  }
  throw new Error(`${profile.source} profiles can't be fetched`);
}

/** ingest.count_new */
export async function countNew(ctx, profile) {
  if (profile.source === 'chesscom') return countNewGames(ctx, profile);
  if (profile.source === 'lichess') return countNewLichess(ctx, profile);
  return 0;
}

// str.strip()'s whitespace
const STRIP = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** A pasted PGN as store_pgn files it: {digest, text}. `reviewAs` ("white"/"black") is written into every game's
 * tag section as [ReviewAs ...] so normalise knows which side is "me" without a username match. */
export async function pgnFile(text, reviewAs = null) {
  let normalised = text.replaceAll('\r\n', '\n').replace(STRIP, '') + '\n';
  if (reviewAs === 'white' || reviewAs === 'black') {
    const tag = `[ReviewAs "${reviewAs}"]\n`;
    const event = /(?<![^\n])(?=\[Event )/g;
    normalised = event.test(normalised) ? normalised.replace(event, tag) : tag + normalised;
  }
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalised));
  const digest = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  return { digest, text: normalised };
}

/** ingest.store_pgn: the PGN saved under its content hash in the profile's pgn/; returns the digest. */
export async function storePgn(ctx, profile, text, reviewAs = null) {
  const { digest, text: normalised } = await pgnFile(text, reviewAs);
  await ctx.files.mkdir(profile.pgnDir);
  const out = join(profile.pgnDir, `${digest}.pgn`);
  if (!(await ctx.files.exists(out))) await ctx.files.write(out, normalised);
  return digest;
}
