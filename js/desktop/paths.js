// Where the desktop app finds its files: the same places chess_review/config.py uses, so the Electron build and the
// Python one share a data folder.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo checkout (or, packaged, the root of app.asar): js/desktop/../.. */
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** config.DATA: $CHESS_REVIEW_DATA, else the per-user data folder for a packaged app, else data/ in the checkout. */
export function dataDir({ packaged, env = process.env, platform = process.platform, home = homedir() }) {
  if (env.CHESS_REVIEW_DATA) return env.CHESS_REVIEW_DATA;
  if (!packaged) return join(ROOT, 'data');
  if (platform === 'win32') return join(env.LOCALAPPDATA || home, 'chess-review');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'chess-review');
}

/** config.STOCKFISH: $STOCKFISH, else bin/stockfish(.exe): beside app.asar in a packaged app (resources/bin, an
 * extraResource: an executable can't run from inside the asar), else in the checkout. */
export function stockfishPath({ packaged, resources = process.resourcesPath, env = process.env, platform = process.platform }) {
  if (env.STOCKFISH) return env.STOCKFISH;
  const name = platform === 'win32' ? 'stockfish.exe' : 'stockfish';
  return join(packaged ? resources : ROOT, 'bin', name);
}

/** The page: chess_review/static (index.html, account.js, themes/), inside app.asar when packaged. */
export const STATIC_DIR = join(ROOT, 'chess_review', 'static');
