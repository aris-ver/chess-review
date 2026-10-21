"""Puzzle progress kept in step with a Blundr account (docs/accounts.md). Only these files ever leave the browser:

    DATA/puzzle_attempts.jsonl, puzzle_attempts.reset-*.jsonl     library puzzles: first tries, rating (puzzles.py)
    DATA/puzzle_solved.jsonl, puzzle_daily.jsonl                  pack progress and the daily puzzle (packs.py)
    DATA/profiles/<id>/puzzle_attempts[.reset-*].jsonl            each profile's review schedule (own_puzzles.py)

The account holds the same thing as a set of lines per file. A sync is a three-way merge against the copy this
browser last got from the account (DATA/account_sync.json, the base):

    1. delta()       lines added here since the base, and lines gone from here (a reset moves a file's lines into a
                     .reset- archive, so they leave one file and join another); the page sends them to the account
    2. the account   applies them and answers with everything it holds
    3. commit()      what the account holds, plus whatever this browser added or removed meanwhile, becomes the files
                     here, and the account's answer becomes the new base

A guest has no base, so signing up (or signing in on a browser used as a guest) uploads all of it and nothing is lost.
Reviewed games, profiles and the eval cache are not in the list and stay in the browser.
"""

import json
import os
from pathlib import Path
from typing import Optional

from chess_review.config import DATA

BASE = "account_sync.json"


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
    """{file relative to DATA: [line, ...]} for every puzzle-progress file there is."""
    return {p.relative_to(data).as_posix(): _lines(p) for p in _files(data)}


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
    puzzles.record and packs.record_daily keep it when there is a single browser."""
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
    changed = []
    for f in sorted(here.keys() | merged.keys()):
        if here.get(f) == merged.get(f):
            continue
        changed.append(f)
        path = data / f
        if f in merged:
            _write(path, "".join(ln + "\n" for ln in merged[f]))
        else:
            path.unlink(missing_ok=True)       # its lines all moved elsewhere: a reset on another browser
    _save_base(user, theirs, data)
    return {"changed": changed, "pending": any(diff(theirs, merged))}


def forget(wipe: bool = False, data: Path = DATA) -> dict:
    """Signed out: this browser stops syncing. With `wipe`, its puzzle progress goes too (a shared computer)."""
    (data / BASE).unlink(missing_ok=True)
    removed = []
    if wipe:
        for p in _files(data):
            p.unlink()
            removed.append(p.relative_to(data).as_posix())
    return {"removed": removed}


def handle(path: str, body: dict) -> Optional[dict]:
    """The bridge's /api/sync/* routes, for web/account.js."""
    user = str(body.get("user") or "")
    if path == "/api/sync/delta" and user:
        return delta(user)
    if path == "/api/sync/commit" and user and isinstance(body.get("files"), dict):
        return commit(user, {str(k): [str(x) for x in v] for k, v in body["files"].items() if isinstance(v, list)})
    if path == "/api/sync/forget":
        return forget(bool(body.get("wipe")))
    return None
