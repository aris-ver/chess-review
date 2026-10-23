// Stockfish 19 (npm stockfish@19.0.1, single-threaded WASM builds) as a pool of Web Workers, for the Python worker.
// Same scheme as analyse.py: one engine per physical core, Threads=1, Hash=64 (16 on phones), MultiPV 3, a fixed node count and
// `ucinewgame` (hash cleared) before every position, so a result is the same whichever engine gets it.

// Fetch a .wasm with progress, keep it in Cache Storage for the next visit, and hand back a blob: URL the engine
// script takes from its location hash (stockfish.js reads the wasm's URL from there). bytes: the file's size, for
// the progress bar when the host sends no Content-Length (unpkg doesn't).
export async function cachedWasm(url, onProgress, bytes = 0) {
  const cache = self.caches ? await caches.open('chess-review-engines') : null;
  let res = cache && await cache.match(url);
  if (res) {
    const blob = await res.blob();
    onProgress(blob.size, blob.size);
    return URL.createObjectURL(blob);
  }
  onProgress(0, bytes);       // the bar shows at once: the first chunk can take seconds
  res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = bytes || +res.headers.get('Content-Length') || 0, chunks = [], reader = res.body.getReader();
  let done = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    onProgress(Math.min(done, total || done), total);
  }
  onProgress(done, done);     // finished, whatever the size said
  const blob = new Blob(chunks, { type: 'application/wasm' });
  if (cache) {
    try { await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/wasm' } })); } catch (e) { /* quota: fetch again next time */ }
  }
  return URL.createObjectURL(blob);
}

class Engine {
  constructor(script, wasm, hash) {
    this.script = script;
    this.wasm = wasm;
    this.hash = hash;
    this.start();
  }
  start() {
    this.worker = new Worker(`${this.script}#${encodeURIComponent(this.wasm)}`);
    this.waiter = null;
    this.lines = [];
    this.worker.onmessage = e => {
      const line = String(e.data);
      this.lines.push(line);
      this.tap?.(line);
      if (this.waiter && this.waiter.re.test(line)) { const w = this.waiter; this.waiter = null; w.resolve(this.lines.splice(0)); }
    };
    this.worker.onerror = e => {   // the engine died (a WASM trap): fail the search in hand, start a fresh one
      e.preventDefault();
      const w = this.waiter; this.waiter = null;
      this.worker.terminate();
      this.ready = this.start();
      if (w) w.reject(new Error('engine crashed: ' + (e.message || 'unknown')));
    };
    this.ready = this.until(/^uciok/, ['uci']).then(lines => {
      this.name = ((lines.find(l => l.startsWith('id name ')) || '').slice(8) || 'Stockfish').trim();
      return this.until(/^readyok/, ['setoption name Threads value 1', `setoption name Hash value ${this.hash}`, 'isready']);
    });
    return this.ready;
  }
  until(re, cmds) {
    return new Promise((resolve, reject) => {
      this.waiter = { re, resolve, reject };
      this.lines = [];
      cmds.forEach(c => this.worker.postMessage(c));
    });
  }
  // The search's `info` lines, the way python-chess would have read them off a native engine.
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
        this.worker.postMessage('stop');
        await finished.catch(() => {});
      }
    }
  }
}

export class EnginePool {
  // size: engines to run; script: the engine's .js; wasmUrl: its .wasm (may be on another origin, e.g. unpkg) and
  // wasmBytes its size; hash: MB per engine. Nothing is fetched until load() (or the first search), so the caller decides
  // what downloads first.
  constructor({ size, script, wasmUrl, wasmBytes, hash = 64, onProgress }) {
    Object.assign(this, { size, script, wasmUrl, wasmBytes, hash, onProgress, name: 'Stockfish 19', free: [], waiting: [], loaded: null });
  }
  load() {
    if (!this.loaded) this.loaded = cachedWasm(this.wasmUrl, this.onProgress, this.wasmBytes).then(wasm => {
      for (let i = 0; i < this.size; i++) this.free.push(new Engine(this.script, wasm, this.hash));
      return this.free[0].ready.then(() => { this.name = this.free[0].name; });
    });
    return this.loaded;
  }
  async acquire() {
    await this.load();
    if (this.free.length) return this.free.pop();
    return new Promise(resolve => this.waiting.push(resolve));
  }
  release(engine) {
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
}

// One engine per physical core: hyperthreads add nothing (measured: 6 and 12 workers both 88 s on 6 cores).
export function physicalCores() {
  return Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2));
}
