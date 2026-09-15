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

from . import profiles
from .config import USER_AGENT
from .profiles import Profile

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


def fetch_archives(profile: Profile, force: bool = False, only: str | None = None, delay: float = 1.0,
                   refresh_latest: bool = False, on_progress=None) -> dict:
    profile.raw_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    archive_urls = _get(session, API.format(username=profile.username)).json()["archives"]
    log.info("%d archives listed for %s", len(archive_urls), profile.username)
    time.sleep(delay)

    stats = {"listed": len(archive_urls), "fetched": 0, "skipped": 0}
    for i, url in enumerate(archive_urls):
        if on_progress:
            on_progress(i, len(archive_urls))
        year, month = url.rstrip("/").split("/")[-2:]
        key = f"{year}-{month}"
        out = profile.raw_dir / f"{key}.json"
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


def store_pgn(profile: Profile, text: str) -> str:
    profile.pgn_dir.mkdir(parents=True, exist_ok=True)
    normalised = text.replace("\r\n", "\n").strip() + "\n"
    digest = hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:16]
    out = profile.pgn_dir / f"{digest}.pgn"
    if not out.exists():
        out.write_text(normalised, encoding="utf-8")
    return digest


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="ingest", description=__doc__)
    p.add_argument("--username", help="chess.com username to pull archives for (creates the profile if needed)")
    p.add_argument("--profile", help="profile id (default: the only profile)")
    p.add_argument("--force", action="store_true", help="re-fetch archives already on disk")
    p.add_argument("--only", metavar="YYYY-MM", help="fetch just this month (combine with --force to refresh a partial month)")
    p.add_argument("--refresh-latest", action="store_true", help="re-fetch the most recent (partial) month even if on disk")
    p.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    p.add_argument("--pgn-file", help="store a PGN file instead of hitting the API ('-' for stdin)")
    args = p.parse_args(argv)

    profiles.migrate_legacy()
    profile = profiles.create("chesscom", args.username) if args.username else profiles.resolve(args.profile)
    if args.pgn_file:
        text = sys.stdin.read() if args.pgn_file == "-" else Path(args.pgn_file).read_text(encoding="utf-8")
        digest = store_pgn(profile, text)
        log.info("stored pasted PGN as %s.pgn in %s", digest, profile.id)
        return
    if profile.source != "chesscom":
        p.error(f"{profile.id} is not a chess.com profile")
    stats = fetch_archives(profile, force=args.force, only=args.only, delay=args.delay, refresh_latest=args.refresh_latest)
    log.info("done: %s", stats)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
