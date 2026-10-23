// The files adapter profiles.js (and later site, ingest, sync) read and write through: paths relative to the data
// directory, '/'-separated, every call async. Three of them: nodeFiles (profiles-files-node.js) on the desktop,
// opfsFiles in the browser and memoryFiles for tests and as a fallback; this file has the two that run anywhere.
//
//     readText(path) → string, or null when there is no such file
//     writeText(path, text)          creates the parent directories
//     appendText(path, text)
//     readBytes(path) → Uint8Array or null;  writeBytes(path, bytes)
//     exists(path) → bool            a file or a directory
//     list(dir) → [{name, dir}]      sorted by name; [] when there is no such directory
//     mkdir(path)                    with its parents; fine when it exists
//     remove(path)                   a file, or a directory with everything in it; fine when it isn't there
//     rename(from, to)               a file or a directory; the target's parent is created

const parts = path => path.split('/').filter(p => p && p !== '.');
const join = ps => ps.join('/');
const enc = new TextEncoder(), dec = new TextDecoder();

/** Everything in a Map: path → Uint8Array, directories implied by their files plus the ones made empty. */
export function memoryFiles() {
  const files = new Map();
  const dirs = new Set(['']);
  const norm = p => join(parts(p));
  const mkdirs = p => {
    const ps = parts(p);
    for (let i = 0; i <= ps.length; i++) dirs.add(join(ps.slice(0, i)));
  };
  const under = (p, k) => p === '' || k.startsWith(p + '/');
  const fs = {
    async readBytes(path) {
      return files.get(norm(path)) ?? null;
    },
    async writeBytes(path, bytes) {
      const p = norm(path);
      mkdirs(join(parts(p).slice(0, -1)));
      files.set(p, new Uint8Array(bytes));
    },
    async readText(path) {
      const b = files.get(norm(path));
      return b === undefined ? null : dec.decode(b);
    },
    async writeText(path, text) {
      await fs.writeBytes(path, enc.encode(text));
    },
    async appendText(path, text) {
      const old = (await fs.readText(path)) ?? '';
      await fs.writeText(path, old + text);
    },
    async exists(path) {
      const p = norm(path);
      return files.has(p) || dirs.has(p);
    },
    async list(dir) {
      const p = norm(dir);
      if (!dirs.has(p)) return [];
      const depth = parts(p).length;
      const out = new Map();
      for (const k of files.keys()) if (under(p, k)) out.set(parts(k)[depth], parts(k).length > depth + 1);
      for (const k of dirs) if (k !== p && under(p, k)) out.set(parts(k)[depth], true);
      return [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, isDir]) => ({ name, dir: isDir }));
    },
    async mkdir(path) {
      mkdirs(norm(path));
    },
    async remove(path) {
      const p = norm(path);
      files.delete(p);
      for (const k of [...files.keys()]) if (under(p, k)) files.delete(k);
      for (const k of [...dirs]) if (k !== '' && (k === p || under(p, k))) dirs.delete(k);
    },
    async rename(from, to) {
      const f = norm(from), t = norm(to);
      mkdirs(join(parts(t).slice(0, -1)));
      if (files.has(f)) {
        files.set(t, files.get(f));
        files.delete(f);
        return;
      }
      if (!dirs.has(f)) throw new Error(`no such file or directory: ${from}`);
      for (const k of [...files.keys()]) if (under(f, k)) {
        files.set(t + k.slice(f.length), files.get(k));
        files.delete(k);
      }
      for (const k of [...dirs]) if (k === f || under(f, k)) {
        dirs.delete(k);
        dirs.add(t + k.slice(f.length));
      }
    },
  };
  return fs;
}

/** The origin private file system (navigator.storage.getDirectory()), under the directory `root`. Async handles only,
 * so it works on the page as well as in a worker. */
export async function opfsFiles(root = 'data') {
  let top = await navigator.storage.getDirectory();
  for (const p of parts(root)) top = await top.getDirectoryHandle(p, { create: true });

  async function dirHandle(ps, create = false) {
    let d = top;
    for (const p of ps) d = await d.getDirectoryHandle(p, { create });
    return d;
  }
  const missing = e => e?.name === 'NotFoundError' || e?.name === 'TypeMismatchError';
  async function fileHandle(path, create = false) {
    const ps = parts(path);
    return (await dirHandle(ps.slice(0, -1), create)).getFileHandle(ps.at(-1), { create });
  }
  async function write(path, data, append = false) {
    const h = await fileHandle(path, true);
    const w = await h.createWritable({ keepExistingData: append });
    if (append) await w.seek((await h.getFile()).size);
    await w.write(data);
    await w.close();
  }
  const fs = {
    async readBytes(path) {
      try {
        return new Uint8Array(await (await (await fileHandle(path)).getFile()).arrayBuffer());
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    writeBytes: (path, bytes) => write(path, bytes),
    async readText(path) {
      const b = await fs.readBytes(path);
      return b === null ? null : dec.decode(b);
    },
    writeText: (path, text) => write(path, text),
    appendText: (path, text) => write(path, text, true),
    async exists(path) {
      const ps = parts(path);
      if (!ps.length) return true;
      try {
        const d = await dirHandle(ps.slice(0, -1));
        for await (const name of d.keys()) if (name === ps.at(-1)) return true;
        return false;
      } catch (e) {
        if (missing(e)) return false;
        throw e;
      }
    },
    async list(dir) {
      try {
        const d = await dirHandle(parts(dir));
        const out = [];
        for await (const [name, h] of d.entries()) out.push({ name, dir: h.kind === 'directory' });
        return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      } catch (e) {
        if (missing(e)) return [];
        throw e;
      }
    },
    async mkdir(path) {
      await dirHandle(parts(path), true);
    },
    async remove(path) {
      const ps = parts(path);
      try {
        await (await dirHandle(ps.slice(0, -1))).removeEntry(ps.at(-1), { recursive: true });
      } catch (e) {
        if (!missing(e)) throw e;
      }
    },
    async rename(from, to) {
      // OPFS has move() on file handles only in some browsers: copy and delete, which works everywhere
      const ps = parts(from);
      const parent = await dirHandle(ps.slice(0, -1));
      let isDir = false;
      for await (const [name, h] of parent.entries()) if (name === ps.at(-1)) isDir = h.kind === 'directory';
      if (isDir) {
        for (const e of await fs.list(from)) await fs.rename(`${from}/${e.name}`, `${to}/${e.name}`);
        await fs.mkdir(to);
      } else {
        const b = await fs.readBytes(from);
        if (b === null) throw new Error(`no such file or directory: ${from}`);
        await fs.writeBytes(to, b);
      }
      await fs.remove(from);
    },
  };
  return fs;
}
