"""The server's job runner: a puzzle build gives way to whatever the user asks for and comes back afterwards,
analyses asked for during another job wait their turn, and the resets archive rather than delete."""

import json
import threading
import time
from pathlib import Path

import duckdb
import pytest

from chess_review import analyse, own_puzzles, puzzles, serve


class Prof:
    source = "chesscom"

    def __init__(self, pid: str, root: Path, games: bool = True):
        self.id, self.username = pid, pid.split("-", 1)[-1]
        self.dir = root / pid
        self.site_dir = self.dir / "site"
        self.moves_parquet = self.dir / "moves.parquet"
        self.site_dir.mkdir(parents=True)
        if games:
            (self.site_dir / "games.json").write_text('{"games": []}')


def wait_for(cond, timeout=3.0):
    t = time.time()
    while not cond():
        if time.time() - t > timeout:
            raise AssertionError("timed out")
        time.sleep(0.005)


class Bodies:
    """Stand-ins for the job bodies: each runs until released (or asked to stop), and records what ran."""

    def __init__(self):
        self.ran: list[serve.Job] = []
        self.go: dict[int, threading.Event] = {}
        self.fail: set[str] = set()

    def __call__(self, job):
        ev = self.go.setdefault(id(job), threading.Event())
        self.ran.append(job)
        while not ev.is_set() and not job.stop_requested:
            time.sleep(0.005)
        if job.kind in self.fail:
            raise RuntimeError("boom")

    def release(self, job):
        self.go.setdefault(id(job), threading.Event()).set()

    def running(self, kind, pid=None):
        return lambda: any(j.kind == kind and (pid is None or j.profile.id == pid) and j.status == "running" for j in self.ran)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    profs = {pid: Prof(pid, tmp_path) for pid in ("chesscom-a", "chesscom-b")}
    monkeypatch.setattr(serve.profiles, "load", lambda pid: profs.get(pid))
    monkeypatch.setattr(serve.profiles, "delete", lambda pid: profs.pop(pid, None) is not None)
    r = serve.Runner(nodes=1000, workers=1, builds_file=tmp_path / "builds.json")
    b = Bodies()
    for name in ("_build", "_analyse", "_ingest", "_refresh", "_puzzles", "_analyse_all"):
        setattr(r, name, b)
    yield r, b, profs
    for j in b.ran:
        j.stop_requested = True
    if r.thread:
        r.thread.join(2)


def test_analysing_a_game_pauses_the_build_and_the_build_comes_back(setup):
    r, b, profs = setup
    r.request_build(profs["chesscom-a"])
    wait_for(b.running("build"))
    build = r.job
    out = r.start(serve.Job("analyse", profs["chesscom-b"], "g1", "g1"))
    assert out is not None and out.kind == "analyse"
    wait_for(b.running("analyse"))
    assert build.status == "stopped" and build.preempted
    st = r.status()
    assert st["job"]["kind"] == "analyse"
    assert [(d["profile"], d["state"]) for d in st["builds"]] == [("chesscom-a", "paused")]
    b.release(r.job)
    wait_for(lambda: r.job.kind == "build" and r.job is not build and r.job.status == "running")
    st = r.status()
    assert st["builds"][0]["state"] == "running"
    assert [(j["kind"], j["status"]) for j in st["recent"]] == [("build", "stopped"), ("analyse", "done")]   # the page sees it end


def test_analyses_asked_for_during_a_foreground_job_queue_once_and_go_before_the_build(setup):
    r, b, profs = setup
    first = r.start(serve.Job("analyse", profs["chesscom-a"], "g1", "g1"))
    wait_for(b.running("analyse"))
    r.request_build(profs["chesscom-b"])                 # waits: a foreground job is running
    queued = r.start(serve.Job("analyse", profs["chesscom-a"], "g2", "g2"))
    assert queued.status == "queued" and r.queue == [queued]
    assert r.start(serve.Job("analyse", profs["chesscom-a"], "g2", "g2")) is queued      # asked twice: one job
    assert r.start(serve.Job("analyse", profs["chesscom-a"], "g1", "g1")) is first       # the one running
    assert r.start(serve.Job("refresh", profs["chesscom-a"])) is None                    # anything else: busy
    assert r.status()["builds"][0]["state"] == "paused"
    b.release(first)
    wait_for(lambda: r.job is queued and queued.status == "running")
    b.release(queued)
    wait_for(b.running("build", "chesscom-b"))
    assert r.queue == []


def test_a_build_stopped_by_the_user_does_not_come_back(setup):
    r, b, profs = setup
    r.request_build(profs["chesscom-a"])
    wait_for(b.running("build"))
    assert r.cancel_build("chesscom-a")
    wait_for(lambda: not r.busy() and len(r.recent) == 1)
    assert r.builds == [] and r.status()["builds"] == []
    assert json.loads(r.builds_file.read_text()) == []
    assert r.finished == {}                         # stopped, not finished


def test_builds_run_one_after_another_and_report_how_they_ended(setup):
    r, b, profs = setup
    r.request_build(profs["chesscom-a"])
    r.request_build(profs["chesscom-b"])
    wait_for(b.running("build", "chesscom-a"))
    assert [d["state"] for d in r.status()["builds"]] == ["running", "waiting"]
    b.fail.add("build")
    b.release(r.job)
    wait_for(b.running("build", "chesscom-b"))
    assert r.finished["chesscom-a"]["status"] == "error"     # a failed build is not retried in a loop
    b.fail.clear()
    b.release(r.job)
    wait_for(lambda: "chesscom-b" in r.finished)
    assert r.finished["chesscom-b"]["status"] == "done" and r.builds == []


def test_builds_carry_on_after_a_restart(setup, tmp_path):
    r, b, _ = setup
    r.builds = ["chesscom-a", "chesscom-gone"]
    r._save_builds()
    again = serve.Runner(nodes=1000, workers=1, builds_file=r.builds_file)
    assert again.builds == ["chesscom-a", "chesscom-gone"]
    again.builds.reverse()
    again._build = b
    again._kick()                                   # the gone profile is dropped, the other one starts
    wait_for(b.running("build", "chesscom-a"))
    assert again.builds == ["chesscom-a"]
    again.cancel_build("chesscom-a")
    again.thread.join(2)


def test_a_new_profile_is_fetched_then_built_and_a_failed_fetch_drops_the_build(setup, tmp_path):
    r, b, profs = setup
    new = profs["chesscom-new"] = Prof("chesscom-new", tmp_path, games=False)
    ingest = r.start(serve.Job("ingest", new), then_build=True)
    wait_for(b.running("ingest"))
    assert [(d["profile"], d["state"], d["phase"]) for d in r.status()["builds"]] == [("chesscom-new", "fetching", "fetching")]
    (new.site_dir / "games.json").write_text('{"games": []}')
    b.release(ingest)
    wait_for(b.running("build", "chesscom-new"))
    r.cancel_build("chesscom-new")
    wait_for(lambda: not r.busy())

    typo = profs["chesscom-typo"] = Prof("chesscom-typo", tmp_path, games=False)
    b.fail.add("ingest")
    b.release(r.start(serve.Job("ingest", typo), then_build=True))
    wait_for(lambda: not r.busy() and r.job.kind == "ingest" and r.builds == [])
    assert not any(j.kind == "build" and j.profile is typo for j in b.ran)


def test_the_build_counts_games_refreshes_puzzles_and_skips_the_bookkeeping_when_preempted(tmp_path, monkeypatch):
    p = Prof("chesscom-a", tmp_path)
    r = serve.Runner(nodes=1000, workers=1)
    monkeypatch.setattr(serve, "_open_db_retry", lambda: duckdb.connect())
    monkeypatch.setattr(serve, "base_views", lambda con, prof: None)
    monkeypatch.setattr(serve, "export_parquet", lambda con: None)
    monkeypatch.setattr(serve.aggregates, "build", lambda prof: None)
    monkeypatch.setattr(serve, "PUZZLE_REFRESH_S", 0)
    monkeypatch.setattr(r, "_todo", lambda con, prof: (5, [("g1", ["k"]), ("g2", ["k"]), ("g3", ["k"])]))
    refreshed, lines = [], []

    def refresh(job):
        refreshed.append(job.done)
        job.puzzles = job.done * 10
    monkeypatch.setattr(r, "_refresh_puzzles", refresh)
    monkeypatch.setattr(r, "_puzzles", lambda job: lines.append(job.phase))

    seen = []

    def game(job, con, gid, keys):
        seen.append((gid, job.done, job.total))
    monkeypatch.setattr(r, "_analyse_game", game)
    job = serve.Job("build", p)
    r._build(job)
    assert seen == [("g1", 2, 5), ("g2", 3, 5), ("g3", 4, 5)]      # two of five were analysed already
    assert refreshed == [3, 4, 5, 5] and lines == ["lines"]          # after each game, then once at the end

    refreshed.clear(), lines.clear()

    def preempting(job, con, gid, keys):
        job.stop_requested = job.preempted = True
    monkeypatch.setattr(r, "_analyse_game", preempting)
    job = serve.Job("build", p)
    r._build(job)
    assert job.done == 2 and refreshed == [] and lines == []         # it comes back and does that then


class FakePool:
    def imap_unordered(self, fn, keys, chunksize=1):
        for k in keys:
            yield k, {"nodes": 1, "eval_cp": 10, "mate_in": None, "best_move": "e2e4", "pv": ["e2e4"]}, \
                [{"rank": 1, "move": "e2e4", "eval_cp": 10, "mate_in": None, "pv": ["e2e4"]}]

    def terminate(self):
        pass


def test_a_stopped_analysis_keeps_the_results_in_hand():
    con = duckdb.connect()
    con.execute(analyse.SCHEMA)
    a = analyse.Analyser(workers=1, nodes=1)
    a._pool = FakePool()
    n = []
    a.run([f"k{i}" for i in range(7)], con, batch=100, should_stop=lambda: True, on_progress=lambda d, t: n.append(d))
    assert con.execute("SELECT count(*) FROM evals").fetchone()[0] == 1 and n == [1]


def test_resetting_the_rating_archives_the_record_and_keeps_tried_puzzles_out(tmp_path):
    path = tmp_path / "puzzle_attempts.jsonl"
    puzzles.record("aaaaa", 1500, True, path=path)
    puzzles.record("bbbbb", 1500, False, path=path)
    assert puzzles.stats(puzzles.attempts(path))["played"] == 2
    moved = puzzles.reset(path)
    assert moved.name.startswith("puzzle_attempts.reset-") and not path.exists()
    assert len(puzzles.attempts(moved)) == 2                     # nothing lost: rename it back to undo
    assert puzzles.stats(puzzles.attempts(path))["rating"] == puzzles.START_RATING
    assert puzzles.tried(path) == {"aaaaa", "bbbbb"}
    assert puzzles.record("aaaaa", 1500, True, path=path) is not None     # opened by its URL, it counts again
    assert puzzles.reset(path) != moved                          # a second reset in the same second: its own file
    assert puzzles.reset(path) is None                           # nothing to archive


def test_resetting_a_profiles_schedule_makes_every_puzzle_new_again(tmp_path):
    class P:
        id, dir, moves_parquet = "x", tmp_path, tmp_path / "none.parquet"
    own_puzzles.record(P, "m0123456789", solved=False)
    assert own_puzzles.schedule(own_puzzles.attempts(own_puzzles.attempts_path(P)))
    moved = own_puzzles.reset(P)
    assert moved.parent == tmp_path and moved.name.startswith("puzzle_attempts.reset-")
    assert own_puzzles.attempts(own_puzzles.attempts_path(P)) == []
