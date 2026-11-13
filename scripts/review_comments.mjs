// Rebuild every reviewed game's move comments with the code in this checkout and check what they claim against the
// board (a piece said to be lost that the line never takes, a miss that never names the move missed, ...): rerun it
// after changing js/core/explain.js or facts.js.
//
//     node scripts/review_comments.mjs [DATA] [--rows out.json] [--examples N]
//
// DATA is the app's data folder (default: %LOCALAPPDATA%/chess-review, else ~/.local/share/chess-review). Its
// databases are copied to a temp folder first, so a running app is never touched. Prints, per label, the shapes of
// the first sentence, then the checks, then per label how many moves have nothing for Explain to show (no sentence
// that says something: explain.reasons) and how many have a line to play out; --rows writes every move with its
// comment for a closer look.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadBook } from '../js/core/book.js';
import * as C from '../js/core/chess.js';
import { classifyGame } from '../js/core/classify.js';
import { comment, line, moveLine, punishing, reasons } from '../js/core/explain.js';
import { extract, tradeOver } from '../js/core/facts.js';
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
      const f = extract(m, C.boardFromFen(before.fen), before, after, multipv[before.fen_key] ?? null, byPly.get(m.ply - 1) ?? null);
      rows.push({ game: game.game_id, ply: m.ply, san: m.san, label: m.label, fen: before.fen, f,
        comment: comment(f, m.in_book ? game.opening_name : null), pvBefore: before.pv ?? [], pvAfter: after?.pv ?? [],
        reasons: reasons(f, m.in_book ? game.opening_name : null), line: moveLine(f, m.move_played, m.in_book ? game.opening_name : null) });
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

/** {capture, promotion, check} for each legal ply of `pv` from `board`. */
function plyKinds(board, pv) {
  const b = C.copy(board);
  const out = [];
  for (const u of pv) {
    let m;
    try {
      m = C.moveFromUci(u);
    } catch {
      break;
    }
    if (!C.isLegal(b, m)) break;
    out.push({ capture: C.isCapture(b, m), promotion: !!m.promotion, check: C.givesCheck(b, m) });
    C.push(b, m);
  }
  return out;
}
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
  // the lines shown under a bad move or an inaccuracy, against where the engine's line settles
  if (BAD.has(r.label) || r.label === 'inaccuracy') {
    // the refutation counts from before the move, so what the move itself takes is in it
    const shown = [[board, [C.uci(played), ...r.pvAfter], f.refutation, r.ply + 1, 1]];
    if (r.label === 'miss') shown.push([board, r.pvBefore, f.best_line, r.ply, 0]);
    for (const [b0, pv, sans, ply, from] of shown) {
      const text = sans.length ? line(sans, ply) : null;
      const said = text && c.find(x => x.includes(text));
      if (!said) continue;
      bump('line: shown');
      const k = plyKinds(b0, pv), len = sans.length + from;
      if (len < k.length && k[len].capture) bump('line: stops right before the engine takes something', r);
      let end = len;
      while (end > 0 && end < k.length && end < 16 && (k[end].capture || k[end].promotion || k[end - 1].capture || k[end - 1].check)) end++;
      const off = Math.abs(tradeOver(b0, pv.slice(0, end), board.turn).net - tradeOver(b0, pv.slice(0, len), board.turn).net) >= 200;
      if (off) bump('line: material 2+ pawns off where the exchange settles');
      if (off && /\b(loses|wins)\b/.test(said)) bump('line: ... under a "loses"/"wins" claim', r);
      if (sans.length > 7) bump('line: longer than 7 plies');
    }
  }
  // fork / pin / skewer / discovered attack sentences, against the line under them
  if (f.motif && f.refutation.length && all.includes(`${f.refutation[0]} ${f.motif_detail}`)) {
    bump(`pattern: ${f.motif}`);
    const pieceSqs = [...f.motif_detail.matchAll(/(pawn|knight|bishop|rook|queen) on ([a-h][1-8])/g)];
    if (f.motif !== 'discovered' && pieceSqs.some(m => m[1] === 'pawn')) bump('pattern: names a pawn', r);
    if (f.motif !== 'discovered' && !pieceSqs.some(m => taken.has(m[2]))) bump('pattern: the line takes none of the pieces named', r);
    const [r0, r1] = f.refutation_uci.map(u => C.moveFromUci(u));
    if (f.motif !== 'discovered' && r1 && r1.to === r0.to && /x/.test(f.refutation[1])) bump('pattern: its piece is taken at once', r);
    if (!f.allowed_mate && (f.trade?.net ?? 0) > -200) bump('pattern: the line wins under two pawns', r);
  }
  if (/\bforks [^.:]*\bpawn\b/.test(all)) bump('any move: a fork that names a pawn', r);
  if (!BAD.has(r.label)) continue;
  bump('bad: total');
  // a piece named as hung / lost / left / put somewhere, with its square
  const named = [...all.matchAll(/(?:hangs|leaves|puts|guards|(?<!to )take) the (pawn|knight|bishop|rook|queen) on ([a-h][1-8])(?! safe)/g)];
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
    const told = c.filter(x => !x.startsWith('Played '));
    if (/^Missed [^,:]+(: [^,]*)?\.$/.test(c0) && told.length === 1) bump('miss: says nothing but the line', r);
    if (/which kept \w+ (winning|better)/.test(c0) && told.length === 1 && (f.wp_loss ?? 0) >= 20) {
      bump('miss: "kept winning/better", the move dropped 20+, and nothing says what it cost', r);
    }
    if (told.length > 1 && !/still mate/.test(told[1])) bump('miss: says what the move played cost');
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
// the move panel: Explain is greyed out on a move with no reason, unless it is a bad move with a line that punishes it;
// with one, it can play the move's line
const panel = {}, lineOnly = [];
for (const r of rows) {
  if (!r.reasons.length && r.line) lineOnly.push(r);
  const p = panel[r.label] ??= { n: 0, empty: 0, playable: 0 };
  p.n++;
  if (!r.reasons.length && !r.line) p.empty++;
  else if (r.line) p.playable++;
}
out += '\n== Explain: moves with nothing to explain (greyed out), and with a line to play\n';
const pct = (a, n) => `${String(a).padStart(5)} (${String(Math.round(100 * a / n)).padStart(3)}%)`;
for (const [label, p] of Object.entries(panel).sort((a, b) => b[1].n - a[1].n)) {
  out += `  ${label.padEnd(11)} ${String(p.n).padStart(5)}   empty ${pct(p.empty, p.n)}   playable line ${pct(p.playable, p.n)}\n`;
}
const tot = Object.values(panel).reduce((a, p) => ({ n: a.n + p.n, empty: a.empty + p.empty, playable: a.playable + p.playable }), { n: 0, empty: 0, playable: 0 });
out += `  ${'all'.padEnd(11)} ${String(tot.n).padStart(5)}   empty ${pct(tot.empty, tot.n)}   playable line ${pct(tot.playable, tot.n)}\n`;
out += `  ${String(lineOnly.length).padStart(5)}  with no reason, only the line that punishes the move (explain.punishing)\n`;
for (const r of lineOnly.slice(0, nExamples)) out += `           ${r.game.split('/').pop()}@${r.ply} ${r.label} ${r.san} | ${punishing(r.f).text}\n`;
console.log(out);
if (rowsOut) writeFileSync(rowsOut, JSON.stringify(rows.map(({ f, pvBefore, pvAfter, ...r }) => ({ ...r, short: r.reasons.map(x => x.short), reasons: r.reasons.map(x => x.text), wp_before: f.wp_before, wp_after: f.wp_after, best: f.best_san }))));
