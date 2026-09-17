#!/usr/bin/env bash
# Where is WSL's memory going? Our server + engines vs. everything else.
cd "$(dirname "$0")/.."
pid=$(cat data/serve.pid 2>/dev/null)
echo "chess-review server:  $(( $(ps -o rss= -p "$pid" 2>/dev/null || echo 0) / 1024 )) MB (pid $pid)"
sf=0; for p in $(pgrep -x stockfish); do sf=$((sf + $(ps -o rss= -p "$p"))); done
echo "stockfish engines:    $((sf / 1024)) MB ($(pgrep -c stockfish) processes)"
echo "page cache:           $(( $(grep ^Cached: /proc/meminfo | awk '{print $2}') / 1024 )) MB (files read recently; reclaimable)"
echo "--- totals:"
free -m | head -2
