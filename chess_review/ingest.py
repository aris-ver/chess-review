"""Stage 1: pull every monthly archive from the chess.com public API to data/raw.

Serialised requests with a delay; 429s are backed off. Archives already on disk
are skipped, so re-running is a no-op. Pasted PGNs (--pgn-file / stdin) bypass
the API and are stored under data/pgn keyed by content hash.

Lichess profiles stream the game export API instead (one request, NDJSON) into
raw/YYYY-MM.ndjson by the month each game started; a refresh asks only for games
started since the newest one on disk.

The app fetches a profile a page at a time, newest first (fetch_steps): a new
profile gets its latest PAGE games or so (whole chess.com months, since that is
what the API hands out), and each "older" fetch the page before the oldest on
disk. The CLI still fetches everything.

The fetches are generators of the requests they want made (Get): run()
makes them here, the browser without blocking the page's own requests.
"""

import argparse
import hashlib
import itertools
import json
import logging
import re
import sys
import time
from dataclasses import dataclass, field
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
PAGE = 20           # games a page of the app's fetch brings in (at least, on chess.com: whole months)
# after a 429 without a Retry-After (chess.com's isn't readable cross-origin, so always in the browser)
BACKOFF = (2, 5, 15, 30, 60)


class NoSuchPlayer(ValueError):
    """The site has no player by that name (a typo, a closed account)."""


@dataclass
class Get:
    """A request a fetch wants made. The fetches below are generators of these steps (Get, Read, Sleep) and leave
    making them to a driver: run() here with requests, and in the browser one that awaits each step
    (web/py/chess_web/runner.py), so the page's own requests are answered while games come in."""
    url: str
    params: dict = field(default_factory=dict)
    headers: dict = field(default_factory=dict)
    stream: bool = False        # the body is read with Read steps instead of all at once
    timeout: float = 60


@dataclass
class Read:
    """The next lines of a streamed reply: a list (maybe empty), None once it has ended."""
    response: object


@dataclass
class Sleep:
    seconds: float
    note: str = ""      # why, for the user while it lasts (a site asking to slow down): on_wait(note), then None


def run(steps, on_wait=None):
    """A fetch's return value, its requests made with requests."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    lines, out = {}, None
    try:
        while True:
            step = steps.send(out)
            if isinstance(step, Sleep):
                if step.note and on_wait:
                    on_wait(step.note)
                time.sleep(step.seconds)
                if step.note and on_wait:
                    on_wait(None)
                out = None
            elif isinstance(step, Read):
                out = list(itertools.islice(lines[id(step.response)], 200)) or None
            else:
                out = session.get(step.url, params=step.params or None, headers=step.headers or None,
                                  stream=step.stream, timeout=step.timeout)
                if step.stream:
                    lines[id(out)] = out.iter_lines()
    except StopIteration as e:
        return e.value
    finally:
        steps.close()


def _get(url: str, max_retries: int = 6, missing: str | None = None):
    for attempt in range(max_retries):
        r = yield Get(url)
        if r.status_code == 404 and missing:
            raise NoSuchPlayer(missing)
        if r.status_code == 429:
            if attempt == max_retries - 1:
                break
            wait = int(r.headers.get("Retry-After", 0)) or BACKOFF[min(attempt, len(BACKOFF) - 1)]
            log.warning("429 on %s, sleeping %ss", url, wait)
            yield Sleep(wait, f"chess.com asked to slow down: trying again in {wait} s")
            continue
        r.raise_for_status()
        return r
    raise RuntimeError("chess.com kept asking to slow down: try again in a few minutes")


def _archive_list(profile: Profile):
    # a 404 here is the player; one for a month is chess.com's own trouble (it has had whole days of those)
    return (yield from _get(API.format(username=profile.username), missing=f"chess.com has no user called {profile.username}"))


def _month(url: str) -> str:
    year, month = url.rstrip("/").split("/")[-2:]
    return f"{year}-{month}"


def _months_on_disk(profile: Profile) -> list[str]:
    return sorted(f.stem for f in profile.raw_dir.glob("*.json")) if profile.raw_dir.exists() else []


def _archives(profile: Profile, force: bool = False, only: str | None = None, delay: float = 1.0,
              refresh_latest: bool = False, since: str | None = None, on_progress=None):
    """Every month not on disk (since: only from that month on, a refresh of a profile fetched a page at a time)."""
    profile.raw_dir.mkdir(parents=True, exist_ok=True)
    archive_urls = (yield from _archive_list(profile)).json()["archives"]
    log.info("%d archives listed for %s", len(archive_urls), profile.username)
    if since:
        archive_urls = [u for u in archive_urls if _month(u) >= since]

    stats = {"listed": len(archive_urls), "fetched": 0, "skipped": 0}
    for i, url in enumerate(archive_urls):
        if on_progress:
            on_progress(i, len(archive_urls))
        key = _month(url)
        out = profile.raw_dir / f"{key}.json"
        if only and key != only:
            stats["skipped"] += 1
            continue
        is_latest = url == archive_urls[-1] or key == since    # (the newest month on disk may have been partial)
        if out.exists() and not force and not (refresh_latest and is_latest):
            stats["skipped"] += 1
            continue
        if delay:
            yield Sleep(delay)      # between requests only: a refresh asks for one month and passes delay=0
        body = (yield from _get(url)).text
        n = len(json.loads(body).get("games", []))
        out.write_text(body, encoding="utf-8")
        stats["fetched"] += 1
        log.info("%s: %d games", key, n)
    return stats


def _archive_page(profile: Profile, older: bool = False, delay: float = 1.0, on_progress=None):
    """A page of chess.com months, newest first, until they hold PAGE games: the latest months for a new profile
    (months already on disk count without being fetched again: a first fetch cut short picks up where it stopped),
    with `older` the months before the oldest on disk. Sets the profile's "older" flag."""
    profile.raw_dir.mkdir(parents=True, exist_ok=True)
    archive_urls = (yield from _archive_list(profile)).json()["archives"]
    have = _months_on_disk(profile)
    todo = [u for u in reversed(archive_urls) if not (older and have) or _month(u) < have[0]]
    stats = {"listed": len(archive_urls), "fetched": 0, "skipped": 0, "games": 0}
    for url in todo:
        if stats["games"] >= PAGE:
            break
        if on_progress:
            on_progress(stats["games"], PAGE)
        out = profile.raw_dir / f"{_month(url)}.json"
        if out.exists():
            body = out.read_text(encoding="utf-8")
            stats["skipped"] += 1
        else:
            if delay and stats["fetched"]:
                yield Sleep(delay)      # between months only: a page is often one request
            body = (yield from _get(url)).text
            out.write_text(body, encoding="utf-8")
            stats["fetched"] += 1
        stats["games"] += len(json.loads(body).get("games", []))
    have = _months_on_disk(profile)
    stats["older"] = bool(have) and any(_month(u) < have[0] for u in archive_urls)
    profiles.set_older(profile.id, stats["older"])
    log.info("chess.com %s, a page%s: %s", profile.username, " back" if older else "", stats)
    return stats


def fetch_archives(profile: Profile, **kw) -> dict:
    return run(_archives(profile, **kw))


def _count_archives(profile: Profile, delay: float = 1.0, max_months: int = 3):
    archive_urls = (yield from _archive_list(profile)).json()["archives"]
    new = 0
    for i, url in enumerate(reversed(archive_urls[-max_months:])):
        year, month = url.rstrip("/").split("/")[-2:]
        local = profile.raw_dir / f"{year}-{month}.json"
        if local.exists() and i > 0:
            break               # everything older than the latest month is fetched once and never changes
        yield Sleep(delay)
        remote = (yield from _get(url)).json().get("games", [])
        have = set()
        if local.exists():
            try:
                have = {g.get("url") for g in json.loads(local.read_text(encoding="utf-8")).get("games", [])}
            except ValueError:
                pass
        new += sum(1 for g in remote if g.get("url") not in have)
    return new


def count_new_games(profile: Profile, **kw) -> int:
    """How many games chess.com has for this profile that aren't in its raw archives yet: the latest month's
    games minus those already in the same month's file on disk, plus whole months newer than anything on disk.
    Read-only: nothing is written, a refresh does that. Looks at most max_months back."""
    return run(_count_archives(profile, **kw))


NDJSON = {"Accept": "application/x-ndjson"}


def _lichess_stream(username: str, params: dict, on_game, max_retries: int = 4):
    """on_game(each game of the export, as a dict). Lichess asks for a full minute's pause after a 429."""
    for attempt in range(max_retries):
        r = yield Get(LICHESS_GAMES.format(username=username), params={"perfType": LICHESS_PERFS, **params},
                      headers=NDJSON, stream=True)
        if r.status_code == 429:
            r.close()
            if attempt == max_retries - 1:
                break
            log.warning("429 from lichess, sleeping 60s")
            yield Sleep(60, "lichess asked to slow down: trying again in a minute")
            continue
        try:
            r.raise_for_status()
            while (lines := (yield Read(r))) is not None:
                for line in lines:
                    if line:
                        on_game(json.loads(line))
            return
        finally:
            r.close()
    raise RuntimeError("lichess kept asking to slow down: try again in a few minutes")


def _lichess_on_disk(profile: Profile) -> tuple[int, int, int]:
    """(newest createdAt, oldest createdAt, number of games) over the profile's raw/*.ndjson; 0s when there's none."""
    newest, oldest, n = 0, 0, 0
    for f in profile.raw_dir.glob("*.ndjson") if profile.raw_dir.exists() else []:
        for line in f.read_text(encoding="utf-8").splitlines():
            if line.strip():
                t = json.loads(line).get("createdAt", 0)
                newest, oldest, n = max(newest, t), min(oldest, t) if n else t, n + 1
    return newest, oldest, n


def _lichess(profile: Profile, on_progress=None, page: str | None = None):
    """Without `page`: every game, or those since the newest on disk. page="new": the newest PAGE games;
    page="older": the PAGE before the oldest on disk. A page sets the profile's "older" flag."""
    profile.raw_dir.mkdir(parents=True, exist_ok=True)
    r = yield Get(LICHESS_USER.format(username=profile.username), headers={"Accept": "application/json"}, timeout=30)
    if r.status_code == 404:
        raise NoSuchPlayer(f"no lichess player called {profile.username}")
    r.raise_for_status()
    user = r.json()
    if user.get("disabled"):
        raise NoSuchPlayer(f"lichess account {profile.username} is closed")
    newest, oldest, had = _lichess_on_disk(profile)
    params = {"clocks": "true", "opening": "true", "pgnInJson": "true", "sort": "dateAsc"}
    if page:
        total = PAGE
        params.update(sort="dateDesc", max=PAGE)
        if page == "older" and oldest:
            params["until"] = oldest - 1
    else:
        # the total is every game, variants included, so a rough bar: it stops short and jumps at the end
        total = max(user.get("count", {}).get("all", 0) - had, 1)
        if newest:
            params["since"] = newest

    seen: dict[str, set] = {}       # month -> ids already in that file
    stats = {"fetched": 0, "skipped": 0}

    def take(g: dict) -> None:
        i = stats["fetched"] + stats["skipped"]
        if on_progress and (page or i % 20 == 0):
            on_progress(min(i, total), total)
        month = datetime.fromtimestamp(g["createdAt"] / 1000, tz=timezone.utc).strftime("%Y-%m")
        out = profile.raw_dir / f"{month}.ndjson"
        if month not in seen:
            seen[month] = {json.loads(l)["id"] for l in out.read_text(encoding="utf-8").splitlines() if l.strip()} \
                if out.exists() else set()
        if g["id"] in seen[month]:
            stats["skipped"] += 1
            return
        with out.open("a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(g, separators=(",", ":")) + "\n")
        seen[month].add(g["id"])
        stats["fetched"] += 1

    yield from _lichess_stream(profile.username, params, take)
    if page:        # a full page: there may be more before it (a page that ends exactly at the first game says so too)
        stats["older"] = stats["fetched"] + stats["skipped"] >= PAGE
        profiles.set_older(profile.id, stats["older"])
    log.info("lichess %s%s: %s", profile.username, f", a page ({page})" if page else "", stats)
    return stats


def fetch_lichess(profile: Profile, on_progress=None) -> dict:
    """Every standard game the player has on lichess, with clocks and the opening, appended to
    raw/YYYY-MM.ndjson. Only games started at or after the newest one on disk are asked for, and ids already
    there are skipped. (A correspondence game still running at the last fetch, older than the newest game on
    disk by the time it ends, is missed until a fresh profile.)"""
    return run(_lichess(profile, on_progress=on_progress))


def _count_lichess(profile: Profile):
    newest, _, _ = _lichess_on_disk(profile)
    ids_on_disk = set()
    for f in profile.raw_dir.glob("*.ndjson"):
        ids_on_disk |= {json.loads(l)["id"] for l in f.read_text(encoding="utf-8").splitlines() if l.strip()}
    params = {"moves": "false", "tags": "false", "since": newest} if newest else {"moves": "false", "tags": "false"}
    new = []
    yield from _lichess_stream(profile.username, params, lambda g: new.append(g["id"] not in ids_on_disk))
    return sum(new)


def count_new_lichess(profile: Profile) -> int:
    """How many games lichess has for this profile that aren't on disk yet. Read-only, ids only."""
    return run(_count_lichess(profile))


def fetch_steps(profile: Profile, refresh: bool = False, on_progress=None, older: bool = False):
    """fetch() as steps, for a driver other than run()."""
    if profile.source == "chesscom":
        have = _months_on_disk(profile)
        if refresh and have:
            # the latest month again and any newer. chess.com only rate-limits parallel requests: no pause
            return (yield from _archives(profile, refresh_latest=True, since=have[-1], delay=0))
        return (yield from _archive_page(profile, older=older, on_progress=on_progress))
    if profile.source == "lichess":
        if refresh and _lichess_on_disk(profile)[2]:
            return (yield from _lichess(profile))
        return (yield from _lichess(profile, on_progress=on_progress, page="older" if older else "new"))
    raise ValueError(f"{profile.source} profiles can't be fetched")


def fetch(profile: Profile, refresh: bool = False, on_progress=None, older: bool = False, on_wait=None) -> dict:
    """The profile's games from wherever it lives, a page at a time: the newest page for a new profile, the page
    before the oldest on disk with `older`, what's new since the newest on a refresh."""
    return run(fetch_steps(profile, refresh, on_progress, older), on_wait)


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
