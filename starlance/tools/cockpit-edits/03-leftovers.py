# Parts 02 left floating in the window: the monitor's header pieces and the blue side wings follow the
# dash down. The source's painted HUD (lines, ticks, ring, text) goes: the game draws its own, lighter one.
import bpy, re
DROP = 1.0
FOLLOW = re.compile(r"^(Header light mounting housing|Main display header|Top vent slot|Lateral blue instrument housing|Lateral housing seam|Side 04 stencil|Side fox stencil)")
HUD = re.compile(r"^(Display line|HUD |Heading tape)")
moved = gone = 0
for o in list(bpy.data.objects):
    if FOLLOW.match(o.name):
        o.location.z -= DROP
        moved += 1
    elif HUD.match(o.name) or (o.type == "FONT" and o.location.y > -1.0 and o.location.z > 2.0):
        bpy.data.objects.remove(o, do_unlink=True)
        gone += 1
print("moved", moved, "removed", gone)
