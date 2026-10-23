// tabs.js: several tabs' workers, one leader, over a fake BroadcastChannel and a fake Web Locks manager (the same
// semantics: one holder per name, the rest queued in order; a lock is released when its callback's promise settles).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Tabs } from './tabs.js';

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await tick(); };

function fakeLocks() {
  const held = new Map(), queues = new Map();
  const grant = name => {
    if (held.has(name)) return;
    const next = queues.get(name)?.shift();
    if (!next) return;
    held.set(name, next);
    Promise.resolve().then(() => next.cb({ name })).then(next.resolve, next.reject).finally(() => {
      held.delete(name);
      grant(name);
    });
  };
  return {
    request(name, cb) {
      return new Promise((resolve, reject) => {
        if (!queues.has(name)) queues.set(name, []);
        queues.get(name).push({ cb, resolve, reject });
        grant(name);
      });
    },
    held,
  };
}

/** A tab whose worker can be closed: closing releases its locks (the fake's callbacks return promises we settle). */
function bus() {
  const members = new Set();
  return {
    channel() {
      const ch = {
        onmessage: null,
        postMessage(m) {
          const copy = structuredClone(m);
          for (const o of members) if (o !== ch && !o.closed) setTimeout(() => o.onmessage?.({ data: copy }), 0);
        },
        closed: false,
      };
      members.add(ch);
      return ch;
    },
  };
}

/** A tab: its Tabs over a locks manager whose locks it can drop when the tab closes. */
function tab(name, b, locks, answer) {
  const page = [];
  const kills = [];
  const scoped = {     // the tab's own view of the lock manager: what it holds goes when it closes
    request: (lock, cb) => locks.request(lock, info => {
      const out = cb(info);
      if (out && typeof out.then === 'function') return Promise.race([out, new Promise(r => kills.push(r))]);
      return out;
    }),
  };
  const ch = b.channel();
  const tabs = new Tabs({ toPage: m => page.push(m), channel: ch, locks: scoped, id: name, log: { error() {} } });
  return {
    tabs, page,
    start: () => tabs.start(async () => answer(name)),
    close() { ch.closed = true; kills.forEach(k => k()); },
  };
}

const answerer = log => name => async (req, emit, signal) => {
  log.push(`${name} ${req.path}`);
  if (req.path === '/stream') {
    emit({ type: 'response', status: 200, headers: [], stream: true });
    for (let i = 0; !signal.aborted && i < 1000; i++) {
      emit({ type: 'chunk', body: `${name}:${i}` });
      await tick();
    }
    log.push(`${name} stream stopped`);
    emit({ type: 'end' });
    return;
  }
  if (req.path === '/slow') await new Promise(r => setTimeout(r, 50));
  emit({ type: 'response', status: 200, headers: [], body: `${name} answers ${req.path}` });
};

test('the first tab leads; a second one is answered by it', async () => {
  const b = bus(), locks = fakeLocks(), log = [];
  const a = tab('a', b, locks, answerer(log)), c = tab('c', b, locks, answerer(log));
  await a.start();
  await c.start();
  await settle();
  assert.ok(a.tabs.leading);
  assert.ok(!c.tabs.leading);
  a.tabs.request({ id: 1, method: 'GET', path: '/x' });
  c.tabs.request({ id: 1, method: 'GET', path: '/y' });
  await settle();
  assert.deepEqual(a.page.filter(m => m.type === 'response').map(m => [m.id, m.body]), [[1, 'a answers /x']]);
  assert.deepEqual(c.page.filter(m => m.type === 'response').map(m => [m.id, m.body]), [[1, 'a answers /y']]);
  assert.deepEqual(log, ['a /x', 'a /y']);
});

test('the leader goes: the next tab leads and what was unanswered is asked again, once', async () => {
  const b = bus(), locks = fakeLocks(), log = [];
  const a = tab('a', b, locks, answerer(log)), c = tab('c', b, locks, answerer(log)), d = tab('d', b, locks, answerer(log));
  await a.start(); await c.start(); await d.start();
  await settle();
  a.close();                                         // closed with requests on their way
  c.tabs.request({ id: 7, method: 'GET', path: '/after' });
  d.tabs.request({ id: 3, method: 'POST', path: '/post' });
  await settle(30);
  assert.ok(c.tabs.leading);
  assert.deepEqual(c.page.filter(m => m.type === 'response').map(m => m.body), ['c answers /after']);
  assert.deepEqual(d.page.filter(m => m.type === 'response').map(m => m.body), ['c answers /post']);
  assert.equal(log.filter(l => l === 'c /post').length, 1);
});

test('progress reaches every tab, and a tab that opens later gets what was said so far', async () => {
  const b = bus(), locks = fakeLocks(), log = [];
  const a = tab('a', b, locks, answerer(log));
  await a.start();
  await settle();
  a.tabs.progress({ what: 'app', done: 1, total: 1, text: 'Ready' });
  const c = tab('c', b, locks, answerer(log));
  await c.start();
  await settle();
  assert.deepEqual(a.page.filter(m => m.type === 'progress').map(m => m.text), ['Ready']);
  assert.deepEqual(c.page.filter(m => m.type === 'progress').map(m => [m.what, m.text]), [['app', 'Ready']]);
});

test('a stream from another tab stops when that tab aborts it or goes away', async () => {
  const b = bus(), locks = fakeLocks(), log = [];
  const a = tab('a', b, locks, answerer(log)), c = tab('c', b, locks, answerer(log)), d = tab('d', b, locks, answerer(log));
  await a.start(); await c.start(); await d.start();
  await settle();
  c.tabs.request({ id: 1, method: 'GET', path: '/stream' });
  d.tabs.request({ id: 1, method: 'GET', path: '/stream' });
  await settle(20);
  assert.ok(c.page.some(m => m.type === 'chunk' && m.body.startsWith('a:')));
  c.tabs.abort(1);
  await settle(20);
  assert.equal(log.filter(l => l === 'a stream stopped').length, 1);
  d.close();                                          // d's worker is gone: its lock goes, the leader stops its stream
  await settle(20);
  assert.equal(log.filter(l => l === 'a stream stopped').length, 2);
});

test("a stream the old leader was sending ends when it goes; the leader's own page is answered locally", async () => {
  const b = bus(), locks = fakeLocks(), log = [];
  const a = tab('a', b, locks, answerer(log)), c = tab('c', b, locks, answerer(log));
  await a.start(); await c.start();
  await settle();
  c.tabs.request({ id: 5, method: 'GET', path: '/stream' });
  await settle(10);
  a.close();
  await settle(30);
  assert.ok(c.tabs.leading);
  assert.ok(c.page.some(m => m.type === 'end' && m.id === 5));
  c.tabs.request({ id: 6, method: 'GET', path: '/z' });
  await settle();
  assert.equal(c.page.find(m => m.type === 'response' && m.id === 6).body, 'c answers /z');
});

test('without Web Locks a tab simply leads', async () => {
  const b = bus(), log = [];
  const page = [];
  const t = new Tabs({ toPage: m => page.push(m), channel: b.channel(), locks: null, id: 'solo' });
  await t.start(async () => answerer(log)('solo'));
  t.request({ id: 1, method: 'GET', path: '/x' });
  await settle();
  assert.equal(page[0].body, 'solo answers /x');
});
