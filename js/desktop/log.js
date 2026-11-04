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

/** logging's asctime: local time, "2026-10-24 10:03:56,123", as the Python app wrote the same file. */
export function asctime(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:` +
    `${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
}

function write(name, msg) {
  const line = `${asctime()} ${name} ${msg}\n`;
  if (!file) return void process.stderr.write(line);
  try { appendFileSync(file, line, 'utf8'); } catch { process.stderr.write(line); }
}

/** log.info / log.warn / log.error(message, error?) under a logger name, like Python's logging.getLogger(name). */
export function logger(name) {
  const at = level => (msg, err) => write(name, (level === 'INFO' ? '' : level + ' ') + msg + (err ? `\n${err.stack || err}` : ''));
  return { info: at('INFO'), warn: at('WARNING'), error: at('ERROR') };
}
