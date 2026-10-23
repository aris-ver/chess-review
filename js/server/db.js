// The database: SQLite in place of chess_review/db.py's DuckDB views over parquet. One interface, two drivers:
// node:sqlite on the desktop (db-node.js) and SQLite WASM in OPFS in the browser (js/web/db.js). Pure: nothing here
// imports either, so the browser and Node load the same file.
//
// The files, by name relative to the data directory (as the Python ones are):
//
//     evals.sqlite                  the shared engine cache, keyed by position: evals, evals_multipv (was evals.duckdb)
//     progress.sqlite               puzzle progress across profiles: puzzle_attempts, puzzle_solved, puzzle_daily
//                                   (was puzzle_attempts*.jsonl, puzzle_solved.jsonl, puzzle_daily.jsonl)
//     profiles/<id>/games.sqlite    one player's games, positions, moves (was games/positions/moves.parquet), the
//                                   moves' fingerprints (was moves.fp.json) and the own-puzzle review record
//                                   (puzzle_attempts, was profiles/<id>/puzzle_attempts*.jsonl)
//
// A profile's connection has evals.sqlite attached (as `ev`), so `games`, `positions`, `moves`, `evals` and
// `evals_multipv` all answer unqualified, as on the connection db.connect(profile) gives in Python, and its queries
// port as they are. `positions` has fen_key as a stored column, filled on insert.
//
// Values: what SQLite has no type for is encoded on the way in and decoded on the way out by the column's declared
// type: BOOLEAN columns hold 0/1 and come back as true/false, JSON columns (pv, marks) hold JSON text and come back
// parsed. Decoding needs a declared type, so it happens for plain column references (also through a join or a view),
// not for expressions: `SELECT pv` is a list, `SELECT coalesce(pv, '[]')` is text. TIMESTAMP is ISO text.
//
// A driver opens a database by name and gives back a raw connection:
//     { prepare(sql) → { all(params), get(params), run(params) → {changes, lastInsertRowid}, decltypes() },
//       exec(sql), attach(name, schema), close() }
// with rows as plain objects and params as an array of SQLite values. Everything else is here.

import { fenKey } from '../core/fen.js';

export const EVALS = 'evals.sqlite';
export const PROGRESS = 'progress.sqlite';
export const profileDb = id => `profiles/${id}/games.sqlite`;

export const SCHEMA_VERSION = 1;

/** (name, SQL type) in order, as normalise.GAMES_SCHEMA */
export const GAMES_SCHEMA = [
  ['game_id', 'TEXT'],
  ['played_at', 'TIMESTAMP'],
  ['time_control', 'TEXT'],
  ['time_class', 'TEXT'],
  ['my_colour', 'TEXT'],
  ['my_rating', 'INTEGER'],
  ['opponent_rating', 'INTEGER'],
  ['result', 'TEXT'],
  ['termination', 'TEXT'],
  ['eco', 'TEXT'],
  ['opening_name', 'TEXT'],
  ['opponent', 'TEXT'],
  ['my_name', 'TEXT'],
];

/** as normalise.POSITIONS_SCHEMA, plus fen_key (a computed column of Python's positions view) */
export const POSITIONS_SCHEMA = [
  ['game_id', 'TEXT'],
  ['ply', 'INTEGER'],
  ['fen', 'TEXT'],
  ['move_played', 'TEXT'],
  ['side_to_move', 'TEXT'],
  ['clock_remaining', 'INTEGER'],
  ['fen_key', 'TEXT'],
];

/** as classify.MOVES_SCHEMA */
export const MOVES_SCHEMA = [
  ['game_id', 'TEXT'],
  ['ply', 'INTEGER'],
  ['side_to_move', 'TEXT'],
  ['is_mine', 'BOOLEAN'],
  ['move_played', 'TEXT'],
  ['san', 'TEXT'],
  ['best_move', 'TEXT'],
  ['best_san', 'TEXT'],
  ['n_legal', 'INTEGER'],
  ['is_forced', 'BOOLEAN'],
  ['in_book', 'BOOLEAN'],
  ['wp_before', 'REAL'],      // mover POV, 0-100
  ['wp_after', 'REAL'],
  ['wp_loss', 'REAL'],        // max(0, before - after)
  ['accuracy', 'REAL'],       // lichess per-move accuracy, 0-100
  ['label', 'TEXT'],
  ['only_move', 'BOOLEAN'],   // MultiPV says #1 was the only good move (NULL without MultiPV)
  ['clock_remaining', 'INTEGER'],
  ['time_spent', 'INTEGER'],
];

/** as analyse.SCHEMA */
export const EVALS_SCHEMA = [
  ['fen_key', 'TEXT'],
  ['nodes', 'INTEGER'],
  ['eval_cp', 'INTEGER'],
  ['mate_in', 'INTEGER'],
  ['best_move', 'TEXT'],
  ['pv', 'JSON'],
];

export const EVALS_MULTIPV_SCHEMA = [
  ['fen_key', 'TEXT'],
  ['rank', 'INTEGER'],
  ['move', 'TEXT'],
  ['eval_cp', 'INTEGER'],
  ['mate_in', 'INTEGER'],
  ['pv', 'JSON'],
];

/** One line of puzzle_attempts.jsonl ({id, ts, solved, ms, hinted, rating}; own puzzles have no rating). `archive`
 * is the reset it was moved aside by (`reset-<when>`, as the .reset-<when>.jsonl file was named), NULL while
 * current; seq keeps the file's order. */
export const ATTEMPTS_SCHEMA = [
  ['seq', 'INTEGER'],
  ['archive', 'TEXT'],
  ['id', 'TEXT'],
  ['ts', 'INTEGER'],
  ['solved', 'BOOLEAN'],
  ['ms', 'INTEGER'],
  ['hinted', 'BOOLEAN'],
  ['rating', 'INTEGER'],
];

/** puzzle_solved.jsonl: {id, ts} */
export const SOLVED_SCHEMA = [
  ['seq', 'INTEGER'],
  ['id', 'TEXT'],
  ['ts', 'INTEGER'],
];

/** puzzle_daily.jsonl: {date, n, id, solved, clean, ms, marks} */
export const DAILY_SCHEMA = [
  ['seq', 'INTEGER'],
  ['date', 'TEXT'],
  ['n', 'INTEGER'],
  ['id', 'TEXT'],
  ['solved', 'BOOLEAN'],
  ['clean', 'BOOLEAN'],
  ['ms', 'INTEGER'],
  ['marks', 'JSON'],
];

const SEQ = 'seq INTEGER PRIMARY KEY AUTOINCREMENT';

function table(name, schema, extra = []) {
  const cols = schema.map(([n, t]) => (n === 'seq' ? SEQ : `"${n}" ${t}`));
  return `CREATE TABLE IF NOT EXISTS ${name} (\n  ${[...cols, ...extra].join(',\n  ')}\n);`;
}

export const EVALS_DDL = [
  table('evals', EVALS_SCHEMA, ['PRIMARY KEY (fen_key)']),
  table('evals_multipv', EVALS_MULTIPV_SCHEMA, ['PRIMARY KEY (fen_key, rank)']),
].join('\n');

export const PROGRESS_DDL = [
  table('puzzle_attempts', ATTEMPTS_SCHEMA),
  'CREATE INDEX IF NOT EXISTS puzzle_attempts_id ON puzzle_attempts (id);',
  table('puzzle_solved', SOLVED_SCHEMA),
  table('puzzle_daily', DAILY_SCHEMA),
].join('\n');

export const PROFILE_DDL = [
  table('games', GAMES_SCHEMA, ['PRIMARY KEY (game_id)']),
  table('positions', POSITIONS_SCHEMA, ['PRIMARY KEY (game_id, ply)']),
  'CREATE INDEX IF NOT EXISTS positions_fen_key ON positions (fen_key);',
  table('moves', MOVES_SCHEMA, ['PRIMARY KEY (game_id, ply)']),
  table('move_fingerprints', [['game_id', 'TEXT'], ['fp', 'TEXT']], ['PRIMARY KEY (game_id)']),
  table('puzzle_attempts', ATTEMPTS_SCHEMA),
  'CREATE INDEX IF NOT EXISTS puzzle_attempts_id ON puzzle_attempts (id);',
].join('\n');

/** A JS value as SQLite stores it. */
export function encode(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && !ArrayBuffer.isView(v)) return JSON.stringify(v);
  return v;
}

const DECODE = {
  BOOLEAN: v => (v === null ? null : !!v),
  JSON: v => (v === null || typeof v !== 'string' ? v : JSON.parse(v)),
};

/** One connection. Every method is synchronous: both drivers are (node:sqlite, and SQLite WASM in a worker). */
export class Db {
  /** @param raw a driver's connection; @param name the database's name (EVALS, PROGRESS, profileDb(id)) */
  constructor(raw, name) {
    this.raw = raw;
    this.name = name;
    this.statements = new Map();
    this.depth = 0;
  }

  statement(sql) {
    let s = this.statements.get(sql);
    if (!s) {
      const stmt = this.raw.prepare(sql);
      const types = stmt.decltypes();
      const decoders = Object.entries(types).filter(([, t]) => t && DECODE[t.toUpperCase()])
        .map(([col, t]) => [col, DECODE[t.toUpperCase()]]);
      s = { stmt, decoders };
      if (this.statements.size > 500) this.statements.clear();
      this.statements.set(sql, s);
    }
    return s;
  }

  decode(row, decoders) {
    for (const [col, f] of decoders) row[col] = f(row[col]);
    return row;
  }

  /** Every row, as objects column name → value. */
  all(sql, params = []) {
    const { stmt, decoders } = this.statement(sql);
    const rows = stmt.all(params.map(encode));
    if (decoders.length) for (const r of rows) this.decode(r, decoders);
    return rows;
  }

  /** The first row, or undefined. */
  get(sql, params = []) {
    const { stmt, decoders } = this.statement(sql);
    const row = stmt.get(params.map(encode));
    return row === undefined ? undefined : this.decode(row, decoders);
  }

  /** The first column of every row. */
  column(sql, params = []) {
    return this.all(sql, params).map(r => r[Object.keys(r)[0]]);
  }

  /** The first column of the first row (undefined without one). */
  value(sql, params = []) {
    const r = this.get(sql, params);
    return r === undefined ? undefined : r[Object.keys(r)[0]];
  }

  /** A statement that returns no rows: { changes, lastInsertRowid }. */
  run(sql, params = []) {
    return this.statement(sql).stmt.run(params.map(encode));
  }

  /** Statements without parameters, any number of them. */
  exec(sql) {
    this.raw.exec(sql);
  }

  /** fn() in one transaction: committed when it returns, rolled back when it throws. Nested calls join the outer
   * one. fn must not await: the connection is shared, and a transaction open across an await would take in
   * whatever else ran meanwhile. */
  tx(fn) {
    if (this.depth) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  /** rows (objects) into table, schema's columns in order: a key a row lacks is NULL, one the schema lacks is dropped,
   * as db.write_parquet does. or: 'IGNORE' | 'REPLACE' | ''. Returns the number of rows inserted. */
  insert(table, schema, rows, or = '') {
    const cols = schema.map(c => (Array.isArray(c) ? c[0] : c)).filter(c => c !== 'seq');
    const sql = `INSERT ${or ? `OR ${or} ` : ''}INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const { stmt } = this.statement(sql);
    let n = 0;
    this.tx(() => {
      for (const r of rows) n += stmt.run(cols.map(c => encode(r[c]))).changes;
    });
    return n;
  }

  close() {
    this.statements.clear();
    this.raw.close();
  }
}

/** Opens the databases by name through a driver and keeps one connection to each. The driver:
 *     { open(name) → Promise<raw connection>, remove(name) → Promise, exists(name) → Promise<bool> }
 * (db-node.js's nodeSqlite(dataDir), js/web/db.js's webSqlite()). */
export class Store {
  constructor(driver) {
    this.driver = driver;
    this.open = new Map();     // name → Promise<Db>
  }

  async connect(name, ddl, attach = []) {
    if (!this.open.has(name)) {
      const p = (async () => {
        const raw = await this.driver.open(name);
        const db = new Db(raw, name);
        try {
          for (const [other, as] of attach) await this.ensure(other);
          for (const [other, as] of attach) raw.attach(other, as);
          if (db.value('PRAGMA user_version') === 0) {
            db.tx(() => {
              db.exec(ddl);
              db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
            });
          }
        } catch (e) {
          raw.close();
          throw e;
        }
        return db;
      })();
      this.open.set(name, p);
      p.catch(() => this.open.delete(name));
    }
    return this.open.get(name);
  }

  /** The schema of a database another one attaches exists before it is attached. */
  async ensure(name) {
    if (name === EVALS) await this.evals();
    else if (name === PROGRESS) await this.progress();
  }

  /** The engine cache on its own (evals, evals_multipv). */
  evals() {
    return this.connect(EVALS, EVALS_DDL);
  }

  /** Puzzle progress across profiles (puzzle_attempts, puzzle_solved, puzzle_daily). */
  progress() {
    return this.connect(PROGRESS, PROGRESS_DDL);
  }

  /** A profile's games, positions and moves with the engine cache attached: db.connect(profile).
   * @param profile a profiles.js profile, or its id */
  profile(profile) {
    const id = typeof profile === 'string' ? profile : profile.id;
    return this.connect(profileDb(id), PROFILE_DDL, [[EVALS, 'ev']]);
  }

  /** Close one database (by name) or all of them. */
  async close(name = null) {
    for (const [n, p] of [...this.open]) {
      if (name !== null && n !== name) continue;
      this.open.delete(n);
      try {
        (await p).close();
      } catch {
        // it never opened
      }
    }
  }

  /** Close and delete a profile's database (profiles.remove does this before deleting the profile's files). */
  async drop(profile) {
    const name = profileDb(typeof profile === 'string' ? profile : profile.id);
    await this.close(name);
    await this.driver.remove(name);
  }
}

/** A position row as the positions table holds it: normalise's row with its fen_key. */
export const withFenKey = r => (r.fen_key ? r : { ...r, fen_key: fenKey(r.fen) });

/** Replace a profile's games and positions with normalise's output, as normalise.build rewrites games.parquet and
 * positions.parquet: games and positions are normalise's row objects (GAMES_SCHEMA, POSITIONS_SCHEMA without
 * fen_key). The moves stay as they are until classify.build rewrites them, as moves.parquet does. */
export function writeGames(db, games, positions) {
  db.tx(() => {
    db.exec('DELETE FROM games; DELETE FROM positions;');
    db.insert('games', GAMES_SCHEMA, games);
    db.insert('positions', POSITIONS_SCHEMA, positions.map(withFenKey));
  });
}
