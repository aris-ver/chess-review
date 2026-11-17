// web/engines.js's pruneEngines over a fake Cache Storage: only this build's engines stay on the device.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pruneEngines } from '../../web/engines.js';

function fakeCaches(names) {
  const stores = new Map(Object.entries(names).map(([n, urls]) => [n, new Map(urls.map(u => [u, 'wasm']))]));
  return {
    stores,
    has: async n => stores.has(n),
    open: async n => {
      if (!stores.has(n)) stores.set(n, new Map());
      const s = stores.get(n);
      return { keys: async () => [...s.keys()].map(url => ({ url })), delete: async r => s.delete(r.url ?? r) };
    },
  };
}

test('engines of other versions are deleted, this build\'s kept', async () => {
  const old = 'https://unpkg.com/stockfish@18.0.0/bin/stockfish-18-single.wasm';
  const full = 'https://unpkg.com/stockfish@19.0.1/bin/stockfish-19-single.wasm';
  const lite = 'https://blundr.gr/web/engine/stockfish-19-lite-single.wasm';
  globalThis.self = globalThis;
  globalThis.caches = fakeCaches({ 'chess-review-engines': [old, full, lite], other: [old] });
  try {
    assert.deepEqual(await pruneEngines([full, lite, undefined]), [old]);
    assert.deepEqual([...caches.stores.get('chess-review-engines').keys()], [full, lite]);
    assert.equal(caches.stores.get('other').size, 1);      // another cache isn't touched
    assert.deepEqual(await pruneEngines([full, lite]), []);
  } finally {
    delete globalThis.caches;
  }
});

test('no engine cache: none is made', async () => {
  globalThis.self = globalThis;
  globalThis.caches = fakeCaches({});
  try {
    assert.deepEqual(await pruneEngines(['https://x/a.wasm']), []);
    assert.equal(caches.stores.size, 0);
  } finally {
    delete globalThis.caches;
  }
});
