"""Synthesises Starlance's one-shot sound effects into assets/sfx/*.wav (stdlib only, our own sounds).

Run: python3 scripts/sfx.py
"""

import math
import random
import struct
import wave
from pathlib import Path

RATE = 22050
OUT = Path(__file__).resolve().parent.parent / "assets" / "sfx"
random.seed(7)


def write(name, samples):
    OUT.mkdir(parents=True, exist_ok=True)
    peak = max(1e-9, max(abs(s) for s in samples))
    with wave.open(str(OUT / f"{name}.wav"), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(b"".join(struct.pack("<h", int(32000 * 0.9 * s / peak)) for s in samples))


def sweep(f0, f1, seconds, shape="saw", decay=6.0):
    out, phase = [], 0.0
    n = int(RATE * seconds)
    for i in range(n):
        t = i / n
        phase += (f0 + (f1 - f0) * t) / RATE
        p = phase % 1.0
        v = 2 * p - 1 if shape == "saw" else (1.0 if p < 0.5 else -1.0) if shape == "square" else math.sin(2 * math.pi * p)
        out.append(v * math.exp(-decay * t))
    return out


def noise(seconds, decay, smooth):
    out, lp = [], 0.0
    n = int(RATE * seconds)
    for i in range(n):
        t = i / n
        lp += (random.uniform(-1, 1) - lp) * smooth * (1 - 0.8 * t)
        out.append(lp * math.exp(-decay * t))
    return out


def mix(*parts):
    n = max(len(p) for p, _ in parts)
    return [sum(g * p[i] for p, g in parts if i < len(p)) for i in range(n)]


write("laser", sweep(1800, 500, 0.16, "square", 5))
write("charged", mix((sweep(900, 140, 0.45, "saw", 3), 0.7), (noise(0.45, 4, 0.5), 0.3)))
write("explosion", mix((noise(0.9, 4.5, 0.12), 1.0), (sweep(90, 35, 0.9, "sine", 3), 0.6)))
write("hit", mix((noise(0.3, 7, 0.4), 0.8), (sweep(220, 80, 0.3, "square", 6), 0.4)))
write("lock", sweep(1320, 1320, 0.07, "sine", 1) + [0.0] * 600 + sweep(1760, 1760, 0.09, "sine", 2))
write("bomb", mix((noise(1.6, 2.5, 0.06), 1.0), (sweep(70, 25, 1.6, "sine", 2), 0.8)))
write("pickup", sweep(660, 660, 0.07, "sine", 1) + sweep(880, 880, 0.07, "sine", 1) + sweep(1320, 1320, 0.14, "sine", 3))
write("alarm", (sweep(440, 440, 0.12, "square", 0.5) + [0.0] * 1500) * 2)
