// The db driver in the browser: SQLite's own WASM build (js/vendor/sqlite-wasm) with the databases in OPFS, through
// its "opfs-sahpool" VFS. That VFS needs no COOP/COEP headers but runs only in a dedicated worker (the one that
// replaces web/py-worker.js), and only one tab at a time can hold the pool: a second tab gets an error from
// webSqlite() and should say so rather than run without its data.
//
// The same driver over the "memdb" VFS keeps the databases in memory, for the tests (Node loads the same module)
// and for a browser without OPFS.

const VFS = 'opfs-sahpool';
const POOL_SPARE = 4;          // free pool slots kept ahead of the next open: a database and its journal take two

let module = null;

/** sqlite3InitModule's result, once. wasmBinary: the .wasm's bytes where it can't be fetched (Node). */
function load(wasmBinary) {
  module ??= (async () => {
    globalThis.sqlite3ApiConfig = { warn: () => {}, log: () => {} };    // it reports every VFS it can't install
    const { default: init } = await import('../vendor/sqlite-wasm/sqlite3.mjs');
    return init(wasmBinary ? { wasmBinary, print: () => {}, printErr: () => {} } : {});
  })();
  return module;
}

const quote = s => `'${String(s).replace(/'/g, "''")}'`;
const trim = s => s.replace(/^\/+|\/+$/g, '');

function wrap(sqlite3, db, uri) {
  const { capi } = sqlite3;
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);      // finalized by db.close()
      const start = params => {
        stmt.reset(true);
        if (params.length) stmt.bind(params);
      };
      return {
        all(params) {
          start(params);
          const out = [];
          while (stmt.step()) out.push(stmt.get({}));
          stmt.reset();
          return out;
        },
        get(params) {
          start(params);
          const row = stmt.step() ? stmt.get({}) : undefined;
          stmt.reset();
          return row;
        },
        run(params) {
          start(params);
          stmt.step();
          stmt.reset();
          return { changes: db.changes(), lastInsertRowid: Number(capi.sqlite3_last_insert_rowid(db.pointer)) };
        },
        decltypes() {
          const out = {};
          for (let i = 0; i < stmt.columnCount; i++) out[stmt.getColumnName(i)] = capi.sqlite3_column_decltype(stmt.pointer, i);
          return out;
        },
      };
    },
    exec: sql => void db.exec(sql),
    attach: (name, as) => void db.exec(`ATTACH ${quote(uri(name))} AS ${as}`),
    close: () => db.close(),
  };
}

/** The driver for db.js's Store. opts.memory: the memdb VFS instead of OPFS; opts.root: a directory every name is
 * under, so that separate stores don't meet (a memdb database stays for the life of the module, closed or not);
 * opts.wasmBinary: see load(). */
export async function webSqlite({ memory = false, root = '', wasmBinary = null } = {}) {
  const sqlite3 = await load(wasmBinary);
  const pool = memory ? null : await sqlite3.installOpfsSAHPoolVfs({ name: VFS });
  const vfs = memory ? 'memdb' : VFS;
  const path = name => '/' + [trim(root), trim(name)].filter(Boolean).join('/');
  const uri = name => `file:${path(name)}?vfs=${vfs}`;
  const names = new Set();
  return {
    sqlite3,
    async open(name) {
      if (pool) await pool.reserveMinimumCapacity(pool.getFileCount() + POOL_SPARE);
      const db = new sqlite3.oo1.DB(uri(name), 'c');
      names.add(name);
      // no WAL: the pool has no shared memory, and one worker runs everything, so a rollback journal does
      if (pool) db.exec('PRAGMA journal_mode = TRUNCATE');
      return wrap(sqlite3, db, uri);
    },
    async remove(name) {
      names.delete(name);
      if (pool) for (const f of [path(name), `${path(name)}-journal`]) pool.unlink(f);
      else {      // a memdb database outlives its connections: empty it, so that opening the name again starts afresh
        const db = new sqlite3.oo1.DB(uri(name), 'c');
        try {
          const all = db.selectObjects("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'view')");
          for (const o of all) db.exec(`DROP ${o.type.toUpperCase()} IF EXISTS "${o.name.replace(/"/g, '""')}"`);
          db.exec('PRAGMA user_version = 0');
        } finally {
          db.close();
        }
      }
    },
    async exists(name) {
      return pool ? pool.getFileNames().includes(path(name)) : names.has(name);
    },
    /** One database's bytes (a backup; the hand-over of the migration). Close it in the Store first. */
    exportFile: name => pool?.exportFile(path(name)),
    /** Put a database file in place, the other side of exportFile. */
    importFile: (name, bytes) => pool?.importDb(path(name), bytes),
  };
}
