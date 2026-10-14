"""Copy Lichess's free piece sets, boards and sound packs into chess_review/static/themes/, with a manifest
(themes.json) the settings page lists and a CREDITS.md naming each author and licence.

    git clone --depth 1 --filter=blob:none --sparse https://github.com/lichess-org/lila.git
    git -C lila sparse-checkout set --no-cone /COPYING.md /public/piece/ /public/sound/ /public/images/board/
    python scripts/import_lichess_themes.py lila

Licences come from lila's COPYING.md: a file it doesn't list as an exception is lila's own (AGPLv3+). Sets
it lists as non-free are left out, and so are the sound packs it doesn't name ("the other sounds in
public/sound" are non-free -- that includes Lichess's standard pack). ALLOW names the exceptions to that.
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "chess_review" / "static" / "themes"
PIECES = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"]
# the files each pack contributes; the page falls back (castle -> move, mate -> check, ...) where one is missing
SOUND_FILES = ["Move", "Capture", "Castles", "Promote", "Check", "Checkmate", "GenericNotify", "LowTime", "Error",
               "Confirmation", "Victory", "Defeat", "Draw"]
FREE_SOUNDS = ["futuristic", "lisp", "nes", "piano", "sfx"]
OWN_SOUNDS = ROOT / "chess_review" / "sound_packs"   # <pack>/pack.json {name, author, license} + <File>.mp3
SKIP_PIECES = {"mono"}   # one image per piece for both colours, tinted by Lichess's CSS: not a drop-in set
# listed under COPYING.md's non-free heading, but with a CC BY 4.0 licence: free with credit, so they ship
ALLOW = {"public/piece/totoy", "public/piece/papercut"}
LILA = {"author": "the lila authors", "license": "AGPLv3+", "license_url": "https://www.gnu.org/licenses/agpl-3.0.html"}
NAMES = {"icpieces": "IC Pieces", "mpchess": "MPChess", "rhosgfx": "RhosGFX", "xkcd": "xkcd", "kiwen-suwi": "Kiwen-suwi",
         "ic": "IC", "ncf-board": "NCF", "blue2": "Blue 2", "blue3": "Blue 3", "wood2": "Wood 2", "wood3": "Wood 3",
         "wood4": "Wood 4", "maple2": "Maple 2", "canvas2": "Canvas", "nes": "NES", "sfx": "SFX"}


def nice(i: str) -> str:
    return NAMES.get(i) or " ".join(w.capitalize() for w in i.split("-"))


def plain(md: str) -> tuple[str, str | None]:
    """'[text](url)' -> ('text', 'url'); a list of links joins the texts and keeps the first url."""
    links = re.findall(r"\[([^\]]+)\]\(([^)]+)\)", md)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", md).strip()
    return text, (links[0][1] if links else None)


def licences(copying: str) -> tuple[dict, set]:
    """{path: {author, license, license_url}} for the free exceptions, and the set of non-free paths."""
    free, nonfree, section = {}, set(), None
    for line in copying.splitlines():
        if line.startswith("## "):
            section = "free" if "(free)" in line else "nonfree" if "(non-free)" in line else None
            continue
        cells = [c.strip() for c in line.split("|")]
        if section is None or len(cells) < 3 or not cells[0].startswith("public/"):
            continue
        for path in re.findall(r"public/[\w./{},-]+", cells[0]):
            path = path.rstrip(",").lower()
            if section == "nonfree" and path not in ALLOW:
                nonfree.add(path)
                continue
            author, _ = plain(cells[1])
            lic, url = plain(cells[2])
            free[path] = {"author": author, "license": lic, "license_url": url}
    return free, nonfree


def main(lila: Path) -> None:
    pub = lila / "public"
    free, nonfree = licences((lila / "COPYING.md").read_text(encoding="utf-8"))
    if OUT.exists():
        shutil.rmtree(OUT)
    manifest = {"pieces": [], "boards": [], "sounds": []}

    for d in sorted(p for p in (pub / "piece").iterdir() if p.is_dir()):
        key = f"public/piece/{d.name.lower()}"
        if d.name in SKIP_PIECES or key in nonfree:
            continue
        ext = next((e for e in ("svg", "webp", "png") if (d / f"wK.{e}").exists()), None)
        if not ext or not all((d / f"{p}.{ext}").exists() for p in PIECES):
            print(f"skipping piece set {d.name}: not the 12 standard files")
            continue
        dest = OUT / "pieces" / d.name.lower()
        dest.mkdir(parents=True)
        for p in PIECES:
            shutil.copy2(d / f"{p}.{ext}", dest / f"{p}.{ext}")
        manifest["pieces"].append({"id": d.name.lower(), "name": nice(d.name.lower()), "ext": ext, **free.get(key, LILA)})

    board_lic = free.get("public/images/board", LILA)
    bd = pub / "images" / "board"
    for f in sorted(bd.iterdir()):
        if not f.is_file() or f.suffix not in (".jpg", ".png") or f.stem.count("."):
            continue                                        # .orig/.thumbnail copies and horsey's highlight overlays
        thumb = next((t for t in bd.glob(f"{f.stem}.thumbnail.*")), f)
        dest = OUT / "boards"
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dest / f.name)
        if thumb != f:
            shutil.copy2(thumb, dest / thumb.name)
        manifest["boards"].append({"id": f.stem, "name": nice(f.stem), "file": f.name, "thumb": thumb.name, **board_lic})

    for pack in FREE_SOUNDS:
        src, dest = pub / "sound" / pack, OUT / "sounds" / pack
        dest.mkdir(parents=True)
        have = [n for n in SOUND_FILES if (src / f"{n}.mp3").exists()]
        for n in have:
            shutil.copy2(src / f"{n}.mp3", dest / f"{n}.mp3")
        manifest["sounds"].append({"id": pack, "name": nice(pack), "files": have, **free.get(f"public/sounds/{pack}", LILA)})
    # this project's own packs: kept outside OUT so the rmtree above can't lose them
    for src in sorted(p for p in OWN_SOUNDS.iterdir() if p.is_dir()) if OWN_SOUNDS.exists() else []:
        meta = json.loads((src / "pack.json").read_text(encoding="utf-8"))
        dest = OUT / "sounds" / src.name
        dest.mkdir(parents=True)
        have = [n for n in SOUND_FILES if (src / f"{n}.mp3").exists()]
        for n in have:
            shutil.copy2(src / f"{n}.mp3", dest / f"{n}.mp3")
        manifest["sounds"].append({"id": src.name, "name": meta["name"], "files": have, "author": meta["author"],
                                   "license": meta["license"], "license_url": meta.get("license_url")})

    (OUT / "themes.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    lines = ["# Themes", "",
             "Piece sets, boards and sound packs from [Lichess](https://github.com/lichess-org/lila), each under its",
             "own licence as listed in lila's COPYING.md. Copied unmodified by scripts/import_lichess_themes.py.",
             "Sound packs from chess_review/sound_packs/ are this project's own.", ""]
    for kind, title in (("pieces", "Piece sets"), ("boards", "Boards"), ("sounds", "Sound packs")):
        lines += [f"## {title}", "", "Name | Author | Licence", "--- | --- | ---"]
        for t in manifest[kind]:
            lic = f"[{t['license']}]({t['license_url']})" if t["license_url"] else t["license"]
            lines.append(f"{t['name']} | {t['author']} | {lic}")
        lines.append("")
    (OUT / "CREDITS.md").write_text("\n".join(lines), encoding="utf-8")
    print({k: len(v) for k, v in manifest.items()})


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "lila"))
