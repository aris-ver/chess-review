// Engine output to evals rows, as chess_review/analyse.py stores them. The engine itself (a native Stockfish process
// on the desktop, a WASM worker on the web) is driven elsewhere; this is the pure part: parsing the UCI `info` lines
// a search printed exactly as python-chess parses them, and turning the result into the `evals` row and the
// `evals_multipv` rows of one position.
//
// Sign convention: see pov.js. Everything is stored from the side-to-move POV.

import { copy, isCheckmate, isGameOver, moveFromUci, parseUci, push, uci } from './chess.js';
import { pyFloat, pyInt } from './py.js';

const UCI_REGEX = /^(?:[a-h][1-8][a-h][1-8][pnbrqk]?|[PNBRQK]@[a-h][1-8]|0000$)/;
const INTS = ['depth', 'seldepth', 'nodes', 'multipv', 'currmovenumber', 'hashfull', 'nps', 'tbhits', 'cpuload'];

/** The next whitespace-delimited token and the rest of the line (python-chess's _next_token). */
function nextToken(line) {
  const m = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(line);
  return m ? [m[1], m[2] ?? ''] : ['', ''];
}

/** Moves (UCI strings) for as long as tokens look like moves; throws on one that is illegal. */
function variationLine(root, line) {
  const b = copy(root);
  const moves = [];
  for (;;) {
    const [token, rest] = nextToken(line);
    if (!UCI_REGEX.test(token)) return [moves, line];
    const m = parseUci(b, token);
    push(b, m);
    moves.push(uci(m));
    line = rest;
  }
}

/** One `info` line (without the word "info") as python-chess's _parse_uci_info reads it. score is {cp} or {mate},
 * relative to the side to move; pv, currline and refutation hold UCI strings. A malformed field is skipped, with
 * the line read on from where python-chess reads on. */
export function parseInfo(arg, root) {
  const info = {};
  let rest = arg;
  const int = token => {
    const v = pyInt(token);
    if (v === null) throw new Error(`not an int: ${token}`);
    return v;
  };
  while (rest) {
    let parameter;
    [parameter, rest] = nextToken(rest);
    try {
      if (parameter === 'string') {
        info.string = rest;
        break;
      } else if (INTS.includes(parameter)) {
        let number;
        [number, rest] = nextToken(rest);
        info[parameter] = int(number);
      } else if (parameter === 'time') {
        let ms;
        [ms, rest] = nextToken(rest);
        info.time = int(ms) / 1000.0;
      } else if (parameter === 'ebf') {
        let number;
        [number, rest] = nextToken(rest);
        const v = pyFloat(number);
        if (v === null) throw new Error(`not a float: ${number}`);
        info.ebf = v;
      } else if (parameter === 'score') {
        let kind, value, token, after;
        [kind, rest] = nextToken(rest);
        [value, rest] = nextToken(rest);
        [token, after] = nextToken(rest);
        if (token === 'lowerbound' || token === 'upperbound') {
          info[token] = true;
          rest = after;
        }
        if (kind === 'cp') info.score = { cp: int(value) };
        else if (kind === 'mate') info.score = { mate: int(value) };
      } else if (parameter === 'currmove') {
        let current;
        [current, rest] = nextToken(rest);
        info.currmove = uci(moveFromUci(current));
      } else if (parameter === 'currline') {
        info.currline ??= {};
        let cpu;
        [cpu, rest] = nextToken(rest);
        const n = int(cpu);
        const [moves, after] = variationLine(root, rest);
        rest = after;
        info.currline[n] = moves;
      } else if (parameter === 'refutation') {
        info.refutation ??= {};
        const b = copy(root);
        let refuted;
        [refuted, rest] = nextToken(rest);
        const m = parseUci(b, refuted);
        push(b, m);
        const [moves, after] = variationLine(b, rest);
        rest = after;
        info.refutation[uci(m)] = moves;
      } else if (parameter === 'pv') {
        const [moves, after] = variationLine(root, rest);
        info.pv = moves;
        rest = after;
      } else if (parameter === 'wdl') {
        let w, d, l;
        [w, rest] = nextToken(rest);
        [d, rest] = nextToken(rest);
        [l, rest] = nextToken(rest);
        info.wdl = [int(w), int(d), int(l)];
      }
    } catch {
      // python-chess logs the error and reads on
    }
  }
  return info;
}

/** What python-chess's AnalysisResult holds after a search: one merged info per MultiPV line, a later `info` for
 * a line updating the fields it carries. Lines other than `info` (bestmove, ...) are ignored. */
export function analysisFromLines(lines, root) {
  const multipv = [{}];
  for (const line of lines) {
    const [token, rest] = nextToken(line);
    if (token !== 'info') continue;
    const info = parseInfo(rest, root);
    if (!Object.keys(info).length) continue;
    const k = info.multipv ?? 1;
    while (multipv.length < k) multipv.push({});
    const i = k - 1 < 0 ? multipv.length + k - 1 : k - 1;
    if (i < 0 || i >= multipv.length) throw new Error(`multipv ${k} out of range`);
    Object.assign(multipv[i], info);
  }
  return multipv;
}

function score(info) {
  if (!info.score) throw new Error('no score in the engine output');
  return 'mate' in info.score ? [null, info.score.mate] : [info.score.cp, null];
}

/** Single-PV evaluation from a search's output. Terminal positions are resolved without the engine (mate_in=0 =
 * checkmated), so `lines` may be empty for them. */
export function evaluate(board, lines) {
  if (isCheckmate(board)) return { nodes: 0, eval_cp: null, mate_in: 0, best_move: null, pv: [] };
  if (board.isStalemate() || board.isInsufficientMaterial()) return { nodes: 0, eval_cp: 0, mate_in: null, best_move: null, pv: [] };
  const info = analysisFromLines(lines, board)[0];
  const [cp, mate] = score(info);
  const pv = info.pv ?? [];
  return { nodes: info.nodes ?? 0, eval_cp: cp, mate_in: mate, best_move: pv.length ? pv[0] : null, pv };
}

/** [evals row, evals_multipv rows] for one position, from a MultiPV search's output. */
export function evaluateMultipv(board, lines) {
  if (isGameOver(board)) return [evaluate(board, lines), []];
  const infos = analysisFromLines(lines, board);
  const ranks = [];
  for (const info of infos) {
    if (!('pv' in info) || !('score' in info)) continue;
    const [cp, mate] = score(info);
    const pv = info.pv;
    ranks.push({ rank: info.multipv ?? ranks.length + 1, move: pv[0] ?? null, eval_cp: cp, mate_in: mate, pv });
  }
  ranks.sort((a, b) => a.rank - b.rank);
  const top = ranks.length ? ranks[0] : { eval_cp: null, mate_in: null, pv: [] };
  const nodes = Math.max(0, ...infos.map(i => i.nodes ?? 0));
  const main = { nodes, eval_cp: top.eval_cp, mate_in: top.mate_in, best_move: top.pv.length ? top.pv[0] : null, pv: top.pv };
  return [main, ranks];
}
