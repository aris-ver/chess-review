// The review files against Python's (scripts/dump_site_parity.py: tests/parity/site.json, and with --local
// tests/parity/local/site-*.json): the profiles of the storage dump loaded into SQLite, then build, writeGame and
// updateIndex, and every file they write compared field for field. Not byte for byte: JSON.stringify writes a
// whole float without its ".0" (50 where json.dumps writes 50.0) and without json.dumps' spaces, and the review's
// fingerprint ("fp") isn't Python's digest, so it is left out of the comparison.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PARITY, load, same } from '../parity.js';
import { setBook } from '../core/book.js';
import { writeResults } from './eval-cache.js';
import { nodeSqlite } from './db-node.js';
import { EVALS_MULTIPV_SCHEMA, EVALS_SCHEMA, Store, writeGames } from './db.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { build, evalText, slug, updateIndex, writeGame } from './site.js';

async function replay(c, expected, driver) {
  const store = new Store(driver);
  const files = memoryFiles();
  try {
    setBook(c.book);
    const p = await new Profiles(files, store).create(c.source, c.username, Date.parse(c.now));
    const db = await store.profile(p);
    writeGames(db, c.games, c.positions);
    db.insert('evals', EVALS_SCHEMA, c.cache.evals);
    db.insert('evals_multipv', EVALS_MULTIPV_SCHEMA, c.cache.multipv);
    writeResults(db, c.results);

    const name = expected.name;
    const stats = await build(db, files, p);
    same({ games: stats.games, rebuilt: stats.rebuilt }, expected.build, `${name}.build`);
    const again = await build(db, files, p);
    same({ games: again.games, rebuilt: again.rebuilt }, expected.again, `${name}.again`);
    same(JSON.parse(await files.readText(`${p.siteDir}/games.json`)), expected.games_json, `${name}.games.json`);
    const written = (await files.list(`${p.siteDir}/games`)).map(e => e.name.replace(/\.json$/, ''));
    same(written, Object.keys(expected.reviews).sort(), `${name} review files`);
    for (const [id, want] of Object.entries(expected.reviews)) {
      const { fp, ...review } = JSON.parse(await files.readText(`${p.siteDir}/games/${id}.json`));
      assert.match(fp, /^[0-9a-f]{40}$/);
      same(review, want, `${name}.reviews[${id}]`);
    }

    const entry = await writeGame(db, files, p, expected.write_game.game_id);
    same(entry, expected.write_game.entry, `${name}.write_game`);
    await updateIndex(files, p, entry);
    await updateIndex(files, p, { ...entry, id: 'extra', played_at: '2025-06-01T00:00:00' });
    same(JSON.parse(await files.readText(`${p.siteDir}/games.json`)), expected.updated, `${name}.updated`);
  } finally {
    await store.close();
  }
}

async function replayAll(pairs) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-site-'));
  try {
    for (const [i, [c, expected]] of pairs.entries()) await replay(c, expected, nodeSqlite(join(dir, String(i))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('site: the review files as Python writes them', async () => {
  const storage = load('storage.json'), site = load('site.json');
  assert.equal(storage.length, site.length);
  await replayAll(storage.map((c, i) => [c, site[i]]));
});

const localSite = name => PARITY + `local/site-${name}.json`;
const local = existsSync(PARITY + 'local/')
  ? readdirSync(PARITY + 'local/').filter(f => /^storage-.*\.json$/.test(f)).sort()
    .map(f => JSON.parse(readFileSync(PARITY + 'local/' + f, 'utf8')))
    .filter(c => existsSync(localSite(c.name))) : [];

test('site: your profiles, as in Python', { skip: !local.length && 'no tests/parity/local site dump' }, async () => {
  await replayAll(local.map(c => [c, JSON.parse(readFileSync(localSite(c.name), 'utf8'))]));
});

test('site: slug and evalText', () => {
  same(slug('https://www.chess.com/game/live/123456/'), '123456');
  same([slug('https://lichess.org/abcdEFGH'), slug('fuzz-golden-0'), slug('pgn:ä')], ['9c02a3c328c5', '7370e79bef08', 'b61f19ac28de']);
  same([evalText(0, null, 'white'), evalText(0, null, 'black'), evalText(-4, null, 'white'), evalText(4, null, 'black'),
    evalText(125, null, 'black'), evalText(null, 3, 'white'), evalText(null, 3, 'black'), evalText(null, 0, 'white'),
    evalText(null, null, 'white'), evalText(-5, null, 'white'), evalText(15, null, 'white')],
  ['+0.0', '+0.0', '-0.0', '-0.0', '-1.2', 'M3', '-M3', '#', null, '-0.1', '+0.1']);
});
