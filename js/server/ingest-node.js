// ingest's ctx.files over Node's file system (the desktop, and scripts). Text is UTF-8 and written as given: "\n"
// stays "\n" on Windows too, as Python writes the raw files.
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';

export const nodeFiles = {
  async list(dir) {
    try {
      return await readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  },
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  },
  read: path => readFile(path, 'utf8'),
  write: (path, text) => writeFile(path, text, 'utf8'),
  append: (path, text) => appendFile(path, text, 'utf8'),
  mkdir: dir => mkdir(dir, { recursive: true }).then(() => {}),
};
