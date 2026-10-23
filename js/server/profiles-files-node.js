// The files adapter (profiles-files.js has the interface) over node:fs, rooted at the data directory.

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

const missing = e => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';

export function nodeFiles(dataDir) {
  const at = path => join(dataDir, ...path.split('/').filter(Boolean));
  const orNull = async p => {
    try {
      return await p;
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  };
  return {
    async readBytes(path) {
      const b = await orNull(fs.readFile(at(path)));
      return b === null ? null : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    },
    async writeBytes(path, bytes) {
      await fs.mkdir(dirname(at(path)), { recursive: true });
      await fs.writeFile(at(path), bytes);
    },
    readText: path => orNull(fs.readFile(at(path), 'utf8')),
    async writeText(path, text) {
      await fs.mkdir(dirname(at(path)), { recursive: true });
      await fs.writeFile(at(path), text, 'utf8');
    },
    async appendText(path, text) {
      await fs.mkdir(dirname(at(path)), { recursive: true });
      await fs.appendFile(at(path), text, 'utf8');
    },
    async exists(path) {
      return (await orNull(fs.stat(at(path)))) !== null;
    },
    async list(dir) {
      const entries = (await orNull(fs.readdir(at(dir), { withFileTypes: true }))) ?? [];
      return entries.map(e => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async mkdir(path) {
      await fs.mkdir(at(path), { recursive: true });
    },
    async remove(path) {
      await fs.rm(at(path), { recursive: true, force: true });
    },
    async rename(from, to) {
      await fs.mkdir(dirname(at(to)), { recursive: true });
      await fs.rename(at(from), at(to));
    },
  };
}
