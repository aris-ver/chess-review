// Rebuild every reviewed game's move comments with the code in this checkout and check what they claim against the
// board (a piece said to be lost that the line never takes, a miss that never names the move missed, ...): rerun it
// after changing js/core/explain.js or facts.js.
//
//     node scripts/review_comments.mjs [DATA] [--rows out.json] [--examples N]
//
// DATA is the app's data folder (default: %LOCALAPPDATA%/chess-review, else ~/.local/share/chess-review). Its
// databases are copied to a temp folder first, so a running app is never touched. Prints, per label, the shapes of
// the first sentence, then the checks; --rows writes every move with its comment for a closer look.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadBook } from '../js/core/book.js';
import * as C from '../js/core/chess.js';
import { classifyGame } from '../js/core/classify.js';
import { comment } from '../js/core/explain.js';
import { extract } from '../js/core/facts.js';
import { bookKeysFromDir } from '../js/desktop/book.js';
import { POSITIONS_SQL, loadMultipv } from '../js/server/classify.js';
import { nodeSqlite } from '../js/server/db-node.js';
import { EVALS, Store, profileDb } from '../js/server/db.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const rowsOut = opt('--rows');
const nExamples = Number(opt('--examples') ?? 3);
const DATA = args[0] ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'chess-review')
  : join(homedir(), '.local', 'share', 'chess-review'));

// --- load ---------------------------------------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'review-comments-'));
const profiles = readdirSync(join(DATA, 'profiles')).filter(id => existsSync(join(DATA, profileDb(id))));
for (const name of [EVALS, ...profiles.map(profileDb)]) {
  mkdirSync(join(tmp, name, '..'), { recursive: true });
  for (const suffix of ['', '-wal']) if (existsSync(join(DATA, name + suffix))) copyFileSync(join(DATA, name + suffix), join(tmp, name + suffix));
}
const keys = bookKeysFromDir(join(DATA, 'book'));
if (keys.length) loadBook(keys.join('\n'));

const store = new Store(nodeSqlite(tmp));
const rows = [];
let nGames = 0;
for (const id of profiles) {
  const db = await store.profile(id);
  const multipv = loadMultipv(db);
  const byGame = new Map();
  for (const r of db.all(`${POSITIONS_SQL} ORDER BY p.game_id, p.ply`)) {
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, []);
    byGame.get(r.game_id).push(r);
  }
  for (const game of db.all('SELECT * FROM games')) {
    const pos = byGame.get(game.game_id);
    if (!pos || pos.length < 2) continue;
    const evaluated = pos.filter(p => p.eval_cp != null || p.mate_in != null).length;
    if (evaluated / pos.length < 0.99) continue;
    nGames++;
    const byPly = new Map(pos.map(p => [p.ply, p]));
    for (const m of classifyGame(game, pos, multipv)) {
      if (!m.label) continue;
      const before = byPly.get(m.ply), after = byPly.get(m.ply + 1);
      const f = extract(m, C.boardFromFen(before.fen), before, after, multipv[before.fen_key] ?? null);
      rows.push({ game: game.game_id, ply: m.ply, san: m.san, label: m.label, fen: before.fen, f,
        comment: comment(f, m.in_book ? game.opening_name : null) });
    }
  }
}
await store.close();
rmSync(tmp, { recursive: true, force: true });

// --- tally --------------------------------------------------------------------------------------------------------

const tally = {};
const bump = (k, r) => {
  tally[k] ??= { n: 0, ex: [] };
  tally[k].n++;
  if (r && tally[k].ex.length < nExamples) {
    tally[k].ex.push(`${r.game.split('/').pop()}@${r.ply} ${r.label} ${r.san} (${r.f.wp_before?.toFixed(0)}→${r.f.wp_after?.toFixed(0)}%) | ${r.comment.join(' ')}`);
  }
};

const shape = s => s
  .replace(/\d+\.(\.\.)? ?/g, '')
  .replace(/\b(O-O(-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?/g, 'M')
  .replace(/(M ?)+/g, 'M ')
  .replace(/\d+(:\d+)?( seconds)?/g, 'N')
  .replace(/\((.*?)\)/g, '(O)')
  .replace(/\b(pawn|knight|bishop|rook|queen|king)s?\b/g, 'P')
  .replace(/\b(White|Black)\b/g, 'S')
  .replace(/\b[a-h]-pawn\b/g, 'P');
const shapes = {};
for (const r of rows) {
  const s = shapes[r.label] ??= { n: 0, by: {} };
  s.n++;
  const k = r.comment.length ? shape(r.comment[0]) : '(none)';
  s.by[k] = (s.by[k] ?? 0) + 1;
}

const BAD = new Set(['mistake', 'blunder', 'miss']);
for (const r of rows) {
  const f = r.f, c = r.comment, c0 = c[0] ?? '', all = c.join(' ');
  const board = C.boardFromFen(r.fen);
  const played = C.legalMoves(board).find(x => C.san(board, x) === r.san);
  if (!played) continue;
  const after = C.copy(board);
  C.push(after, played);
  // the opponent's captures in the shown line, as squares
  const taken = new Set();
  const walk = C.copy(after);
  for (const [i, u] of f.refutation_uci.entries()) {
    const m = C.moveFromUci(u);
    if (!C.isLegal(walk, m)) break;
    if (i % 2 === 0 && C.isCapture(walk, m)) taken.add(C.makeSquare(m.to));
    C.push(walk, m);
  }
  if (!BAD.has(r.label)) continue;
  bump('bad: total');
  // a piece named as hung / lost / left / put somewhere, with its square
  const named = [...all.matchAll(/(?:hangs|leaves|puts|guards|take) the (pawn|knight|bishop|rook|queen) on ([a-h][1-8])(?! safe)/g)];
  for (const [, piece, s] of named) {
    bump('claim: a piece on a square is lost');
    if (!taken.has(s)) bump('claim: the line shown never takes it', r);
    if (piece === 'pawn') bump('claim: it is a pawn', r);
    if (C.makeSquare(played.to) === s && /hangs/.test(all)) bump('claim: "hangs" names the piece that just moved', r);
  }
  if (r.label === 'miss') {
    bump('miss');
    if (/hangs/.test(c0)) bump('miss: told as a hang', r);
    if (!all.includes(f.best_san ?? '@@')) bump('miss: never names the move that was missed', r);
  }
  if (f.missed_mate && !/mate/i.test(all)) bump('mate on the board, not mentioned', r);
  if (f.allowed_mate && !/mate/i.test(all)) bump('allowed mate, not mentioned', r);
  if (/no defence/.test(all)) {
    bump('"no defence"');
    if (f.wp_before != null && f.wp_before < 10) bump('"no defence" though already lost', r);
  }
  if (/falls apart/.test(all)) {
    bump('"falls apart"');
    if (f.wp_after != null && f.wp_after > 30) bump('"falls apart" though not lost after', r);
  }
  const down = all.match(/down ([\d.]+) pawns/);
  if (down) {
    bump('"down N pawns"');
    if (!taken.size) bump('"down N pawns" with no capture in the line', r);
  }
  if (/Played with/.test(all)) {
    bump('clock sentence');
    const notable = (f.clock_remaining != null && f.clock_remaining < 30) || (f.time_spent != null && (f.time_spent >= 30 || f.time_spent <= 2));
    if (!notable) bump('clock sentence with nothing notable about the time');
  }
}

let out = `games ${nGames}, labelled moves ${rows.length}\n`;
for (const [label, s] of Object.entries(shapes).sort((a, b) => b[1].n - a[1].n)) {
  out += `\n== ${label}: ${s.n}\n`;
  for (const [k, n] of Object.entries(s.by).sort((a, b) => b[1] - a[1]).slice(0, 12)) out += `  ${String(n).padStart(5)}  ${k}\n`;
}
out += '\n== checks (mistakes, blunders, misses)\n';
for (const [k, v] of Object.entries(tally)) {
  out += `  ${String(v.n).padStart(5)}  ${k}\n`;
  for (const e of v.ex) out += `           ${e}\n`;
}
console.log(out);
if (rowsOut) writeFileSync(rowsOut, JSON.stringify(rows.map(({ f, ...r }) => ({ ...r, wp_before: f.wp_before, wp_after: f.wp_after, best: f.best_san }))));
