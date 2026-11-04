// chess_review/normalise.py: raw chess.com archives, lichess exports and pasted PGNs into game and position rows.
// Rows only: writing them is the storage layer's (docs/js-port.md, round 2).
//
// The PGN reader is python-chess's read_game, line for line, as far as normalise looks at a game: its tags (with
// the Seven Tag Roster's defaults), the mainline's moves and their comments (the clocks). Where it stops on an
// illegal move, which comment lands on which move and how much text a game takes are all python-chess's, so the
// rows match Python's field for field.
//
// played_at is Python's datetime.isoformat(), 'YYYY-MM-DDTHH:MM:SS' (UTC, no zone), as db.write_parquet writes it.

import { boardFromFen, castlingMoves, fen, isLegal, legalMoves, nullMove, push, squareFile, squareRank, uci } from './chess.js';
import { pyInt, pyRound } from './py.js';
import { Chess, fen as fenIO } from '../vendor/chessops.js';

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const DRAW_CODES = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

// games' columns, [name, SQL type] in order (normalise.GAMES_SCHEMA)
export const GAMES_SCHEMA = [
  ['game_id', 'VARCHAR'],
  ['played_at', 'TIMESTAMP'],
  ['time_control', 'VARCHAR'],
  ['time_class', 'VARCHAR'],
  ['my_colour', 'VARCHAR'],
  ['my_rating', 'INTEGER'],
  ['opponent_rating', 'INTEGER'],
  ['result', 'VARCHAR'],
  ['termination', 'VARCHAR'],
  ['eco', 'VARCHAR'],
  ['opening_name', 'VARCHAR'],
  ['opponent', 'VARCHAR'],      // not in the spec schema; needed to label games in the UI
  ['my_name', 'VARCHAR'],       // the profile's username for chess.com games; the PGN header name for pasted ones
];

// positions' columns (normalise.POSITIONS_SCHEMA)
export const POSITIONS_SCHEMA = [
  ['game_id', 'VARCHAR'],
  ['ply', 'INTEGER'],
  ['fen', 'VARCHAR'],
  ['move_played', 'VARCHAR'],
  ['side_to_move', 'VARCHAR'],
  ['clock_remaining', 'INTEGER'],
];

// --- python-chess's PGN reader ----------------------------------------------------------------------------------

const TAG = /^\[([A-Za-z0-9][A-Za-z0-9_+#=:-]*)\s+"([^\r]*)"\]\s*$/;
const MOVETEXT = new RegExp([
  '([NBKRQ]?[a-h]?[1-8]?[\\-x]?[a-h][1-8](?:=?[nbrqkNBRQK])?|[PNBRQK]?@[a-h][1-8]|--|Z0|0000|@@@@|O-O(?:-O)?|0-0(?:-0)?)',
  '(\\{[\\s\\S]*)', '(;[\\s\\S]*)', '(\\$[0-9]+)', '(\\()', '(\\))', '(\\*|1-0|0-1|1/2-1/2)', '([\\?!]{1,2})',
].join('|'), 'g');
const SKIP_MOVETEXT = /;|\{|\}/g;
const CLOCK = /(\s?)\[%clk\s(\d+):(\d+):(\d+(?:\.\d*)?)\](\s?)/;
const RESULTS = ['1-0', '0-1', '1/2-1/2', '*'];
const SEVEN_TAGS = [['Event', '?'], ['Site', '?'], ['Date', '????.??.??'], ['Round', '?'], ['White', '?'],
  ['Black', '?'], ['Result', '*']];
// the Variant tags normalise keeps (_is_standard); other games' moves are not read, only skipped over
const STANDARD = ['standard', 'chess'];

// str.isspace(): not empty, and every character Python's whitespace
const isSpace = line => /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/.test(line);

/** io.StringIO(text).readline(): up to and with the next "\n", '' at the end. */
class Lines {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }

  readline() {
    if (this.at >= this.text.length) return '';
    const nl = this.text.indexOf('\n', this.at);
    const end = nl < 0 ? this.text.length : nl + 1;
    const line = this.text.slice(this.at, end);
    this.at = end;
    return line;
  }
}

/** chess.pgn.Headers: the Seven Tag Roster's defaults, then the game's tags. */
export class Headers extends Map {
  constructor() {
    super(SEVEN_TAGS);
  }

  /** headers.get(name, fallback) */
  value(name, fallback = null) {
    return this.has(name) ? this.get(name) : fallback;
  }
}

/** board.parse_san(san) on an ordinary board; throws where python-chess raises ValueError. */
export function parseSan(pos, san) {
  const castles = ['O-O', 'O-O+', 'O-O#', '0-0', '0-0+', '0-0#'].includes(san) ? 'king'
    : ['O-O-O', 'O-O-O+', 'O-O-O#', '0-0-0', '0-0-0+', '0-0-0#'].includes(san) ? 'queen' : null;
  if (castles) {
    const m = castlingMoves(pos).find(c => (squareFile(c.to) > squareFile(c.from)) === (castles === 'king'));
    if (!m) throw new SyntaxError(`illegal san: ${san}`);
    return m;
  }
  const match = /^([NBKRQ])?([a-h])?([1-8])?[-x]?([a-h][1-8])(=?[nbrqkNBRQK])?[+#]?$/.exec(san);
  if (!match) {
    if (['--', 'Z0', '0000', '@@@@'].includes(san)) return nullMove();
    throw new SyntaxError(`invalid san: ${san}`);
  }
  const [, piece, file, rank, target, promo] = match;
  const to = squareOf(target);
  const promotion = promo ? ROLE[promo.at(-1).toLowerCase()] : undefined;
  const fromFile = file ? file.charCodeAt(0) - 97 : null;
  const fromRank = rank ? Number(rank) - 1 : null;
  let role = null;
  if (piece) role = ROLE[piece.toLowerCase()];
  else if (file && rank) {
    const m = findMove(pos, fromFile + 8 * fromRank, to, promotion);
    if (m.promotion !== promotion) throw new SyntaxError(`missing promotion piece type: ${san}`);
    return m;
  } else role = 'pawn';
  const pawnFile = !piece && !file ? squareFile(to) : null;    // no pawn captures without the file
  if (pos.board[pos.turn].has(to)) throw new SyntaxError(`illegal san: ${san}`);
  let found = null;
  for (const m of legalMoves(pos)) {
    if (m.to !== to || pos.board.getRole(m.from) !== role) continue;
    if (role === 'king' && Math.abs(squareFile(m.to) - squareFile(m.from)) === 2) continue;   // castling: never by Kg1
    if (fromFile !== null && squareFile(m.from) !== fromFile) continue;
    if (fromRank !== null && squareRank(m.from) !== fromRank) continue;
    if (pawnFile !== null && squareFile(m.from) !== pawnFile) continue;
    if (m.promotion !== promotion) continue;
    if (found) throw new SyntaxError(`ambiguous san: ${san}`);
    found = m;
  }
  if (!found) throw new SyntaxError(`illegal san: ${san}`);
  return found;
}

const ROLE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const squareOf = name => (name.charCodeAt(0) - 97) + 8 * (name.charCodeAt(1) - 49);

/** board.find_move(from, to, promotion): a pawn to the back rank promotes to a queen unless told otherwise, and a
 * king taking its own rook from e1/e8 castles. */
function findMove(pos, from, to, promotion) {
  let m;
  if (promotion === undefined && pos.board.pawn.has(from) && (squareRank(to) === 0 || squareRank(to) === 7)) {
    m = { from, to, promotion: 'queen' };
  } else if (promotion === undefined && (from === 4 || from === 60) && pos.board.king.has(from)
             && (to === from + 3 || to === from - 4)) {
    m = { from, to: to === from + 3 ? from + 2 : from - 2 };
  } else m = promotion ? { from, to, promotion } : { from, to };
  if (!isLegal(pos, m)) throw new SyntaxError(`no matching legal move for ${uci(m)}`);
  return m;
}

/** The board a game's moves are read on: false when the FEN tag doesn't parse (read_game then skips the movetext),
 * null for a game normalise drops anyway (a variant): its movetext is only read past. */
function initialBoard(headers) {
  const tag = headers.value('FEN');
  if (tag !== null && fenIO.parseFen(tag).isErr) return false;
  if (!STANDARD.includes(headers.value('Variant', 'Standard').toLowerCase())) return null;
  return tag === null ? Chess.default() : boardFromFen(tag);
}

/**
 * chess.pgn.read_game(stream): the next game, or null at the end of the text. A game is
 * {headers, root, errors}; nodes are {move, comment, parent, children}, the mainline the first children.
 */
export function readGame(stream) {
  let line = stream.readline().replace(/^\ufeff+/, '');
  while (isSpace(line) || line.startsWith('%') || line.startsWith(';')) line = stream.readline();

  let found = false;
  const game = { headers: new Headers(), root: { move: null, comment: '', parent: null, children: [] }, errors: [] };
  let emptyLines = 0;
  while (line) {
    if (line.startsWith('%') || line.startsWith(';')) {
      line = stream.readline();
      continue;
    }
    if (emptyLines < 1 && isSpace(line)) {
      emptyLines += 1;
      line = stream.readline();
      continue;
    }
    found = true;
    if (!line.startsWith('[')) break;
    emptyLines = 0;
    const tag = TAG.exec(line);
    if (tag) game.headers.set(tag[1], tag[2]);
    line = stream.readline();
  }
  if (!found) return null;

  const start = initialBoard(game.headers);
  if (start === false) {          // the fast path: skip the movetext
    game.invalidFen = true;
    let inComment = false;
    while (line) {
      if (!inComment) {
        if (isSpace(line)) break;
        if (line.startsWith('%')) {
          line = stream.readline();
          continue;
        }
      }
      for (const [token] of line.matchAll(SKIP_MOVETEXT)) {
        if (token === '{') inComment = true;
        else if (!inComment && token === ';') break;
        else if (token === '}') inComment = false;
      }
      line = stream.readline();
    }
    return game;
  }

  // GameBuilder's state, and the boards (null on a variant board: its moves aren't read)
  const variations = [game.root];
  let startingComment = '';
  let inVariation = false;
  const boards = [{ pos: start, before: [] }];
  const visitComment = text => {
    const top = variations.at(-1);
    if (inVariation || (top.parent === null && !top.children.length)) top.comment = [top.comment, text].filter(Boolean).join(' ');
    else startingComment = [startingComment, text].filter(Boolean).join(' ');
  };

  let skipDepth = 0;
  let fresh = true;
  while (line) {
    if (fresh) {
      if (line.startsWith('%') || line.startsWith(';')) {
        line = stream.readline();
        continue;
      }
      if (isSpace(line)) return game;
    }
    fresh = true;

    for (const [token] of line.matchAll(MOVETEXT)) {
      if (token.startsWith('{')) {
        line = token.slice(token.startsWith('{ ') ? 2 : 1);
        const parts = [];
        while (line && !line.includes('}')) {
          parts.push(line);
          line = stream.readline();
        }
        if (line) {
          const close = line.indexOf('}');
          const end = close > 0 && line[close - 1] === ' ' ? close - 1 : close;
          parts.push(line.slice(0, end));
          line = line.slice(close + 1);
        }
        if (!skipDepth) visitComment(parts.join(''));
        fresh = false;
        break;
      } else if (token === '(') {
        if (skipDepth) skipDepth += 1;
        else if (boards.at(-1).before.length) {
          const parent = variations.at(-1).parent;
          if (parent === null) throw new Error('begin_variation called, but root node on top of stack');
          variations.push(parent);
          inVariation = false;
          const top = boards.at(-1);
          boards.push({ pos: top.pos && top.before.at(-1).clone(), before: top.before.slice(0, -1) });
        }
      } else if (token === ')') {
        if (skipDepth === 1) {
          skipDepth = 0;
          variations.pop();
        } else if (skipDepth) skipDepth -= 1;
        else if (boards.length > 1) {
          variations.pop();
          boards.pop();
        }
      } else if (skipDepth) continue;
      else if (token.startsWith(';')) break;
      else if (token.startsWith('$') || /^[?!]{1,2}$/.test(token)) continue;      // NAGs: normalise reads none
      else if (RESULTS.includes(token) && boards.length === 1) {
        if (game.headers.value('Result', '*') === '*') game.headers.set('Result', token);
      } else {
        const board = boards.at(-1);
        let m = null;
        if (board.pos) {
          try {
            m = parseSan(board.pos, token);
          } catch (e) {
            game.errors.push(e.message);
            skipDepth = 1;
          }
        } else m = token;       // a variant board: kept as text, never played
        if (m !== null) {
          const top = variations.at(-1);
          if (top === undefined) throw new Error('pop from empty list');   // as python-chess fails, past a stray ')'
          const node = { move: m, comment: '', parent: top, children: [] };
          top.children.push(node);
          variations[variations.length - 1] = node;
          startingComment = '';
          inVariation = true;
          board.before.push(board.pos ? board.pos.clone() : null);
          if (board.pos) push(board.pos, m);
        }
      }
    }
    if (fresh) line = stream.readline();
  }
  return game;
}

/** Every game in a text, as read_game finds them one after another. */
export function* readGames(text) {
  const stream = new Lines(text);
  let game;
  while ((game = readGame(stream)) !== null) yield game;
}

/** node.clock(): the first [%clk h:mm:ss] in a move's comment, in seconds. */
export function clock(comment) {
  const m = CLOCK.exec(comment);
  if (!m) return null;
  return Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** game.board(): the position the game starts from (an ordinary board). */
function gameBoard(game) {
  const tag = game.headers.value('FEN');
  return tag === null ? Chess.default() : boardFromFen(tag);
}

// --- rows ---------------------------------------------------------------------------------------------------

/** One row per ply (position before the move), plus a terminal row with move_played null. */
export function extractPositions(game, gameId) {
  const board = gameBoard(game);
  const rows = [];
  for (let node = game.root.children[0]; node; node = node.children[0]) {
    const clk = clock(node.comment);
    rows.push({
      game_id: gameId,
      ply: rows.length,
      fen: fen(board),
      move_played: uci(node.move),
      side_to_move: board.turn,
      clock_remaining: clk === null ? null : pyRound(clk),
    });
    push(board, node.move);
  }
  rows.push({ game_id: gameId, ply: rows.length, fen: fen(board), move_played: null, side_to_move: board.turn,
    clock_remaining: null });
  return rows;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// datetime.strptime(s, "%Y.%m.%d %H:%M:%S"): _strptime's own patterns, matched from the start and then required to
// reach the end (no backtracking into a shorter alternative)
const STRPTIME = /^(\d\d\d\d)\.(1[0-2]|0[1-9]|[1-9])\.(3[01]|[12]\d|0[1-9]|[1-9]| [1-9])\s+(2[0-3]|[0-1]\d|\d):([0-5]\d|\d):(6[0-1]|[0-5]\d|\d)/i;

function strptime(s) {
  const m = STRPTIME.exec(s);
  if (!m || m[0].length !== s.length) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (y < 1 || d > (mo === 2 && leap ? 29 : DAYS[mo - 1]) || sec > 59) return null;
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(sec)}`;
}

/** datetime.fromtimestamp(seconds, tz=utc).isoformat() without the zone. */
export function utcIso(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 19);
}

/** normalise._played_at */
export function playedAt(headers, fallbackEpoch = null) {
  const date = headers.value('UTCDate') || headers.value('Date');
  const tm = headers.value('UTCTime') || headers.value('StartTime') || '00:00:00';
  if (date && !date.includes('?')) {
    const at = strptime(`${date} ${tm}`);
    if (at) return at;
  }
  return fallbackEpoch === null || fallbackEpoch === undefined ? null : utcIso(fallbackEpoch);
}

/** normalise._opening_name: the last part of chess.com's ECOUrl, or the Opening tag. */
export function openingName(headers) {
  const url = headers.value('ECOUrl');
  if (url) return url.replace(/\/+$/, '').split('/').at(-1).replace(/-(?=[A-Za-z0-9])/g, ' ');
  return headers.value('Opening');
}

function isStandard(game) {
  const variant = game.headers.value('Variant', 'Standard').toLowerCase();
  if (variant !== 'standard' && variant !== 'chess') return false;
  if (game.invalidFen) return false;      // (python-chess raises here, failing the whole build)
  return fen(gameBoard(game)) === STARTING_FEN;
}

/** normalise._time_class: chess.com's bucket for a pasted PGN (the archives carry it). */
export function timeClass(timeControl) {
  if (!timeControl || timeControl === '-') return null;
  if (timeControl.includes('/')) return 'daily';
  const plus = timeControl.indexOf('+');
  const base = pyInt(plus < 0 ? timeControl : timeControl.slice(0, plus));
  const inc = plus < 0 || plus === timeControl.length - 1 ? 0 : pyInt(timeControl.slice(plus + 1));
  if (base === null || inc === null) return null;
  const est = base + 40 * inc;
  return est < 180 ? 'bullet' : est < 600 ? 'blitz' : 'rapid';
}

const firstGame = text => readGames(text ?? '').next().value ?? null;

/** normalise.parse_chesscom: one game of a chess.com monthly archive, [gameRow, positions] or null. */
export function parseChesscom(g, username) {
  if (g.rules !== 'chess') return null;
  const { white, black } = g;
  const uname = username.toLowerCase();
  let me, them, colour;
  if (white.username.toLowerCase() === uname) [me, them, colour] = [white, black, 'white'];
  else if (black.username.toLowerCase() === uname) [me, them, colour] = [black, white, 'black'];
  else return null;

  const game = firstGame(g.pgn);
  if (game === null || !isStandard(game)) return null;

  const myCode = me.result;
  const result = myCode === 'win' ? 'win' : DRAW_CODES.has(myCode) ? 'draw' : 'loss';
  const h = game.headers;
  const row = {
    game_id: g.url,
    played_at: playedAt(h, g.end_time ?? null),
    time_control: g.time_control ?? null,
    time_class: g.time_class ?? null,
    my_colour: colour,
    my_rating: me.rating ?? null,
    opponent_rating: them.rating ?? null,
    result,
    termination: h.value('Termination') || (myCode === 'win' ? them.result : myCode),
    eco: h.value('ECO') || null,
    opening_name: openingName(h),
    opponent: them.username ?? null,
    my_name: me.username || username,
  };
  return [row, extractPositions(game, g.url)];
}

// lichess speed -> this app's time classes (chess.com's four, plus classical, which chess.com doesn't have)
export const LICHESS_CLASS = { ultraBullet: 'bullet', bullet: 'bullet', blitz: 'blitz', rapid: 'rapid',
  classical: 'classical', correspondence: 'daily' };
// lichess status -> how chess.com words the ending ("X won by resignation", "Game drawn by stalemate")
export const LICHESS_WIN = { mate: 'checkmate', resign: 'resignation', outoftime: 'time', timeout: 'abandonment',
  cheat: 'fair play', variantEnd: 'variant end', unknownFinish: 'default' };
export const LICHESS_DRAW = { draw: 'agreement', stalemate: 'stalemate', outoftime: 'timeout vs insufficient material',
  insufficientMaterialClaim: 'insufficient material', repetition: 'repetition' };

const own = (table, key) => Object.hasOwn(table, key) ? table[key] : key;
const pyStr = v => v === null || v === undefined ? 'None' : String(v);

function lichessName(side) {
  if (side.user) return side.user.name ?? null;
  if (side.aiLevel) return `lichess AI level ${side.aiLevel}`;
  return 'Anonymous';
}

/** normalise.parse_lichess: one game of the lichess export (pgnInJson, clocks, opening). */
export function parseLichess(g, username) {
  if (g.variant !== 'standard' || ['created', 'started', 'aborted', 'noStart'].includes(g.status)) return null;
  const uname = username.toLowerCase();
  const players = g.players ?? {};
  let me, them, colour;
  for (const [c, other] of [['white', 'black'], ['black', 'white']]) {
    if ((players[c]?.user || {}).id === uname) {
      [me, them, colour] = [players[c], players[other], c];
      break;
    }
  }
  if (!me) return null;

  const game = firstGame(g.pgn ?? '');
  if (game === null || !isStandard(game)) return null;

  const winner = g.winner ?? null;
  const result = winner === null ? 'draw' : winner === colour ? 'win' : 'loss';
  const status = g.status ?? null;
  const termination = winner === null ? `Game drawn by ${pyStr(own(LICHESS_DRAW, status))}`
    : `${pyStr(lichessName(players[winner]))} won by ${pyStr(own(LICHESS_WIN, status))}`;
  let tc;
  if (g.clock) tc = g.clock.increment ? `${g.clock.initial}+${g.clock.increment}` : `${g.clock.initial}`;
  else if (g.daysPerTurn) tc = `1/${g.daysPerTurn * 86400}`;
  else tc = '-';
  // lichess gives the rating going into the game; chess.com's archives, and so the cards, the one after it
  const rating = p => p.rating === null || p.rating === undefined ? null : p.rating + (p.ratingDiff ?? 0);
  const gameId = `https://lichess.org/${g.id}`;
  const opening = g.opening || {};
  const row = {
    game_id: gameId,
    played_at: utcIso(Math.floor(g.createdAt / 1000)),
    time_control: tc,
    time_class: own(LICHESS_CLASS, g.speed) ?? null,
    my_colour: colour,
    my_rating: rating(me),
    opponent_rating: rating(them),
    result,
    termination,
    eco: opening.eco || game.headers.value('ECO') || null,
    opening_name: opening.name || openingName(game.headers),
    opponent: lichessName(them),
    my_name: me.user.name || username,
  };
  return [row, extractPositions(game, gameId)];
}

const ratingOf = v => v !== null && /^[0-9]+$/.test(v) ? Number(v) : null;

/** normalise.parse_pgn_text: every reviewable game of a pasted PGN, [gameRow, positions] each. `digest` names the
 * file (its game ids are pgn:<digest>:<n> unless the game links to a site); `onSkip(message)` hears of a game in
 * which the user is neither player. */
export function* parsePgnText(text, username, digest, onSkip = null) {
  let idx = 0;
  for (const game of readGames(text)) {
    idx += 1;
    if (!isStandard(game)) continue;
    const h = game.headers;
    const uname = username.toLowerCase();
    // a pasted game carries the side to review as a custom tag (the UI asks); otherwise match the username
    let colour;
    const reviewAs = h.value('ReviewAs', '').toLowerCase();
    if (reviewAs === 'white' || reviewAs === 'black') colour = reviewAs;
    else if (h.value('White', '').toLowerCase() === uname) colour = 'white';
    else if (h.value('Black', '').toLowerCase() === uname) colour = 'black';
    else {
      onSkip?.(`pgn ${digest} game ${idx}: ${username} is neither player, skipping`);
      continue;
    }
    const res = h.value('Result', '*');
    const result = res === '1/2-1/2' ? 'draw'
      : res === '1-0' || res === '0-1' ? ((res === '1-0') === (colour === 'white') ? 'win' : 'loss') : null;
    const [me, them] = colour === 'white' ? ['White', 'Black'] : ['Black', 'White'];
    const link = h.value('Link') || h.value('Site') || '';
    const gameId = link.startsWith('http') ? link : `pgn:${digest}:${idx}`;
    const tc = h.value('TimeControl');
    const row = {
      game_id: gameId,
      played_at: playedAt(h),
      time_control: tc,
      time_class: timeClass(tc),
      my_colour: colour,
      my_rating: ratingOf(h.value(`${me}Elo`, '?')),
      opponent_rating: ratingOf(h.value(`${them}Elo`, '?')),
      result,
      termination: h.value('Termination'),
      eco: h.value('ECO') || null,
      opening_name: openingName(h),
      opponent: h.value(them),
      my_name: h.value(me) || username,
    };
    yield [row, extractPositions(game, gameId)];
  }
}

// Path.read_text(): universal newlines
const readText = text => text.replace(/\r\n?/g, '\n');
// str.splitlines()
const splitLines = text => text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).filter((l, i, all) => i < all.length - 1 || l);
const byName = files => [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * normalise.build without the writing: a profile's raw files into its rows.
 * files: {chesscom: [{name, text}] (raw/*.json), lichess: [...] (raw/*.ndjson), pgn: [...] (pgn/*.pgn)}, names
 * with their extension. Returns {games, positions, stats}; a game id seen before is skipped, as in Python.
 */
export function normalise(files, username, onSkip = null) {
  const games = new Map();
  const positions = [];
  const stats = { raw_games: 0, skipped_variant_or_other: 0, pgn_files: 0 };
  const take = parsed => {
    const [row, pos] = parsed;
    if (games.has(row.game_id)) return;
    games.set(row.game_id, row);
    for (const p of pos) positions.push(p);
  };

  for (const f of byName(files.chesscom ?? [])) {
    for (const g of JSON.parse(readText(f.text)).games ?? []) {
      stats.raw_games += 1;
      const parsed = parseChesscom(g, username);
      if (parsed === null) stats.skipped_variant_or_other += 1;
      else take(parsed);
    }
  }
  for (const f of byName(files.lichess ?? [])) {
    for (const line of splitLines(readText(f.text))) {
      if (!line.trim()) continue;
      stats.raw_games += 1;
      const parsed = parseLichess(JSON.parse(line), username);
      if (parsed === null) stats.skipped_variant_or_other += 1;
      else take(parsed);
    }
  }
  for (const f of byName(files.pgn ?? [])) {
    stats.pgn_files += 1;
    for (const parsed of parsePgnText(readText(f.text), username, f.name.replace(/\.pgn$/, ''), onSkip)) take(parsed);
  }
  stats.games = games.size;
  stats.positions = positions.length;
  return { games: [...games.values()], positions, stats };
}
