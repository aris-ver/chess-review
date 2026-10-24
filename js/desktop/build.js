// Builds the Electron app for Windows: packaging/dist/Blundr-windows.zip, a portable folder (Blundr/Blundr.exe,
// resources/app.asar, resources/bin/stockfish.exe, resources/build.json), no installer, and
// packaging/dist/blundr-app-<runtime>.asar, the same app.asar on its own: the small in-app update (update.js). Run on
// Windows from the repo root after `npm ci`:
//
//   node js/desktop/build.js [--version v1.0.0]
//
// app.asar also holds the puzzle pack (puzzle_packs/puzzles.json and packs.json, from chess_review/puzzle_packs/)
// and the opening book (book_keys.txt, made here from packaging/assets/book, data/book or lichess's TSVs).
//
// Stockfish comes from packaging/bin/stockfish.exe; if it isn't there the latest official release is fetched into it ($GH_TOKEN, if set, against the API's rate limit). The app is
// staged and packaged under %LOCALAPPDATA%\chess-review-build\electron, not in the repo: packaging over the WSL share
// is slow.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { bookKeysFromDir } from './book.js';
import { ROOT } from './paths.js';

const { values: args } = parseArgs({ options: { version: { type: 'string', default: '' } } });
const NAME = 'Blundr';
const ZIP = 'Blundr-windows.zip';
const BOOK_URL = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master';
const HOME = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || homedir(), 'chess-review-build', 'electron')
  : join(tmpdir(), 'chess-review-build', 'electron');
const STAGE = join(HOME, 'app'), OUT = join(HOME, 'out'), DIST = join(ROOT, 'packaging', 'dist');
const STOCKFISH = join(ROOT, 'packaging', 'bin', 'stockfish.exe');

function version() {
  if (args.version) return args.version;
  try { return execFileSync('git', ['-C', ROOT, 'describe', '--tags', '--always'], { encoding: 'utf8' }).trim() || 'dev'; } catch { return 'dev'; }
}

async function fetchStockfish() {
  if (existsSync(STOCKFISH)) return;
  console.log('Downloading latest Stockfish (Windows x86-64)...');
  const headers = { 'User-Agent': 'chess-review-build', ...(process.env.GH_TOKEN && { Authorization: `Bearer ${process.env.GH_TOKEN}` }) };
  const rel = await (await fetch('https://api.github.com/repos/official-stockfish/Stockfish/releases/latest', { headers })).json();
  const asset = (rel.assets || []).find(a => a.name === 'stockfish-windows-x86-64-universal.zip');
  if (!asset) throw new Error(`no Windows build in Stockfish's latest release (${rel.tag_name ?? rel.message})`);
  const tmp = join(HOME, 'stockfish-download');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const zip = join(tmp, 'stockfish.zip');
  writeFileSync(zip, Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer()));
  execFileSync('tar', ['-xf', zip, '-C', tmp]);     // Windows' tar (bsdtar) reads zips
  const exe = readdirSync(tmp, { recursive: true }).find(f => f.toLowerCase().endsWith('.exe'));
  mkdirSync(join(ROOT, 'packaging', 'bin'), { recursive: true });
  cpSync(join(tmp, exe), STOCKFISH);
  rmSync(tmp, { recursive: true, force: true });
}

// the opening book's keys, from the TSVs fetched here before, a checkout's data/book, or lichess
async function bookKeys() {
  for (const dir of [join(ROOT, 'packaging', 'assets', 'book'), join(ROOT, 'data', 'book')]) {
    const keys = bookKeysFromDir(dir);
    if (keys.length) return keys;
  }
  console.log('Downloading the opening book...');
  const dir = join(ROOT, 'packaging', 'assets', 'book');
  mkdirSync(dir, { recursive: true });
  for (const f of ['a', 'b', 'c', 'd', 'e']) {
    const r = await fetch(`${BOOK_URL}/${f}.tsv`);
    if (!r.ok) throw new Error(`opening book ${f}.tsv: HTTP ${r.status}`);
    writeFileSync(join(dir, `${f}.tsv`), await r.text());
  }
  return bookKeysFromDir(dir);
}

// What goes into app.asar: the JS (no tests), the page, the puzzles, the book and a package.json that starts
// js/desktop/main.js.
async function stage(ver) {
  rmSync(STAGE, { recursive: true, force: true });
  const notTest = src => !/\.test\.js$/.test(src) && !/[\\/]js[\\/](run-tests|parity)\.js$/.test(src);
  cpSync(join(ROOT, 'js'), join(STAGE, 'js'), { recursive: true, filter: src => notTest(src) && src !== join(ROOT, 'js', 'desktop', 'build.js') });
  cpSync(join(ROOT, 'chess_review', 'static'), join(STAGE, 'chess_review', 'static'), { recursive: true });
  cpSync(join(ROOT, 'chess_review', 'puzzle_packs', 'puzzles.json'), join(STAGE, 'puzzle_packs', 'puzzles.json'));
  cpSync(join(ROOT, 'chess_review', 'puzzle_packs', 'packs.json'), join(STAGE, 'puzzle_packs', 'packs.json'));
  const keys = await bookKeys();
  if (keys.length < 1000) throw new Error(`the opening book has only ${keys.length} positions`);
  writeFileSync(join(STAGE, 'book_keys.txt'), keys.join('\n'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  writeFileSync(join(STAGE, 'package.json'), JSON.stringify({
    name: 'blundr', productName: NAME, version: numeric(ver), description: 'Blundr: chess game review',
    type: 'module', main: pkg.main,
  }, null, 2));
}

// '0.8.0' from 'v0.8.0' or git describe's 'v0.7.2-3-gabc123': the Windows file version takes numbers only
function numeric(ver) {
  const m = /^v?(\d+(?:\.\d+){0,3})/.exec(ver);
  return m ? m[1].split('.').concat(['0', '0']).slice(0, 3).join('.') : '0.0.0';
}

async function main() {
  const ver = version();
  const electronVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  await fetchStockfish();
  await stage(ver);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(HOME, 'bin'), { recursive: true });
  cpSync(STOCKFISH, join(HOME, 'bin', 'stockfish.exe'));

  const mod = await import('@electron/packager');
  const packager = mod.packager ?? mod.default;
  const [built] = await packager({
    dir: STAGE, out: OUT, name: NAME, executableName: NAME, platform: 'win32', arch: 'x64', electronVersion,
    appVersion: numeric(ver), buildVersion: numeric(ver), appCopyright: '', asar: true, overwrite: true, prune: false,
    icon: join(ROOT, 'packaging', 'chess-review.ico'),
    extraResource: [join(HOME, 'bin')],     // resources/bin/stockfish.exe: an exe can't run from inside the asar
    win32metadata: { ProductName: NAME, FileDescription: NAME, CompanyName: NAME },
  });
  // build.json beside app.asar: what the updater (README.md) compares; `runtime` is the Electron version, the part
  // that only a full download can change
  const runtime = `electron-${electronVersion}`;
  writeFileSync(join(built, 'resources', 'build.json'), JSON.stringify({ version: ver, runtime }));
  const app = join(OUT, NAME);
  renameSync(built, app);

  mkdirSync(DIST, { recursive: true });
  const zip = join(DIST, ZIP);
  rmSync(zip, { force: true });
  // the small update: app.asar alone, named for the runtime it fits (js/server/updater.js ELECTRON_ASSETS)
  const asar = join(DIST, `blundr-app-${runtime}.asar`);
  for (const f of readdirSync(DIST)) if (/^blundr-app-.*\.asar$/.test(f)) rmSync(join(DIST, f));
  cpSync(join(app, 'resources', 'app.asar'), asar);
  // the zip wraps the app folder, as Blundr-windows.zip does (updater.ZIP_ROOTS)
  if (process.platform === 'win32') execFileSync('tar', ['-a', '-c', '-f', zip, '-C', OUT, NAME]);
  else execFileSync('zip', ['-qr', zip, NAME], { cwd: OUT });
  console.log(`\nversion ${ver}, Electron ${electronVersion}\nApp folder: ${join(app, NAME + '.exe')}\nZip: ${zip}
Small update: ${asar}`);
}

main().catch(err => { console.error(err); process.exit(1); });
