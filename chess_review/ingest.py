"""Stage 1: pull every monthly archive from the chess.com public API to data/raw.

Serialised requests with a delay; 429s are backed off. Archives already on disk
are skipped, so re-running is a no-op. Pasted PGNs (--pgn-file / stdin) bypass
the API and are stored under data/pgn keyed by content hash.
"""

import argparse
import hashlib
import json
import logging
import sys
import time
from pathlib import Path

import requests

from .config import PGN_DIR, RAW_DIR, USER_AGENT

log = logging.getLogger("ingest")
API = "https://api.chess.com/pub/player/{username}/games/archives"


def _get(session: requests.Session, url: str, max_retries: int = 6) -> requests.Response:
    for attempt in range(max_retries):
        r = session.get(url, timeout=60)
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", 0)) or 30 * (attempt + 1)
            log.warning("429 on %s, sleeping %ss", url, wait)
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r
    raise RuntimeError(f"gave up on {url} after {max_retries} attempts")


def fetch_archives(username: str, force: bool = False, only: str | None = None, delay: float = 1.0,
                   refresh_latest: bool = False) -> dict:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    archive_urls = _get(session, API.format(username=username)).json()["archives"]
    log.info("%d archives listed for %s", len(archive_urls), username)
    time.sleep(delay)

    stats = {"listed": len(archive_urls), "fetched": 0, "skipped": 0}
    for url in archive_urls:
        year, month = url.rstrip("/").split("/")[-2:]
        key = f"{year}-{month}"
        out = RAW_DIR / f"{key}.json"
        if only and key != only:
            stats["skipped"] += 1
            continue
        is_latest = url == archive_urls[-1]
        if out.exists() and not force and not (refresh_latest and is_latest):
            stats["skipped"] += 1
            continue
        body = _get(session, url).text
        n = len(json.loads(body).get("games", []))
        out.write_text(body, encoding="utf-8")
        stats["fetched"] += 1
        log.info("%s: %d games", key, n)
        time.sleep(delay)
    return stats


def store_pgn(text: str) -> str:
    PGN_DIR.mkdir(parents=True, exist_ok=True)
    normalised = text.replace("\r\n", "\n").strip() + "\n"
    digest = hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:16]
    out = PGN_DIR / f"{digest}.pgn"
    if not out.exists():
        out.write_text(normalised, encoding="utf-8")
    return digest


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="ingest", description=__doc__)
    p.add_argument("--username", help="chess.com username to pull archives for")
    p.add_argument("--force", action="store_true", help="re-fetch archives already on disk")
    p.add_argument("--only", metavar="YYYY-MM", help="fetch just this month (combine with --force to refresh a partial month)")
    p.add_argument("--refresh-latest", action="store_true", help="re-fetch the most recent (partial) month even if on disk")
    p.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    p.add_argument("--pgn-file", help="store a PGN file instead of hitting the API ('-' for stdin)")
    args = p.parse_args(argv)

    if args.pgn_file:
        text = sys.stdin.read() if args.pgn_file == "-" else Path(args.pgn_file).read_text(encoding="utf-8")
        digest = store_pgn(text)
        log.info("stored pasted PGN as %s.pgn", digest)
        return
    if not args.username:
        p.error("--username or --pgn-file required")
    stats = fetch_archives(args.username, force=args.force, only=args.only, delay=args.delay, refresh_latest=args.refresh_latest)
    log.info("done: %s", stats)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
