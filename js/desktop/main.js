// The desktop app's main process (Electron), in launcher.py's place: the local server on 127.0.0.1, the page in one
// "Blundr" window, a failure page if the server doesn't come up. Closing the window shuts everything down. Before
// anything in the data folder is opened, handover.js checks that data from the Python app has been converted.

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadBook } from '../core/book.js';
import { DEFAULT_NODES } from '../core/config.js';
import { nodeSqlite } from '../server/db-node.js';
import { Store } from '../server/db.js';
import { nodeFiles } from '../server/profiles-files-node.js';
import { Profiles } from '../server/profiles.js';
import { serve } from '../server/router.js';
import { Account } from '../server/account.js';
import { Pack } from '../server/puzzles.js';
import { Packs } from '../server/packs.js';
import { ELECTRON_ASSETS, GITHUB_REPO, Updater } from '../server/updater.js';
import { bookKeysFromDir } from './book.js';
import { EnginePool } from './engines.js';
import { checkData, restoreClean } from './handover.js';
import { retireOldExes, unblock } from './launcher.js';
import { logger, setupLogging } from './log.js';
import { STATIC_DIR, bundled, dataDir, stockfishPath } from './paths.js';
import { listen, makeServer, routerApi } from './server.js';
import { makeApply, makeUnpack, readInstalled, releasesFetch, updateFiles } from './update.js';

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
let serverPort = null;
const BUNDLED = bundled({ packaged });
// the packaged app's folder (Blundr.exe), which an update replaces
const INSTALL = dirname(process.execPath);

/** The opening book: DATA/book_keys.txt if there is one, else the keys in app.asar (build.js), else DATA/book's TSVs
 * as book.py reads them (a checkout). */
function loadOpeningBook() {
  for (const f of [join(DATA, 'book_keys.txt'), BUNDLED.book]) {
    if (f && existsSync(f)) {
      loadBook(readFileSync(f, 'utf8'));
      return log.info(`opening book from ${f}`);
    }
  }
  const keys = bookKeysFromDir(join(DATA, 'book'));
  if (keys.length) {
    loadBook(keys.join('\n'));
    return log.info(`opening book from ${join(DATA, 'book')}: ${keys.length} positions`);
  }
  log.warn(`no opening book (${BUNDLED.book ?? join(DATA, 'book')}): no move is labelled book`);
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** updater.py's Updater for this build: resources/build.json says what is installed (nulls from a checkout, which
 * never updates); a small update is app.asar alone (update.js). BLUNDR_UPDATE_API serves the releases from
 * elsewhere (a test release). */
function makeUpdater(quit) {
  const api = process.env.BLUNDR_UPDATE_API;
  return new Updater({
    fetch: api ? releasesFetch(api, GITHUB_REPO) : globalThis.fetch, files: updateFiles(DATA),
    installed: packaged ? readInstalled(process.resourcesPath) : null, platform: process.platform,
    assets: ELECTRON_ASSETS, unpack: makeUnpack(DATA), apply: makeApply({ dataDir: DATA, install: INSTALL, quit }), log,
  });
}

/** js/server over the data folder: the router with its job runner (serve.main's start-up). */
function startServer({ quit }) {
  loadOpeningBook();
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
    updater: makeUpdater(quit),
  };
  return serve({ env, pool: engines, nodes: DEFAULT_NODES, log });
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
  }
  await app.whenReady();
  Menu.setApplicationMenu(null);    // pywebview's window had no menu bar either

  const win = new BrowserWindow({ title: 'Blundr', width: 1400, height: 900, minWidth: 900, minHeight: 600, show: false, backgroundColor: '#302e2b',
                                  webPreferences: { contextIsolation: true, sandbox: true } });
  win.once('ready-to-show', () => win.show());
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

  const router = startServer({ quit: () => win.close() });
  router.catch(err => log.error('the server failed to start', err));
  const server = makeServer({ staticDir: STATIC_DIR, api: routerApi(router), log });
  // Serve.Runner.reap_idle: engine memory is freed when nothing has used the engines for a while
  const reaper = setInterval(async () => {
    try {
      const r = await router;
      if (!r.runner.busy() && (await engines.reapIdle(ENGINE_IDLE_SECONDS * 1000))) log.info('idle: engines shut down');
    } catch (err) {
      log.warn(`reaper: ${err.message}`);
    }
  }, REAP_EVERY);
  app.on('window-all-closed', async () => {
    log.info('window closed: shutting down');
    clearInterval(reaper);
    server.close();
    await engines.close();
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

main().catch(err => {
  // with no window of our own to say it in, a console-less exe would just vanish
  log.error('the app window failed to open', err);
  dialog.showErrorBox('Blundr', `Blundr could not open its window.\n\nDetails are in ${logFile}.`);
  app.exit(1);
});
