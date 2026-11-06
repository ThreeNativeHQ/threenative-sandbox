"""Shrinks a glb's textures without visible loss: each JPEG is re-encoded at a fixed high quality
(QUALITY by texture role, 4:4:4 chroma so normal and roughness channels stay independent), and each
PNG is quantised only when its SSIM stays >= MIN_SSIM, else losslessly re-packed. A texture is
replaced only when the result is smaller. Full-resolution SSIM punishes these grainy ambientCG maps
at any quality, so the report prints PSNR and SSIM at mip 1 (what a minified surface samples).

  uv run --with pillow --with numpy --with scikit-image python -I tools/texture-squeeze.py <in.glb> <out.glb>
"""

import io
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

MIN_SSIM = 0.99
QUALITY = {"normal": 92}  # every other JPEG role: 90
HERE = os.path.dirname(os.path.abspath(__file__))


def ssim(a: Image.Image, b: Image.Image) -> float:
    x, y = np.asarray(a), np.asarray(b)
    return structural_similarity(x, y, channel_axis=2 if x.ndim == 3 else None, data_range=255)


def mip1(x: np.ndarray) -> np.ndarray:
    x = x[: x.shape[0] // 2 * 2, : x.shape[1] // 2 * 2].astype(float)
    return (x[0::2, 0::2] + x[1::2, 0::2] + x[0::2, 1::2] + x[1::2, 1::2]) / 4


def jpeg(img: Image.Image, q: int) -> bytes:
    out = io.BytesIO()
    img.save(out, "JPEG", quality=q, subsampling=0, optimize=True, progressive=True)
    return out.getvalue()


def squeeze_jpeg(path: str) -> tuple[int, int, float]:
    src = Image.open(path).convert("RGB")
    q = QUALITY.get(os.path.basename(path).split("_")[0].split(".")[0], 90)
    data = jpeg(src, q)
    a, b = np.asarray(src), np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
    psnr = 10 * np.log10(255**2 / max(np.mean((a.astype(float) - b) ** 2), 1e-9))
    s = structural_similarity(mip1(a), mip1(b), channel_axis=2, data_range=255)
    print(f"q{q} psnr {psnr:5.1f} dB  ", end="")
    return write_if_smaller(path, (data, s))


def squeeze_png(path: str) -> tuple[int, int, float]:
    src = Image.open(path).convert("RGBA")
    q = src.quantize(256, method=Image.Quantize.FASTOCTREE).convert("RGBA")
    s = ssim(src, q)
    img = q if s >= MIN_SSIM else src
    out = io.BytesIO()
    img.save(out, "PNG", optimize=True, compress_level=9)
    return write_if_smaller(path, (out.getvalue(), s if img is q else 1.0))


def write_if_smaller(path: str, best: tuple[bytes, float] | None) -> tuple[int, int, float]:
    before = os.path.getsize(path)
    if best is None or len(best[0]) >= before:
        return before, before, 1.0
    with open(path, "wb") as f:
        f.write(best[0])
    return before, len(best[0]), best[1]


def gltf_transform(*args: str) -> None:
    subprocess.run(["pnpm", "exec", "gltf-transform", *args], cwd=os.path.dirname(HERE), check=True, capture_output=True)


def main(src: str, dst: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        gltf_transform("copy", os.path.abspath(src), f"{tmp}/m.gltf")
        total = [0, 0]
        for name in sorted(os.listdir(tmp)):
            path = f"{tmp}/{name}"
            if name.endswith((".jpg", ".jpeg")):
                b, a, s = squeeze_jpeg(path)
            elif name.endswith(".png"):
                b, a, s = squeeze_png(path)
            else:
                continue
            total[0] += b
            total[1] += a
            print(f"{name:32s} {b:>9d} -> {a:>9d}  ssim {s:.4f}")
        gltf_transform("copy", f"{tmp}/m.gltf", os.path.abspath(dst))
        print(f"textures {total[0]} -> {total[1]}  glb {os.path.getsize(src)} -> {os.path.getsize(dst)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
