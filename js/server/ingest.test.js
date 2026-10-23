// ingest over a fake fetch: tests/test_paged_fetch.py's and tests/test_lichess.py's cases, the requests as
// web/py/chess_web/runner.py's drive makes them, and store_pgn against scripts/dump_parity_games.py's dump.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { load, same } from '../parity.js';
import { normalise } from '../core/normalise.js';
import {
  ConnectionError, NoSuchPlayer, PAGE, TimeoutError, countNew, fetchGames, pgnFile, send, storePgn,
} from './ingest.js';
import { nodeFiles } from './ingest-node.js';

/** ctx.files in memory: path -> text. */
function memoryFiles() {
  const m = new Map();
  return {
    m,
    list: dir => [...m.keys()].filter(k => k.startsWith(dir + '/')).map(k => k.slice(dir.length + 1)),
    exists: path => m.has(path),
    read: path => m.get(path),
    write: (path, text) => void m.set(path, text),
    append: (path, text) => void m.set(path, (m.get(path) ?? '') + text),
    mkdir: () => {},
  };
}

/** A profile, its ctx (no real sleeping) and what profiles.set_older / set_played would have stored. */
function setup(source) {
  const summary = { older: null, played: null };
  const profile = { id: `${source}-me`, source, username: 'me', rawDir: 'p/raw', pgnDir: 'p/pgn' };
  const notes = [];
  const ctx = {
    files: memoryFiles(),
    sleep: async () => {},
    setOlder: (id, v) => { summary.older = v; },
    setPlayed: (id, n) => { summary.played = n; },
    onWait: note => notes.push(note),
  };
  return { profile, ctx, summary, notes };
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const months = ctx => ctx.files.list('p/raw').map(f => f.replace(/\.\w+$/, '')).sort();

// --- chess.com ------------------------------------------------------------------------------------------------

const BASE = 'https://api.chess.com/pub/player/me/games/';

/** chess.com with `ms` {'2026-08': n games}; `statuses` are answered first (429s, say); `played` the games its stats
 * count (null: no stats, a 404). Returns the URLs asked. */
function site(ctx, ms, { statuses = [], played = null } = {}) {
  const asked = [];
  statuses = [...statuses];
  ctx.fetch = async url => {
    asked.push(url);
    if (statuses.length) {
      const [status, headers] = statuses.shift();
      return new Response('', { status, headers });
    }
    if (url.endsWith('/stats')) {
      if (played === null) return json({}, 404);
      return json({ chess_blitz: { record: { win: played - 3, loss: 2, draw: 1 } },
        chess960_daily: { record: { win: 9 } } });      // not standard chess: not counted
    }
    if (url.endsWith('/archives')) return json({ archives: Object.keys(ms).sort().map(k => BASE + k.replace('-', '/')) });
    const key = url.replace(/\/+$/, '').split('/').slice(-2).join('-');
    return json({ games: Array.from({ length: ms[key] }, (_, i) => ({ url: `${key}/${i}` })) });
  };
  return asked;
}

test('chess.com: newest months first until a page', async () => {
  const { profile, ctx, summary } = setup('chesscom');
  const asked = site(ctx, { '2026-06': 30, '2026-07': 12, '2026-08': 5, '2026-09': 8 });
  let stats = await fetchGames(ctx, profile);
  assert.deepEqual(months(ctx), ['2026-07', '2026-08', '2026-09']);     // 8 + 5 + 12 >= 20: June waits
  assert.equal(stats.games, 25);
  assert.equal(stats.older, true);
  assert.equal(summary.older, true);
  assert.equal(asked.length, 5);                                         // the list, three months and the stats
  assert.equal(summary.played, null);                                    // no stats there: just the games fetched

  stats = await fetchGames(ctx, profile, { older: true });
  assert.deepEqual(months(ctx), ['2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(stats, { listed: 4, fetched: 1, skipped: 0, games: 30, older: false });
  assert.equal(summary.older, false);
});

test('chess.com: counts every game played from its stats', async () => {
  const { profile, ctx, summary } = setup('chesscom');
  site(ctx, { '2026-08': 5, '2026-09': 8 }, { played: 1234 });
  await fetchGames(ctx, profile);
  assert.equal(summary.played, 1234);                                    // blitz's 1231 + 2 + 1, not chess960's
  site(ctx, { '2026-08': 5, '2026-09': 9 }, { played: 1235 });
  await fetchGames(ctx, profile, { refresh: true });
  assert.equal(summary.played, 1235);
});

test('chess.com: a first fetch cut short picks up where it stopped', async () => {
  const { profile, ctx } = setup('chesscom');
  site(ctx, { '2026-07': 15, '2026-08': 5, '2026-09': 8 });
  ctx.files.write('p/raw/2026-09.json', JSON.stringify({ games: Array(8).fill({ url: 'x' }) }));
  const stats = await fetchGames(ctx, profile);
  assert.deepEqual([stats.fetched, stats.skipped], [2, 1]);
  assert.equal(stats.older, false);
});

test('chess.com: a refresh asks only for the newest month and after', async () => {
  const { profile, ctx } = setup('chesscom');
  site(ctx, { '2026-06': 30, '2026-07': 25, '2026-08': 5 });
  await fetchGames(ctx, profile);                       // August, then July: June stays on the site
  const asked = site(ctx, { '2026-06': 30, '2026-07': 25, '2026-08': 9, '2026-09': 2 });
  await fetchGames(ctx, profile, { refresh: true });
  assert.deepEqual(months(ctx), ['2026-07', '2026-08', '2026-09']);     // never June
  assert.equal(JSON.parse(ctx.files.read('p/raw/2026-08.json')).games.at(-1).url, '2026-08/8');
  assert.deepEqual(asked.map(u => u.slice(BASE.length - 'games/'.length)),
    ['games/archives', 'games/2026/08', 'games/2026/09', 'stats']);
});

test('chess.com: says while it waits out a 429', async () => {
  const { profile, ctx, notes } = setup('chesscom');
  site(ctx, { '2026-09': 3 }, { statuses: [[429, {}], [429, { 'Retry-After': '7' }]] });
  await fetchGames(ctx, profile);
  assert.deepEqual(notes, ['chess.com asked to slow down: trying again in 2 s', null,
    'chess.com asked to slow down: trying again in 7 s', null]);
});

test('chess.com: logs to a log(level, message) function or a logger object alike', async () => {
  for (const kind of ['function', 'object']) {
    const { profile, ctx } = setup('chesscom');
    const lines = [];
    ctx.log = kind === 'function' ? (level, message) => lines.push(level)
      : { info: () => lines.push('info'), warn: () => lines.push('warning'), error: () => lines.push('error') };
    site(ctx, { '2026-09': 3 }, { statuses: [[429, {}]] });
    await fetchGames(ctx, profile);
    assert.ok(lines.includes('warning') && lines.includes('info'), kind);
  }
});

test('chess.com: gives up after too many 429s', async () => {
  const { profile, ctx } = setup('chesscom');
  site(ctx, { '2026-09': 3 }, { statuses: Array(6).fill([429, {}]) });
  await assert.rejects(fetchGames(ctx, profile), /kept asking to slow down/);
});

test('chess.com: no such player', async () => {
  const { profile, ctx } = setup('chesscom');
  site(ctx, {}, { statuses: [[404, {}]] });
  await assert.rejects(fetchGames(ctx, profile), e => e instanceof NoSuchPlayer
    && e.message === 'chess.com has no user called me');
});

test('chess.com: counts new games without writing', async () => {
  const { profile, ctx } = setup('chesscom');
  site(ctx, { '2026-08': 5, '2026-09': 8 });
  await fetchGames(ctx, profile);
  site(ctx, { '2026-08': 5, '2026-09': 11, '2026-10': 2 });
  const before = new Map(ctx.files.m);
  assert.equal(await countNew(ctx, profile), 2);       // October's two: September is on disk, so the count stops
  assert.deepEqual(ctx.files.m, before);
});

// --- lichess --------------------------------------------------------------------------------------------------

const DAY = 86_400_000;

/** lichess with n games, one a day; the export honours since/until/max/sort as lichess does. */
function lichessSite(ctx, n, { statuses = [] } = {}) {
  const games = Array.from({ length: n }, (_, i) => ({ id: `g${String(i).padStart(3, '0')}`, createdAt: 1780000000000 + i * DAY }));
  const asked = [];
  statuses = [...statuses];
  ctx.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/user/')) return json({ count: { all: n } });
    assert.equal(init.headers.Accept, 'application/x-ndjson');
    const params = Object.fromEntries(u.searchParams);
    asked.push(params);
    if (statuses.length) return new Response('', { status: statuses.shift() });
    let out = games.filter(g => g.createdAt >= Number(params.since ?? 0) && g.createdAt <= Number(params.until ?? 2 ** 60));
    if (params.sort === 'dateDesc') out.reverse();
    out = out.slice(0, Number(params.max ?? out.length));
    return new Response(out.map(g => JSON.stringify(g)).join('\n') + '\n');
  };
  return { games, asked };
}

const ids = ctx => ctx.files.list('p/raw').flatMap(f => ctx.files.read(`p/raw/${f}`).split('\n').filter(Boolean)
  .map(l => JSON.parse(l).id)).sort();
const range = (a, b) => Array.from({ length: b - a }, (_, i) => `g${String(a + i).padStart(3, '0')}`);

test('lichess: pages back from the newest', async () => {
  const { profile, ctx, summary } = setup('lichess');
  const { games, asked } = lichessSite(ctx, 45);
  assert.equal((await fetchGames(ctx, profile)).older, true);
  assert.deepEqual(ids(ctx), range(25, 45));
  assert.equal(asked.at(-1).max, String(PAGE));
  assert.equal(asked.at(-1).sort, 'dateDesc');
  assert.equal(asked.at(-1).until, undefined);
  assert.equal(asked.at(-1).perfType, 'ultraBullet,bullet,blitz,rapid,classical,correspondence');
  assert.equal(summary.played, 45);

  await fetchGames(ctx, profile, { older: true });
  assert.equal(asked.at(-1).until, String(games[25].createdAt - 1));
  assert.deepEqual(ids(ctx), range(5, 45));
  assert.equal(summary.older, true);

  assert.deepEqual(await fetchGames(ctx, profile, { older: true }), { fetched: 5, skipped: 0, older: false });
  assert.equal(ids(ctx).length, 45);
  assert.equal(summary.older, false);
});

test('lichess: a refresh asks only for newer games', async () => {
  const { profile, ctx } = setup('lichess');
  const { games, asked } = lichessSite(ctx, 30);
  await fetchGames(ctx, profile);
  assert.deepEqual(await fetchGames(ctx, profile, { refresh: true }), { fetched: 0, skipped: 1 });   // the newest comes back from `since`
  assert.equal(asked.at(-1).since, String(games.at(-1).createdAt));
  assert.equal(asked.at(-1).max, undefined);
  assert.equal(ids(ctx).length, 20);
});

test('lichess: says while it waits out a 429', async () => {
  const { profile, ctx, notes } = setup('lichess');
  lichessSite(ctx, 3, { statuses: [429] });
  await fetchGames(ctx, profile);
  assert.deepEqual(notes, ['lichess asked to slow down: trying again in a minute', null]);
  assert.equal(ids(ctx).length, 3);
});

test('lichess: no such player, a closed account', async () => {
  const { profile, ctx } = setup('lichess');
  ctx.fetch = async () => json({}, 404);
  await assert.rejects(fetchGames(ctx, profile), { name: 'NoSuchPlayer', message: 'no lichess player called me' });
  ctx.fetch = async () => json({ disabled: true });
  await assert.rejects(fetchGames(ctx, profile), { message: 'lichess account me is closed' });
});

const PGN = `[Event "rated blitz game"]
[Site "https://lichess.org/PndlSDZg"]
[UTCDate "2026.10.12"]
[UTCTime "14:04:47"]
[White "thibault"]
[Black "Pehachzed"]
[Result "0-1"]
[Variant "Standard"]
[TimeControl "300+3"]

1. f3 { [%clk 0:05:00] } 1... e5 { [%clk 0:05:00] } 2. g4 { [%clk 0:04:58] } 2... Qh4# { [%clk 0:04:59] } 0-1
`;

const lichessGame = (id, createdAt) => ({ id, rated: true, variant: 'standard', speed: 'blitz', createdAt,
  status: 'mate', winner: 'black',
  players: { white: { user: { name: 'thibault', id: 'thibault' }, rating: 1749, ratingDiff: -5 },
    black: { user: { name: 'Pehachzed', id: 'pehachzed' }, rating: 1800, ratingDiff: 7 } },
  opening: { eco: 'C20', name: "Barnes Opening: Fool's Mate" }, clock: { initial: 300, increment: 3 }, pgn: PGN });

test('lichess: fetch, then a refresh asks only for newer games, and normalise reads them', async () => {
  const { ctx } = setup('lichess');
  const profile = { id: 'lichess-thibault', source: 'lichess', username: 'thibault', rawDir: 'p/raw', pgnDir: 'p/pgn' };
  const [sep, oct1, oct2] = [1788000000000, 1791000000000, 1791813887348];      // 2026-08-29, 2026-10-03, 2026-10-12
  const games = [lichessGame('a', sep), lichessGame('b', oct1)];
  const asked = [];
  ctx.fetch = async url => {
    const u = new URL(url);
    if (u.pathname.startsWith('/api/user/')) return json({ count: { all: games.length } });
    const params = Object.fromEntries(u.searchParams);
    asked.push(params);
    return new Response(games.filter(g => g.createdAt >= Number(params.since ?? 0)).map(g => JSON.stringify(g) + '\n').join(''));
  };
  assert.equal((await fetchGames(ctx, profile)).fetched, 2);
  assert.deepEqual(ctx.files.list('p/raw').sort(), ['2026-08.ndjson', '2026-10.ndjson']);

  games.push(lichessGame('c', oct2));
  assert.equal(await countNew(ctx, profile), 1);
  assert.deepEqual(await fetchGames(ctx, profile, { refresh: true }), { fetched: 1, skipped: 1 });   // "b" comes back from `since`
  assert.equal(asked.at(-1).since, String(oct1));
  assert.equal(ctx.files.read('p/raw/2026-10.ndjson').split('\n').filter(Boolean).length, 2);
  assert.equal(await countNew(ctx, profile), 0);

  const lichess = ctx.files.list('p/raw').map(name => ({ name, text: ctx.files.read(`p/raw/${name}`) }));
  assert.equal(normalise({ lichess }, 'thibault').stats.games, 3);
});

test('lichess: the raw lines are written as Python writes them (ASCII, no spaces)', async () => {
  const { profile, ctx } = setup('lichess');
  ctx.fetch = async url => url.includes('/api/user/') ? json({ count: { all: 1 } })
    : new Response(JSON.stringify({ id: 'x', createdAt: 1780000000000, players: { white: { user: { name: 'Zo\u00eb \ud83d\ude00' } } } }));
  await fetchGames(ctx, profile);
  assert.equal(ctx.files.read('p/raw/2026-05.ndjson'),
    '{"id":"x","createdAt":1780000000000,"players":{"white":{"user":{"name":"Zo\\u00eb \\ud83d\\ude00"}}}}\n');
});

// --- the requests ---------------------------------------------------------------------------------------------

const stream = (chunks, { stall = false } = {}) => new Response(new ReadableStream({
  async pull(controller) {
    if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
    else if (stall) await new Promise(() => {});
    else controller.close();
  },
}));

test('requests: a streamed body comes as whole lines, whatever its chunks', async () => {
  const r = await send({ fetch: async () => stream(['{"a":1}\n{"b"', ':2}\n\n{"c":3}']) }, { url: 'https://x.org/', stream: true });
  const lines = [];
  let got;
  while ((got = await r.lines()) !== null) lines.push(...got);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '', '{"c":3}']);
});

test('requests: params, headers and the user agent', async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, headers: init.headers };
    return new Response('{}');
  };
  await send({ fetch, userAgent: 'blundr/1' }, { url: 'https://x.org/a', params: { perfType: 'a,b', max: 20, q: "x y'*~" },
    headers: { Accept: 'application/json' } });
  assert.equal(seen.url, 'https://x.org/a?perfType=a%2Cb&max=20&q=x+y%27%2A~');
  assert.deepEqual(seen.headers, { Accept: 'application/json', 'User-Agent': 'blundr/1' });
  await send({ fetch }, { url: 'https://x.org/a' });
  assert.equal(seen.url, 'https://x.org/a');
  assert.deepEqual(seen.headers, {});
});

test('requests: each ends one way or the other', async () => {
  await assert.rejects(send({ fetch: () => new Promise(() => {}) }, { url: 'https://lichess.org/api', timeout: 0.05 }),
    e => e instanceof TimeoutError && e.message === "lichess.org didn't answer within 0.05 s");
  await assert.rejects(send({ fetch: async () => stream(['{'], { stall: true }) }, { url: 'https://x.org/', timeout: 0.05 }),
    e => e instanceof TimeoutError && e.message === 'x.org stopped answering (0.05 s without data)');
  await assert.rejects(send({ fetch: async () => { throw new TypeError('Failed to fetch'); } }, { url: 'https://x.org/' }),
    e => e instanceof ConnectionError && e.message === "couldn't reach x.org: Failed to fetch");
  const r = await send({ fetch: async () => new Response('', { status: 503 }) }, { url: 'https://x.org/m' });
  assert.throws(() => r.raiseForStatus(), { name: 'HTTPError', message: '503 Server Error for url: https://x.org/m' });
});

// --- pasted PGNs ----------------------------------------------------------------------------------------------

test('store_pgn: the same digest and file as Python', async () => {
  for (const [text, reviewAs, digest, stored] of load('normalise.json').store_pgn) {
    same(await pgnFile(text, reviewAs), { digest, text: stored }, `pgnFile(${JSON.stringify(text.slice(0, 30))}, ${reviewAs})`);
  }
});

test('store_pgn: written once, under its digest, with Node\'s files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  try {
    const ctx = { files: nodeFiles };
    const profile = { pgnDir: join(dir, 'pgn') };
    const digest = await storePgn(ctx, profile, '1. e4 e5 *\r\n', 'black');
    assert.equal(digest, (await pgnFile('1. e4 e5 *', 'black')).digest);
    assert.equal(await readFile(join(dir, 'pgn', `${digest}.pgn`), 'utf8'), '[ReviewAs "black"]\n1. e4 e5 *\n');
    assert.equal(await storePgn(ctx, profile, '1. e4 e5 *', 'black'), digest);
    assert.deepEqual(await nodeFiles.list(join(dir, 'pgn')), [`${digest}.pgn`]);
    assert.deepEqual(await nodeFiles.list(join(dir, 'nothing')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
