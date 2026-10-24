// Assembles the browser version (docs/web.md) into web-dist/, a static site.
//
//   node scripts/build_web.js [--serve [--port 8200]] [--engine-wasm URL|cdn]     (npm run build:web -- ...)
//
// web-dist/
//   index.html            chess_review/static/index.html with the board's pieces (js/desktop/pieces.json) filled in,
//                         plus the web/shim.js tag
//   account.js            the Blundr account, from chess_review/static/ (the desktop app has the same one)
//   privacy.html, terms.html   from web/pages/
//   manifest.json, icons/ what "Add to Home Screen" installs (icons from web/icons/, rendered from packaging/chess-review.ico)
//   themes/               the page's pieces, boards and sounds
//   js/                   the JS server as the desktop runs it: js/core, js/server (minus the Node adapters), js/web (the
//                         worker, its tabs, the browser adapters), js/vendor (chessops, SQLite WASM); no tests
//   web/                  shim.js, engines.js, config.js, engine/ (Stockfish 19)
//   book_keys.txt         the opening book's positions, one fen_key a line (js/core/book.js), from data/book
//                         (scripts/fetch_book.sh)
//   puzzles.json          the Lichess puzzle pack, fetched alongside the app; packs.json, the puzzle packs
//   legacy/               the one-time move from the Python build's data (js/web/legacy.js): app.zip (legacy/chess_review,
//                         what migrate_sqlite.py needs) and python-chess's wheel, with Pyodide from its CDN. Fetched only
//                         by a browser that still has the Python build's IndexedDB, and only once.
//
// Downloads (cached in data/web-cache): npm stockfish@19.0.1. --engine-wasm points the full engine at another host (the
// Worker refuses files over 25 MiB); `--engine-wasm cdn` is blundr.gr's: the same npm package's file on unpkg. By
// default it is served from web/engine/ next to the rest, which is what --serve wants.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync, gunzipSync } from 'node:zlib';

import { bookKeysFromDir } from '../js/desktop/book.js';
import { ROOT } from '../js/desktop/paths.js';
import { fillPieces } from '../js/server/router.js';

const { values: args } = parseArgs({ options: {
  serve: { type: 'boolean', default: false }, port: { type: 'string', default: '8200' }, 'engine-wasm': { type: 'string' },
} });

const OUT = join(ROOT, 'web-dist');
const CACHE = join(ROOT, 'data', 'web-cache');
const STATIC = join(ROOT, 'chess_review', 'static');
// Pyodide and python-chess only for the one-time move from the Python build's data (legacy/, js/web/legacy.js): the
// Pyodide that wrote that IndexedDB, so its IDBFS layout reads back as it was written
const LEGACY_PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const LEGACY_WHEEL = 'chess-1.11.2-py3-none-any.whl';
// what migrate_sqlite.py imports: all the legacy app.zip holds
const LEGACY_MODULES = ['__init__.py', 'config.py', 'fen.py', 'migrate_sqlite.py'];
// js/ as the browser gets it: no tests, no Node adapters, no Electron
const JS_DIRS = ['core', 'server', 'web', 'vendor'];
const JS_SKIP = ['.test.js', '-node.js', '.md'];
// File names that ad blockers' privacy lists block on sight (EasyPrivacy has /analyse.js, /stats.js, /track.js ...):
// a module of the worker with such a name doesn't load where one is installed, and Blundr never starts there.
const BLOCKED_NAME = new RegExp('analy[sz]|track|stats?\\b|statistic|metric|telemetr|beacon|pixel|advert|(^|[-_.])ads?([-_.]|$)'
  + '|counter|collect|insight|fingerprint', 'i');
// The pieces, boards and sounds (themes/), kept a day (web-dist/_headers) instead of the Worker's default of asking
// again every time: on a phone each of those questions is a round trip, and the home screen's covers waited seconds for
// their pieces. A set changed in place reaches a returning visitor within a day.
const THEMES_CACHE = 'public, max-age=86400, stale-while-revalidate=604800';
const STOCKFISH_VERSION = '19.0.1';   // the same Stockfish as the desktop's bin/: change both together, or reviews stop matching
const STOCKFISH_NPM = `https://registry.npmjs.org/stockfish/-/stockfish-${STOCKFISH_VERSION}.tgz`;
// the full engine (95 MB) as visitors download it: unpkg serves npm files of any size, with CORS and a year's cache
const ENGINE_CDN = `https://unpkg.com/stockfish@${STOCKFISH_VERSION}/bin/stockfish-19-single.wasm`;
const ENGINE_FILES = ['stockfish-19-single.js', 'stockfish-19-single.wasm', 'stockfish-19-lite-single.js',
  'stockfish-19-lite-single.wasm'];

const NAME = 'Blundr';     // the app's name, on blundr.gr and on Windows
const BG = '#302e2b';      // the page's --bg: the status bar and the splash while it loads
// Added to the home screen (iPhone: Share > Add to Home Screen; Android: Install app) the site opens full screen with
// its own icon. iOS reads the apple-* tags, everything else the manifest. No service worker: it stays an online site.
const HEAD = `<link rel="manifest" href="manifest.json">
<link rel="icon" href="icons/favicon-32.png" type="image/png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="theme-color" content="${BG}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${NAME}">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
`;
const MANIFEST = {
  name: NAME, short_name: NAME, description: 'Chess game review and puzzles', start_url: '/', scope: '/',
  display: 'standalone', background_color: BG, theme_color: BG,
  icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
};

/** Every file under dir, recursively, as absolute paths. */
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(f => join(dir, f)).filter(f => statSync(f).isFile()).sort();
}

function copyIfChanged(src, dst) {
  const s = statSync(src);
  if (existsSync(dst)) {
    const d = statSync(dst);
    if (d.size === s.size && d.mtimeMs >= s.mtimeMs) return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

/** The npm package's engine files, from the cache or downloaded into it (a .tgz: gzip around a plain tar). */
async function engineFiles() {
  const out = Object.fromEntries(ENGINE_FILES.map(n => [n, join(CACHE, 'stockfish', n)]));
  if (Object.values(out).every(p => existsSync(p))) return out;
  console.log('downloading', STOCKFISH_NPM);
  const r = await fetch(STOCKFISH_NPM);
  if (!r.ok) throw new Error(`${STOCKFISH_NPM}: HTTP ${r.status}`);
  const tar = gunzipSync(Buffer.from(await r.arrayBuffer()));
  mkdirSync(join(CACHE, 'stockfish'), { recursive: true });
  for (let at = 0; at + 512 <= tar.length;) {
    const head = tar.subarray(at, at + 512);
    if (head.every(b => b === 0)) break;
    const field = (from, to) => head.subarray(from, to).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 136).trim() || '0', 8);
    const type = field(156, 157);
    const name = basename(field(0, 100));
    if ((type === '' || type === '0') && name in out) writeFileSync(out[name], tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  const missing = ENGINE_FILES.filter(n => !existsSync(out[n]));
  if (missing.length) throw new Error(`not in ${STOCKFISH_NPM}: ${missing}`);
  return out;
}

function page() {
  const pieces = JSON.parse(readFileSync(join(ROOT, 'js', 'desktop', 'pieces.json'), 'utf8'));
  // the page as served has LF line ends whatever the checkout's are (the file is CRLF)
  let html = fillPieces(readFileSync(join(STATIC, 'index.html'), 'utf8').replace(/\r\n/g, '\n'), pieces);
  const t = html.indexOf('</title>') + '</title>\n'.length;
  html = html.slice(0, t) + HEAD + html.slice(t);
  const i = html.indexOf('<script');    // before the page's own scripts (account.js first): the first fetch must already be redirected
  return html.slice(0, i) + '<script src="web/shim.js"></script>\n' + html.slice(i);
}

/** What the JS server reads besides its code: the opening book's keys, the Lichess puzzle pack and the packs. */
function dataFiles(out) {
  const book = join(ROOT, 'data', 'book');
  const keys = bookKeysFromDir(book);
  if (!keys.length) throw new Error(`no opening book in ${book} (scripts/fetch_book.sh)`);
  writeFileSync(join(out, 'book_keys.txt'), keys.join('\n'));
  // beside the code, fetched alongside it (the Worker sends it compressed: 9 MB of JSON, about 2 MB as sent)
  const packs = join(ROOT, 'chess_review', 'puzzle_packs');
  writeFileSync(join(out, 'puzzles.json'), JSON.stringify(JSON.parse(readFileSync(join(packs, 'puzzles.json'), 'utf8'))));
  copyIfChanged(join(packs, 'packs.json'), join(out, 'packs.json'));
}

/** js/ as the browser imports it, and nothing left from a build before (a module removed from js/). */
function jsTree(out) {
  const want = new Set();
  for (const d of JS_DIRS) {
    for (const f of files(join(ROOT, 'js', d))) {
      const name = basename(f);
      if (JS_SKIP.some(s => name.endsWith(s))) continue;
      const rel = relative(join(ROOT, 'js'), f);
      if (BLOCKED_NAME.test(name)) {
        throw new Error(`js/${rel}: ad blockers block a file of that name, so the worker would not load where one is installed. Rename it.`);
      }
      want.add(rel);
      copyIfChanged(f, join(out, 'js', rel));
    }
  }
  for (const f of files(join(out, 'js'))) if (!want.has(relative(join(out, 'js'), f))) unlinkSync(f);
}

/** A zip of entries [{ name, data }], deflated: what Pyodide's unpackArchive reads. */
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const packed = deflateRawSync(data), fname = Buffer.from(name, 'utf8'), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12);       // time 00:00, date 1980-01-01: the same bytes every build
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(fname.length, 26); head.writeUInt16LE(0, 28);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10); dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x21, 14); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(fname.length, 28);
    dir.writeUInt32LE(offset, 42);
    local.push(head, fname, packed);
    central.push(dir, fname);
    offset += head.length + fname.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

/** The one-time move from the Python build's IndexedDB (js/web/legacy.js): migrate_sqlite and what it imports,
 * python-chess's wheel (both frozen in legacy/), and Pyodide's URL. Returns config.js's `legacy` entry. */
function legacy(out) {
  const dst = join(out, 'legacy');
  mkdirSync(dst, { recursive: true });
  writeFileSync(join(dst, 'app.zip'), zip(LEGACY_MODULES.map(name => ({
    name: `chess_review/${name}`, data: readFileSync(join(ROOT, 'legacy', 'chess_review', name)) }))));
  copyIfChanged(join(ROOT, 'legacy', LEGACY_WHEEL), join(dst, LEGACY_WHEEL));
  return { pyodide: LEGACY_PYODIDE, wheel: `legacy/${LEGACY_WHEEL}`, app: 'legacy/app.zip' };
}

async function build(engineWasm) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'index.html'), page());
  copyIfChanged(join(STATIC, 'account.js'), join(OUT, 'account.js'));
  rmSync(join(OUT, 'web', 'account.js'), { force: true });      // where builds before the desktop app had it
  for (const f of files(join(STATIC, 'themes'))) copyIfChanged(f, join(OUT, 'themes', relative(join(STATIC, 'themes'), f)));
  for (const f of files(join(ROOT, 'web', 'pages')).filter(f => f.endsWith('.html'))) {    // plain pages at the site's root
    copyIfChanged(f, join(OUT, basename(f)));
    if (readFileSync(f, 'utf8').includes('<span class="fill">')) {
      console.log(`warning: ${relative(ROOT, f)} still has placeholders (class=fill) to fill in before going live`);
    }
  }
  for (const f of readdirSync(join(ROOT, 'web', 'icons'))) copyIfChanged(join(ROOT, 'web', 'icons', f), join(OUT, 'icons', f));
  // browsers ask for /favicon.ico on their own (address-bar suggestions, history), whatever the page links
  copyIfChanged(join(ROOT, 'packaging', 'chess-review.ico'), join(OUT, 'favicon.ico'));
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(MANIFEST, null, 1));
  for (const f of readdirSync(join(ROOT, 'web')).filter(f => f.endsWith('.js'))) copyIfChanged(join(ROOT, 'web', f), join(OUT, 'web', f));
  // what the Python builds shipped: Pyodide's worker, the app's zip, python-chess's wheel
  rmSync(join(OUT, 'app.zip'), { force: true });
  rmSync(join(OUT, 'web', 'py-worker.js'), { force: true });
  for (const f of readdirSync(join(OUT, 'web')).filter(f => /^chess-.*\.whl$/.test(f))) rmSync(join(OUT, 'web', f));
  jsTree(OUT);
  dataFiles(OUT);
  const engines = await engineFiles();
  for (const [name, src] of Object.entries(engines)) {
    const dst = join(OUT, 'web', 'engine', name);
    if (engineWasm && name === 'stockfish-19-single.wasm') {     // served from elsewhere (unpkg): too big for the Worker
      rmSync(dst, { force: true });
      continue;
    }
    copyIfChanged(src, dst);
  }
  // The Worker (worker/, wrangler) serves web-dist/ but refuses files over 25 MiB: the full engine comes from unpkg.
  writeFileSync(join(OUT, '.assetsignore'), 'web/engine/stockfish-19-single.wasm\n');
  // Rules the Worker applies to its static files (themes/ never reaches its code: wrangler.jsonc run_worker_first)
  writeFileSync(join(OUT, '_headers'), `/themes/*\n  Cache-Control: ${THEMES_CACHE}\n`);
  // engineBytes: the progress bar's total, as unpkg sends no Content-Length; engineName: what the notice says it is
  const config = {
    legacy: legacy(OUT), engineWasm: engineWasm || 'engine/stockfish-19-single.wasm',
    engineBytes: statSync(engines['stockfish-19-single.wasm']).size,
    engineLiteWasm: 'engine/stockfish-19-lite-single.wasm',
    engineLiteBytes: statSync(engines['stockfish-19-lite-single.wasm']).size,
    engineName: `Stockfish ${STOCKFISH_VERSION.split('.')[0]}`,
  };
  writeFileSync(join(OUT, 'web', 'config.js'), `self.CR_CONFIG = ${JSON.stringify(config, null, 1)};\n`);
  console.log('built', OUT);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.webp': 'image/webp', '.css': 'text/css', '.txt': 'text/plain', '.zip': 'application/zip',
  '.whl': 'application/zip', '.woff2': 'font/woff2' };

/** web-dist/ on localhost as the Worker would serve it (index.html for a folder): themes/ cached as _headers says,
 * the rest never. */
function serve(dir, port) {
  const root = normalize(dir + sep);
  return createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(dir, path));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-cache' }).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
                         'Cache-Control': path.startsWith('/themes/') ? THEMES_CACHE : 'no-cache' });
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1');
}

await build(args['engine-wasm'] === 'cdn' ? ENGINE_CDN : args['engine-wasm']);
if (args.serve) {
  serve(OUT, Number(args.port));
  console.log(`serving http://127.0.0.1:${args.port}/`);
}
