#!/usr/bin/env python3
"""Puts ThreeNative (left) and Unreal (right) side by side with large labels, for the visual judge.

    python3 tools/side_by_side.py <threenative.png> <unreal.png> <out.png>
"""
import sys

from PIL import Image, ImageDraw, ImageFont

left, right, out = sys.argv[1:4]
a, b = Image.open(left).convert("RGB"), Image.open(right).convert("RGB")
sheet = Image.new("RGB", (a.width + b.width + 16, max(a.height, b.height)), "white")
sheet.paste(a, (0, 0))
sheet.paste(b, (a.width + 16, 0))
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype("DejaVuSans-Bold.ttf", 40)
except OSError:
    font = ImageFont.load_default()
for x, text in ((20, "THREENATIVE"), (a.width + 36, "UNREAL 5.8.3")):
    draw.rectangle((x - 8, a.height - 70, x + 330, a.height - 14), fill="black")
    draw.text((x, a.height - 66), text, fill="yellow", font=font)
sheet.save(out)
print("wrote", out)
