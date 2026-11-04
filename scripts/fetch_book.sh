#!/usr/bin/env bash
# One-time download of the lichess chess-openings book (CC0) used for in_book detection.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/book
rm -f data/book/.tsv
for f in a b c d e; do
  curl -sSL -o "data/book/$f.tsv" "https://raw.githubusercontent.com/lichess-org/chess-openings/master/$f.tsv"
done
wc -l data/book/*.tsv | tail -1
