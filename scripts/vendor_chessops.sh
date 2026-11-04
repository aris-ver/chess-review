#!/usr/bin/env bash
# Rebuilds js/vendor/chessops.js: chessops (and its one dependency, @badrap/result) as a single ES module that the
# browser loads without a bundler and Node imports as it is. Run it only to move to another chessops version, and
# bump the version below and in js/vendor/README.md together.
set -euo pipefail

VERSION=0.15.1
ESBUILD=0.28.2
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "chessops@$VERSION" "esbuild@$ESBUILD"
cat > entry.js <<'JS'
export * from 'chessops';
export { castlingSide, normalizeMove } from 'chessops/chess';
JS
{
  echo "// chessops $VERSION (https://github.com/niklasf/chessops, GPL-3.0-or-later) with @badrap/result (MIT),"
  echo "// bundled into one ES module by scripts/vendor_chessops.sh (esbuild $ESBUILD). Don't edit; rebuild."
  npx esbuild entry.js --bundle --format=esm --target=es2020 --legal-comments=inline --log-level=warning
} > "$ROOT/js/vendor/chessops.js"
echo "wrote js/vendor/chessops.js (chessops $VERSION)"
