"""Synthesize the Clubhouse sound pack from scratch: modal wood knocks, felt slides, glassy bells, a buzz.
No recording is sampled. chess.com's default sounds were only measured (length, decay, rough partial ranges)
to aim the character; every waveform here is generated, so the pack is this project's own.

    python scripts/synth_clubhouse_sounds.py WAV_DIR
    for f in WAV_DIR/*.wav; do ffmpeg -i "$f" -ac 1 -c:a libmp3lame -b:a 128k \
        chess_review/sound_packs/clubhouse/$(basename "$f" .wav).mp3; done
    python scripts/install_own_sounds.py
"""
import os
import sys
import wave

import numpy as np
from scipy import signal

SR = 44100
rng = np.random.default_rng(7)
DAMP = 0.7          # global scale on mode decay times: chess.com-like knocks are dead, not ringing


def t_of(sec):
    return np.arange(int(sec * SR)) / SR


def place(buf, x, at):
    i = int(at * SR)
    end = min(len(buf), i + len(x))
    buf[i:end] += x[:end - i]
    return buf


def knock(modes, length=0.12, click=0.35, click_bw=(1500, 7000), body=1.0, tilt=1.0):
    """A piece hitting a board: a short noise click exciting damped modes (freq Hz, decay s, gain)."""
    t = t_of(length)
    y = np.zeros_like(t)
    for f, d, g in modes:
        ph = rng.uniform(0, 2 * np.pi)
        f_t = f * (1 + 0.012 * np.exp(-t / 0.004))          # tiny pitch drop as the hit settles
        d *= DAMP
        y += g * np.exp(-t / d) *np.sin(2 * np.pi * np.cumsum(f_t) / SR + ph)
    # contact click: band-passed noise, a couple of ms
    n = rng.standard_normal(len(t)) * np.exp(-t / 0.0013)
    b, a = signal.butter(2, [click_bw[0] / (SR / 2), click_bw[1] / (SR / 2)], "band")
    y = body * y + click * signal.lfilter(b, a, n) * 6
    # soft attack (0.3 ms) so it doesn't pop
    y[: int(0.0003 * SR)] *= np.linspace(0, 1, int(0.0003 * SR))
    if tilt != 1.0:                                           # >1 darker, <1 brighter
        b, a = signal.butter(1, min(0.99, 4000 / tilt / (SR / 2)))
        y = signal.lfilter(b, a, y) * 0.5 + y * 0.5
    return y


def slide(length, level=0.05, lo=500, hi=5000):
    """Felt base sliding over wood: band-passed noise with a little grain."""
    t = t_of(length)
    n = rng.standard_normal(len(t))
    b, a = signal.butter(2, [lo / (SR / 2), hi / (SR / 2)], "band")
    n = signal.lfilter(b, a, n)
    grain = 1 + 0.5 * signal.lfilter(*signal.butter(1, 60 / (SR / 2)), rng.standard_normal(len(t))) * 8
    env = np.minimum(1, t / 0.008) * np.minimum(1, (length - t) / 0.02)
    return level * n * env * np.clip(grain, 0.2, 2)


def bell(freq, length=0.9, partials=((1, 1.0, 0.45), (2.0, 0.5, 0.25), (3.0, 0.32, 0.16), (4.05, 0.2, 0.1), (5.9, 0.12, 0.06)),
         attack=0.002):
    t = t_of(length)
    y = np.zeros_like(t)
    for ratio, g, d in partials:
        y += g * np.exp(-t / d) * np.sin(2 * np.pi * freq * ratio * t + rng.uniform(0, 6))
    y *= np.minimum(1, t / attack)
    return y


def marimba(freq, length=0.6, decay=0.22):
    t = t_of(length)
    y = (np.sin(2 * np.pi * freq * t) * np.exp(-t / decay)
         + 0.35 * np.sin(2 * np.pi * freq * 3.93 * t) * np.exp(-t / (decay / 4))
         + 0.12 * np.sin(2 * np.pi * freq * 9.2 * t) * np.exp(-t / (decay / 10)))
    y *= np.minimum(1, t / 0.0015)
    return y


def tail(y, sec=0.05):
    """Pad with silence and fade the very end."""
    y = np.concatenate([y, np.zeros(int(sec * SR))])
    k = int(0.01 * SR)
    y[-k:] *= np.linspace(1, 0, k)
    return y


def room(y, mix=0.12, size=0.045):
    """A small room: a diffuse, low-passed noise tail (discrete echoes flutter)."""
    t = t_of(0.25)
    ir = rng.standard_normal(len(t)) * np.exp(-t / size) * np.minimum(1, t / 0.004)
    ir = signal.lfilter(*signal.butter(2, 2200 / (SR / 2)), ir)
    ir /= np.sqrt((ir ** 2).sum())
    y = np.concatenate([y, np.zeros(len(ir))])
    return y + mix * 0.5 * signal.fftconvolve(y, ir)[: len(y)]


def norm(y, peak=0.85):
    return y / np.abs(y).max() * peak


# ---- the sounds ----------------------------------------------------------------------------------

WOOD = [(205, 0.007, 0.35), (470, 0.006, 0.9), (640, 0.005, 0.5), (935, 0.006, 1.0), (1320, 0.005, 0.7),
        (1750, 0.003, 0.35)]


def move():
    return tail(room(knock(WOOD, length=0.10, click=0.45, click_bw=(1800, 8000))), 0.06)


def capture():
    # a brighter, harder knock (piece knocking the taken one) with a quick second rattle and a short scrape
    hard = [(450, 0.012, 0.6), (900, 0.010, 0.7), (1250, 0.010, 1.0), (1460, 0.009, 0.9), (1580, 0.006, 0.5)]
    y = np.zeros(int(0.30 * SR))
    place(y, slide(0.03, level=0.12, lo=1500, hi=8000), 0.0)
    place(y, knock(hard, length=0.12, click=0.45, click_bw=(2000, 6000)), 0.006)
    place(y, 0.35 * knock(hard[1:], length=0.06, click=0.4), 0.022)
    return tail(room(y, mix=0.15), 0.06)


def castle():
    # king slides two squares (soft felt), then the rook lands lower and heavier
    low = [(230, 0.016, 1.0), (465, 0.012, 1.0), (910, 0.009, 0.9), (1300, 0.006, 0.45), (1460, 0.005, 0.4)]
    y = np.zeros(int(0.26 * SR))
    place(y, 0.6 * knock(WOOD, length=0.05, click=0.4), 0.0)
    place(y, slide(0.075, level=0.035, lo=300, hi=3500), 0.008)
    place(y, knock(low, length=0.13, click=0.35, click_bw=(1200, 4500)), 0.092)
    return tail(room(y), 0.05)


def check():
    # sharp, snappy: a cluster of fast clicks then a bright knock
    bright = [(420, 0.008, 0.4), (660, 0.010, 0.7), (875, 0.012, 0.9), (950, 0.012, 1.0), (1040, 0.010, 0.9),
              (1245, 0.008, 0.5), (1460, 0.006, 0.4)]
    y = np.zeros(int(0.28 * SR))
    for k, at in enumerate((0.0, 0.0035, 0.0062, 0.0085)):
        place(y, (0.25 + 0.1 * k) * knock([], length=0.01, click=0.7, click_bw=(2500, 8000)), at)
    place(y, knock(bright, length=0.12, click=0.4, click_bw=(1800, 6000)), 0.010)
    return tail(room(y, mix=0.15), 0.05)


def promote():
    # a short slide and a lift, then the new piece set down with a fuller, warmer thump
    full = [(195, 0.016, 0.9), (350, 0.014, 0.9), (520, 0.012, 1.0), (735, 0.010, 0.9), (1080, 0.008, 0.85),
            (1240, 0.007, 0.8), (1610, 0.005, 0.5)]
    y = np.zeros(int(0.25 * SR))
    place(y, 0.45 * knock(WOOD, length=0.04, click=0.5), 0.0)
    place(y, slide(0.045, level=0.03, lo=400, hi=4000), 0.006)
    place(y, knock(full, length=0.13, click=0.3, click_bw=(1200, 5000)), 0.058)
    place(y, 0.3 * knock(full[2:], length=0.05, click=0.2), 0.066)
    return tail(room(y), 0.05)


def checkmate():
    # the mating knock, then a low, final bell underneath
    y = np.zeros(int(1.1 * SR))
    place(y, check()[: int(0.15 * SR)] * 1.0, 0.0)
    place(y, 0.35 * bell(196, 1.0, partials=((1, 1, 0.5), (2.0, 0.35, 0.3), (2.98, 0.2, 0.18), (4.2, 0.1, 0.1))), 0.02)
    return tail(y, 0.02)


def error():
    # a short low buzz: a pulse train at ~112 Hz through a body resonance, 3 dips
    t = t_of(0.09)
    f0 = 112 * (1 - 0.18 * np.clip((t - 0.06) / 0.03, 0, 1))      # sags at the end
    ph = 2 * np.pi * np.cumsum(f0) / SR
    saw = signal.sawtooth(ph) + 0.5 * signal.square(2 * ph + 0.3)
    b, a = signal.butter(2, [150 / (SR / 2), 3000 / (SR / 2)], "band")
    y = signal.lfilter(b, a, saw)
    y *= 0.75 + 0.25 * np.cos(2 * np.pi * 36 * t)
    y *= np.minimum(1, t / 0.003) * np.minimum(1, (0.09 - t) / 0.012)
    return tail(y * 0.6, 0.12)


def confirmation():
    # "brilliant": a soft knock, then a rising three-note glassy bell, staggered
    y = np.zeros(int(0.8 * SR))
    place(y, 0.5 * knock(WOOD, length=0.08, click=0.3), 0.0)
    glass = ((1, 1.0, 0.09), (2.0, 0.4, 0.07), (3.01, 0.3, 0.06), (4.0, 0.15, 0.05), (6.0, 0.08, 0.035))
    for f, at, g in ((523.3, 0.025, 0.55), (784.0, 0.065, 0.5), (1046.5, 0.115, 0.6)):
        place(y, g * bell(f, 0.68, partials=glass), at)
    return tail(y, 0.02)


def generic_notify():
    # a soft, round two-note pop
    y = np.zeros(int(0.55 * SR))
    place(y, 0.7 * marimba(659.3, 0.5, 0.16), 0.0)
    place(y, 0.6 * marimba(987.8, 0.45, 0.16), 0.075)
    return tail(y, 0.02)


def low_time():
    # three quick, dry woodblock ticks, the last one a touch higher
    y = np.zeros(int(0.5 * SR))
    for at, f in ((0.0, 1180), (0.13, 1180), (0.26, 1400)):
        place(y, knock([(f, 0.018, 1.0), (f * 2.6, 0.008, 0.35)], length=0.08, click=0.3, click_bw=(2500, 8000)), at)
    return tail(y, 0.05)


def chord(notes, gap, length=1.2, decay=0.3, gains=None):
    y = np.zeros(int(length * SR))
    for i, f in enumerate(notes):
        g = gains[i] if gains else 1.0
        place(y, g * marimba(f, length - i * gap, decay), i * gap)
    return y


def victory():
    # rising major arpeggio landing on a held third
    return tail(chord([392.0, 493.9, 587.3, 784.0], 0.085, 1.3, 0.32, [0.8, 0.8, 0.85, 1.0]), 0.02)


def defeat():
    # falling minor figure, darker and slower
    return tail(chord([523.3, 415.3, 349.2, 261.6], 0.12, 1.4, 0.35, [0.8, 0.8, 0.85, 1.0]), 0.02)


def draw():
    # two even notes a fourth apart, neither up nor down
    return tail(chord([440.0, 587.3, 440.0], 0.11, 1.1, 0.28, [0.9, 0.8, 0.7]), 0.02)


SOUNDS = {
    "Move": (move, 0.80), "Capture": (capture, 0.85), "Castles": (castle, 0.85), "Check": (check, 0.80),
    "Promote": (promote, 0.85), "Checkmate": (checkmate, 0.85), "Error": (error, 0.55),
    "Confirmation": (confirmation, 0.75), "GenericNotify": (generic_notify, 0.6), "LowTime": (low_time, 0.7),
    "Victory": (victory, 0.5), "Defeat": (defeat, 0.5), "Draw": (draw, 0.45),
}


def write_wav(path, y):
    pcm = (np.clip(y, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for name, (fn, peak) in SOUNDS.items():
        y = norm(fn(), peak)
        end = np.nonzero(np.abs(y) > 10 ** (-60 / 20))[0][-1] + int(0.02 * SR)   # drop silence past -60 dB
        y = y[:end]
        k = int(0.015 * SR)
        y[-k:] *= np.linspace(1, 0, k)
        write_wav(os.path.join(out, f"{name}.wav"), y)
        print(name, f"{len(y) / SR * 1000:.0f} ms")
