// What the route dump can't show of sync.js: the games in a profile's database travel with it into the workspace and
// back, a profile a job is on stays put, and the profiles' change is announced (own puzzles' cache).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { nodeSqlite } from './db-node.js';
import { EVALS, GAMES_SCHEMA, PROFILE_DDL, Store, profileDb } from './db.js';
import { nodeFiles } from './profiles-files-node.js';
import { memoryFiles } from './profiles-files.js';
import { Profiles } from './profiles.js';
import { Sync, diff, merge, profileKey, rowLine, tidy } from './sync.js';

async function setup(kind) {
  const dir = mkdtempSync(join(tmpdir(), 'blundr-sync-'));
  const files = kind === 'memory' ? memoryFiles() : nodeFiles(dir);
  const store = new Store(nodeSqlite(dir));
  const profiles = new Profiles(files, store);
  const done = async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, files, store, profiles, done };
}

const game = { game_id: 'g1', played_at: '2026-01-01T00:00:00', time_control: '600', time_class: 'rapid', my_colour: 'white',
               my_rating: 1500, opponent_rating: 1500, result: 'win', termination: 'mate', eco: 'C50', opening_name: 'Italian',
               opponent: 'x', my_name: 'alice' };

for (const kind of ['memory', 'disk']) {
  test(`sync (${kind}): a profile's games go into the workspace with it and come back`, async () => {
    const { files, store, profiles, done } = await setup(kind);
    try {
      let switched = 0;
      const sync = new Sync({ files, store, onSwitch: () => { switched++; } });
      const p = await profiles.create('chesscom', 'alice');
      (await store.profile(p)).insert('games', GAMES_SCHEMA, [game]);
      await sync.writeLines('', 'profiles/chesscom-alice/puzzle_attempts.jsonl', ['{"id": "a", "ts": 1, "solved": true, "ms": null, "hinted": false}']);
      await sync.saveBase('u1', {});

      assert.deepEqual(await sync.switch(null), { switched: true });
      assert.equal(switched, 1);
      assert.equal(await profiles.load('chesscom-alice'), null);
      assert.equal(await store.driver.exists(profileDb('chesscom-alice')), false);
      const aside = await store.connect(`.accounts/u1/${profileDb('chesscom-alice')}`, PROFILE_DDL, [[EVALS, 'ev']]);
      assert.deepEqual(aside.column('SELECT game_id FROM games'), ['g1']);
      await store.close(`.accounts/u1/${profileDb('chesscom-alice')}`);

      assert.deepEqual(await sync.switch('u1'), { switched: true });
      assert.equal(await sync.owner(), 'u1');
      assert.deepEqual((await store.profile('chesscom-alice')).column('SELECT game_id FROM games'), ['g1']);
      assert.deepEqual(await sync.readLines('', 'profiles/chesscom-alice/puzzle_attempts.jsonl'),
        ['{"id": "a", "ts": 1, "solved": true, "ms": null, "hinted": false}']);
      assert.equal(await files.exists('.accounts/u1'), false);
      assert.equal(await store.driver.exists(`.accounts/u1/${profileDb('chesscom-alice')}`), false);
    } finally {
      await done();
    }
  });
}

test('sync: nothing moves while a job is on a synced profile; a profile gone elsewhere stays while busy', async () => {
  const { files, store, profiles, done } = await setup('memory');
  try {
    const cancelled = [];
    const runner = { busyOn: 'chesscom-alice', busy() { return this.busyOn !== null; },
                     get job() { return { profile: { id: this.busyOn } }; }, async cancelBuild(pid) { cancelled.push(pid); } };
    const sync = new Sync({ files, store, runner });
    await profiles.create('chesscom', 'alice');
    await profiles.create('lichess', 'bob');
    assert.deepEqual(await sync.switch('u1'), { busy: true });
    assert.deepEqual(await sync.release(), { busy: true });

    await sync.applyProfiles([], []);       // the account has neither: bob goes, alice (busy) stays
    assert.deepEqual((await profiles.list()).map(p => p.id), ['chesscom-alice']);
    assert.deepEqual(cancelled, ['lichess-bob']);
    runner.busyOn = null;
    await sync.applyProfiles([], []);
    assert.deepEqual(await profiles.list(), []);
    assert.deepEqual(cancelled, ['lichess-bob', 'chesscom-alice']);
  } finally {
    await done();
  }
});

test('sync: lines as Python wrote them, and the merge', () => {
  assert.equal(rowLine('puzzle_attempts', { id: 'x', ts: 5, solved: false, ms: null, hinted: true, rating: 1600, archive: null, seq: 3 }),
    '{"id": "x", "ts": 5, "solved": false, "ms": null, "hinted": true, "rating": 1600}');
  assert.equal(rowLine('puzzle_attempts', { id: 'x', ts: 5, solved: true, ms: 10, hinted: false, rating: null }),
    '{"id": "x", "ts": 5, "solved": true, "ms": 10, "hinted": false}');
  assert.equal(rowLine('puzzle_daily', { date: 'd', n: 1, id: 'i', solved: true, clean: false, ms: null, marks: ['é'] }),
    '{"date": "d", "n": 1, "id": "i", "solved": true, "clean": false, "ms": null, "marks": ["\\u00e9"]}');
  assert.equal(profileKey('{"source": "lichess", "username": " Bob "}'), 'lichess-bob');
  assert.equal(profileKey('{"source": null, "username": "bob"}'), null);
  const [add, remove] = diff({ f: ['a', 'b'] }, { f: ['b', 'c', 'c'], g: ['d'] });
  assert.deepEqual([add, remove], [{ f: ['c'], g: ['d'] }, { f: ['a'] }]);
  const l = (id, ts) => `{"id": "${id}", "ts": ${ts}}`;
  assert.deepEqual(tidy('puzzle_solved.jsonl', [l('b', 2), l('a', 1), l('b', 3)]), [l('a', 1), l('b', 2)]);
  assert.deepEqual(merge({ 'puzzle_solved.jsonl': [l('a', 1)] }, { 'puzzle_solved.jsonl': [l('c', 3)] },
    { 'puzzle_solved.jsonl': [l('a', 1), l('b', 2)] }), { 'puzzle_solved.jsonl': [l('b', 2), l('c', 3)] });
  // a puzzle solved clean on one browser and late on another: the clean line stays, whichever came first; a row
  // without clean is the line Python wrote
  const c = (id, ts) => `{"id": "${id}", "ts": ${ts}, "clean": true}`;
  assert.equal(rowLine('puzzle_solved', { id: 'a', ts: 1, clean: null }), l('a', 1));
  assert.equal(rowLine('puzzle_solved', { id: 'a', ts: 1, clean: true }), c('a', 1));
  assert.deepEqual(tidy('puzzle_solved.jsonl', [l('a', 1), c('a', 4), l('b', 2), c('b', 3), c('c', 5), l('c', 6)]), [c('a', 4), c('b', 3), c('c', 5)]);
  assert.deepEqual(merge({ 'puzzle_solved.jsonl': [l('a', 1)] }, { 'puzzle_solved.jsonl': [c('a', 1)] },
    { 'puzzle_solved.jsonl': [l('a', 1), l('b', 2)] }), { 'puzzle_solved.jsonl': [c('a', 1), l('b', 2)] });
  assert.deepEqual(merge({ 'puzzle_solved.jsonl': [l('a', 1)] }, { 'puzzle_solved.jsonl': [l('a', 1)] },
    { 'puzzle_solved.jsonl': [c('a', 1)] }), { 'puzzle_solved.jsonl': [c('a', 1)] });
  const pinned = '{"added": null, "pinned": "2026", "source": "lichess", "username": "bob"}';
  const unpinned = '{"added": null, "pinned": null, "source": "lichess", "username": "bob"}';
  assert.deepEqual(tidy('profiles.jsonl', [unpinned, pinned]), [pinned]);
});
