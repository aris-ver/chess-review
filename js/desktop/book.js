// The opening book's keys from the lichess chess-openings TSVs, as book.py's load() makes them: every position
// reached along a line's moves (not the start position), as a fen_key. build.js writes them into app.asar as
// book_keys.txt; a checkout without one reads DATA/book's TSVs at start, as Python does.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fenKey } from '../core/fen.js';
import { extractPositions, readGames } from '../core/normalise.js';

/** csv.DictReader(fh, delimiter='\t')'s rows. The TSVs have no quoting, so a plain split does. */
function rows(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const head = lines[0].split('\t');
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = line.split('\t');
    out.push(Object.fromEntries(head.map((h, i) => [h, cells[i] ?? null])));
  }
  return out;
}

/** The keys of TSV texts (in file name order, though the set doesn't care), sorted. */
export function bookKeys(texts) {
  const keys = new Set();
  for (const text of texts) {
    for (const row of rows(text)) {
      if (!row.pgn) continue;
      const game = readGames(row.pgn).next().value;
      if (!game) continue;
      for (const pos of extractPositions(game, '').slice(1)) keys.add(fenKey(pos.fen));
    }
  }
  return [...keys].sort();
}

/** bookKeys over a folder's *.tsv; [] when there are none. */
export function bookKeysFromDir(dir) {
  let names;
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.tsv')).sort();
  } catch {
    return [];
  }
  return bookKeys(names.map(n => readFileSync(join(dir, n), 'utf8')));
}
