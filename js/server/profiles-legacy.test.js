// profiles.migrate_legacy and the CLI's resolve: a pre-profiles data directory moved into profiles/<id>/, and the
// profile a command means.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';

const NOW = Date.UTC(2026, 9, 23, 12);

test('migrateLegacy: the one user\'s files into their profile, what is there already kept', async () => {
  const files = memoryFiles();
  const ps = new Profiles(files);
  assert.equal(await ps.migrateLegacy(NOW), null);
  await files.writeText('meta.json', '{"username": "Old_User"}');
  await files.writeText('raw/2024-01.json', '{"games": []}');
  await files.writeText('pgn/abc.pgn', '1. e4 *\n');
  await files.writeText('games.parquet', 'G');
  await files.writeText('moves.parquet', 'M');
  await files.writeText('site/games.json', '{"games": []}');
  await files.writeText('site/games/a.json', '{}');
  await files.writeText('site/insights.html', 'old');
  await files.writeText('site/index.html', 'the app');
  await files.writeText('profiles/chesscom-old_user/site/insights.html', 'new');      // already there: stays

  const p = await ps.migrateLegacy(NOW);
  assert.equal(p.id, 'chesscom-old_user');
  assert.equal(p.username, 'Old_User');
  assert.equal(await files.readText(`${p.rawDir}/2024-01.json`), '{"games": []}');
  assert.equal(await files.readText(`${p.pgnDir}/abc.pgn`), '1. e4 *\n');
  assert.equal(await files.readText(`${p.dir}/games.parquet`), 'G');
  assert.equal(await files.readText(`${p.dir}/moves.parquet`), 'M');
  assert.equal(await files.exists(`${p.dir}/positions.parquet`), false);
  assert.equal(await files.readText(`${p.siteDir}/games.json`), '{"games": []}');
  assert.equal(await files.readText(`${p.siteDir}/games/a.json`), '{}');
  assert.equal(await files.readText(`${p.siteDir}/insights.html`), 'new');
  assert.equal(await files.readText('site/insights.html'), 'old');
  assert.equal(await files.readText('site/index.html'), 'the app');
  for (const gone of ['meta.json', 'raw', 'pgn', 'games.parquet', 'site/games.json', 'site/games']) {
    assert.equal(await files.exists(gone), false, gone);
  }
  assert.equal(await files.readText(p.metaJson), '{"source": "chesscom", "username": "Old_User", "created": "2026-10-23T12:00:00+00:00"}');
  assert.equal(await ps.migrateLegacy(NOW), null);
});

test('migrateLegacy: no username is "me"', async () => {
  const files = memoryFiles();
  await files.writeText('meta.json', '{}');
  assert.equal((await new Profiles(files).migrateLegacy(NOW)).id, 'chesscom-me');
});

test('resolve: the named profile, or the only one', async () => {
  const files = memoryFiles();
  const ps = new Profiles(files);
  await assert.rejects(ps.resolve(), { message: '--profile required (none exist yet; create one from the UI or with `ingest --username`)' });
  await assert.rejects(ps.resolve('lichess-x'), { message: 'no such profile: lichess-x (have: none)' });
  const a = await ps.create('chesscom', 'a', NOW);
  assert.equal((await ps.resolve()).id, a.id);
  assert.equal((await ps.resolve('chesscom-a')).id, a.id);
  await ps.create('lichess', 'b', NOW);
  await assert.rejects(ps.resolve(), { message: '--profile required (one of: chesscom-a, lichess-b)' });
  await assert.rejects(ps.resolve('pgn-c'), { message: 'no such profile: pgn-c (have: chesscom-a, lichess-b)' });
  await files.writeText('meta.json', '{"username": "legacy"}');          // migrated first, as in Python
  assert.equal((await ps.resolve('chesscom-legacy')).id, 'chesscom-legacy');
});
