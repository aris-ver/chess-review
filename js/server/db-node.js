// The db driver on the desktop: node:sqlite (Node 22.13 or newer, which Electron ships), one file per database
// under the data directory. WAL, so the engine cache can be written while it is read on another connection.

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const quote = s => `'${String(s).replace(/'/g, "''")}'`;

function wrap(db, path, resolve) {
  return {
    path,
    prepare(sql) {
      const s = db.prepare(sql);
      return {
        all: params => s.all(...params),
        get: params => s.get(...params),
        run: params => s.run(...params),
        decltypes: () => Object.fromEntries(s.columns().map(c => [c.name, c.type])),
      };
    },
    exec: sql => db.exec(sql),
    attach(name, as) {
      db.exec(`ATTACH ${quote(resolve(name))} AS ${as}`);
      db.exec(`PRAGMA ${as}.journal_mode = WAL`);
    },
    close: () => db.close(),
  };
}

/** The driver for db.js's Store over the files under dataDir (paths as db.js names them). */
export function nodeSqlite(dataDir) {
  const resolve = name => join(dataDir, name);
  return {
    async open(name) {
      const path = resolve(name);
      mkdirSync(dirname(path), { recursive: true });
      const db = new DatabaseSync(path);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
      return wrap(db, path, resolve);
    },
    async remove(name) {
      const path = resolve(name);
      for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) rmSync(f, { force: true });
    },
    async exists(name) {
      return existsSync(resolve(name));
    },
  };
}
