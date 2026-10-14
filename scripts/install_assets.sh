#!/usr/bin/env bash
# Install a badge icon set into data/site/assets/icons (gitignored).
#   bash scripts/install_assets.sh <icons-dir>
# icons-dir: files named classification-<name>.svg or <name>.svg for the 14 classifications
# chess.com's icons are for local personal use only. Pieces, boards and sounds are Lichess's and ship with
# the app (chess_review/static/themes, see scripts/import_lichess_themes.py).
set -euo pipefail
cd "$(dirname "$0")/.."
icons="${1:?icons dir}"
mkdir -p data/site/assets/icons
for n in brilliant great-find best excellent good book inaccuracy mistake blunder miss missed-win forced winner equal; do
  if [ -f "$icons/classification-$n.svg" ]; then cp "$icons/classification-$n.svg" "data/site/assets/icons/$n.svg"
  elif [ -f "$icons/$n.svg" ]; then cp "$icons/$n.svg" "data/site/assets/icons/$n.svg"
  else echo "missing icon: $n"; fi
done
echo "icons: $(ls data/site/assets/icons | wc -l)"
