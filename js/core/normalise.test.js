// normalise against scripts/dump_parity_games.py's normalise.json, and your own profiles' raw files when
// `dump_parity_games.py --local` has dumped them to tests/parity/local/.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { PARITY, load, loadPath, same } from '../parity.js';
import { cleanOpeningName, normalise, parseChesscom, parseLichess, parsePgnText, timeClass } from './normalise.js';

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
    const c = loadPath(PARITY + 'local/' + f);
    same(normalise(c.files, c.username), c.out, f);
  }
});

test('normalise: an ECOUrl name loses its move text and gets its apostrophes back', () => {
  const cases = [
    ['Queens Gambit Declined 3.cxd5 exd5 4.Nc3 c6', "Queen's Gambit Declined"],
    ['Van t Kruijs Opening 1...e5', "Van 't Kruijs Opening"],
    ['Kings Pawn Opening 1...e5', "King's Pawn Opening"],
    ['Queens Gambit Declined Chigorin Defense...4.Nc3 Nf6 5.Bg5 Be7', "Queen's Gambit Declined Chigorin Defense"],
    ['Italian Game Two Knights Modern Bishops Opening 6.O O', "Italian Game Two Knights Modern Bishop's Opening"],
    ['Modern Defense with 1 e4 2.d4 Bg7', 'Modern Defense with 1 e4'],
    ['Four Knights Game', 'Four Knights Game'],
    ['Two Knights Defense', 'Two Knights Defense'],
    ['French Defense Normal Variation', 'French Defense Normal Variation'],
    ["King's Pawn Game: Wayward Queen Attack", "King's Pawn Game: Wayward Queen Attack"],
  ];
  for (const [dirty, clean] of cases) assert.equal(cleanOpeningName(dirty), clean, dirty);
  assert.equal(cleanOpeningName(null), null);
  assert.equal(cleanOpeningName(''), '');
});

test('normalise: the name from an ECOUrl is clean, an Opening tag is kept as it is', () => {
  const name = tag => [...parsePgnText(`[White "me"]\n[Black "you"]\n${tag}\n\n1. e4 e5 *\n`, 'me', 'd')][0][0].opening_name;
  assert.equal(name('[ECOUrl "https://www.chess.com/openings/Queens-Gambit-Declined-3.cxd5-exd5-4.Nc3-c6"]'), "Queen's Gambit Declined");
  assert.equal(name('[Opening "Kings Gambit 2.f4"]'), 'Kings Gambit 2.f4');
});
