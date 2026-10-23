// Native Stockfish as a pool of child processes, for the desktop app. The same scheme as analyse.py and
// web/engines.js: one engine per physical core, Threads=1, Hash=64, MultiPV 3, a fixed node count and `ucinewgame`
// (hash cleared) before every position, so a result is the same whichever engine gets it. The interface is
// js/core/engine.js's EnginePool.

import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { createInterface } from 'node:readline';

class Engine {
  constructor(path, hash) {
    this.path = path;
    this.hash = hash;
    this.closed = false;
    this.start();
  }
  start() {
    // windowsHide: a console-less app would otherwise flash a cmd window for every engine (config.ENGINE_POPEN)
    const proc = this.proc = spawn(this.path, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.waiter = null;
    this.lines = [];
    let up = false;
    createInterface({ input: proc.stdout }).on('line', line => {
      this.lines.push(line);
      this.tap?.(line);
      if (this.waiter && this.waiter.re.test(line)) { const w = this.waiter; this.waiter = null; w.resolve(this.lines.splice(0)); }
    });
    proc.stdin.on('error', () => {});     // EPIPE from a dead engine: 'exit' says so
    const died = err => {   // fail the search in hand; a crash after a good start gets a fresh engine
      if (this.proc !== proc) return;
      const w = this.waiter; this.waiter = null;
      if (up && !this.closed) this.ready = this.start();
      if (w) w.reject(err);
    };
    proc.on('error', err => died(new Error(`stockfish at ${this.path}: ${err.message}`)));
    proc.on('exit', (code, signal) => died(new Error(`engine crashed: ${signal || `exit code ${code}`}`)));
    this.ready = this.until(/^uciok/, ['uci']).then(lines => {
      up = true;
      this.name = ((lines.find(l => l.startsWith('id name ')) || '').slice(8) || 'Stockfish').trim();
      return this.until(/^readyok/, ['setoption name Threads value 1', `setoption name Hash value ${this.hash}`, 'isready']);
    });
    this.ready.catch(() => {});   // seen by whoever awaits it
    return this.ready;
  }
  until(re, cmds) {
    return new Promise((resolve, reject) => {
      this.waiter = { re, resolve, reject };
      this.lines = [];
      this.proc.stdin.write(cmds.map(c => c + '\n').join(''));
    });
  }
  // The search's `info` lines, as python-chess reads them off the engine (analyse.evaluate_multipv).
  async search(fen, nodes, multipv) {
    await this.ready;
    await this.until(/^readyok/, ['ucinewgame', `setoption name MultiPV value ${multipv}`, 'isready']);
    const out = await this.until(/^bestmove/, [`position fen ${fen}`, `go nodes ${nodes}`]);
    return out.filter(l => l.startsWith('info '));
  }
  // An infinite search (`go infinite`, like an analysis board) of `fen` with `multipv` lines: its `info` lines as they
  // come. Closing the iterator (return(), or leaving a for-await) sends `stop` and waits for the engine's bestmove.
  async *stream(fen, multipv) {
    await this.ready;
    await this.until(/^readyok/, ['ucinewgame', `setoption name MultiPV value ${multipv}`, 'isready']);
    const buf = [];
    let wake = null, end = null;
    const finished = this.until(/^bestmove/, [`position fen ${fen}`, 'go infinite']);
    finished.then(() => { end = {}; wake?.(); }, err => { end = { err }; wake?.(); });
    this.tap = line => {    // the search's lines go here instead of piling up for until()
      this.lines.length = 0;
      if (line.startsWith('info ')) { buf.push(line); wake?.(); }
    };
    try {
      for (;;) {
        while (buf.length) yield buf.shift();
        if (end) {
          if (end.err) throw end.err;
          return;
        }
        await new Promise(resolve => { wake = resolve; });
        wake = null;
      }
    } finally {
      this.tap = null;
      if (!end) {
        this.proc.stdin.write('stop\n');
        await finished.catch(() => {});
      }
    }
  }
  close() {
    this.closed = true;
    const proc = this.proc;
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const kill = setTimeout(() => proc.kill(), 2000);
      proc.once('exit', () => { clearTimeout(kill); resolve(); });
      proc.stdin.write('quit\n');
    });
  }
}

export class EnginePool {
  // size: engines to run; path: the stockfish executable; hash: MB per engine. Nothing starts until load() (or the
  // first search).
  constructor({ size = physicalCores(), path, hash = 64 }) {
    Object.assign(this, { size, path, hash, name: 'Stockfish', free: [], waiting: [], engines: [], loaded: null });
  }
  load() {
    if (!this.loaded) {
      this.engines = Array.from({ length: this.size }, () => new Engine(this.path, this.hash));
      this.free = [...this.engines];
      this.loaded = Promise.all(this.engines.map(e => e.ready)).then(() => { this.name = this.engines[0].name; }, err => {
        this.close();
        throw err;
      });
    }
    return this.loaded;
  }
  async acquire() {
    await this.load();
    if (this.free.length) return this.free.pop();
    return new Promise(resolve => this.waiting.push(resolve));
  }
  release(engine) {
    if (engine.closed) return;
    const next = this.waiting.shift();
    if (next) next(engine); else this.free.push(engine);
  }
  async search(fen, nodes, multipv = 3) {
    const engine = await this.acquire();
    try { return await engine.search(fen, nodes, multipv); } finally { this.release(engine); }
  }
  // Engine.stream on a free engine, which goes back to the pool once the stream is closed.
  async *stream(fen, multipv = 3) {
    const engine = await this.acquire();
    try { yield* engine.stream(fen, multipv); } finally { this.release(engine); }
  }
  // Every engine quits (killed if it doesn't within 2 s); the next search starts a fresh set. Call it between jobs:
  // a search in hand fails.
  async close() {
    const engines = this.engines;
    Object.assign(this, { engines: [], free: [], loaded: null });
    await Promise.all(engines.map(e => e.close()));
  }
}

// One engine per physical core: hyperthreads add nothing (analyse.default_workers: on the dev box 6 processes
// give 1.9 Mnps together, 11 give 1.6). Node has no physical core count, so half the logical ones, as Python does.
export function physicalCores() {
  return Math.max(1, Math.floor((cpus().length || 2) / 2));
}
