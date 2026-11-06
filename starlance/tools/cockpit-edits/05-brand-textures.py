# Swap every third-party mark and screen picture for Starlance art (tools/cockpit-brand/), and drop the
# leftover legend text (crew names, ship name, codes): the game draws its own screens.
import bpy, os
BRAND = "/home/joao/projects/threenative/sandbox/starlance/tools/cockpit-brand"
SWAP = {
    "mark-fox.png": "emblem-alpha.png",
    "mark-04-stencil.png": "wordmark-alpha.png",
    "center-clean.png": "screen-center.png",
    "crew-clean.png": "crew-strip.png",
    "radar-clean.png": "screen-radar.png",
    "comms-clean.png": "screen-comms.png",
    "weapons-clean.png": "screen-weapons.png",
}
for old, new in SWAP.items():
    im = bpy.data.images.get(old) or bpy.data.images.get(os.path.splitext(new)[0])
    if im is None:
        print("missing", old)
        continue
    if im.packed_file:  # a packed image ignores its filepath on reload
        im.unpack(method="REMOVE")
    im.filepath = os.path.join(BRAND, new)
    im.alpha_mode = "STRAIGHT"
    im.reload()
    im.pack()
    im.name = os.path.splitext(new)[0]
# The yoke carries the bare spear, not the full emblem.
yoke = bpy.data.objects.get("Yoke fox stencil")
if yoke is not None:
    spear = bpy.data.images.load(os.path.join(BRAND, "spear-alpha.png"), check_existing=True)
    m = yoke.active_material.copy()
    for n in m.node_tree.nodes:
        if n.type == "TEX_IMAGE":
            n.image = spear
    yoke.active_material = m
gone = 0
for o in list(bpy.data.objects):
    if o.type == "FONT":
        bpy.data.objects.remove(o, do_unlink=True)
        gone += 1
print("text removed", gone)
