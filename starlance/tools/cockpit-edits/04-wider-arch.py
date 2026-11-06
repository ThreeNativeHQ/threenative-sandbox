# Wider, taller canopy: the pillars spread sideways by SX and the roof rises by RAISE, blended in above
# z 3.0, so the frame sits at the edge of a 55 deg view instead of across it. Replaces the build's
# OPEN_X / OPEN_Z rim stretch (set to 1.0 there).
import bpy, re
from mathutils import Vector
SX, RAISE = 1.3, 1.0
CANOPY = re.compile(r"^(Canopy|Continuous (faceted )?canopy)")
ARCH = re.compile(r"^(Roof corner reinforcement|Roof vent inset|Overhead lamp backing|Overhead amber lens|Faceted canopy inset plate)")

def f(p):
    s = min(max((p.z - 3.0) / 1.3, 0.0), 1.0)
    s = s * s * (3 - 2 * s)
    return Vector((p.x * SX, p.y, p.z + RAISE * s))

n = 0
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    if CANOPY.match(o.name):
        mw, inv = o.matrix_world, o.matrix_world.inverted()
        for v in o.data.vertices:
            v.co = inv @ f(mw @ v.co)
        o.data.update()
        n += 1
    elif ARCH.match(o.name):
        c = sum((o.matrix_world @ Vector(b) for b in o.bound_box), Vector()) / 8
        o.location += f(c) - c
        n += 1
print("edited", n)
