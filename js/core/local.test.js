// Your own games (data/profiles) with their real evals and MultiPV, dumped by `scripts/dump_parity.py --local` to
// tests/parity/local/ (gitignored), with the opening book loaded from the book_keys.txt dumped beside them.
// Skipped when there is no local dump.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { PARITY, checkGame, localDumps, same } from '../parity.js';
import { isBook, loadBook } from './book.js';

const files = localDumps();

test('local: your games classify as in Python', { skip: !files.length && 'no tests/parity/local dump' }, () => {
  loadBook(readFileSync(PARITY + 'local/book_keys.txt', 'utf8'));
  let games = 0;
  for (const f of files) {
    for (const c of JSON.parse(readFileSync(f, 'utf8'))) {
      for (const key of c.book) same(isBook(key), true, `${c.name} book ${key}`);
      checkGame(c);
      games += 1;
    }
  }
  if (!games) throw new Error('the local dumps hold no games');
});
