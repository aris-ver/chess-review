# Running on a VM with Docker

```bash
git clone git@github.com:aris-ver/chess-review.git && cd chess-review
docker compose build
```

## Bring your data

Everything the app knows lives in `data/` (archives, parquet tables, the DuckDB eval cache,
sounds). Copy it from the laptop so nothing has to be re-analysed:

```bash
rsync -av --exclude serve.log --exclude serve.pid ~/projects/chess-review/data/ user@vm:chess-review/data/
```

Or start empty and ingest inside the container:

```bash
docker compose run --rm chess-review python -m chess_review ingest --username <me>
docker compose run --rm chess-review python -m chess_review normalise
docker compose run --rm chess-review python -m chess_review review
```

## Run

```bash
docker compose up -d
docker compose logs -f
```

The port is published on localhost only. Put Tailscale on the VM and expose it on your tailnet
with HTTPS (no public exposure, no auth needed beyond your Tailscale login):

```bash
sudo tailscale up
sudo tailscale serve --bg 8123        # -> https://<vm>.<tailnet>.ts.net/
```

## Sizing

Analysis uses all cores it is given (`cpus:` and `--workers` in `docker-compose.yml`). Stockfish
does ~400 knps per core on a modern x86 core, so at 1M nodes/position a 4-vCPU VM analyses a
rapid game in ~2-3 minutes. Use `--nodes 500000` in the `command:` for twice the speed. Memory:
~256 MB per worker plus ~150 MB each for the network; 3 GB is comfortable for 4 workers.

`SF_BUILD=x86-64-bmi2` is a little faster on Intel and AMD Zen3+; keep `avx2` on Zen1/Zen2 or unknown CPUs.

## Updating

```bash
git pull && docker compose build && docker compose up -d
```
