#!/usr/bin/env bash
# Keep only the sounds the page uses in data/site/sounds; park everything else in data/sounds_unused.
set -euo pipefail
cd "$(dirname "$0")/.."
S=data/site/sounds; U=data/sounds_unused
mkdir -p "$S" "$U"
# chess.com's review stinger arrives with a content hash in the name -> canonical name
for f in "$S"/brilliant-*.mp3; do [ -e "$f" ] && mv -f "$f" "$S/brilliant.mp3"; done
for f in "$S"/tenseconds-*.mp3; do [ -e "$f" ] && mv -f "$f" "$S/tenseconds.mp3"; done
keep="game-start game-end capture castle premove move-self move-opponent move-check promote notify illegal tenseconds game-win-long game-lose-long game-draw brilliant"
for f in "$S"/*; do
  name=$(basename "$f")
  case "$name" in *:Zone.Identifier) rm -f "$f"; continue;; esac
  stem="${name%.*}"
  if ! grep -qw -- "$stem" <<<"$keep"; then mv -f "$f" "$U/"; fi
done
bash scripts/fetch_sounds.sh >/dev/null     # restore any of the standard set that went missing
echo "kept:"; ls "$S"
echo "parked in $U: $(ls "$U" | wc -l) files"
