"""Desktop app entry point (PyInstaller): the local server in a background thread, the review UI in a
native window (pywebview over the OS webview). Closing the window shuts everything down.

multiprocessing.freeze_support() must run before anything else touches multiprocessing, since
analyse.py spawns a worker Pool (spawn context) that re-execs this same exe."""

import logging
import multiprocessing
import os
import shutil
import socket
import sys
import threading
import time

multiprocessing.freeze_support()

HOST, PREFERRED_PORT = "127.0.0.1", 8123
log = logging.getLogger("launcher")


def _seed_book(bundle_root, data_dir) -> None:
    """First run only: copy the bundled opening-book TSVs into the per-user data dir
    book.py reads from (DATA/book), since a packaged exe's own folder may be read-only."""
    src = bundle_root / "assets" / "book"
    dst = data_dir / "book"
    if src.is_dir() and not dst.exists():
        dst.mkdir(parents=True, exist_ok=True)
        for tsv in src.glob("*.tsv"):
            shutil.copy2(tsv, dst / tsv.name)


def _unblock_bundle(bundle_root, frozen: bool) -> None:
    """Windows marks a downloaded zip with a Zone.Identifier stream, and Explorer's extractor - current
    WinRAR too - copies it onto every file it writes. .NET then refuses to load pywebview's assemblies
    from the Internet zone and webview.start() dies resolving Python.Runtime.Loader.Initialize. Strip the
    stream from our own binaries first: by the time .NET complains there is no window to say it in, and
    which extractor the user reached for is not ours to control. Same trust check as the network-path one
    in packaging/chess-review.spec."""
    if not frozen or sys.platform != "win32":
        return
    dropped = 0
    for path in bundle_root.rglob("*"):
        if path.suffix.lower() not in (".dll", ".exe", ".pyd"):
            continue
        try:
            os.remove(f"{path}:Zone.Identifier")   # no stream -> FileNotFoundError, the normal case
            dropped += 1
        except OSError:
            pass
    if dropped:
        log.info("cleared the downloaded-file mark from %d bundled binaries", dropped)


def _message_box(title: str, text: str) -> None:
    """A plain Win32 dialog for a failure that leaves us no app window: a console-less exe would otherwise
    just vanish, and the user never finds app.log on their own."""
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)   # MB_ICONERROR
    except Exception:
        log.exception("could not show the error dialog")


def _free_port(host: str, preferred: int) -> int:
    """The preferred port, or any free one if it's taken (a second copy of the app, or something else on 8123)."""
    for port in (preferred, 0):
        try:
            with socket.socket() as s:
                s.bind((host, port))
                return s.getsockname()[1]
        except OSError:
            continue
    raise OSError("no free port")


def _wait_for_port(host: str, port: int, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _setup_logging(data_dir) -> None:
    # a windowed exe has no console (sys.stderr is None), so everything goes to a file the user can send us
    data_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s",
                        handlers=[logging.FileHandler(data_dir / "app.log", encoding="utf-8")])
    sys.excepthook = lambda *exc: log.error("uncaught", exc_info=exc)
    threading.excepthook = lambda args: log.error("uncaught in %s", args.thread.name,
                                                  exc_info=(args.exc_type, args.exc_value, args.exc_traceback))


def main() -> None:
    from chess_review.config import BUNDLE_ROOT, DATA, FROZEN, STOCKFISH

    _setup_logging(DATA)
    log.info("starting; data in %s", DATA)
    if not STOCKFISH.exists():
        log.error("Stockfish not found at %s - analysis will fail", STOCKFISH)
    _unblock_bundle(BUNDLE_ROOT, FROZEN)   # before anything can try to load a .NET assembly
    _seed_book(BUNDLE_ROOT, DATA)

    from chess_review import serve, updater
    import webview

    port = _free_port(HOST, PREFERRED_PORT)
    threading.Thread(target=serve.main, args=([f"--host={HOST}", f"--port={port}"],), daemon=True, name="server").start()

    if _wait_for_port(HOST, port):
        window = webview.create_window("Chess Review", f"http://{HOST}:{port}/", width=1400, height=900, min_size=(900, 600))
        updater.exit_app = window.destroy   # "Restart to update": the apply script waits for this process to exit
    else:
        log.error("server did not come up on %s:%d", HOST, port)
        webview.create_window("Chess Review", html=f"<h2>The app failed to start.</h2><p>See <code>{DATA / 'app.log'}</code>.</p>")
    try:
        # private_mode=False keeps localStorage (pinned profiles, the auto-analyse switch) between runs
        webview.start(private_mode=False, storage_path=str(DATA / "webview"))
        log.info("window closed: shutting down")
    except Exception:
        # start() is where pywebview picks its backend and loads .NET, so this is where a blocked or
        # broken install shows up - with no window of our own to report it in.
        log.exception("the app window failed to open")
        _message_box("Chess Review",
                     "Chess Review could not open its window.\n\n"
                     "The usual cause is Windows blocking the files it downloaded. Unblock the zip "
                     "(right-click it, Properties, tick Unblock) and extract it again.\n\n"
                     f"Details are in {DATA / 'app.log'}.")
    finally:
        if serve.Handler.runner is not None:
            serve.Handler.runner.analyser.close()
            serve.Handler.runner.explorer.close()


if __name__ == "__main__":
    main()
