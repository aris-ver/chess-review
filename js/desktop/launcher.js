// What launcher.py did at start besides opening the window, for the packaged Windows app:
//   - the exe's old names (Chess Review.exe, chess-review.exe), left beside Blundr.exe by the Python builds and
//     by an install that moved over from one, are deleted, retrying while the copy that handed over still exits;
//   - the downloaded-file mark (the Zone.Identifier stream Explorer's extractor copies onto every file of a
//     downloaded zip) is cleared from the app's own binaries, so Windows stops treating them as from the internet.
// The opening book needs no seeding any more: its keys ship inside app.asar (book.js).

import { join } from 'node:path';

import { LEGACY_EXE_NAMES, rawFs } from './update.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** launcher._retire_old_exes / _delete: the old exes beside this one, removed. Resolves to the names removed. */
export async function retireOldExes(installDir, { log, tries = 20, wait = 500, fs = rawFs() } = {}) {
  let left = LEGACY_EXE_NAMES.map(n => join(installDir, n)).filter(p => fs.existsSync(p));
  const removed = [];
  for (let i = 0; i < tries && left.length; i++) {
    if (i) await sleep(wait);
    left = left.filter(p => {
      try {
        fs.unlinkSync(p);
        removed.push(p);
        log?.info(`removed the old ${p}`);
        return false;
      } catch (e) {
        return e.code !== 'ENOENT';     // still running: the next round
      }
    });
  }
  if (left.length) log?.warn(`could not remove ${left.join(', ')}`);
  return removed;
}

/** launcher._unblock_bundle: the Zone.Identifier stream removed from every .exe, .dll and .node under dir.
 * Returns how many had one. */
export function unblock(dir, { log, fs = rawFs() } = {}) {
  let dropped = 0;
  let names;
  try {
    names = fs.readdirSync(dir, { recursive: true });     // the raw fs: app.asar is a file, not a folder
  } catch {
    return 0;
  }
  for (const rel of names) {
    if (!/\.(exe|dll|node)$/i.test(rel)) continue;
    try {
      fs.unlinkSync(`${join(dir, rel)}:Zone.Identifier`);    // no stream: ENOENT, the normal case
      dropped++;
    } catch {
      // none
    }
  }
  if (dropped) log?.info(`cleared the downloaded-file mark from ${dropped} bundled binaries`);
  return dropped;
}
