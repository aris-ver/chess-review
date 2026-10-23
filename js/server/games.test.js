// From the site to rows in the database: a fake chess.com and a fake lichess serve the raw files of
// tests/parity/aggregates.json's pipeline cases, games.js fetches and rebuilds, and the rows come out as Python's
// normalise.build wrote them. Then a refresh, a pasted PGN and the new-games count on the same profiles.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { load, same } from '../parity.js';
import { nodeSqlite } from './db-node.js';
import { Store } from './db.js';
import { addPgn, countNew, ingestFiles, ingestProfile, normaliseProfile, rawFiles, refreshProfile } from './games.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** chess.com with months {"2024-01.json": text}, or lichess with {"2025-12.ndjson": lines}: a fetch. */
function site(source, username, raw) {
  const asked = [];
  const fetch = async url => {
    asked.push(url);
    if (source === 'chesscom') {
      const base = `https://api.chess.com/pub/player/${username}/games/`;
      if (url.endsWith('/stats')) return json({ chess_blitz: { record: { win: 40, loss: 30, draw: 3 } } });
      if (url.endsWith('/archives')) return json({ archives: Object.keys(raw).sort().map(f => base + f.slice(0, 7).replace('-', '/')) });
      const month = url.split('/').slice(-2).join('-');
      return new Response(raw[`${month}.json`]);
    }
    if (url.startsWith('https://lichess.org/api/user/')) return json({ id: username, count: { all: 99 } });
    const since = Number(new URL(url).searchParams.get('since') ?? 0);
    const lines = Object.keys(raw).sort().flatMap(f => raw[f].split('\n').filter(Boolean))
      .filter(l => JSON.parse(l).createdAt >= since);
    return new Response(lines.map(l => l + '\n').join(''));
  };
  return { fetch, asked };
}

async function setup(dir, source, username, raw) {
  const store = new Store(nodeSqlite(dir));
  const files = memoryFiles();
  const profiles = new Profiles(files, store);
  const { fetch, asked } = site(source, username, raw);
  const env = { store, files, profiles, fetch, sleep: async () => {} };
  const p = await profiles.create(source, username);
  return { env, p, asked, store, files, profiles };
}

for (const source of ['chesscom', 'lichess']) {
  test(`${source}: fetched and normalised into the rows Python writes`, async () => {
    const c = load('aggregates.json').pipeline[source];
    const dir = mkdtempSync(join(tmpdir(), 'blundr-games-'));
    const { env, p, files, profiles, store } = await setup(dir, source, c.username, c.raw);
    try {
      same(p.id, c.id, 'profile id');
      const steps = [];
      const out = await ingestProfile(env, p, { onStep: s => steps.push(s) });
      same(steps, ['normalise', 'site', 'aggregates'], 'steps');
      for (const [f, text] of Object.entries(c.raw)) same(await files.readText(`${p.rawDir}/${f}`), text, `raw/${f}`);
      same(out.normalise, c.stats, 'normalise stats');
      const db = await store.profile(p);
      same(db.all('SELECT * FROM games ORDER BY game_id'), c.games, 'games');
      same(db.all('SELECT * FROM positions ORDER BY game_id, ply'), c.positions, 'positions');
      assert.ok(out.classify.moves > 0, 'classified');
      same(out.aggregates.games, 0, 'insights: nothing analysed yet');
      assert.match(await files.readText(`${p.siteDir}/insights.html`), /<title>Insights · /);
      const summary = await profiles.summary(p);
      same([summary.older, summary.played], [false, source === 'chesscom' ? 73 : 99], 'older, played');

      // nothing new: a refresh adds nothing and flags nothing; the count agrees
      same(await countNew(env, p), 0, 'count_new');
      const again = await refreshProfile(env, p);
      same(again.added, [], 'refresh: added');
      same(db.all('SELECT * FROM games ORDER BY game_id'), c.games, 'games after the refresh');
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('refresh: the games it brings in are flagged new', async () => {
  const c = load('aggregates.json').pipeline.chesscom;
  const [first, second] = Object.keys(c.raw).sort();
  const dir = mkdtempSync(join(tmpdir(), 'blundr-games-'));
  const { env, p, store, profiles } = await setup(dir, 'chesscom', c.username, { [first]: JSON.stringify({ games: [] }) });
  try {
    await ingestProfile(env, p);
    same((await store.profile(p)).value('SELECT count(*) FROM games'), 0, 'no games yet');
    Object.assign(env, site('chesscom', c.username, { [first]: JSON.stringify({ games: [] }), [second]: c.raw[second] }));
    same(await countNew(env, p) > 0, true, 'count_new sees the new month');
    const out = await refreshProfile(env, p);
    same(out.added.length > 0, true, 'added');
    same((await profiles.summary(p)).unseen, out.added, 'unseen');
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pasted PGN: filed under its digest, its games found and normalised', async () => {
  const pgn = load('normalise.json').pgn.find(c => c.out.length > 0);
  const dir = mkdtempSync(join(tmpdir(), 'blundr-games-'));
  const { env, store, profiles, files } = await setup(dir, 'pgn', pgn.username, {});
  try {
    const p = await profiles.create('pgn', pgn.username);
    const { digest, gameIds } = await addPgn(env, p, pgn.text);
    assert.ok(await files.exists(`${p.pgnDir}/${digest}.pgn`));
    same(gameIds, pgn.out.map(([row]) => row.game_id.replace(`pgn:${pgn.digest}:`, `pgn:${digest}:`)), 'game ids');
    const stats = await normaliseProfile(env, p);
    same(stats.games, new Set(gameIds).size, 'games');
    same((await store.profile(p)).column('SELECT game_id FROM games ORDER BY game_id'), [...new Set(gameIds)].sort(), 'rows');
    same((await addPgn(env, p, 'not a game')).gameIds, [], 'no game');
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestFiles: names of files only, reads that throw on a missing file', async () => {
  const files = memoryFiles();
  await files.writeText('p/raw/2024-01.json', '{}');
  await files.mkdir('p/raw/sub');
  const f = ingestFiles(files);
  same(await f.list('p/raw'), ['2024-01.json'], 'list');
  same(await f.list('nowhere'), [], 'list of nothing');
  await f.append('p/raw/a.ndjson', 'x\n');
  await f.append('p/raw/a.ndjson', 'y\n');
  same(await f.read('p/raw/a.ndjson'), 'x\ny\n', 'append');
  await assert.rejects(f.read('p/raw/none.json'));
  same(Object.keys(await rawFiles(files, { rawDir: 'p/raw', pgnDir: 'p/pgn' })), ['chesscom', 'lichess', 'pgn'], 'rawFiles');
});
