#!/usr/bin/env bash
# One-time download of the chess.com default sound set into data/site/sounds (gitignored, personal use).
# Add brilliant.mp3 (or .webm) here yourself; chess.com does not serve it publicly.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/site/sounds
base="https://images.chesscomfiles.com/chess-themes/sounds/_MP3_/default"
for n in game-start game-end capture castle premove move-self move-opponent move-check promote notify illegal tenseconds \
         game-win-long game-lose-long game-draw; do
  [ -s "data/site/sounds/$n.mp3" ] && continue
  curl -sSL -A "chess-review/0.1 (personal offline game analysis tool)" -o "data/site/sounds/$n.mp3" "$base/$n.mp3" || echo "failed: $n"
done
ls -la data/site/sounds | tail -n +2 | wc -l
