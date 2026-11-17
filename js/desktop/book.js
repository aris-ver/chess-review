// The opening book's keys from the lichess chess-openings TSVs, as book.py's load() makes them: every position
// reached along a line's moves (not the start position), as a fen_key. build.js writes them into app.asar as
// book_keys.txt; a checkout without one reads DATA/book's TSVs at start, as Python does.
//
// bookTree makes book_tree.json, the opening tree the Openings tab walks (js/core/opening-tree.js, docs/openings.md).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { boardFromFen, copy, fen, legalMoves, push, uci } from '../core/chess.js';
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

/** A folder's *.tsv texts in file name order; [] when there are none. */
function tsvTexts(dir) {
  let names;
  try {
    names = readdirSync(dir).filter(n => n.endsWith('.tsv')).sort();
  } catch {
    return [];
  }
  return names.map(n => readFileSync(join(dir, n), 'utf8'));
}

/** bookKeys over a folder's *.tsv; [] when there are none. */
export const bookKeysFromDir = dir => bookKeys(tsvTexts(dir));

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The opening tree of TSV texts, as book_tree.json holds it:
 *
 *     { names: [[eco, name], ...], pos: { <fen_key>: [nameIndex or -1, "e2e4 d2d4 ..."], ... } }
 *
 * for the start position and every book position (bookKeys). A position's name is that of the shortest line ending
 * on it; one no line ends on takes the name of the last named position before it on the shortest line through it
 * (-1 when there's none). Its moves are every legal move into a book position, transpositions too, so they agree
 * with isBook: the ones more lines take first, then the rest in UCI order. */
export function bookTree(texts) {
  const lines = [];
  for (const text of texts) {
    for (const row of rows(text)) {
      if (!row.pgn) continue;
      const game = readGames(row.pgn).next().value;
      if (!game) continue;
      const ps = extractPositions(game, '');
      if (ps.length < 2) continue;
      lines.push({ eco: row.eco, name: row.name, keys: ps.map(p => fenKey(p.fen)),
        moves: ps.slice(0, -1).map(p => p.move_played) });
    }
  }
  if (!lines.length) return { names: [], pos: {} };
  // shortest first, file order among equals
  const byLength = lines.map((l, i) => [l, i]).sort((a, b) => a[0].keys.length - b[0].keys.length || a[1] - b[1])
    .map(([l]) => l);

  const names = [], nameIndex = new Map();
  const indexOf = (eco, name) => {
    const k = `${eco}\t${name}`;
    if (!nameIndex.has(k)) {
      nameIndex.set(k, names.length);
      names.push([eco, name]);
    }
    return nameIndex.get(k);
  };
  const own = new Map();      // fen_key -> the shortest line ending there
  for (const l of byLength) if (!own.has(l.keys.at(-1))) own.set(l.keys.at(-1), indexOf(l.eco, l.name));
  const named = new Map();    // fen_key -> its name, own or inherited
  const taken = new Map();    // "<fen_key> <uci>" -> how many lines play that move there
  for (const l of byLength) {
    let cur = -1;
    l.keys.forEach((k, i) => {
      if (own.has(k)) cur = own.get(k);
      if (!named.has(k)) named.set(k, cur);
      if (i < l.moves.length) {
        const edge = `${k} ${l.moves[i]}`;
        taken.set(edge, (taken.get(edge) || 0) + 1);
      }
    });
  }

  const start = lines[0].keys[0];
  const book = new Set(lines.flatMap(l => l.keys.slice(1)));
  const pos = {};
  for (const k of [...named.keys()].sort(byText)) {
    if (k !== start && !book.has(k)) continue;
    const board = boardFromFen(k + ' 0 1');
    const next = [];
    for (const m of legalMoves(board)) {
      const b = copy(board);
      push(b, m);
      if (book.has(fenKey(fen(b)))) next.push(uci(m));
    }
    const n = u => taken.get(`${k} ${u}`) || 0;
    next.sort((a, b) => n(b) - n(a) || byText(a, b));
    pos[k] = [named.get(k), next.join(' ')];
  }
  return { names, pos };
}

/** bookTree over a folder's *.tsv; null when there are none. */
export function bookTreeFromDir(dir) {
  const texts = tsvTexts(dir);
  return texts.length ? bookTree(texts) : null;
}
