// Assembles the browser version (docs/web.md) into web-dist/, a static site.
//
//   node scripts/build_web.js [--serve [--port 8200] [--log]] [--engine-wasm URL|cdn]     (npm run build:web -- ...)
//
// web-dist/
//   index.html            chess_review/static/index.html with the board's pieces (js/desktop/pieces.json) filled in,
//                         plus the web/shim.js tag
//   account.js            the Blundr account, from chess_review/static/ (the desktop app has the same one)
//   privacy.html, terms.html   from web/pages/
//   manifest.json, icons/ what "Add to Home Screen" installs (icons from web/icons/, rendered from packaging/chess-review.ico)
//   themes/               the page's pieces, boards and sounds
//   v/<version>/          the code, under a name of its own each build (a hash of what is in it), so that browsers keep it
//                         for good (_headers: a year, immutable) and ask for none of it again until a deploy changes it:
//     js/                 the JS server as the desktop runs it: js/core, js/server (minus the Node adapters), js/web (the
//                         worker, its tabs, the browser adapters), js/vendor (chessops, SQLite WASM); no tests
//     web/                shim.js, engines.js, config.js
//   web/engine/           Stockfish 19, outside v/: the same files every build
//   book_keys.txt         the opening book's positions, one fen_key a line (js/core/book.js), from data/book
//                         (scripts/fetch_book.sh)
//   puzzles.json          the Lichess puzzle pack, fetched alongside the app; packs.json, the puzzle packs
//   _headers              what the Worker sends with the files: the security headers and the CSP on all, caching on
//                         themes/ and v/
//   legacy/               the one-time move from the Python build's data (js/web/legacy.js): app.zip (legacy/chess_review,
//                         what migrate_sqlite.py needs) and python-chess's wheel, with Pyodide from its CDN. Fetched only
//                         by a browser that still has the Python build's IndexedDB, and only once.
//
// Downloads (cached in data/web-cache): npm stockfish@19.0.1. --engine-wasm points the full engine at another host (the
// Worker refuses files over 25 MiB); `--engine-wasm cdn` is blundr.gr's: the same npm package's file on unpkg. By
// default it is served from web/engine/ next to the rest, which is what --serve wants.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, normalize, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';

import { bookKeysFromDir } from '../js/desktop/book.js';
import { ROOT } from '../js/desktop/paths.js';
import { API, LICHESS_USER } from '../js/server/ingest.js';
import { fillPieces } from '../js/server/router.js';

const { values: args } = parseArgs({ options: {
  serve: { type: 'boolean', default: false }, port: { type: 'string', default: '8200' }, 'engine-wasm': { type: 'string' },
  log: { type: 'boolean', default: false },
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
// v/<version>/: a file there never changes (a change is a new version), so a browser keeps it without asking. On a phone
// the worker's imports, asked again on every visit, were one round trip per level of imports: seconds before the app
// worker said a word. index.html, the one way in to a version, is asked for every time, so a deploy shows at once.
const CODE_CACHE = 'public, max-age=31536000, immutable';
// Sent with every static file (_headers /*), on top of the rules above. HSTS for a year, blundr.gr alone: no
// includeSubDomains or preload until every subdomain is known to be on https (preload is hard to take back). The page
// is never framed, never sniffed, sends only its origin to other sites, and asks for no camera, microphone, location
// or other device. The Content-Security-Policy is made per build (csp()): it names the page's inline scripts by hash.
const SECURITY = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), '
    + 'hid=(), magnetometer=(), microphone=(), midi=(), payment=(), serial=(), usb=()',
};
// what the server fetches from other sites (js/server/ingest.js): the chess.com and lichess APIs, which send CORS
const API_ORIGINS = [API, LICHESS_USER].map(u => new URL(u).origin);
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

/** The app worker's code asked for all at once, the moment the page's head arrives: left to itself, the worker (which
 * web/shim.js starts later, as the page's scripts run) learns of a module only once the one importing it has
 * arrived, a round trip per level of imports (on a phone, seconds). Its own requests then find these in the HTTP
 * cache, or join them on their way; a warm visit finds them all kept (CODE_CACHE) and asks for none. */
const WARM_UP = (code, modules) => `<script>for (const m of ${JSON.stringify(modules)}) `
  + `fetch(${JSON.stringify(code)} + m).then(r => r.arrayBuffer()).catch(() => {});</script>\n`;

/** index.html as served. code: 'v/<version>/'; modules: what the app worker fetches as it starts, in code (warmUp). */
function page(code, modules) {
  const pieces = JSON.parse(readFileSync(join(ROOT, 'js', 'desktop', 'pieces.json'), 'utf8'));
  // the page as served has LF line ends whatever the checkout's are (the file is CRLF)
  let html = fillPieces(readFileSync(join(STATIC, 'index.html'), 'utf8').replace(/\r\n/g, '\n'), pieces);
  const t = html.indexOf('</title>') + '</title>\n'.length;
  html = html.slice(0, t) + HEAD + html.slice(t);
  const i = html.indexOf('<script');    // before the page's own scripts (account.js first): the first fetch must already be redirected
  html = html.slice(0, i) + `<script src="${code}web/shim.js"></script>\n` + html.slice(i);
  const h = html.indexOf('<style');     // first in the head: before the page's style, its body, its scripts
  return html.slice(0, h) + WARM_UP(code, modules) + html.slice(h);
}

/** The Content-Security-Policy for html (index.html as served) and engineWasm (the full engine's URL, when another
 * host serves it). Scripts: our own files, the page's inline scripts by their SHA-256 (its body's and WARM_UP: no
 * 'unsafe-inline'), WebAssembly (SQLite, Stockfish, Pyodide: 'wasm-unsafe-eval', no 'unsafe-eval') and Pyodide's
 * folder for the one-time move. Styles may be inline: the page and the shim set style attributes and <style> tags all
 * over. Fetches: our own, the APIs, the engine (blob: is the engine worker reading its .wasm) and Pyodide's files.
 * The account's sign-in goes to Lichess and Google as a navigation (account/login/...), which this doesn't limit. */
function csp(html, engineWasm) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const engine = /^https?:/.test(engineWasm || '') ? [engineWasm] : [];
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...hashes, LEGACY_PYODIDE].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    ["connect-src 'self' blob:", ...engine, ...API_ORIGINS, LEGACY_PYODIDE].join(' '),
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
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

/** The code as the browser imports it, as { 'js/core/fen.js': bytes, ..., 'web/shim.js': ..., 'web/config.js': ... }:
 * js/ without tests and Node adapters, and web/'s scripts; config.js's text is given. */
function codeFiles(config) {
  const out = {};
  const check = rel => {
    if (BLOCKED_NAME.test(basename(rel))) {
      throw new Error(`${rel}: ad blockers block a file of that name, so the worker would not load where one is installed. Rename it.`);
    }
  };
  for (const d of JS_DIRS) {
    for (const f of files(join(ROOT, 'js', d))) {
      const name = basename(f);
      if (JS_SKIP.some(s => name.endsWith(s))) continue;
      const rel = relative(ROOT, f).split(sep).join('/');
      check(rel);
      out[rel] = readFileSync(f);
    }
  }
  for (const f of readdirSync(join(ROOT, 'web')).filter(f => f.endsWith('.js')).sort()) {
    check(`web/${f}`);
    out[`web/${f}`] = readFileSync(join(ROOT, 'web', f));
  }
  out['web/config.js'] = Buffer.from(config);
  return out;
}

/** The version: a hash of every file's path and bytes. Hex, so it never spells a name an ad blocker knows. */
function version(code) {
  const h = createHash('sha256');
  for (const rel of Object.keys(code).sort()) h.update(`${rel}\0${code[rel].length}\0`).update(code[rel]);
  return h.digest('hex').slice(0, 12);
}

// what a module names that is fetched with it: static imports and re-exports, import('...') of a literal, and
// new URL('x.wasm', import.meta.url) (SQLite's WASM)
const IMPORTS = [/(?:^|[;}\s])(?:import|export)\s[^'"`;()]*?\sfrom\s*['"]([^'"]+)['"]/g, /(?:^|[;\s])import\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /new URL\(\s*['"]([^'"]+\.wasm)['"]\s*,\s*import\.meta\.url\s*\)/g];

/** Every file of code the app worker fetches as it starts, worker.js first: what the page asks for all at once
 * (WARM_UP) instead of the worker finding them one level of imports at a time. */
function warmUp(code, entry = 'js/web/worker.js') {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const rel = todo.shift();
    if (seen.has(rel) || !(rel in code)) continue;
    seen.add(rel);
    if (!/\.m?js$/.test(rel)) continue;
    for (const re of IMPORTS) {
      for (const m of code[rel].toString('utf8').matchAll(re)) {
        if (!/^\/|:/.test(m[1])) todo.push(new URL(m[1], `http://x/${rel}`).pathname.slice(1));     // relative: one of ours
      }
    }
  }
  return [...seen];
}

/** v/<version>/ written, and nothing left from a build before: the versions before it, and where the code was before
 * there were versions (js/, web/*.js). */
function codeTree(out, code, ver) {
  const dir = join(out, 'v', ver);
  for (const [rel, data] of Object.entries(code)) {
    const dst = join(dir, rel);
    if (existsSync(dst) && readFileSync(dst).equals(data)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, data);
  }
  for (const v of readdirSync(join(out, 'v'))) if (v !== ver) rmSync(join(out, 'v', v), { recursive: true });
  rmSync(join(out, 'js'), { recursive: true, force: true });
  for (const f of readdirSync(join(out, 'web')).filter(f => f.endsWith('.js'))) rmSync(join(out, 'web', f));
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
  mkdirSync(join(OUT, 'web'), { recursive: true });
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
  // what the Python builds shipped: Pyodide's worker, the app's zip, python-chess's wheel
  rmSync(join(OUT, 'app.zip'), { force: true });
  rmSync(join(OUT, 'web', 'py-worker.js'), { force: true });
  for (const f of readdirSync(join(OUT, 'web')).filter(f => /^chess-.*\.whl$/.test(f))) rmSync(join(OUT, 'web', f));
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
  // engineBytes: the progress bar's total, as unpkg sends no Content-Length; engineSha256: what the downloaded bytes
  // must hash to before they run (web/engines.js), npm's own file, so unpkg can't hand out another; engineName: what
  // the notice says it is; site: the site's root from the code's (v/<version>/), which the other paths here are
  // relative to
  const sha256 = f => createHash('sha256').update(readFileSync(f)).digest('hex');
  const config = {
    legacy: legacy(OUT), engineWasm: engineWasm || 'engine/stockfish-19-single.wasm',
    engineBytes: statSync(engines['stockfish-19-single.wasm']).size,
    engineSha256: sha256(engines['stockfish-19-single.wasm']),
    engineLiteWasm: 'engine/stockfish-19-lite-single.wasm',
    engineLiteBytes: statSync(engines['stockfish-19-lite-single.wasm']).size,
    engineLiteSha256: sha256(engines['stockfish-19-lite-single.wasm']),
    engineName: `Stockfish ${STOCKFISH_VERSION.split('.')[0]}`,
    site: '../../',
  };
  const code = codeFiles(`self.CR_CONFIG = ${JSON.stringify(config, null, 1)};\n`);
  const ver = version(code);
  mkdirSync(join(OUT, 'v'), { recursive: true });
  codeTree(OUT, code, ver);
  const html = page(`v/${ver}/`, warmUp(code));
  writeFileSync(join(OUT, 'index.html'), html);
  // Rules the Worker applies to its static files (themes/ never reaches its code: wrangler.jsonc run_worker_first).
  // Every rule a path matches applies: /* to all of them.
  const rule = (path, headers) => `${path}\n${Object.entries(headers).map(([k, v]) => `  ${k}: ${v}\n`).join('')}`;
  writeFileSync(join(OUT, '_headers'), rule('/*', { ...SECURITY, 'Content-Security-Policy': csp(html, engineWasm) })
    + rule('/themes/*', { 'Cache-Control': THEMES_CACHE }) + rule('/v/*', { 'Cache-Control': CODE_CACHE }));
  console.log('built', OUT, 'version', ver);
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.webp': 'image/webp', '.css': 'text/css', '.txt': 'text/plain', '.zip': 'application/zip',
  '.whl': 'application/zip', '.woff2': 'font/woff2' };

/** _headers' rules as [[pattern, {header: value}]]: a pattern is a path, `*` standing for anything. */
function headerRules(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push([new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), {}]);
    else if (rules.length) {
      const i = line.indexOf(':');
      rules.at(-1)[1][line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

/** web-dist/ on localhost as the Worker serves it: index.html for a folder, an ETag that a request may send back for a
 * 304, the Worker's default Cache-Control (ask again every time) unless web-dist/_headers says otherwise, and text
 * compressed, so that a throttled browser here waits for what it waits for on blundr.gr. */
function serve(dir, port, log = false) {
  const root = normalize(dir + sep);
  const packed = new Map();     // file -> { mtime, body, type, etag, gzip }
  return createServer((req, res) => {
    if (log) res.on('finish', () => console.log(res.statusCode, req.url));
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(dir, path));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-cache' }).end('not found');
      return;
    }
    const mtime = statSync(file).mtimeMs;
    let p = packed.get(file);
    if (!p || p.mtime !== mtime) {
      const body = readFileSync(file);
      const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
      const text = /^text\/|json|javascript|wasm|svg/.test(type);
      p = { mtime, body, type, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`,
            gzip: text ? gzipSync(body) : null };
      packed.set(file, p);
    }
    const headers = { 'Content-Type': p.type, 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: p.etag };
    const rules = existsSync(join(dir, '_headers')) ? headerRules(readFileSync(join(dir, '_headers'), 'utf8')) : [];
    for (const [re, h] of rules) if (re.test(path)) Object.assign(headers, h);
    if (req.headers['if-none-match'] === p.etag) {
      res.writeHead(304, headers).end();
      return;
    }
    const gz = p.gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gz) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers).end(gz ? p.gzip : p.body);
  }).listen(port, '127.0.0.1');
}

await build(args['engine-wasm'] === 'cdn' ? ENGINE_CDN : args['engine-wasm']);
if (args.serve) {
  serve(OUT, Number(args.port), args.log);
  console.log(`serving http://127.0.0.1:${args.port}/`);
}
