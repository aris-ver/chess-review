#!/usr/bin/env bash
# Install a piece set and a badge icon set into data/site/assets (gitignored).
#   bash scripts/install_assets.sh <icons-dir> [pieces-dir]
# icons-dir:  files named classification-<name>.svg or <name>.svg for the 14 classifications
# pieces-dir: wp.png wn.png ... bk.png
# chess.com's assets are for local personal use only; for anything reachable beyond localhost
# use Lichess pieces (github.com/lichess-org/lila) and your own icons. See README.
set -euo pipefail
cd "$(dirname "$0")/.."
icons="${1:?icons dir}"; pieces="${2:-}"
mkdir -p data/site/assets/icons data/site/assets/pieces
for n in brilliant great-find best excellent good book inaccuracy mistake blunder miss missed-win forced winner equal; do
  if [ -f "$icons/classification-$n.svg" ]; then cp "$icons/classification-$n.svg" "data/site/assets/icons/$n.svg"
  elif [ -f "$icons/$n.svg" ]; then cp "$icons/$n.svg" "data/site/assets/icons/$n.svg"
  else echo "missing icon: $n"; fi
done
if [ -n "$pieces" ]; then
  for p in wp wn wb wr wq wk bp bn bb br bq bk; do
    [ -f "$pieces/$p.png" ] && cp "$pieces/$p.png" data/site/assets/pieces/ || echo "missing piece: $p"
  done
fi
echo "icons: $(ls data/site/assets/icons | wc -l)  pieces: $(ls data/site/assets/pieces | wc -l)"
