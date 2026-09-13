"""Plain-English rendering of MoveFacts. Format strings over structured data, nothing else."""

from .critical import band
from .facts import MoveFacts


def move_label(ply: int, san: str) -> str:
    n = ply // 2 + 1
    return f"{n}. {san}" if ply % 2 == 0 else f"{n}... {san}"


def _line(sans: list[str], start_ply: int) -> str:
    """Render a SAN list with move numbers, e.g. '14...Nc6 15. Bxf7+ Kxf7'."""
    out = []
    for i, san in enumerate(sans):
        p = start_ply + i
        n = p // 2 + 1
        if p % 2 == 0:
            out.append(f"{n}. {san}")
        elif i == 0:
            out.append(f"{n}... {san}")
        else:
            out.append(san)
    return " ".join(out)


def _clock(seconds: int) -> str:
    if seconds >= 60:
        m, s = divmod(seconds, 60)
        return f"{m}:{s:02d}"
    return f"{seconds} seconds"


def headline(f: MoveFacts) -> str:
    who = "You" if f.is_mine else "Opponent"
    if f.missed_mate:
        return f"{who} missed mate in {f.missed_mate}"
    if f.allowed_mate:
        return f"{who} allowed mate in {f.allowed_mate}"
    label = f.label or "move"
    if f.wp_before is not None and f.wp_after is not None:
        return f"{label.capitalize()} — win chance {f.wp_before:.0f}% → {f.wp_after:.0f}%"
    return label.capitalize()


def explain(f: MoveFacts) -> list[str]:
    """Ordered sentences. The first is the main reason, the rest are supporting facts."""
    s: list[str] = []
    reply_ply = f.ply + 1
    ref = _line(f.refutation, reply_ply) if f.refutation else None
    best = f.best_san
    hung = f.hung_pieces[0] if f.hung_pieces else None
    swing = f.material_swing

    if f.missed_mate and best:
        s.append(f"{best} forces mate: {_line(f.best_line, f.ply)}.")
    elif f.allowed_mate and ref:
        s.append(f"After {ref} there is no defence.")
    elif hung and ref:
        s.append(f"This hangs the {hung['piece']} on {hung['square']}: {ref}.")
    elif f.motif and ref:
        s.append(f"{f.refutation[0]} {f.motif_detail}: {ref}.")
    elif swing is not None and swing <= -200 and ref:
        s.append(f"Loses material after {ref} (down {abs(swing) / 100:g} pawns).")
    elif f.label == "miss" and best:
        s.append(f"Missed {best}" + (f": {_line(f.best_line, f.ply)}." if f.best_line else "."))
    elif f.wp_after is not None and f.wp_after >= 65 and ref:
        s.append(f"Still better after {ref}, but much of the advantage is gone.")
    elif ref:
        s.append(f"The position falls apart after {ref}.")

    if best and not f.missed_mate and f.label != "miss":
        b0 = band(f.wp_before) if f.wp_before is not None else "equal"
        if f.was_only_move:
            s.append(f"{best} was the only move.")
        elif b0 == "winning":
            s.append(f"{best} kept the win.")
        elif b0 == "losing":
            s.append(f"{best} was the best chance.")
        else:
            s.append(f"{best} held the balance.")

    if f.clock_remaining is not None:
        clock = f"Played with {_clock(f.clock_remaining)} remaining"
        if f.time_spent is not None and f.time_spent >= 30:
            clock += f", after thinking for {_clock(f.time_spent)}"
        elif f.time_spent is not None and f.time_spent <= 2 and f.clock_remaining > 60:
            clock += ", in under 3 seconds"
        s.append(clock + ".")
    return s


def comment(f: MoveFacts, opening: str | None = None) -> list[str]:
    """One or two sentences for ANY move (the move list / current-move panel).
    Mistakes and worse get the full explanation."""
    if f.label is None:
        return []
    if f.label == "book":
        return [f"{f.san} is a book move." + (f" ({opening})" if opening else "")]
    if f.label == "forced":
        return [f"{f.san} was the only legal move."]
    if f.label == "brilliant":
        return [f"{f.san} is brilliant — {_moved_piece(f)} sacrifice that keeps the position under control."]
    if f.label == "great":
        return [f"{f.san} is a great move — the only move that keeps things together."]
    if f.label == "best":
        return [f"{f.san} is the best move."]
    if f.label == "excellent":
        return [f"{f.san} is an excellent move." + (f" {f.best_san} was the engine's choice." if f.best_san else "")]
    if f.label == "good":
        return [f"{f.san} is a good move." + (f" {f.best_san} was better." if f.best_san else "")]
    if f.label == "inaccuracy":
        s = [f"{f.san} is an inaccuracy."]
        if f.best_san:
            s.append(f"{f.best_san} was better.")
        return s
    return explain(f)


def _moved_piece(f: MoveFacts) -> str:
    return {"N": "a knight", "B": "a bishop", "R": "a rook", "Q": "a queen"}.get(f.san[0], "a piece")
