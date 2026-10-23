// The page's saved preferences (volume, theme, ...), as serve.load_settings / save_settings: DATA/settings.json, one
// {key: string} object. They live here rather than only in localStorage because localStorage belongs to the origin,
// and the desktop app's port changes whenever 8123 is taken.
//
// `files` is a profiles-files.js adapter rooted at the data directory.

import { pyDumps } from './profiles.js';

export const SETTINGS_FILE = 'settings.json';

/** json.dumps(v, indent=1, sort_keys=True): Python's pretty layout, byte for byte. */
export function pyDumpsIndented(v, indent = 1, depth = 0) {
  const pad = n => '\n' + ' '.repeat(indent * n);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return `[${v.map(x => pad(depth + 1) + pyDumpsIndented(x, indent, depth + 1)).join(',')}${pad(depth)}]`;
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!keys.length) return '{}';
    return `{${keys.map(k => `${pad(depth + 1)}${pyDumps(k)}: ${pyDumpsIndented(v[k], indent, depth + 1)}`).join(',')}${pad(depth)}}`;
  }
  return pyDumps(v);
}

/** The saved settings, {} when there are none or the file can't be read. */
export async function loadSettings(files) {
  try {
    const text = await files.readText(SETTINGS_FILE);
    if (text === null) return {};
    const d = JSON.parse(text);
    return d !== null && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

const queues = new WeakMap();     // files adapter → the last save, so saves run one at a time (serve's _settings_lock)

/** Merge {key: string | null} into the saved settings (null removes the key). */
export function saveSettings(files, changes) {
  const run = async () => {
    const d = await loadSettings(files);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete d[k];
      else d[k] = v;
    }
    await files.writeText('settings.tmp', pyDumpsIndented(d));
    await files.rename('settings.tmp', SETTINGS_FILE);
  };
  const next = (queues.get(files) ?? Promise.resolve()).then(run, run);
  queues.set(files, next.catch(() => {}));
  return next;
}

/** POST /api/settings's check: {key: string | null}. */
export const validSettings = b => b !== null && typeof b === 'object' && !Array.isArray(b) &&
  Object.values(b).every(v => v === null || typeof v === 'string');
