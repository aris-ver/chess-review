#!/usr/bin/env bash
# First-run setup inside the container: opening book, sounds (if missing), then whatever command was given.
set -e
cd /app
[ -s data/book/a.tsv ] || bash scripts/fetch_book.sh || echo "warning: could not fetch the opening book"
[ -s data/site/sounds/move-self.mp3 ] || bash scripts/fetch_sounds.sh || echo "warning: could not fetch sounds"
exec "$@"
