# Lower the whole dash band (screens, consoles, yoke, sticks, pedals) by DROP and stretch the canopy
# window's lower edge down with it, so the pilot sees the ground ahead over the nose.
# Before: window bottom z 2.46, 0.34 m under the eye (z 2.8) = 3 deg below level.
import bpy, re
from mathutils import Vector
DROP = 1.0
SILL = 2.6  # window bottom 2.46 plus margin: canopy vertices under this follow the dash down
CANOPY = re.compile(r"^(Canopy|Continuous (faceted )?canopy)")
moved = 0
for o in bpy.data.objects:
    if o.type != "MESH" or o.parent is not None:
        continue
    if CANOPY.match(o.name):
        mw, inv = o.matrix_world, o.matrix_world.inverted()
        for v in o.data.vertices:
            w = mw @ v.co
            if w.z < SILL:
                v.co = inv @ Vector((w.x, w.y, w.z - DROP))
        o.data.update()
        continue
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    if max(b.z for b in bb) < 3.3 and sum(b.z for b in bb) / 8 < SILL:
        o.location.z -= DROP
        moved += 1
print("moved", moved)
