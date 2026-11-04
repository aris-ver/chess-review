// profiles.js on both files adapters that run under Node (memory, node:fs). summary() and the meta.json bytes are
// checked against Python in db-parity.test.js; this is the rest of the module, with meta.json as Python writes it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { nodeSqlite } from './db-node.js';
import { Store } from './db.js';
import { memoryFiles } from './profiles-files.js';
import { nodeFiles } from './profiles-files-node.js';
import { parseTs, profileId, Profiles, pyDumps, validId } from './profiles.js';

const NOW = Date.UTC(2026, 9, 23, 12);

async function exercise(files, store) {
  const ps = new Profiles(files, store);
  assert.deepEqual(await ps.list(), []);
  const a = await ps.create('chesscom', ' Some_User ', NOW);
  assert.equal(a.id, 'chesscom-some_user');
  assert.equal(a.username, 'Some_User');
  await ps.create('lichess', 'x', NOW);
  await files.mkdir('profiles/not-a-profile');                 // no meta.json: not listed
  assert.deepEqual((await ps.list()).map(p => p.id), ['chesscom-some_user', 'lichess-x']);
  assert.equal(await ps.load('../evil'), null);

  await ps.addUnseen(a.id, ['g2', 'g1']);
  await ps.addUnseen(a.id, ['g1', 'g3']);
  await ps.markSeen(a.id, 'g2');
  await ps.setOlder(a.id, true);
  await ps.setPlayed(a.id, 7);
  await ps.markShown(a.id, ['g3']);
  assert.equal(await files.readText(a.metaJson),
    '{"source": "chesscom", "username": "Some_User", "created": "2026-10-23T12:00:00+00:00", "unseen": ["g1", "g3"], '
    + '"older": true, "played": 7, "shown": ["g3"]}');
  await ps.expireShown();
  assert.equal(await files.readText(a.metaJson),
    '{"source": "chesscom", "username": "Some_User", "created": "2026-10-23T12:00:00+00:00", "unseen": ["g1"], '
    + '"older": true, "played": 7}');
  const s = await ps.setPinned(a.id, true, NOW);
  assert.equal(s.pinned, '2026-10-23T12:00:00+00:00');
  assert.equal(s.played, 7);                         // max(played, games) with no games.json yet
  assert.equal((await ps.setPinned(a.id, false, NOW)).pinned, null);

  assert.deepEqual([...(await ps.gameIds(a))], []);
  await files.writeText(`${a.siteDir}/games.json`, JSON.stringify({ games: [{ id: 'g1' }, { id: 'g2' }] }));
  assert.deepEqual([...(await ps.gameIds(a))].sort(), ['g1', 'g2']);
  await files.writeText(`${a.siteDir}/games.json`, '{broken');
  assert.equal((await ps.summary(a, NOW)).games, 0);

  if (store) (await store.profile(a)).run("INSERT INTO games (game_id) VALUES ('g1')");
  assert.equal(await ps.remove(a.id), true);
  assert.equal(await ps.remove(a.id), false);
  assert.equal(await files.exists(a.dir), false);
  assert.deepEqual((await ps.list()).map(p => p.id), ['lichess-x']);
  if (store) {
    assert.equal(await store.driver.exists(a.db), false);
    assert.equal((await store.profile(a)).value('SELECT count(*) FROM games'), 0);   // a new profile starts empty
  }
}

async function adapter(files) {
  await files.writeText('a/b/c.txt', 'one');
  await files.appendText('a/b/c.txt', ' two');
  await files.appendText('a/new.txt', 'x');
  assert.equal(await files.readText('a/b/c.txt'), 'one two');
  assert.equal(await files.readText('a/missing.txt'), null);
  assert.deepEqual(await files.list('a'), [{ name: 'b', dir: true }, { name: 'new.txt', dir: false }]);
  assert.deepEqual(await files.list('nowhere'), []);
  await files.rename('a/b', 'z/y');
  assert.equal(await files.readText('z/y/c.txt'), 'one two');
  assert.equal(await files.exists('a/b'), false);
  await files.writeBytes('bin', new Uint8Array([0, 255]));
  assert.deepEqual([...(await files.readBytes('bin'))], [0, 255]);
  await files.remove('z');
  await files.remove('z');
  assert.equal(await files.exists('z/y/c.txt'), false);
}

test('profiles: ids, timestamps, json.dumps', () => {
  assert.equal(profileId('pgn', 'Ünï Côde!!'), 'pgn-n-c-de');
  assert.throws(() => profileId('fide', 'x'));
  assert.throws(() => profileId('pgn', '!!!'));
  assert.equal(validId('a..b'), false);
  assert.equal(pyDumps({ a: [1, true, null], 'é': 'ü\n"' }), '{"a": [1, true, null], "\\u00e9": "\\u00fc\\n\\""}');
  assert.equal(pyDumps('😀'), '"\\ud83d\\ude00"');
  assert.equal(parseTs('2026-10-23T12:00:00'), NOW);
  assert.equal(parseTs('2026-10-23T14:00:00+02:00'), NOW);
  assert.equal(parseTs('2026-10-23 12:00Z'), NOW);
  assert.equal(parseTs('2026-02-30'), null);
  assert.equal(parseTs(''), null);
});

test('profiles: in memory', async () => {
  await adapter(memoryFiles());
  await exercise(memoryFiles(), null);
});

test('profiles: on disk, with their databases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-profiles-'));
  try {
    await adapter(nodeFiles(join(dir, 'adapter')));
    const store = new Store(nodeSqlite(join(dir, 'data')));
    await exercise(nodeFiles(join(dir, 'data')), store);
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
