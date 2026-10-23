// normalise against scripts/dump_parity_games.py's normalise.json, and your own profiles' raw files when
// `dump_parity_games.py --local` has dumped them to tests/parity/local/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { PARITY, load, same } from '../parity.js';
import { normalise, parseChesscom, parseLichess, parsePgnText, timeClass } from './normalise.js';

const N = load('normalise.json');

test('normalise: time classes of pasted games', () => {
  for (const [tc, out] of N.time_class) same(timeClass(tc), out, `timeClass(${JSON.stringify(tc)})`);
});

test('normalise: pasted PGNs, python-chess corner cases included', () => {
  for (const c of N.pgn) {
    same([...parsePgnText(c.text, c.username, c.digest)], c.out, `parsePgnText(${c.digest}, ${c.username})`);
  }
});

test('normalise: chess.com archive games', () => {
  N.chesscom.forEach((c, i) => same(parseChesscom(c.g, c.username), c.out, `parseChesscom[${i}]`));
});

test('normalise: lichess export games', () => {
  N.lichess.forEach((c, i) => same(parseLichess(c.g, c.username), c.out, `parseLichess[${i}]`));
});

test('normalise: a whole profile\'s files', () => {
  N.build.forEach((c, i) => same(normalise(c.files, c.username), c.out, `normalise[${i}]`));
});

const local = existsSync(PARITY + 'local/')
  ? readdirSync(PARITY + 'local/').filter(f => /^normalise-.*\.json$/.test(f)).sort() : [];

test('local: your profiles normalise as in Python', { skip: !local.length && 'no tests/parity/local normalise dump' }, () => {
  for (const f of local) {
    const c = JSON.parse(readFileSync(PARITY + 'local/' + f, 'utf8'));
    same(normalise(c.files, c.username), c.out, f);
  }
});
