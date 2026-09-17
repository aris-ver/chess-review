#!/usr/bin/env bash
# (Re)start the review server detached from the terminal session. Log: data/serve.log
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=8123
prev=""
for a in "$@"; do [ "$prev" = "--port" ] && PORT="$a"; prev="$a"; done

# Stop whatever currently serves the port (and its process group: pool workers + Stockfish children),
# plus anything recorded in the pid file. Orphaned engines eat ~1.5 GB per pool.
for pid in $(ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$" {print $NF}' | grep -oE 'pid=[0-9]+' | cut -d= -f2) \
           $(cat data/serve.pid 2>/dev/null || true); do
  kill -0 "$pid" 2>/dev/null || continue
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
done
sleep 2
pkill -f "chess_review serve" 2>/dev/null || true
pkill -x stockfish 2>/dev/null || true
sleep 1

# setsid forks when the caller leads a process group, so record the pid from inside the new session.
setsid nohup bash -c 'echo $$ > data/serve.pid; exec .venv/bin/python -m chess_review serve "$@"' _ "$@" \
  > data/serve.log 2>&1 < /dev/null &
sleep 2
tail -1 data/serve.log
