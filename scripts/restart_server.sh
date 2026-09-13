#!/usr/bin/env bash
# (Re)start the review server detached from the terminal session. Log: data/serve.log
set -euo pipefail
cd "$(dirname "$0")/.."
# setsid makes the server a process-group leader: kill the whole group so the
# worker pool and its Stockfish children die with it (orphans eat ~1.5 GB per pool).
if [ -f data/serve.pid ] && kill -0 "$(cat data/serve.pid)" 2>/dev/null; then
  kill -TERM -- "-$(cat data/serve.pid)" 2>/dev/null || kill "$(cat data/serve.pid)"; sleep 2
fi
pkill -f "chess_review/.venv/bin/python -c from multiprocessing" 2>/dev/null || true   # any stray pool workers
pkill -x stockfish 2>/dev/null || true
# 0.0.0.0 inside WSL (NAT mode) is only reachable via Windows localhost and the WSL Tailscale IP.
setsid nohup .venv/bin/python -m chess_review serve --host 0.0.0.0 "$@" > data/serve.log 2>&1 < /dev/null &
echo $! > data/serve.pid
sleep 2
tail -1 data/serve.log
