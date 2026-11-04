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
import * as O from './own-puzzles.js';
import { Profiles, pyDumps } from './profiles.js';
import { Sync, diff, locate, merge, profileKey, rowLine, tidy } from './sync.js';

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

// ---------- personal puzzles: profiles/<id>/own_puzzles.jsonl ----------

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PID = O.puzzleId('https://www.chess.com/game/live/7', 2);
/** A puzzle's line as ownLine writes it: the opponent's 1.e4, and the solution `moves` after it. */
const own = (moves, follow = '', id = PID) => pyDumps({ id, fen: START, moves: `e2e4 ${moves}`, follow,
  game: { slug: '7', ply: 2, opponent: 'bob', date: '2026-10-20', time_class: 'blitz', played_san: 'a6', label: 'mistake' } });
const OWN_FILE = 'profiles/chesscom-alice/own_puzzles.jsonl';

test('sync: personal puzzles merge one line per id, the same one on every device', () => {
  const short = own('e7e5', 'g1f3'), long = own('e7e5 g1f3 b8c6'), other = own('e7e5', 'g1f3 b8c6');
  assert.equal(O.betterOwn(short, long), long);
  assert.equal(O.betterOwn(long, short), long);
  assert.equal(O.betterOwn(short, other), O.betterOwn(other, short));       // a tie: the greater line, either way round
  const b = own('d7d5', '', O.puzzleId('g', 1));
  assert.deepEqual(tidy(OWN_FILE, [long, b, short, '{"id": "nope"}']), [b, long].sort((x, y) => (JSON.parse(x).id < JSON.parse(y).id ? -1 : 1)));
  // one device settled the longer line (its short one goes, the long one comes), the other still has the short one
  assert.deepEqual(merge({ [OWN_FILE]: [short] }, { [OWN_FILE]: [long] }, { [OWN_FILE]: [short] }), { [OWN_FILE]: [long] });
  assert.deepEqual(merge({}, { [OWN_FILE]: [short] }, { [OWN_FILE]: [long] }), { [OWN_FILE]: [long] });
  assert.deepEqual(locate(OWN_FILE), { db: profileDb('chesscom-alice'), table: 'own_puzzles', archive: null, dir: 'profiles/chesscom-alice' });
  assert.equal(locate('profiles/../own_puzzles.jsonl'), null);
});

test('sync: the puzzles made on one device are played on another, without the games', async () => {
  const a = await setup('memory'), b = await setup('memory');
  try {
    let account = {};     // the Worker: a set of lines per file
    const send = ({ add, remove }) => {
      for (const [f, ls] of Object.entries(remove)) account[f] = (account[f] ?? []).filter(l => !ls.includes(l));
      for (const [f, ls] of Object.entries(add)) account[f] = [...new Set([...(account[f] ?? []), ...ls])];
      account = Object.fromEntries(Object.entries(account).filter(([, ls]) => ls.length));
      return structuredClone(account);
    };
    const device = d => {
      const pool = new O.Pool(d.store);
      let switched = 0;
      const sync = new Sync({ files: d.files, store: d.store, ownPuzzles: id => pool.load({ id }),
                              onSwitch: () => { switched++; pool.cache.clear(); } });
      return { pool, sync, switched: () => switched, round: async () => sync.commit('u1', send(await sync.delta('u1'))) };
    };
    const A = device(a), B = device(b);

    // the desktop: a profile with a puzzle from its games (the Pool's keepOwn put it in the table), and a pasted
    // profile's puzzle, which stays here
    const alice = await a.profiles.create('chesscom', 'alice');
    (await a.store.profile(alice)).insert('games', GAMES_SCHEMA, [{ ...game, game_id: 'https://www.chess.com/game/live/7' }]);
    (await a.store.profile(alice)).run('INSERT INTO own_puzzles (id, line) VALUES (?, ?)', [PID, own('e7e5', 'g1f3')]);
    await a.files.writeText('profiles/pgn-mine/meta.json', '{"source": "pgn", "username": "mine"}');
    (await a.store.profile('pgn-mine')).run('INSERT INTO own_puzzles (id, line) VALUES (?, ?)', [O.puzzleId('p', 1), own('d7d5')]);
    await A.round();
    assert.deepEqual(Object.keys(account).sort(), ['profiles.jsonl', OWN_FILE]);
    assert.deepEqual(account[OWN_FILE], [own('e7e5', 'g1f3')]);
    assert.equal((await a.store.profile(alice)).value('SELECT count(*) FROM own_puzzles'), 1);

    // the phone: the profile arrives with its puzzle, which is dealt with no games here (and no "View in game")
    const got = await B.round();
    assert.deepEqual(got.changed, [OWN_FILE, 'profiles.jsonl']);
    assert.equal(B.switched(), 1);
    const balice = await b.profiles.load('chesscom-alice');
    const [p, st] = await O.nextPuzzle(B.pool, balice, null, 1e9);
    assert.equal(p.id, PID);
    assert.deepEqual(p.moves.map(m => m.san), ['e4', 'e5']);
    assert.deepEqual(p.follow.map(m => m.san), ['Nf3']);
    assert.deepEqual([p.source, p.profile, p.game.opponent, p.game.here], ['mine', 'chesscom-alice', 'bob', false]);
    assert.equal(st.total, 1);
    // its review schedule is the profile's puzzle_attempts, which syncs as before
    await O.record(B.pool, balice, PID, false, 1000, false, 1e9);
    await B.round();
    await A.round();
    assert.equal(O.schedule(O.attempts(await a.store.profile(alice))).get(PID).box, 0);
    assert.equal((await A.pool.puzzles(alice))[0].game.here, undefined);     // the desktop has the game

    // the phone settles a longer line: it replaces the short one everywhere, and the desktop, which still makes the
    // short one from its games, keeps the long one and doesn't send its own back
    (await b.store.profile(balice)).run('UPDATE own_puzzles SET line = ? WHERE id = ?', [own('e7e5 g1f3 b8c6'), PID]);
    await B.round();
    assert.deepEqual(account[OWN_FILE], [own('e7e5 g1f3 b8c6')]);
    await A.round();
    assert.deepEqual(await A.sync.readLines('', OWN_FILE), [own('e7e5 g1f3 b8c6')]);
    assert.equal(O.keepOwn(await a.store.profile(alice), [O.ownPuzzle('chesscom-alice', own('e7e5', 'g1f3'))]).get(PID), own('e7e5 g1f3 b8c6'));
    assert.deepEqual(await A.sync.delta('u1'), { add: {}, remove: {} });
    assert.equal((await A.pool.puzzles(alice))[0].moves.length, 4);

    // the profile removed on the desktop: its puzzles leave the account with it
    await a.profiles.remove(alice.id);
    await A.round();
    assert.deepEqual(account, {});
  } finally {
    await a.done();
    await b.done();
  }
});
