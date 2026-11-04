// Several tabs, one database. The SQLite files live in OPFS through the "opfs-sahpool" VFS, which only a dedicated
// worker can open and only one at a time. So every tab starts its own worker (js/web/worker.js), and the workers
// elect a leader with the Web Locks API: the one holding the lock "blundr-leader" opens the databases, runs the job
// runner and the engines, and answers every tab. The others pass their page's requests to it over a
// BroadcastChannel and hand the answers back. When the leader's tab closes, its lock is released, the next worker in
// the queue takes over (opening the databases again), and the requests that were still unanswered are sent again.
//
// Why not a SharedWorker: it can't open OPFS sync access handles (only a dedicated worker can, and the pool needs
// them), and Chrome on Android has long had none. Web Locks and BroadcastChannel are in every browser that has the
// pool (Safari 16.4+, Chrome 102+, Firefox 111+), dedicated workers included. Without Web Locks a worker simply
// leads; a second tab then fails to open the pool and says so.
//
// Each worker also holds a lock of its own ("blundr-tab:<id>") for as long as it lives. The leader waits on it to
// learn that a tab went away, and stops what it was doing for that tab (an open /api/eval_stream keeps an engine).
//
// Messages on the channel:
//   {type: 'req', from, id, method, path, body, contentType}     a tab's request, for the leader
//   {type: 'abort', from, id}                                    the page gave up on it
//   {type: 'res', to, msg}                                       a part of the answer: msg is what goes to the page
//   {type: 'leader', tab}                                        a new leader: send what's unanswered again
//   {type: 'hello', from}                                        a new tab: the leader sends it the progress so far
//   {type: 'progress', to?, ...}                                 the loading lines, for every tab (or one)
// What goes to a page: {type: 'response', id, status, headers, body} or, for a stream, a 'response' with
// stream: true, then {type: 'chunk', id, body} and {type: 'end', id}; and {type: 'progress', what, done, total, text}.

const forever = () => new Promise(() => {});
const randomId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export const LEADER_LOCK = 'blundr-leader';
export const TAB_LOCK = 'blundr-tab:';
export const WAIT_MS = 8000;    // a follower that hears nothing from the leader this long says so instead of "Loading"
export const STUCK = "Blundr is open in another tab that isn't answering. Close the other Blundr tabs (or reload them), then reload this one.";

export class Tabs {
  /** toPage(msg): to this tab's page. channel: a BroadcastChannel (or anything with postMessage and onmessage);
   * locks: navigator.locks, or null to lead at once. */
  constructor({ toPage, channel, locks = globalThis.navigator?.locks ?? null, id = randomId(), log = console, waitMs = WAIT_MS }) {
    Object.assign(this, { toPage, channel, locks, id, log, waitMs });
    this.heard = false;          // anything from a leader yet (its loading lines, an answer)
    this.answer = null;          // once leading: answer(req, emit, signal) → Promise
    this.pending = new Map();    // own requests sent to the leader: id → {req, streaming}
    this.local = new Map();      // own requests answered here: id → AbortController
    this.remote = new Map();     // other tabs' requests answered here: 'from:id' → AbortController
    this.seen = new Set();       // 'from:id' already taken: a request sent again after a change of leader is not run twice
    this.watched = new Set();    // tabs whose lock the leader waits on
    this.progressSoFar = new Map();
    channel.onmessage = e => this.onChannel(e.data);
  }

  get leading() {
    return this.answer !== null;
  }

  /** Join: hold this tab's lock, say hello, and queue for the leader's lock. becomeLeader() → answer function,
   * called once this worker is elected. Resolves once this tab's lock is held (requests can go out from then on). */
  async start(becomeLeader) {
    if (!this.locks) {
      await this.elected(becomeLeader);
      return;
    }
    await new Promise(granted => this.locks.request(TAB_LOCK + this.id, () => { granted(); return forever(); }));
    this.channel.postMessage({ type: 'hello', from: this.id });
    // a live leader answers the hello with its loading lines at once; one that doesn't (a frozen background tab still
    // holding the lock) would otherwise leave this tab on "Loading" for good
    setTimeout(() => {
      if (!this.leading && !this.heard) this.toPage({ type: 'progress', what: 'app', done: 0, total: 0, text: STUCK });
    }, this.waitMs).unref?.();
    this.locks.request(LEADER_LOCK, async () => {
      await this.elected(becomeLeader);
      return forever();
    }).catch(e => this.log.error('the leader lock failed', e));
  }

  async elected(becomeLeader) {
    this.answer = await becomeLeader();
    this.channel.postMessage({ type: 'leader', tab: this.id });
    // what this tab had sent to the old leader is answered here now
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      if (p.streaming) this.toPage({ type: 'end', id });
      else this.serveLocal(p.req);
    }
  }

  /** A request from this tab's page: {id, method, path, body, contentType}. */
  request(req) {
    if (this.leading) return this.serveLocal(req);
    this.pending.set(req.id, { req, streaming: false });
    this.channel.postMessage({ type: 'req', from: this.id, ...req });
  }

  /** The page gave up on request `id` (an aborted fetch, a cancelled stream). */
  abort(id) {
    const ac = this.local.get(id);
    if (ac) return ac.abort();
    if (this.pending.delete(id)) this.channel.postMessage({ type: 'abort', from: this.id, id });
  }

  /** The leader's loading lines: to its own page and every other tab; kept for tabs that open later. */
  progress(msg) {
    msg = { type: 'progress', ...msg };
    this.progressSoFar.set(msg.what, msg);
    this.toPage(msg);
    this.channel.postMessage(msg);
  }

  serveLocal(req) {
    const ac = new AbortController();
    this.local.set(req.id, ac);
    return this.answer(req, msg => this.toPage({ ...msg, id: req.id }), ac.signal)
      .catch(e => this.log.error('answering failed', e))
      .finally(() => this.local.delete(req.id));
  }

  serveRemote(m) {
    const key = `${m.from}:${m.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.watch(m.from);
    const ac = new AbortController();
    this.remote.set(key, ac);
    const { type, from, ...req } = m;
    this.answer(req, msg => this.channel.postMessage({ type: 'res', to: from, msg: { ...msg, id: m.id } }), ac.signal)
      .catch(e => this.log.error('answering failed', e))
      .finally(() => this.remote.delete(key));
  }

  /** Once tab `from` has gone, whatever it asked for is stopped and forgotten. */
  watch(from) {
    if (!this.locks || this.watched.has(from)) return;
    this.watched.add(from);
    this.locks.request(TAB_LOCK + from, () => {
      this.watched.delete(from);
      for (const [key, ac] of [...this.remote]) if (key.startsWith(from + ':')) ac.abort();
      for (const key of [...this.seen]) if (key.startsWith(from + ':')) this.seen.delete(key);
    }).catch(() => {});
  }

  onChannel(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'leader' || (['progress', 'here', 'res'].includes(m.type) && (!m.to || m.to === this.id))) {
      this.heard = true;
    }
    switch (m.type) {
      case 'req':
        if (this.leading) this.serveRemote(m);
        return;
      case 'abort':
        if (this.leading) this.remote.get(`${m.from}:${m.id}`)?.abort();
        return;
      case 'res': {
        if (m.to !== this.id) return;
        const msg = m.msg, p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'response' && msg.stream) p.streaming = true;
        else if (msg.type === 'response' || msg.type === 'end') this.pending.delete(msg.id);
        this.toPage(msg);
        return;
      }
      case 'leader':
        if (m.tab === this.id) return;
        for (const [id, p] of [...this.pending]) {
          if (p.streaming) {      // the old leader's stream ended with it
            this.pending.delete(id);
            this.toPage({ type: 'end', id });
          } else this.channel.postMessage({ type: 'req', from: this.id, ...p.req });
        }
        return;
      case 'hello':
        if (!this.leading) return;
        this.channel.postMessage({ type: 'here', to: m.from });     // alive, even before it has anything to say
        for (const msg of this.progressSoFar.values()) this.channel.postMessage({ ...msg, to: m.from });
        return;
      case 'here':
        return;
      case 'progress': {
        if (m.to && m.to !== this.id) return;
        const { to, ...msg } = m;
        this.toPage(msg);
        return;
      }
    }
  }
}
