"""Print our review of one game (by opponent name or id) move by move, with alternative accuracy aggregations."""
import glob, json, math, statistics, sys

needle = sys.argv[1] if len(sys.argv) > 1 else "nagibator0044"
g = next(json.load(open(f)) for f in glob.glob("data/site/games/*.json") if needle in open(f).read())
print(g["id"], g["played_at"][:10], "me:", g["my_colour"], "result:", g["result"])
for side in ("white", "black"):
    print(f"  {side:5} {g[side]['name']:16} acc={g[side]['accuracy']}  {g[side]['counts']}")

print()
for m in g["moves"]:
    print(f"{m['ply']:3} {m['san']:7} {str(m['label']):10} eval={str(m['eval']):>6} loss={m['wp_loss']}")


def move_acc(loss):
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss) - 3.1669))


def lichess_game_accuracy(moves, side, start_wp):
    """lila AccuracyPercent: volatility-weighted mean and harmonic mean of per-move accuracies, averaged."""
    wps = [start_wp] + [m["wp_white"] for m in moves]
    n = len(wps)
    window = max(2, min(8, n // 10))
    # volatility per position = stdev of win% over a sliding window
    vols = []
    for i in range(n):
        lo, hi = max(0, i - window // 2), min(n, i + window // 2 + 1)
        w = [x for x in wps[lo:hi] if x is not None]
        vols.append(max(0.5, min(12.0, statistics.pstdev(w))) if len(w) > 1 else 0.5)
    accs, weights = [], []
    for m in moves:
        if m["wp_loss"] is None or m["label"] in ("book",):
            continue
        if (m["ply"] % 2 == 0) != (side == "white"):
            continue
        accs.append(move_acc(m["wp_loss"]))
        weights.append(vols[m["ply"]])
    if not accs:
        return None
    weighted = sum(a * w for a, w in zip(accs, weights)) / sum(weights)
    harmonic = len(accs) / sum(1 / max(a, 1e-9) for a in accs)
    return round((weighted + harmonic) / 2, 1), round(sum(accs) / len(accs), 1), round(harmonic, 1)


print()
for side in ("white", "black"):
    r = lichess_game_accuracy(g["moves"], side, g["start_wp_white"])
    print(f"{side:5} {g[side]['name']:16} lichess-style={r[0]}  plain-mean={r[1]}  harmonic={r[2]}")
