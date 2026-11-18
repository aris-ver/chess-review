// The desktop app's main process (Electron), in launcher.py's place: the local server on 127.0.0.1, the page in one
// "Blundr" window, a failure page if the server doesn't come up. Closing the window shuts everything down. Before
// anything in the data folder is opened, handover.js checks that data from the Python app has been converted.

import { app, BrowserWindow, Menu, dialog, powerMonitor, shell } from 'electron';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadBook } from '../core/book.js';
import { DEFAULT_NODES, FAST_NODES } from '../core/config.js';
import { nodeSqlite } from '../server/db-node.js';
import { Store } from '../server/db.js';
import { nodeFiles } from '../server/profiles-files-node.js';
import { Profiles } from '../server/profiles.js';
import { serve } from '../server/router.js';
import { Account } from '../server/account.js';
import { setCodeFingerprint } from '../server/classify.js';
import { DrillTables, tablesFromFiles } from '../server/drills.js';
import { Pack } from '../server/puzzles.js';
import { Packs } from '../server/packs.js';
import { ELECTRON_ASSETS, GITHUB_REPO, Updater, cmpVersion, parseVersion } from '../server/updater.js';
import { bookKeysFromDir, bookTreeFromDir } from './book.js';
import { EnginePool } from './engines.js';
import { checkData, restoreClean } from './handover.js';
import { retireOldExes, unblock } from './launcher.js';
import { logger, setupLogging } from './log.js';
import { STATIC_DIR, bundled, dataDir, stockfishPath } from './paths.js';
import { listen, makeServer, routerApi } from './server.js';
import { installing, lastInstall, leftAside, makeApply, makeUnpack, readInstalled, releasesFetch, updateFiles } from './update.js';

const HOST = '127.0.0.1', PREFERRED_PORT = 8123;
const ENGINE_IDLE_SECONDS = 600;    // config.ENGINE_IDLE_SECONDS: idle engines quit (they restart in about a second)
const REAP_EVERY = 30_000;          // serve.main's reaper
const log = logger('launcher');
const packaged = app.isPackaged;
const DATA = dataDir({ packaged });
const logFile = setupLogging(DATA);
process.on('uncaughtException', err => log.error('uncaught', err));
process.on('unhandledRejection', err => log.error('unhandled rejection', err));

// pywebview kept its profile (localStorage: pinned profiles, the auto-analyse switch) in DATA/webview; Electron's
// goes beside it. It is per origin, so the port matters as it did before.
app.setPath('userData', join(DATA, 'electron'));
// One copy per data folder (Electron keys the lock on userData): two would share the databases, both download into
// DATA/update, and closing one would swap the install under the other. Nothing needs a second copy (listen()'s other
// port was for something else on 8123); starting one again brings the window that is open to the front.
const firstCopy = app.requestSingleInstanceLock();
let mainWindow = null;
if (!firstCopy) {
  log.info('already running: the open window comes to the front');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}
// The first start after the Python app: its WebView2 profile's localStorage comes along (both are Chromium's
// leveldb, keyed by origin), so the pinned profiles and switches stay. Copied, before Chromium opens its own.
const oldStorage = join(DATA, 'webview', 'EBWebView', 'Default', 'Local Storage');
const newStorage = join(DATA, 'electron', 'Local Storage');
if (existsSync(oldStorage) && !existsSync(newStorage)) {
  try {
    cpSync(oldStorage, newStorage, { recursive: true });
    log.info('localStorage carried over from the previous version');
  } catch (err) {
    log.warn(`could not carry localStorage over: ${err.message}`);
  }
}

const STOCKFISH = stockfishPath({ packaged });
// Nothing starts until the first search.
export const engines = new EnginePool({ path: STOCKFISH });
// the rook drills' opponent (server/drill-opponent.js): one engine of its own, so a review job never delays a reply;
// reaped and closed with the others
export const drillEngine = new EnginePool({ size: 1, path: STOCKFISH, hash: 16 });
let serverPort = null;
const BUNDLED = bundled({ packaged });
// the packaged app's folder (Blundr.exe), which an update replaces
const INSTALL = dirname(process.execPath);

/** The opening book: DATA/book_keys.txt if there is one, else the keys in app.asar (build.js), else DATA/book's TSVs
 * as book.py reads them (a checkout). Returns its text ('' when there is none). */
function loadOpeningBook() {
  for (const f of [join(DATA, 'book_keys.txt'), BUNDLED.book]) {
    if (f && existsSync(f)) {
      const text = readFileSync(f, 'utf8');
      loadBook(text);
      log.info(`opening book from ${f}`);
      return text;
    }
  }
  const keys = bookKeysFromDir(join(DATA, 'book'));
  if (keys.length) {
    loadBook(keys.join('\n'));
    log.info(`opening book from ${join(DATA, 'book')}: ${keys.length} positions`);
    return keys.join('\n');
  }
  log.warn(`no opening book (${BUNDLED.book ?? join(DATA, 'book')}): no move is labelled book`);
  return '';
}

/** The opening tree (the Openings tab's), read the first time the tab asks: app.asar's book_tree.json (build.js),
 * else made from DATA/book's TSVs (a checkout: about 4 s). null when there is neither. */
async function loadOpeningTree() {
  if (BUNDLED.tree && existsSync(BUNDLED.tree)) return readFile(BUNDLED.tree, 'utf8');
  const tree = bookTreeFromDir(join(DATA, 'book'));
  if (!tree) log.warn(`no opening tree (${BUNDLED.tree ?? join(DATA, 'book')}): the Openings tab has nothing to show`);
  return tree;
}

/** What this build calls itself: build.json's version in a packaged app (build.js: the release tag, or git
 * describe's), package.json's in a checkout. Part of every game's fingerprint (setCodeFingerprint). */
const appVersion = () => (packaged && readInstalled(process.resourcesPath).version) || app.getVersion();

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** updater.py's Updater for this build: resources/build.json says what is installed (nulls from a checkout, which
 * never updates); a small update is app.asar alone (update.js). A newer release downloads by itself and goes in as
 * the app closes (auto); DATA/update.log says whether the last install failed, which the banner then shows.
 * BLUNDR_UPDATE_API serves the releases from elsewhere (a test release). */
function makeUpdater(quit) {
  const api = process.env.BLUNDR_UPDATE_API;
  const installed = packaged ? readInstalled(process.resourcesPath) : null;
  const u = new Updater({
    fetch: api ? releasesFetch(api, GITHUB_REPO) : globalThis.fetch, files: updateFiles(DATA),
    installed, platform: process.platform, auto: true, installing: () => installing(DATA),
    assets: ELECTRON_ASSETS, unpack: makeUnpack(DATA), apply: makeApply({ dataDir: DATA, install: INSTALL, quit }), log,
  });
  let last = null;
  try { last = lastInstall(readFileSync(join(DATA, 'update.log'), 'utf8')); } catch { /* no log: never updated */ }
  // a failed install of what is still newer than this version (one that went in, or an older one, is done with)
  const v = parseVersion(last?.version), mine = parseVersion(installed?.version);
  if (last?.error && u.enabled && v && mine && cmpVersion(v, mine) > 0) {
    u.installFailed = last;
    log.warn(`the last install of ${last.version} failed: ${last.error}`);
  }
  return u;
}

/** js/server over the data folder: the router with its job runner (serve.main's start-up). */
function startServer({ updater }) {
  // a new version (or book) changes every game's fingerprint: each profile's next build redoes its reviews
  setCodeFingerprint(appVersion(), loadOpeningBook());
  const store = new Store(nodeSqlite(DATA)), files = nodeFiles(DATA);
  // the Blundr account (account.py's): a provider sign-in runs in the system browser, which the Worker sends back to
  // this server's port; the export lands in Downloads (DATA when there is none)
  const account = new Account({
    fetch: globalThis.fetch, files, site: process.env.BLUNDR_URL || undefined, port: () => serverPort, log,
    openBrowser: url => shell.openExternal(url),
    saveExport: async bytes => {
      const downloads = app.getPath('downloads');
      const dst = join(existsSync(downloads) ? downloads : DATA, 'blundr-account.json');
      writeFileSync(dst, bytes);
      return dst;
    },
  });
  const env = {
    store, files, profiles: new Profiles(files, store), fetch: globalThis.fetch, log, account,
    pack: new Pack(() => readJson(BUNDLED.puzzles)), packs: new Packs(() => readJson(BUNDLED.packs)),
    updater,
    openingTree: loadOpeningTree,
    // the endgame drills' tables, read the first time a drill needs one (a file that isn't there: the routes say so)
    drillTables: new DrillTables(tablesFromFiles(path => readFile(path).catch(err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    }), BUNDLED.endgames)),
    // no Stockfish file: the rook drills say so (503 'no_engine') instead of failing on every move
    ...(existsSync(STOCKFISH) ? { drillEngine } : {}),
  };
  return serve({ env, pool: engines, nodes: DEFAULT_NODES, fastNodes: FAST_NODES, log });
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function failurePage(win, detail, title = 'The app failed to start.', extra = '') {
  const html = `<!doctype html><meta charset="utf-8"><title>Blundr</title><body style="font-family:system-ui;margin:2em">
<h2>${esc(title)}</h2><p>${esc(detail)}</p>${extra}<p>See <code>${esc(logFile)}</code>.</p>`;
  return win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

async function main() {
  log.info(`starting; data in ${DATA}`);
  if (!existsSync(STOCKFISH)) log.error(`Stockfish not found at ${STOCKFISH} - analysis will fail`);
  if (packaged && process.platform === 'win32') {
    unblock(INSTALL, { log });
    retireOldExes(INSTALL, { log }).catch(err => log.warn(`old exes: ${err.message}`));
    leftAside(INSTALL, { log });
  }
  await app.whenReady();
  Menu.setApplicationMenu(null);    // pywebview's window had no menu bar either

  const win = new BrowserWindow({ title: 'Blundr', width: 1400, height: 900, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#232a35',
                                  webPreferences: { contextIsolation: true, sandbox: true } });
  mainWindow = win;
  win.once('ready-to-show', () => win.show());
  // Windows ending the session (shutdown, restart, sign-out), or the system shutting down elsewhere: no install on
  // the way out, as it may kill the script half-way through a swap; the update waits for the next close
  let ending = false;
  const sessionEnds = () => { ending = true; };
  win.on('query-session-end', sessionEnds);
  win.on('session-end', sessionEnds);
  powerMonitor.on('shutdown', sessionEnds);
  // links that open a new window (chess.com, lichess, GitHub) go to the user's browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // the Python app's data, converted by the bridge release: nothing in DATA is opened until it checks out
  const files = nodeFiles(DATA);
  const handover = await checkData(files, DATA, dir => nodeSqlite(dir)).catch(err => {
    log.error('checking the data failed', err);
    return { ok: false, title: 'The app could not check its data.', detail: String(err.message || err), problems: [] };
  });
  if (!handover.ok) {
    log.error(`data not opened: ${handover.title} ${JSON.stringify(handover.problems)}`);
    const list = handover.problems.length ? '<ul>' + handover.problems.slice(0, 20).map(p =>
      `<li><code>${esc(p.name)}</code> ${esc(p.table)}: ${p.found === null ? 'missing' : esc(p.found)} of ${esc(p.expected)} rows</li>`).join('') + '</ul>' : '';
    app.on('window-all-closed', () => app.quit());
    return failurePage(win, `${handover.detail} Data folder: ${DATA}`, handover.title, list);
  }
  log.info(`data: ${handover.how}`);
  // the clean solves the bridge left out, put back before the first sync can drop them from the account again
  try {
    const store = new Store(nodeSqlite(DATA));
    const n = await restoreClean(files, await store.progress());
    await store.close();
    if (n !== null) log.info(`clean solves restored from puzzle_solved.jsonl: ${n}`);
  } catch (err) {
    log.warn(`restoring clean solves: ${err.message}`);
  }

  const updater = makeUpdater(() => win.close());
  const router = startServer({ updater });
  router.catch(err => log.error('the server failed to start', err));
  const server = makeServer({ staticDir: STATIC_DIR, api: routerApi(router), log });
  // Serve.Runner.reap_idle: engine memory is freed when nothing has used the engines for a while
  const reaper = setInterval(async () => {
    try {
      const r = await router;
      if (!r.runner.busy() && (await engines.reapIdle(ENGINE_IDLE_SECONDS * 1000))) log.info('idle: engines shut down');
      if (await drillEngine.reapIdle(ENGINE_IDLE_SECONDS * 1000)) log.info('idle: the drill engine shut down');
    } catch (err) {
      log.warn(`reaper: ${err.message}`);
    }
  }, REAP_EVERY);
  app.on('window-all-closed', async () => {
    log.info('window closed: shutting down');
    clearInterval(reaper);
    // a staged update goes in once this process has gone (the script waits for it), the app not started again:
    // the user closed it. Writing and starting the script is all it waits on, and a failure there only logs.
    if (ending) log.info('the session is ending: a staged update waits for the next close');
    else if (await updater.applyOnQuit()) log.info('a staged update installs as the app closes');
    server.close();
    await Promise.all([engines.close(), drillEngine.close()]);
    app.quit();
  });

  let port;     // serverPort too, once listening (the account's sign-in comes back to it)
  try {
    port = serverPort = await listen(server, HOST, PREFERRED_PORT);
  } catch (err) {
    log.error(`server did not come up on ${HOST}:${PREFERRED_PORT}`, err);
    return failurePage(win, 'Its local server could not start.');
  }
  log.info(`serving ${STATIC_DIR} at http://${HOST}:${port}/`);
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (url.startsWith('http://')) {
      log.error(`the page failed to load: ${desc} (${code})`);
      failurePage(win, `The page failed to load: ${desc}.`);
    }
  });
  await win.loadURL(`http://${HOST}:${port}/`).catch(() => {});   // did-fail-load has shown why
}

if (firstCopy) main().catch(err => {
  // with no window of our own to say it in, a console-less exe would just vanish
  log.error('the app window failed to open', err);
  dialog.showErrorBox('Blundr', `Blundr could not open its window.\n\nDetails are in ${logFile}.`);
  app.exit(1);
});
