// chess_review/export.py: a profile's games, and its positions joined with their evals, as CSV files in its export/
// folder, for eyeballing. eval_cp / mate_in in the CSV are re-signed to WHITE POV in the SQL; the stored cache stays
// side-to-move POV.
//
// Python had DuckDB COPY ... TO (HEADER) write the files; here the rows come out of SQLite and are written the way
// DuckDB's CSV writer writes them: a header line, "," between fields, "\n" after each line, NULL as nothing, a string
// in double quotes (inner quotes doubled) when it is empty or holds a comma, a quote or a line break, a TIMESTAMP as
// "YYYY-MM-DD HH:MM:SS". array_to_string(pv, ' ') is done here too (pv is JSON text in SQLite): NULL stays NULL,
// NULL items are left out. DuckDB sorts NULLs last, so does the games query; games played in the same second come
// in either order, as in DuckDB.

const QUOTE = /[",\n\r]/;

/** One field as DuckDB's CSV writer writes it. */
export function csvField(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return s === '' || QUOTE.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** rows (objects) as a CSV file with a header line, columns in the rows' order. */
export function csv(rows, columns = rows.length ? Object.keys(rows[0]) : []) {
  return [columns, ...rows.map(r => columns.map(c => r[c]))].map(r => r.map(csvField).join(',') + '\n').join('');
}

export const GAMES_SQL = 'SELECT * FROM games ORDER BY played_at NULLS LAST';

export const POSITIONS_EVALS_SQL = `
  SELECT p.game_id, p.ply, p.side_to_move, p.move_played, p.clock_remaining,
         e.nodes,
         CASE WHEN p.side_to_move = 'white' THEN e.eval_cp ELSE -e.eval_cp END AS eval_cp_white,
         CASE WHEN p.side_to_move = 'white' THEN e.mate_in ELSE -e.mate_in END AS mate_in_white,
         e.best_move, e.pv, p.fen
  FROM positions p LEFT JOIN evals e USING (fen_key)
  ORDER BY p.game_id, p.ply
`;

const GAMES_COLUMNS = ['game_id', 'played_at', 'time_control', 'time_class', 'my_colour', 'my_rating', 'opponent_rating',
  'result', 'termination', 'eco', 'opening_name', 'opponent', 'my_name'];
const POSITIONS_COLUMNS = ['game_id', 'ply', 'side_to_move', 'move_played', 'clock_remaining', 'nodes', 'eval_cp_white',
  'mate_in_white', 'best_move', 'pv', 'fen'];

/** The two files' text: {games, positionsEvals}. */
export function exportCsv(db) {
  const games = db.all(GAMES_SQL).map(r => ({ ...r, played_at: r.played_at === null ? null : r.played_at.replace('T', ' ') }));
  const positions = db.all(POSITIONS_EVALS_SQL).map(r => ({ ...r, pv: r.pv === null ? null : r.pv.filter(m => m !== null).join(' ') }));
  return { games: csv(games, GAMES_COLUMNS), positionsEvals: csv(positions, POSITIONS_COLUMNS) };
}

/** export.main for one profile: export/games.csv and export/positions_evals.csv. db: store.profile(p); files: the
 * profiles-files adapter. Returns {games, positions, evaluated, out}, the counts export.py logs. */
export async function exportProfile(db, files, profile) {
  const out = profile.exportDir;
  await files.mkdir(out);
  const text = exportCsv(db);
  await files.writeText(`${out}/games.csv`, text.games);
  await files.writeText(`${out}/positions_evals.csv`, text.positionsEvals);
  const counts = db.get(`
    SELECT (SELECT count(*) FROM games) games,
           (SELECT count(*) FROM positions) positions,
           (SELECT count(*) FROM positions p JOIN evals e USING (fen_key)) evaluated
  `);
  return { ...counts, out };
}
