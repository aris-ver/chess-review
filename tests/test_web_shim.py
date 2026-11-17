"""web/shim.js under Node, with a fake Python worker and a fake Cache Storage: what it keeps from the last visit
(blundr-kept) goes when the browser's data changes owner, so the next visit doesn't show the last person's."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

HARNESS = r"""
const fs = require('fs'), vm = require('vm');
const kept = new Map();       // Cache Storage 'blundr-kept': url -> text
const cache = {
  match: async k => kept.has(k) ? new Response(kept.get(k), { headers: { 'Content-Type': 'application/json' } }) : undefined,
  put: async (k, r) => { const t = await r.text(); kept.delete(k); kept.set(k, t); },     // put again: listed last
  delete: async k => kept.delete(k),
  keys: async () => [...kept.keys()],
};
let worker;
class FakeWorker { constructor() { worker = this; this.sent = []; } postMessage(m) { this.sent.push(m); } }
const el = () => ({ style: {}, classList: { toggle() {}, remove() {} }, remove() {}, querySelector: () => ({}), isConnected: false });
const g = {
  location: { href: 'https://blundr.gr/', origin: 'https://blundr.gr', hash: '' },
  document: { createElement: el, head: { appendChild() {} }, body: null, addEventListener() {}, querySelector: () => null,
              documentElement: { classList: { add() {}, remove() {}, contains: () => false } } },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  caches: { open: async name => { if (name !== 'blundr-kept') throw new Error(name); return cache; } },
  Worker: FakeWorker, XMLHttpRequest: function () {}, HashChangeEvent: class { constructor(t) { this.type = t; } },
  addEventListener() {}, dispatchEvent() {}, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('network'); },
  URL, Request, Response, TextDecoder, TextEncoder, DOMException, Uint8Array, JSON, Object, Promise, Error,
};
g.XMLHttpRequest.prototype.open = function () {};
g.self = g.window = g;
vm.createContext(g);
vm.runInContext(fs.readFileSync(process.argv[2], 'utf8'), g);

const tick = () => new Promise(r => setTimeout(r, 20));
// the page asks; the worker's answer comes back when `answer` is called
function ask(path, init) {
  const n = worker.sent.length;
  const res = g.fetch(path, init);
  return { res, answer: async (status, body) => {
    while (worker.sent.length === n) await tick();
    const id = worker.sent[n].id;
    worker.onmessage({ data: { type: 'response', id, status, headers: [['Content-Type', 'application/json']],
                               body: new TextEncoder().encode(JSON.stringify(body)) } });
    await res; await tick();
  } };
}
const sync = async (route, body) => ask(route, { method: 'POST', body: '{}' }).answer(200, body);
const keys = () => [...kept.keys()].map(k => k.replace('https://blundr.gr/', '')).sort();

(async () => {
  const out = {};
  await ask('api/profiles').answer(200, [{ id: 'a' }]);
  await ask('p/a/games/g1.json').answer(200, { id: 'g1' });
  out.kept = keys();
  await sync('api/sync/switch', { switched: false });       // same owner: nothing moved
  out.afterNoSwitch = keys();
  const late = ask('api/profiles');                          // asked before the log out, answered after it
  await sync('api/sync/switch', { switched: true });
  out.afterSwitch = keys();
  await late.answer(200, [{ id: 'a' }]);
  out.afterLateAnswer = keys();
  await ask('api/profiles').answer(200, [{ id: 'b' }]);     // the new owner's answers are kept again
  out.newOwner = [keys(), kept.get('https://blundr.gr/api/profiles')];
  await sync('api/sync/release', { released: true });        // the account was deleted
  out.afterRelease = keys();
  // only the last 30 reviews opened stay; a review opened again counts as new
  for (let i = 0; i < 35; i++) await ask(`p/b/games/g${i}.json`).answer(200, { id: i });
  await ask('p/b/games/g0.json').answer(200, { id: 0 });
  out.reviews = keys().filter(k => k.startsWith('p/b/games/'));
  // a profile the home screen no longer lists: all of it goes
  await ask('p/c/games.json').answer(200, []);
  await ask('api/profiles').answer(200, { profiles: [{ id: 'b' }], scan: null });
  out.afterProfiles = keys().filter(k => !k.startsWith('p/b/games/'));
  console.log('RESULT' + JSON.stringify(out));
})().catch(e => { console.error(e); process.exit(1); });
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="no node")
def test_kept_answers_go_when_the_data_changes_owner(tmp_path):
    harness = tmp_path / "harness.js"
    harness.write_text(HARNESS, encoding="utf-8")
    run = subprocess.run(["node", str(harness), str(ROOT / "web" / "shim.js")], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    out = json.loads(run.stdout.split("RESULT", 1)[1])
    assert out["kept"] == ["api/profiles", "p/a/games/g1.json"]
    assert out["afterNoSwitch"] == out["kept"]
    assert out["afterSwitch"] == []
    assert out["afterLateAnswer"] == []
    assert out["newOwner"] == [["api/profiles"], '[{"id":"b"}]']
    assert out["afterRelease"] == []
    assert sorted(out["reviews"]) == sorted(f"p/b/games/g{i}.json" for i in [0, *range(6, 35)])
    assert out["afterProfiles"] == ["api/profiles"]


REGISTERS = r"""
// web/shim.js run with the given script URL (none: as a checkout's page would): does it register the service worker?
const fs = require('fs'), vm = require('vm');
const [file, src, secure] = process.argv.slice(2);
const registered = [], listeners = {};
const el = () => ({ style: {}, classList: { toggle() {}, remove() {} }, remove() {}, querySelector: () => ({}), isConnected: false });
const g = {
  location: { href: 'https://blundr.gr/', origin: 'https://blundr.gr', hash: '' },
  document: { createElement: el, head: { appendChild() {} }, body: null, addEventListener() {}, querySelector: () => null,
              currentScript: src === '-' ? null : { src },
              documentElement: { classList: { add() {}, remove() {}, contains: () => false } } },
  navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)', serviceWorker: {
    controller: null, addEventListener() {},
    register: async (url, opts) => { registered.push([url, opts]); return { waiting: null, installing: null, addEventListener() {} }; },
  } },
  isSecureContext: secure === '1',
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  caches: { open: async () => ({}) },
  Worker: class { postMessage() {} }, XMLHttpRequest: function () {}, matchMedia: () => ({ matches: false }),
  addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, dispatchEvent() {}, setTimeout: () => 0, clearTimeout() {},
  fetch: async () => { throw new Error('network'); },
  URL, Request, Response, TextDecoder, TextEncoder, DOMException, Uint8Array, JSON, Object, Promise, Error,
};
g.XMLHttpRequest.prototype.open = function () {};
g.self = g.window = g;
vm.createContext(g);
vm.runInContext(fs.readFileSync(file, 'utf8'), g);
(listeners.load || []).forEach(f => f());
setTimeout(() => console.log('RESULT' + JSON.stringify(registered)), 50);
"""


@pytest.mark.skipif(shutil.which("node") is None, reason="no node")
@pytest.mark.parametrize("src, secure, registers", [
    ("https://blundr.gr/v/0123abcd4567/web/shim.js", "1", True),    # a build, on https
    ("https://blundr.gr/v/0123abcd4567/web/shim.js", "0", False),   # not a secure context
    ("https://blundr.gr/web/shim.js", "1", False),                  # a checkout's page: no offline.js beside it
    ("-", "1", False),                                              # no script tag
])
def test_only_a_builds_page_registers_the_service_worker(tmp_path, src, secure, registers):
    """The desktop app's page has no shim at all (scripts/build_web.js adds the tag); the shim registers offline.js
    only from a build's v/<version>/, in a secure context, at the site's root."""
    harness = tmp_path / "harness.js"
    harness.write_text(REGISTERS, encoding="utf-8")
    run = subprocess.run(["node", str(harness), str(ROOT / "web" / "shim.js"), src, secure], capture_output=True, text=True,
                         timeout=60)
    assert run.returncode == 0, run.stderr
    got = json.loads(run.stdout.split("RESULT", 1)[1])
    assert got == ([["/offline.js", {"scope": "/", "updateViaCache": "none"}]] if registers else [])


def test_the_desktop_page_has_no_service_worker():
    """The page the desktop app serves as it is (chess_review/static/index.html): nothing there registers one."""
    page = (ROOT / "chess_review" / "static" / "index.html").read_text(encoding="utf-8")
    assert "serviceWorker" not in page and "offline.js" not in page
    assert "serviceWorker" not in (ROOT / "chess_review" / "static" / "account.js").read_text(encoding="utf-8")
