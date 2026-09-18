"""Profiles: one per (source, username). Everything that belongs to one player lives in
data/profiles/<id>/; the Stockfish cache (evals.duckdb), the opening book and the static
app (data/site: index.html, assets, sounds) are shared, so two players in the same openings
reuse each other's engine work.

    data/profiles/<id>/
        meta.json               {"source": "chesscom", "username": "...", "created": iso}
        raw/                    chess.com monthly archives (chesscom profiles)
        pgn/                    pasted PGNs keyed by content hash
        games.parquet, positions.parquet, moves.parquet
        site/games.json, site/games/<slug>.json, site/insights.html   (served at /p/<id>/...)

The id is derived from source + username, so the directory listing is the registry.
"""

import json
import logging
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from .config import DATA, SITE_DIR

log = logging.getLogger("profiles")
PROFILES_DIR = DATA / "profiles"
SOURCES = ("chesscom", "lichess", "pgn")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,80}$")


def _parse_ts(played_at: Optional[str]) -> Optional[datetime]:
    if not played_at:
        return None
    try:
        dt = datetime.fromisoformat(played_at.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


@dataclass(frozen=True)
class Profile:
    id: str
    source: str
    username: str

    @property
    def dir(self) -> Path:
        return PROFILES_DIR / self.id

    @property
    def raw_dir(self) -> Path:
        return self.dir / "raw"

    @property
    def pgn_dir(self) -> Path:
        return self.dir / "pgn"

    @property
    def games_parquet(self) -> Path:
        return self.dir / "games.parquet"

    @property
    def positions_parquet(self) -> Path:
        return self.dir / "positions.parquet"

    @property
    def moves_parquet(self) -> Path:
        return self.dir / "moves.parquet"

    @property
    def meta_json(self) -> Path:
        return self.dir / "meta.json"

    @property
    def site_dir(self) -> Path:
        return self.dir / "site"

    @property
    def export_dir(self) -> Path:
        return self.dir / "export"

    def game_ids(self) -> set[str]:
        idx = self.site_dir / "games.json"
        try:
            return {g["id"] for g in json.loads(idx.read_text(encoding="utf-8"))["games"]}
        except (OSError, ValueError, KeyError):
            return set()

    def summary(self) -> dict:
        """What the home screen shows: id, source, username, game counts, and per time class (bullet, blitz,
        rapid, daily) the current rating with its net change over the last 7 days. `rating`/`rating_delta_7d`
        are the most recently played class's."""
        games, analysed = 0, 0
        rating, rating_delta_7d = None, None
        ratings: dict[str, dict] = {}
        idx = self.site_dir / "games.json"
        if idx.exists():
            try:
                entries = json.loads(idx.read_text(encoding="utf-8"))["games"]
                rated: dict[str, list] = {}
                for g in entries:
                    games += 1
                    analysed += g.get("analysed", 0) >= 0.999
                    ts = _parse_ts(g.get("played_at"))
                    if ts is not None and g.get("my_rating") is not None:
                        rated.setdefault(g.get("time_class") or "other", []).append((ts, g["my_rating"]))
                cutoff = datetime.now(timezone.utc) - timedelta(days=7)
                latest = None
                for cls, series in rated.items():
                    series.sort(key=lambda x: x[0])
                    before = [r for t, r in series if t < cutoff]
                    baseline = before[-1] if before else series[0][1]
                    ratings[cls] = {"rating": series[-1][1], "delta_7d": series[-1][1] - baseline, "games": len(series)}
                    if latest is None or series[-1][0] > latest[0]:
                        latest = (series[-1][0], cls)
                if latest:
                    rating, rating_delta_7d = ratings[latest[1]]["rating"], ratings[latest[1]]["delta_7d"]
            except (ValueError, KeyError):
                pass
        meta = json.loads(self.meta_json.read_text(encoding="utf-8")) if self.meta_json.exists() else {}
        return {"id": self.id, "source": self.source, "username": self.username, "games": games,
                "analysed": analysed, "created": meta.get("created"), "pinned": meta.get("pinned"),
                "rating": rating, "rating_delta_7d": rating_delta_7d, "ratings": ratings,
                "unseen": meta.get("unseen", [])}


def profile_id(source: str, username: str) -> str:
    slug = re.sub(r"[^a-z0-9_.-]+", "-", username.strip().lower()).strip("-")
    pid = f"{source}-{slug}"
    if source not in SOURCES or not slug or not _ID_RE.match(pid):
        raise ValueError(f"bad profile: source={source!r} username={username!r}")
    return pid


def valid_id(pid: str) -> bool:
    return bool(_ID_RE.match(pid)) and ".." not in pid


def load(pid: str) -> Optional[Profile]:
    if not valid_id(pid):
        return None
    meta = PROFILES_DIR / pid / "meta.json"
    if not meta.exists():
        return None
    m = json.loads(meta.read_text(encoding="utf-8"))
    return Profile(pid, m["source"], m["username"])


def create(source: str, username: str) -> Profile:
    p = Profile(profile_id(source, username), source, username.strip())
    p.dir.mkdir(parents=True, exist_ok=True)
    if not p.meta_json.exists():
        p.meta_json.write_text(json.dumps({"source": source, "username": p.username,
                                           "created": datetime.now(timezone.utc).isoformat(timespec="seconds")}),
                               encoding="utf-8")
    return p


def _update_meta(pid: str, fn) -> Optional[Profile]:
    p = load(pid)
    if p is None:
        return None
    meta = json.loads(p.meta_json.read_text(encoding="utf-8")) if p.meta_json.exists() else {}
    fn(meta)
    p.meta_json.write_text(json.dumps(meta), encoding="utf-8")
    return p


def add_unseen(pid: str, ids) -> None:
    """Games a refresh just brought in: flagged "new" in the list until each is opened."""
    ids = [i for i in ids]
    if ids:
        _update_meta(pid, lambda meta: meta.__setitem__("unseen", sorted(set(meta.get("unseen", [])) | set(ids))))


def mark_seen(pid: str, game_id: str) -> None:
    def drop(meta):
        if game_id in meta.get("unseen", []):
            meta["unseen"] = [i for i in meta["unseen"] if i != game_id]
    _update_meta(pid, drop)


def set_pinned(pid: str, on: bool) -> Optional[dict]:
    """Pin (stamp the time, so pins keep the order they were made in) or unpin a profile on the home screen."""
    p = load(pid)
    if p is None:
        return None
    meta = json.loads(p.meta_json.read_text(encoding="utf-8"))
    if on:
        meta.setdefault("pinned", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    else:
        meta.pop("pinned", None)
    p.meta_json.write_text(json.dumps(meta), encoding="utf-8")
    return p.summary()


def delete(pid: str) -> bool:
    p = load(pid)
    if p is None:
        return False
    shutil.rmtree(p.dir)
    return True


def list_profiles() -> list[Profile]:
    if not PROFILES_DIR.exists():
        return []
    out = [load(d.name) for d in sorted(PROFILES_DIR.iterdir()) if d.is_dir()]
    return [p for p in out if p is not None]


def resolve(pid: Optional[str]) -> Profile:
    """CLI helper: the named profile, or the only one when there is exactly one."""
    migrate_legacy()
    if pid:
        p = load(pid)
        if p is None:
            raise SystemExit(f"no such profile: {pid} (have: {', '.join(x.id for x in list_profiles()) or 'none'})")
        return p
    ps = list_profiles()
    if len(ps) == 1:
        return ps[0]
    raise SystemExit("--profile required" + (f" (one of: {', '.join(p.id for p in ps)})" if ps else " (none exist yet; create one from the UI or with `ingest --username`)"))


def migrate_legacy() -> Optional[Profile]:
    """Move a pre-profiles data/ layout (one user, tables at the top level) into data/profiles/<id>/.
    Nothing is re-analysed: evals.duckdb stays where it is."""
    meta = DATA / "meta.json"
    if not meta.exists():
        return None
    username = json.loads(meta.read_text(encoding="utf-8")).get("username") or "me"
    p = create("chesscom", username)
    moves = [(DATA / "raw", p.raw_dir), (DATA / "pgn", p.pgn_dir),
             (DATA / "games.parquet", p.games_parquet), (DATA / "positions.parquet", p.positions_parquet),
             (DATA / "moves.parquet", p.moves_parquet),
             (SITE_DIR / "games", p.site_dir / "games"), (SITE_DIR / "games.json", p.site_dir / "games.json"),
             (SITE_DIR / "insights.html", p.site_dir / "insights.html")]
    p.site_dir.mkdir(parents=True, exist_ok=True)
    for src, dst in moves:
        if src.exists() and not dst.exists():
            shutil.move(str(src), str(dst))
    meta.unlink()
    log.info("migrated legacy data for %s into %s", username, p.dir)
    return p
