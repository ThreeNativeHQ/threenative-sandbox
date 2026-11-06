"""Paints scratches, scuffs and grime streaks into the hull's base-colour maps. The glb's two plate
maps (Metal027 graphite, Metal038 gunmetal) are nearly flat, and the .blend's procedural wear nodes
export as nothing, so the plates read as smooth paint. The interior is diffuse-only (no specular), so
the wear has to live in the albedo: bright bare-steel scratches, dark gouges, dirt running down from
the rivet rows.

  uv run --with pillow --with numpy python -I tools/hull-wear.py <in.glb> <out.glb>

Run it after the gltf-transform steps and before texture-squeeze.py. Not idempotent: run it on a
fresh build (the output keeps `.wear` out of the texture names, so a second pass would stack).
"""

import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
# (the last number stretches the plate's own tone around its mean: 1 keeps it, <1 flattens it)
# exported file stem (gltf-transform names by slot; _1 graphite Metal027, _2 gunmetal Metal038) -> (scratch brightness over the plate, scratch count, grime strength)
PLATES = {
    "baseColor_1": (0.36, 90, 0.2, 1.3),
    "baseColor_2": (0.34, 100, 0.16, 0.75),
}


def layer(size: int, seed: int, count: int) -> tuple[np.ndarray, np.ndarray]:
    """Returns (scratch, gouge) masks 0..1: long bright hairlines, and short dark chips."""
    rng = np.random.default_rng(seed)
    big = size * 2  # draw at 2x and downsample: antialiased hairlines
    scratch = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(scratch)
    for _ in range(count):
        x, y = rng.uniform(0, big, 2)
        # Mostly along one grain, some across: how a hand and a boot scuff a panel.
        a = rng.normal(0.5, 0.35) if rng.random() < 0.75 else rng.uniform(0, np.pi)
        n = int(rng.uniform(0.05, 0.4) * big / 6)
        pts = [(x, y)]
        for _ in range(n):
            a += rng.normal(0, 0.05)
            x += np.cos(a) * 6
            y += np.sin(a) * 6
            pts.append((x % big, y % big))
        for p, q in zip(pts, pts[1:]):
            if abs(p[0] - q[0]) < 20 and abs(p[1] - q[1]) < 20:  # skip the wrap seam
                d.line([p, q], fill=int(rng.uniform(90, 255)), width=int(rng.choice([1, 1, 2, 3])))
    scratch = scratch.resize((size, size), Image.Resampling.LANCZOS)
    gouge = Image.new("L", (size, size), 0)
    g = ImageDraw.Draw(gouge)
    for _ in range(count * 2):
        x, y = rng.uniform(0, size, 2)
        r = rng.uniform(1, 4)
        g.ellipse([x - r, y - r * 0.6, x + r, y + r * 0.6], fill=int(rng.uniform(120, 255)))
    return np.asarray(scratch, float) / 255, np.asarray(gouge.filter(ImageFilter.GaussianBlur(0.8)), float) / 255


def grime(size: int, seed: int) -> np.ndarray:
    """Vertical streaks (runoff) over blotchy dirt, 0..1."""
    rng = np.random.default_rng(seed)
    out = np.zeros((size, size))
    for octave, weight in ((6, 0.5), (16, 0.3), (48, 0.2)):
        small = rng.random((octave, octave))
        out += weight * np.asarray(
            Image.fromarray((small * 255).astype(np.uint8)).resize((size, size), Image.Resampling.BICUBIC), float
        ) / 255
    streak = np.asarray(
        Image.fromarray((rng.random((1, size // 3)) * 255).astype(np.uint8)).resize((size, size), Image.Resampling.BICUBIC),
        float,
    ) / 255
    streak = np.asarray(Image.fromarray((streak * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), float) / 255
    return np.clip((out - 0.45) * 1.8 + 0.5 * np.clip(streak - 0.55, 0, 1) * 2, 0, 1)


def wear(path: str, seed: int, bright: float, count: int, dirt: float, stretch: float) -> None:
    img = Image.open(path).convert("RGB")
    base = np.asarray(img, float) / 255
    size = img.size[0]
    scratch, gouge = layer(size, seed, count)
    dirty = grime(size, seed + 1)
    mean = base.mean(axis=(0, 1))
    # Stretch the plate's own tone around its mean so its microtexture is visible, then dirt darkens it.
    out = mean + (base - mean) * stretch
    out *= (1 - dirt * dirty)[..., None]
    steel = np.array([0.62, 0.66, 0.72])  # bare metal under the paint: a cool grey-blue
    out = out * (1 - scratch[..., None] * bright * 2.2) + steel * (scratch[..., None] * bright * 2.2)
    out *= (1 - 0.7 * gouge)[..., None]
    Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8)).save(path, quality=95) if path.endswith(
        (".jpg", ".jpeg")
    ) else Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8)).save(path)


def main(src: str, dst: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["pnpm", "exec", "gltf-transform", "copy", os.path.abspath(src), f"{tmp}/m.gltf"],
            cwd=os.path.dirname(HERE), check=True, capture_output=True,
        )
        for seed, name in enumerate(sorted(os.listdir(tmp))):
            stem = name.rsplit(".", 1)[0]
            if stem in PLATES:
                bright, count, dirt, stretch = PLATES[stem]
                wear(f"{tmp}/{name}", 7 + seed, bright, count, dirt, stretch)
                print("worn", name, Image.open(f"{tmp}/{name}").convert("L").resize((1, 1)).getpixel((0, 0)))
        subprocess.run(
            ["pnpm", "exec", "gltf-transform", "copy", f"{tmp}/m.gltf", os.path.abspath(dst)],
            cwd=os.path.dirname(HERE), check=True, capture_output=True,
        )


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
