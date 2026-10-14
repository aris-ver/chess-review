"""Copy this project's own sound packs (chess_review/sound_packs/) into the installed themes, without a lila
checkout: the same step import_lichess_themes.py runs after the Lichess packs, for when only a pack changed.

    python scripts/install_own_sounds.py
"""
import json
import shutil

from import_lichess_themes import OUT, OWN_SOUNDS, SOUND_FILES


def main() -> None:
    manifest = json.loads((OUT / "themes.json").read_text(encoding="utf-8"))
    credits = (OUT / "CREDITS.md").read_text(encoding="utf-8")
    for src in sorted(p for p in OWN_SOUNDS.iterdir() if p.is_dir()):
        meta = json.loads((src / "pack.json").read_text(encoding="utf-8"))
        dest = OUT / "sounds" / src.name
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        have = [n for n in SOUND_FILES if (src / f"{n}.mp3").exists()]
        for n in have:
            shutil.copy2(src / f"{n}.mp3", dest / f"{n}.mp3")
        entry = {"id": src.name, "name": meta["name"], "files": have, "author": meta["author"],
                 "license": meta["license"], "license_url": meta.get("license_url")}
        manifest["sounds"] = [s for s in manifest["sounds"] if s["id"] != src.name] + [entry]
        row = f"{meta['name']} | {meta['author']} | {meta['license']}"
        lines = [l for l in credits.split("\n") if not l.startswith(f"{meta['name']} | ")]
        at = max(i for i, l in enumerate(lines) if l.strip()) + 1      # end of the last table (Sound packs)
        credits = "\n".join(lines[:at] + [row] + lines[at:])
        print(src.name, have)
    note = "Sound packs from chess_review/sound_packs/ are this project's own."
    if note not in credits:
        credits = credits.replace("scripts/import_lichess_themes.py.\n", f"scripts/import_lichess_themes.py.\n{note}\n", 1)
    (OUT / "themes.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    (OUT / "CREDITS.md").write_text(credits, encoding="utf-8")


if __name__ == "__main__":
    main()
