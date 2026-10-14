"""Stage 1: pull every monthly archive from the chess.com public API to data/raw.

Serialised requests with a delay; 429s are backed off. Archives already on disk
are skipped, so re-running is a no-op. Pasted PGNs (--pgn-file / stdin) bypass
the API and are stored under data/pgn keyed by content hash.

Lichess profiles stream the game export API instead (one request, NDJSON) into
raw/YYYY-MM.ndjson by the month each game started; a refresh asks only for games
started since the newest one on disk.
"""

import argparse
import hashlib
import json
import logging
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from . import profiles
from .config import USER_AGENT
from .profiles import Profile

log = logging.getLogger("ingest")
API = "https://api.chess.com/pub/player/{username}/games/archives"
LICHESS_USER = "https://lichess.org/api/user/{username}"
LICHESS_GAMES = "https://lichess.org/api/games/user/{username}"
# Standard chess only: the speeds, not the variants (chess960, atomic, ...), which this app can't review.
LICHESS_PERFS = "ultraBullet,bullet,blitz,rapid,classical,correspondence"


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
        time.sleep(delay)       # between requests only: a refresh asks for one month and passes delay=0
        body = _get(session, url).text
        n = len(json.loads(body).get("games", []))
        out.write_text(body, encoding="utf-8")
        stats["fetched"] += 1
        log.info("%s: %d games", key, n)
    return stats


def count_new_games(profile: Profile, delay: float = 1.0, max_months: int = 3) -> int:
    """How many games chess.com has for this profile that aren't in its raw archives yet: the latest month's
    games minus those already in the same month's file on disk, plus whole months newer than anything on disk.
    Read-only: nothing is written, a refresh does that. Looks at most max_months back."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    archive_urls = _get(session, API.format(username=profile.username)).json()["archives"]
    new = 0
    for i, url in enumerate(reversed(archive_urls[-max_months:])):
        year, month = url.rstrip("/").split("/")[-2:]
        local = profile.raw_dir / f"{year}-{month}.json"
        if local.exists() and i > 0:
            break               # everything older than the latest month is fetched once and never changes
        time.sleep(delay)
        remote = _get(session, url).json().get("games", [])
        have = set()
        if local.exists():
            try:
                have = {g.get("url") for g in json.loads(local.read_text(encoding="utf-8")).get("games", [])}
            except ValueError:
                pass
        new += sum(1 for g in remote if g.get("url") not in have)
    return new


def _lichess_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/x-ndjson"})
    return session


def _lichess_stream(session: requests.Session, username: str, params: dict, max_retries: int = 4):
    """Each game of the export, as a dict. Lichess asks for a full minute's pause after a 429."""
    for attempt in range(max_retries):
        with session.get(LICHESS_GAMES.format(username=username), params={"perfType": LICHESS_PERFS, **params},
                         stream=True, timeout=60) as r:
            if r.status_code == 429:
                log.warning("429 from lichess, sleeping 60s")
                time.sleep(60)
                continue
            r.raise_for_status()
            for line in r.iter_lines():
                if line:
                    yield json.loads(line)
            return
    raise RuntimeError(f"gave up on lichess games for {username} after {max_retries} attempts")


def _lichess_on_disk(profile: Profile) -> tuple[int, int]:
    """(newest createdAt, number of games) over the profile's raw/*.ndjson."""
    newest, n = 0, 0
    for f in profile.raw_dir.glob("*.ndjson") if profile.raw_dir.exists() else []:
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                newest, n = max(newest, json.loads(line).get("createdAt", 0)), n + 1
    return newest, n


def fetch_lichess(profile: Profile, on_progress=None) -> dict:
    """Every standard game the player has on lichess, with clocks and the opening, appended to
    raw/YYYY-MM.ndjson. Only games started at or after the newest one on disk are asked for, and ids already
    there are skipped. (A correspondence game still running at the last fetch, older than the newest game on
    disk by the time it ends, is missed until a fresh profile.)"""
    profile.raw_dir.mkdir(parents=True, exist_ok=True)
    session = _lichess_session()
    r = session.get(LICHESS_USER.format(username=profile.username), headers={"Accept": "application/json"}, timeout=30)
    if r.status_code == 404:
        raise ValueError(f"no lichess player called {profile.username}")
    r.raise_for_status()
    user = r.json()
    if user.get("disabled"):
        raise ValueError(f"lichess account {profile.username} is closed")
    newest, had = _lichess_on_disk(profile)
    # the total is every game, variants included, so a rough bar: it stops short and jumps at the end
    total = max(user.get("count", {}).get("all", 0) - had, 1)
    params = {"clocks": "true", "opening": "true", "pgnInJson": "true", "sort": "dateAsc"}
    if newest:
        params["since"] = newest

    seen: dict[str, set] = {}       # month -> ids already in that file
    stats = {"fetched": 0, "skipped": 0}
    for i, g in enumerate(_lichess_stream(session, profile.username, params)):
        if on_progress and i % 20 == 0:
            on_progress(min(i, total), total)
        month = datetime.fromtimestamp(g["createdAt"] / 1000, tz=timezone.utc).strftime("%Y-%m")
        out = profile.raw_dir / f"{month}.ndjson"
        if month not in seen:
            seen[month] = {json.loads(l)["id"] for l in out.read_text(encoding="utf-8").splitlines() if l.strip()} \
                if out.exists() else set()
        if g["id"] in seen[month]:
            stats["skipped"] += 1
            continue
        with out.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(g, separators=(",", ":")) + "\n")
        seen[month].add(g["id"])
        stats["fetched"] += 1
    log.info("lichess %s: %s", profile.username, stats)
    return stats


def count_new_lichess(profile: Profile) -> int:
    """How many games lichess has for this profile that aren't on disk yet. Read-only, ids only."""
    newest, _ = _lichess_on_disk(profile)
    ids_on_disk = set()
    for f in profile.raw_dir.glob("*.ndjson"):
        ids_on_disk |= {json.loads(l)["id"] for l in f.read_text(encoding="utf-8").splitlines() if l.strip()}
    params = {"moves": "false", "tags": "false", "since": newest} if newest else {"moves": "false", "tags": "false"}
    return sum(1 for g in _lichess_stream(_lichess_session(), profile.username, params) if g["id"] not in ids_on_disk)


def fetch(profile: Profile, refresh: bool = False, on_progress=None) -> dict:
    """The profile's games from wherever it lives: everything for a new profile, what's new on a refresh."""
    if profile.source == "chesscom":
        # chess.com only rate-limits parallel requests; the pause is politeness for a whole history, not a refresh
        return fetch_archives(profile, refresh_latest=refresh, delay=0 if refresh else 1.0, on_progress=on_progress)
    if profile.source == "lichess":
        return fetch_lichess(profile, on_progress=on_progress)
    raise ValueError(f"{profile.source} profiles can't be fetched")


def count_new(profile: Profile) -> int:
    if profile.source == "chesscom":
        return count_new_games(profile)
    if profile.source == "lichess":
        return count_new_lichess(profile)
    return 0


def store_pgn(profile: Profile, text: str, review_as: str | None = None) -> str:
    """Save a PGN under its content hash. `review_as` ("white"/"black") is written into every game's tag
    section as [ReviewAs ...] so normalise knows which side is "me" without a username match."""
    profile.pgn_dir.mkdir(parents=True, exist_ok=True)
    normalised = text.replace("\r\n", "\n").strip() + "\n"
    if review_as in ("white", "black"):
        tag = f'[ReviewAs "{review_as}"]\n'
        normalised = re.sub(r'(?m)^(?=\[Event )', tag, normalised) if re.search(r"(?m)^\[Event ", normalised) else tag + normalised
    digest = hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:16]
    out = profile.pgn_dir / f"{digest}.pgn"
    if not out.exists():
        out.write_text(normalised, encoding="utf-8")
    return digest


def main(argv=None) -> None:
    p = argparse.ArgumentParser(prog="ingest", description=__doc__)
    p.add_argument("--username", help="username to pull games for (creates the profile if needed)")
    p.add_argument("--source", choices=("chesscom", "lichess"), default="chesscom", help="where --username plays")
    p.add_argument("--profile", help="profile id (default: the only profile)")
    p.add_argument("--force", action="store_true", help="re-fetch archives already on disk")
    p.add_argument("--only", metavar="YYYY-MM", help="fetch just this month (combine with --force to refresh a partial month)")
    p.add_argument("--refresh-latest", action="store_true", help="re-fetch the most recent (partial) month even if on disk")
    p.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    p.add_argument("--pgn-file", help="store a PGN file instead of hitting the API ('-' for stdin)")
    args = p.parse_args(argv)

    profiles.migrate_legacy()
    profile = profiles.create(args.source, args.username) if args.username else profiles.resolve(args.profile)
    if args.pgn_file:
        text = sys.stdin.read() if args.pgn_file == "-" else Path(args.pgn_file).read_text(encoding="utf-8")
        digest = store_pgn(profile, text)
        log.info("stored pasted PGN as %s.pgn in %s", digest, profile.id)
        return
    if profile.source == "lichess":
        stats = fetch_lichess(profile)
    elif profile.source == "chesscom":
        stats = fetch_archives(profile, force=args.force, only=args.only, delay=args.delay, refresh_latest=args.refresh_latest)
    else:
        p.error(f"{profile.id} has no site to fetch from")
    log.info("done: %s", stats)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    main()
