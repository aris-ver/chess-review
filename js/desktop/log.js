// A windowed app has no console, so everything goes to DATA/app.log, the file the Python launcher writes too
// (same "time name message" lines), for the user to send us.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let file = null;

export function setupLogging(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  file = join(dataDir, 'app.log');
  return file;
}

function write(name, msg) {
  const line = `${new Date().toISOString().replace('T', ' ').replace('Z', '')} ${name} ${msg}\n`;
  if (!file) return void process.stderr.write(line);
  try { appendFileSync(file, line, 'utf8'); } catch { process.stderr.write(line); }
}

/** log.info / log.warn / log.error(message, error?) under a logger name, like Python's logging.getLogger(name). */
export function logger(name) {
  const at = level => (msg, err) => write(name, (level === 'INFO' ? '' : level + ' ') + msg + (err ? `\n${err.stack || err}` : ''));
  return { info: at('INFO'), warn: at('WARNING'), error: at('ERROR') };
}
