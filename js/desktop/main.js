// The desktop app's main process (Electron), in launcher.py's place: the local server on 127.0.0.1, the page in one
// "Blundr" window, a failure page if the server doesn't come up. Closing the window shuts everything down.

import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { EnginePool } from './engines.js';
import { logger, setupLogging } from './log.js';
import { STATIC_DIR, dataDir, stockfishPath } from './paths.js';
import { listen, makeServer } from './server.js';

const HOST = '127.0.0.1', PREFERRED_PORT = 8123;
const log = logger('launcher');
const packaged = app.isPackaged;
const DATA = dataDir({ packaged });
const logFile = setupLogging(DATA);
process.on('uncaughtException', err => log.error('uncaught', err));
process.on('unhandledRejection', err => log.error('unhandled rejection', err));

// pywebview kept its profile (localStorage: pinned profiles, the auto-analyse switch) in DATA/webview; Electron's
// goes beside it. It is per origin, so the port matters as it did before.
app.setPath('userData', join(DATA, 'electron'));

const STOCKFISH = stockfishPath({ packaged });
// The job runner (round 3) takes this; nothing starts until its first search.
export const engines = new EnginePool({ path: STOCKFISH });

function failurePage(win, detail) {
  const html = `<!doctype html><meta charset="utf-8"><title>Blundr</title><body style="font-family:system-ui;margin:2em">
<h2>The app failed to start.</h2><p>${detail}</p><p>See <code>${logFile}</code>.</p>`;
  return win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

async function main() {
  log.info(`starting; data in ${DATA}`);
  if (!existsSync(STOCKFISH)) log.error(`Stockfish not found at ${STOCKFISH} - analysis will fail`);
  await app.whenReady();
  Menu.setApplicationMenu(null);    // pywebview's window had no menu bar either

  const win = new BrowserWindow({ title: 'Blundr', width: 1400, height: 900, minWidth: 900, minHeight: 600, show: false,
                                  webPreferences: { contextIsolation: true, sandbox: true } });
  win.once('ready-to-show', () => win.show());
  // links that open a new window (chess.com, lichess, GitHub) go to the user's browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const server = makeServer({ staticDir: STATIC_DIR, log });
  app.on('window-all-closed', async () => {
    log.info('window closed: shutting down');
    server.close();
    await engines.close();
    app.quit();
  });

  let port;
  try {
    port = await listen(server, HOST, PREFERRED_PORT);
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
