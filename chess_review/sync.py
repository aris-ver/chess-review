"""Puzzle progress kept in step with a Blundr account (docs/accounts.md), for the website (in Pyodide) and the desktop
app alike: static/account.js runs the loop through /api/sync/* in both. "This browser" below is the desktop app's DATA
folder there. Only these files ever leave the browser:

    DATA/puzzle_attempts.jsonl, puzzle_attempts.reset-*.jsonl     library puzzles: first tries, rating (puzzles.py)
    DATA/puzzle_solved.jsonl, puzzle_daily.jsonl                  pack progress and the daily puzzle (packs.py)
    DATA/profiles/<id>/puzzle_attempts[.reset-*].jsonl            each profile's review schedule (own_puzzles.py)
    profiles.jsonl (no such file: made from profiles/*/meta.json)  the list of chess.com and Lichess profiles added,
                     one line each: {"source", "username", "added", "pinned"}. Not their games: another browser that
                     gets a profile from the account fetches its games afresh. Pasted-PGN games can't be fetched again,
                     so that profile stays out of it.

The account holds the same thing as a set of lines per file. A sync is a three-way merge against the copy this
browser last got from the account (DATA/account_sync.json, the base):

    1. delta()       lines added here since the base, and lines gone from here (a reset moves a file's lines into a
                     .reset- archive, so they leave one file and join another); the page sends them to the account
    2. the account   applies them and answers with everything it holds
    3. commit()      what the account holds, plus whatever this browser added or removed meanwhile, becomes the files
                     here, and the account's answer becomes the new base

Whose data is in DATA right now (the owner: an account, or the guest when there is no base) is switched as a whole
by switch(). The synced things (the puzzle files, the chess.com/Lichess profile folders with their reviews) of the one
leaving are set aside in DATA/.accounts/<owner>/, and those of the one arriving come back from there. So:

    - signing up with progress made as a guest: the page asks, and keep=True hands the guest's data to the new
      account (no base yet, so the first sync uploads all of it); otherwise it's set aside like any other login
    - logging in to an account that already exists: the guest's data is set aside, never added to the account
    - logging out: the account's copy is set aside (its reviews are there next time) and the guest's comes back

Reviewed games, analysis and the eval cache are not in the list and stay in the browser.
"""

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Optional

from chess_review import profiles
from chess_review.config import DATA

log = logging.getLogger("sync")
BASE = "account_sync.json"
PROFILES = "profiles.jsonl"
SYNCED_SOURCES = ("chesscom", "lichess")


def _metas(data: Path) -> dict[str, dict]:
    """profile id -> meta.json, for the profiles that are synced."""
    out = {}
    for meta in sorted(data.glob("profiles/*/meta.json")):
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if m.get("source") in SYNCED_SOURCES and m.get("username"):
            out[meta.parent.name] = m
    return out


def profile_line(m: dict) -> str:
    return json.dumps({"source": m["source"], "username": m["username"], "added": m.get("created"),
                       "pinned": m.get("pinned")}, sort_keys=True)


def _profile_key(line: str) -> Optional[str]:
    v = json.loads(line)
    try:
        return profiles.profile_id(str(v.get("source")), str(v.get("username") or ""))
    except ValueError:
        return None     # not a profile this app can make: left alone


def _busy(pid: str) -> bool:
    """A job is running on it right now (fetching or analysing): not the moment to remove it."""
    from chess_review import serve
    r = getattr(serve.Handler, "runner", None)
    return bool(r and r.busy() and r.job and r.job.profile and r.job.profile.id == pid)


def apply_profiles(data: Path, here: list[str], merged: list[str]) -> list[dict]:
    """Make the profiles here match the account's list: new ones are created (empty: the page then fetches their
    games), a pin set or cleared elsewhere is copied, and one deleted elsewhere is deleted here, its reviews with it.
    Returns the profiles created, as {source, username}."""
    want = {k: json.loads(ln) for ln in merged if (k := _profile_key(ln))}
    have = _metas(data)
    added = []
    for pid, v in want.items():
        meta_path = data / "profiles" / pid / "meta.json"
        m = dict(have[pid]) if pid in have else None
        if m is None:
            m = {"source": v["source"], "username": v["username"], "created": v.get("added")}
            added.append({"source": v["source"], "username": v["username"]})
        if v.get("pinned"):
            m["pinned"] = v["pinned"]
        else:
            m.pop("pinned", None)
        if pid not in have or profile_line(m) != profile_line(have[pid]):
            _write(meta_path, json.dumps(m))
    for pid in have.keys() - want.keys():
        if _busy(pid):
            log.info("not removing %s: busy", pid)     # stays here, and goes back up with the next sync
            continue
        from chess_review import serve
        r = getattr(serve.Handler, "runner", None)
        if r:
            r.cancel_build(pid)
        shutil.rmtree(data / "profiles" / pid, ignore_errors=True)
    return added


def _files(data: Path) -> list[Path]:
    out = sorted(data.glob("puzzle_attempts*.jsonl")) + [data / "puzzle_solved.jsonl", data / "puzzle_daily.jsonl"]
    out += sorted(data.glob("profiles/*/puzzle_attempts*.jsonl"))
    return [p for p in out if p.is_file()]


def _lines(path: Path) -> list[str]:
    """A file's lines that are JSON objects: a line cut short by a crash is skipped, as the readers skip it."""
    out = []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for ln in text.splitlines():
        ln = ln.strip()
        try:
            if ln and isinstance(json.loads(ln), dict):
                out.append(ln)
        except ValueError:
            continue
    return out


def local(data: Path = DATA) -> dict[str, list[str]]:
    """{file relative to DATA: [line, ...]} for every puzzle-progress file there is, and the profile list."""
    out = {p.relative_to(data).as_posix(): _lines(p) for p in _files(data)}
    if metas := _metas(data):
        out[PROFILES] = [profile_line(metas[pid]) for pid in sorted(metas)]
    return out


def load_base(user: str, data: Path = DATA) -> dict[str, list[str]]:
    """The account's files as this browser last saw them; empty when it never synced with this account."""
    try:
        b = json.loads((data / BASE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return b.get("files", {}) if b.get("user") == user else {}


def _save_base(user: str, files: dict[str, list[str]], data: Path) -> None:
    _write(data / BASE, json.dumps({"user": user, "files": files}))


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def diff(base: dict[str, list[str]], here: dict[str, list[str]]) -> tuple[dict, dict]:
    """(added, removed): per file, the lines in `here` but not in `base`, and the other way round."""
    add, remove = {}, {}
    for f in sorted(base.keys() | here.keys()):
        b, h = set(base.get(f, ())), set(here.get(f, ()))
        if a := [ln for ln in here.get(f, ()) if ln not in b]:
            add[f] = list(dict.fromkeys(a))
        if r := [ln for ln in base.get(f, ()) if ln not in h]:
            remove[f] = list(dict.fromkeys(r))
    return add, remove


def _when(line: str):
    v = json.loads(line)
    return v.get("ts") if isinstance(v.get("ts"), (int, float)) else str(v.get("date", ""))


def _once_per(key: str, lines: list[str]) -> list[str]:
    seen, out = set(), []
    for ln in lines:
        k = json.loads(ln).get(key)
        if k is None or k not in seen:
            seen.add(k)
            out.append(ln)
    return out


def tidy(file: str, lines: list[str]) -> list[str]:
    """A merged file in the order and with the uniqueness its reader expects: oldest first (the puzzle rating is
    replayed in that order), and for library puzzles one first try per puzzle and one daily result per day, as
    puzzles.record and packs.record_daily keep it when there is a single browser. The profile list: one line per
    profile, by id, and if two browsers changed its pin at once, pinned wins."""
    if file == PROFILES:
        best: dict[str, str] = {}
        for ln in dict.fromkeys(lines):
            k = _profile_key(ln) or ln
            if k not in best or (json.loads(ln).get("pinned") or "") > (json.loads(best[k]).get("pinned") or ""):
                best[k] = ln
        return [best[k] for k in sorted(best)]
    out = sorted(dict.fromkeys(lines), key=_when)
    name = file.rsplit("/", 1)[-1]
    if "/" not in file and name.startswith("puzzle_attempts"):
        out = _once_per("id", out)
    elif name == "puzzle_solved.jsonl":
        out = _once_per("id", out)
    elif name == "puzzle_daily.jsonl":
        out = _once_per("date", out)
    return out


def merge(base: dict, here: dict, theirs: dict) -> dict[str, list[str]]:
    """The account's files with this browser's own changes since the base put back on top."""
    add, remove = diff(base, here)
    out = {}
    for f in sorted(theirs.keys() | add.keys()):
        gone = set(remove.get(f, ()))
        lines = [ln for ln in list(theirs.get(f, ())) + add.get(f, []) if ln not in gone]
        if lines:
            out[f] = tidy(f, lines)
    return out


def delta(user: str, data: Path = DATA) -> dict:
    add, remove = diff(load_base(user, data), local(data))
    return {"add": add, "remove": remove}


def commit(user: str, theirs: dict[str, list[str]], data: Path = DATA) -> dict:
    """Write the merged files here and remember the account's answer as the base. Returns what changed here."""
    here = local(data)
    merged = merge(load_base(user, data), here, theirs)
    changed, added = [], []
    for f in sorted(here.keys() | merged.keys()):
        if here.get(f) == merged.get(f) or f == PROFILES:
            continue
        changed.append(f)
        path = data / f
        if f in merged:
            _write(path, "".join(ln + "\n" for ln in merged[f]))
        else:
            path.unlink(missing_ok=True)       # its lines all moved elsewhere: a reset on another browser
    if here.get(PROFILES) != merged.get(PROFILES):     # after the files: a profile removed takes its schedule along
        changed.append(PROFILES)
        added = apply_profiles(data, here.get(PROFILES, []), merged.get(PROFILES, []))
    _save_base(user, theirs, data)
    return {"changed": changed, "pending": any(diff(theirs, local(data))), "profiles_added": added}


# ---------- whose data is in DATA ----------

WORKSPACES = ".accounts"
GUEST = "guest"


def owner(data: Path = DATA) -> Optional[str]:
    """The account whose data is in DATA, or None for the guest."""
    try:
        return json.loads((data / BASE).read_text(encoding="utf-8")).get("user") or None
    except (OSError, ValueError):
        return None


def _items(data: Path) -> list[Path]:
    """What belongs to the owner, relative to DATA: the puzzle files, the synced profiles' folders (reviews and all),
    and the base."""
    dirs = {Path("profiles") / pid for pid in _metas(data)}
    items = set(dirs)
    for p in _files(data):
        rel = p.relative_to(data)
        if not (len(rel.parts) > 2 and Path(*rel.parts[:2]) in dirs):
            items.add(rel)
    if (data / BASE).exists():
        items.add(Path(BASE))
    return sorted(items)


def _move(src: Path, dst: Path, merge: bool = False) -> None:
    """src into dst; a folder already at dst gets src's contents, and what's already there stays. With `merge`, two
    puzzle files of the same name become one with the lines of both."""
    if dst.is_dir() and src.is_dir():
        for child in src.iterdir():
            _move(child, dst / child.name, merge)
        shutil.rmtree(src, ignore_errors=True)
    elif dst.exists():
        if merge and src.is_file() and src.suffix == ".jsonl":
            name = f"profiles/{dst.parent.name}/{dst.name}" if dst.parent.parent.name == "profiles" else dst.name
            _write(dst, "".join(ln + "\n" for ln in tidy(name, _lines(dst) + _lines(src))))
        shutil.rmtree(src, ignore_errors=True) if src.is_dir() else src.unlink()
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dst)


def _workspace(data: Path, who: Optional[str]) -> Path:
    name = who or GUEST
    if not all(c.isalnum() or c in "-_" for c in name):
        raise ValueError(f"bad account id {name!r}")
    return data / WORKSPACES / name


def _busy_any(data: Path) -> bool:
    return any(_busy(pid) for pid in _metas(data))


def guest_data(data: Path = DATA) -> dict:
    """What a guest has here that a new account could take: puzzle records and profiles."""
    here = local(data)
    return {"puzzle_records": sum(len(v) for f, v in here.items() if f != PROFILES), "profiles": len(here.get(PROFILES, []))}


def _invalidate() -> None:
    from chess_review import own_puzzles
    own_puzzles.POOL.__init__()        # its cache is per profile id, and the profiles just changed hands


def switch(user: Optional[str], keep: bool = False, wipe: bool = False, data: Path = DATA) -> dict:
    """Make DATA hold `user`'s data (None: the guest's). The current owner's is set aside in DATA/.accounts/, or with
    `wipe` deleted (a shared computer); `keep` hands the guest's data to `user` instead (a new account that asked for it).
    {"busy": True} while a job is running on one of the profiles that would move: ask again in a moment."""
    cur = owner(data)
    if cur == user:
        return {"switched": False}
    if _busy_any(data):
        return {"busy": True}
    if cur is None and user and keep:
        return {"switched": False, "kept": True}        # no base for `user`: the first sync uploads it all
    away = _workspace(data, cur)
    for rel in _items(data):
        if wipe:
            p = data / rel
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        else:
            _move(data / rel, away / rel)
    back = _workspace(data, user)
    if back.exists():
        for child in sorted(back.iterdir()):
            _move(child, data / child.name)
        shutil.rmtree(back, ignore_errors=True)
    _invalidate()
    return {"switched": True}


def release(wipe: bool = False, data: Path = DATA) -> dict:
    """The account was deleted: its copy here becomes the guest's (or with `wipe` goes), and what the guest had set
    aside comes back alongside it."""
    if _busy_any(data):
        return {"busy": True}
    cur = owner(data)
    (data / BASE).unlink(missing_ok=True)
    if wipe:
        for rel in _items(data):
            p = data / rel
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
    back = _workspace(data, None)
    if back.exists():
        for child in sorted(back.iterdir()):
            _move(child, data / child.name, merge=True)
        shutil.rmtree(back, ignore_errors=True)
    if cur:
        shutil.rmtree(_workspace(data, cur), ignore_errors=True)
    _invalidate()
    return {"released": True}


def handle(path: str, body: dict) -> Optional[dict]:
    """serve.py's /api/sync/* routes, for static/account.js."""
    user = str(body.get("user") or "") or None
    if path == "/api/sync/state":
        return {"owner": owner(), "guest_data": guest_data() if owner() is None else None}
    if path == "/api/sync/delta" and user:
        return delta(user)
    if path == "/api/sync/commit" and user and isinstance(body.get("files"), dict):
        return commit(user, {str(k): [str(x) for x in v] for k, v in body["files"].items() if isinstance(v, list)})
    if path == "/api/sync/switch":
        return switch(user, keep=bool(body.get("keep")), wipe=bool(body.get("wipe")))
    if path == "/api/sync/release":
        return release(bool(body.get("wipe")))
    return None
