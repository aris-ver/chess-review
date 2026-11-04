#!/usr/bin/env bash
# Rebuilds js/vendor/sqlite-wasm/: SQLite's own WebAssembly build (@sqlite.org/sqlite-wasm) as the browser loads it,
# an ES module with the .wasm beside it, no bundler. Only the files the page needs are copied, unchanged. Run it only
# to move to another version, and bump the version below and in js/vendor/README.md together.
set -euo pipefail

VERSION=3.53.4-build2
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/js/vendor/sqlite-wasm"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm pack --silent "@sqlite.org/sqlite-wasm@$VERSION" >/dev/null
tar xzf ./*.tgz
mkdir -p "$OUT"
cp package/dist/index.mjs "$OUT/sqlite3.mjs"
cp package/dist/sqlite3.wasm package/dist/sqlite3-opfs-async-proxy.js "$OUT/"
echo "wrote js/vendor/sqlite-wasm/ (@sqlite.org/sqlite-wasm $VERSION)"
