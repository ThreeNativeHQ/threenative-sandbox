# Rebrand the cockpit screen textures: keep the original clean screens, inpaint only the third-party parts
# (ship name, ship diagram, crew, G-DIFF, SMART BOMB, falcon mark) and draw Starlance art in their place.
# Run: uv run --with numpy --with pillow --with opencv-python-headless python -I rebrand.py <shipwire.png> <font-dir>
import sys, os
import numpy as np, cv2
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SRC = "/home/joao/Downloads/cockpit-recreation"
HERE = os.path.dirname(os.path.abspath(__file__))
CREW = os.path.join(HERE, "../../assets/crew")
ship_png, fonts = sys.argv[1], sys.argv[2]
RAJ = os.path.join(fonts, "Rajdhani-Bold.ttf")
DJB = "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf"
DJBO = "/usr/share/fonts/TTF/DejaVuSans-BoldOblique.ttf"


def inpaint(img, boxes, thr=10, grow=9):
    """Remove bright strokes inside boxes: mask = brighter than the box's dark background, then Telea inpaint."""
    a = np.asarray(img.convert("RGB")).copy()
    lum = a.mean(2).astype(np.float32)
    m = np.zeros(lum.shape, np.uint8)
    for x0, y0, x1, y1 in boxes:
        box = lum[y0:y1, x0:x1]
        m[y0:y1, x0:x1] = (box > np.percentile(box, 30) + thr) * 255
    m = cv2.dilate(m, np.ones((grow, grow), np.uint8))
    return Image.fromarray(cv2.inpaint(a, m, 9, cv2.INPAINT_TELEA))


def glow_text(img, xy, text, font, fill, glow=(80, 200, 255), r=4):
    layer = Image.new("RGBA", img.size)
    ImageDraw.Draw(layer).text(xy, text, font=font, fill=glow + (150,))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(r)))
    ImageDraw.Draw(img).text(xy, text, font=font, fill=fill)


def soft_text(img, xy, text, font, fill=(206, 222, 236)):
    """Match the source labels: a little wider, slightly soft, faint blue bloom."""
    layer = Image.new("RGBA", img.size)
    ImageDraw.Draw(layer).text(xy, text, font=font, fill=fill + (255,))
    bb = layer.getbbox()
    piece = layer.crop(bb)
    piece = piece.resize((round(piece.width * 1.12), piece.height), Image.LANCZOS)
    layer = Image.new("RGBA", img.size)
    layer.alpha_composite(piece, (bb[0], bb[1]))
    bloom = Image.new("RGBA", img.size, (90, 170, 255, 0))
    bloom.putalpha(layer.getchannel("A").point(lambda v: v * 0.45).filter(ImageFilter.GaussianBlur(5)))
    img.alpha_composite(bloom)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(0.9)))


def ship_layer(size, color, wire=False):
    s = Image.open(ship_png).convert("RGBA")
    s = s.crop(s.getbbox())
    s.thumbnail(size, Image.LANCZOS)
    a = np.asarray(s).astype(np.float32)
    lum = a[..., :3].mean(2) / 255.0
    out = np.zeros_like(a)
    if wire:  # bright edge lines over a dim see-through fill, like a hologram schematic
        line = lum > 0.6
        out[..., :3] = np.array(color, np.float32) * np.where(line, 1.15, 0.5)[..., None]
        out[..., 3] = a[..., 3] * np.where(line, 1.0, 0.28)
    else:
        out[..., :3] = np.array(color, np.float32) * (0.55 + 0.6 * lum[..., None])
        out[..., 3] = a[..., 3]
    s = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    g = Image.new("RGBA", s.size)
    g.alpha_composite(s.filter(ImageFilter.GaussianBlur(6)))
    g.alpha_composite(s)
    return g


def rounded(w, h, r):
    m = Image.new("L", (w, h))
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), r, fill=255)
    return m


# Centre display: LANCER 04 / STARLANCE and our starfighter instead of ARWING 04 / STAR FOX and the Arwing.
c = inpaint(Image.open(f"{SRC}/center-clean.png"), [(10, 25, 320, 145), (100, 80, 680, 445)], thr=20, grow=13).convert("RGBA")
glow_text(c, (22, 18), "LANCER 04", ImageFont.truetype(RAJ, 66), (226, 242, 255))
glow_text(c, (24, 92), "STARLANCE", ImageFont.truetype(RAJ, 44), (210, 232, 250))
sh = ship_layer((560, 330), (110, 205, 255), wire=True)
c.alpha_composite(sh, (390 - sh.width // 2, 270 - sh.height // 2))
c.convert("RGB").save(f"{HERE}/sl-center.png")

# Crew strip: Lancer (eagle, highlighted), Kestrel (lynx), Vega (otter), Bram (badger) in the four frames.
crew = Image.open(f"{SRC}/crew-clean.png").convert("RGBA")
SLOTS = [(36, 30, 314, 322), (346, 44, 546, 290), (581, 44, 762, 290), (797, 44, 994, 283)]
faces = []
for n in ("lancer", "kestrel", "vega"):
    faces.append(Image.open(f"{CREW}/{n}.png").convert("RGBA").crop((86, 72, 426, 442)))
bram = Image.open(f"{HERE}/crew-bram.png").convert("RGBA")
faces.append(bram.crop((260, 120, 1340, 1300)))
for (x0, y0, x1, y1), f in zip(SLOTS, faces):
    w, h = x1 - x0, y1 - y0
    k = max(w / f.width, h / f.height)
    f = f.resize((round(f.width * k), round(f.height * k)), Image.LANCZOS)
    f = f.crop(((f.width - w) // 2, 0, (f.width - w) // 2 + w, h))
    crew.paste(f, (x0, y0), rounded(w, h, 12))
crew.convert("RGB").save(f"{HERE}/sl-crew.png")

# Lower consoles: every label is inpainted and redrawn in one style, so no new word sits next to an old one.
# Comms: COMMS, SHLD (was G-DIFF), WPN, NAV. The /// tick marks and lamps stay.
cm = inpaint(Image.open(f"{SRC}/comms-clean.png"),
             [(200, 5, 540, 72), (200, 100, 560, 190), (200, 218, 480, 312), (200, 350, 480, 470)], thr=6, grow=15).convert("RGBA")
sel = Image.new("RGBA", cm.size)  # the active row, lit like the stores screen's selected LASER
ImageDraw.Draw(sel).rounded_rectangle((200, 2, 512, 84), 10, fill=(40, 190, 120, 150))
cm.alpha_composite(sel.filter(ImageFilter.GaussianBlur(1.5)))
F = ImageFont.truetype(DJB, 66)
for y, t in ((6, "COMMS"), (110, "SHLD"), (232, "WPN"), (362, "NAV")):
    soft_text(cm, (216, y), t, F)
cm.convert("RGB").save(f"{HERE}/sl-comms.png")

# Weapons: LASER (selected bar), BLASTER, BOMB, LOCK-ON (was SMART BOMB); our ship icon in the selector box.
wp = inpaint(Image.open(f"{SRC}/weapons-clean.png"),
             [(26, 34, 232, 160), (262, 46, 492, 106), (232, 135, 520, 210), (195, 228, 410, 310), (150, 335, 600, 448)], thr=6, grow=15
             ).convert("RGBA")
ic = ship_layer((180, 108), (110, 235, 190))
wp.alpha_composite(ic, (128 - ic.width // 2, 96 - ic.height // 2))
F = ImageFont.truetype(DJBO, 60)
soft_text(wp, (276, 44), "LASER", F, fill=(226, 255, 238))
for x, y, t in ((262, 146), (240, 246), (214, 356)) and ((262, 146, "BLASTER"), (240, 246, "BOMB"), (214, 356, "LOCK-ON")):
    soft_text(wp, (x, y), t, F)
wp.convert("RGB").save(f"{HERE}/sl-weapons.png")

# Hull marks: the Starlance emblem on a canvas with each decal plane's aspect, lightly weathered.
em = Image.open(f"{HERE}/emblem-alpha.png").convert("RGBA")
rng = np.random.default_rng(4)
for name, aspect in (("sl-mark-side", 0.58 / 0.45), ("sl-mark-yoke", 0.41 / 0.37)):
    H = 512
    W = round(H * aspect)
    cv = Image.new("RGBA", (W, H))
    e = em.copy()
    e.thumbnail((W * 0.92, H * 0.92), Image.LANCZOS)
    cv.alpha_composite(e, ((W - e.width) // 2, (H - e.height) // 2))
    a = np.asarray(cv).astype(np.float32)
    wear = cv2.GaussianBlur(rng.random((H, W)).astype(np.float32), (0, 0), 9)
    wear = (wear - wear.min()) / (np.ptp(wear) + 1e-6)
    wear = np.where(wear < 0.22, 0.25, 0.92)  # a few chipped patches, not salt-and-pepper
    wear = cv2.GaussianBlur(wear.astype(np.float32), (0, 0), 1.2)
    a[..., 3] *= wear
    Image.fromarray(a.astype(np.uint8)).save(f"{HERE}/{name}.png")
print("ok")
