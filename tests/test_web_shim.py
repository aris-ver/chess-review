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
  put: async (k, r) => { kept.set(k, await r.text()); },
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
