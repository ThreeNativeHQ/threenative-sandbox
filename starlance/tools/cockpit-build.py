"""Builds assets/cockpit.glb from the source cockpit .blend. Run:

  blender -b <cockpit.blend> --python tools/cockpit-build.py -- <out.glb>
  pnpm exec gltf-transform optimize <out.glb> assets/cockpit.glb --flatten false --join false \
    --instance false --palette false --compress false --vertex-layout separate --texture-compress false

What it does: drops the hidden, text, light, camera, glazing, screen-texture and third-party-brand
objects; replaces the brand marks with Starlance's (tools/cockpit-brand/*.png); joins the static
parts per material; and keeps the moving parts as named nodes that src/render/cockpit.ts drives:
stick_L/R (+ trigger_L/R), yoke, pedal_L/R, throttle, lamp_L0..3 / lamp_R0..3.
"""

import math
import os
import re
import sys

import bmesh
import bpy
from mathutils import Vector

OUT = sys.argv[-1]
BRAND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cockpit-brand")

DROP = re.compile(
    r"^(HUD |Heading tape|Canopy inner glazing|Side 04 stencil|Side fox stencil|Yoke fox stencil|"
    r"Red fox insignia|Tactical fighter display|Crew communications display|Radar display|"
    r"Lower communications console|Lower weapons console|Crew portrait|Radar contact|Signal bar|"
    r"Comms indicator|Status gauge)"
)
STICK = re.compile(r"^(Ergonomic grip|Grip armored cap|Grip cap inset|Grip cap screw|Trigger black surround)")
TRIGGER = re.compile(r"^Trigger luminous red")
YOKE = re.compile(r"^(Yoke center shell|Yoke face inset|Yoke arm|Yoke pivot|Yoke crossbar|Yoke centerpiece)")
PEDAL = re.compile(r"^(Pilot pedal|Pedal grip)")
LAMP = re.compile(r"^Switch lens")

# 1. drop what must not ship -----------------------------------------------------------------
for o in list(bpy.data.objects):
    if o.type != "MESH" or o.hide_render or DROP.match(o.name):
        bpy.data.objects.remove(o, do_unlink=True)

# 2. bake modifiers (bevel, weighted normal) into the meshes ------------------------------------
for o in list(bpy.data.objects):
    if o.modifiers:
        with bpy.context.temp_override(
            object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]
        ):
            bpy.ops.object.convert(target="MESH")


# One UV layer, one name: join() keeps the first object's layer and drops the rest into other layers,
# which would leave the joined faces with empty UVs (a stipple through every normal map).
for o in bpy.data.objects:
    if o.type == "MESH":
        layers = o.data.uv_layers
        if not layers:
            layers.new(name="UVMap")
        while len(layers) > 1:
            layers.remove(layers[-1])
        layers[0].name = "UVMap"


def cx(o):
    return sum((o.matrix_world @ Vector(c)).x for c in o.bound_box) / 8


def side(o):
    return "L" if cx(o) < 0 else "R"


# 3. classify ---------------------------------------------------------------------------------
groups = {}
lamps = {"L": [], "R": []}
for o in list(bpy.data.objects):
    n = o.name
    if LAMP.match(n):
        lamps[side(o)].append(o)
        continue
    if TRIGGER.match(n):
        key = "trigger_" + side(o)
    elif STICK.match(n):
        key = "stick_" + side(o)
    elif YOKE.match(n):
        key = "yoke"
    elif PEDAL.match(n):
        key = "pedal_" + side(o)
    else:
        key = "static"
    groups.setdefault(key, []).append(o)


def join(objs):
    if len(objs) > 1:
        with bpy.context.temp_override(
            active_object=objs[0], selected_editable_objects=objs, selected_objects=objs
        ):
            bpy.ops.object.join()
    return objs[0]


def mat_key(o):
    return o.material_slots[0].material.name if o.material_slots and o.material_slots[0].material else ""


joined = {}
for key, objs in groups.items():
    by_mat = {}
    for o in objs:
        by_mat.setdefault(mat_key(o), []).append(o)
    joined[key] = [join(v) for v in by_mat.values()]
    for o in joined[key]:
        o.name = key + "_" + (mat_key(o) or "mesh")[:20]

# 4. own the lamp and trigger lights: each needs its own material, and gltf-transform's dedup merges
# identical ones, so each copy gets a distinct 2% step of base-colour red.
serial = [0]


def own(o, name):
    m = o.material_slots[0].material.copy()
    m.name = name
    serial[0] += 1
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    c = list(bsdf.inputs["Base Color"].default_value)
    c[0] = c[0] * (1 - 0.02 * serial[0])
    bsdf.inputs["Base Color"].default_value = c
    o.material_slots[0].material = m


for s in "LR":
    for i, o in enumerate(sorted(lamps[s], key=lambda o: o.location.z)):
        o.name = "lamp_%s%d" % (s, i)
        own(o, o.name)
    for o in joined.get("trigger_" + s, []):
        own(o, "trigger_" + s)


# 5. pivots -------------------------------------------------------------------------------------
def empty(name, loc, parent=None):
    e = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(e)
    e.location = loc
    bpy.context.view_layer.update()  # matrix_world is stale until then, and adopt() inverts it
    if parent is not None:
        e.parent = parent
        e.matrix_parent_inverse = parent.matrix_world.inverted()
    return e


def adopt(o, parent):
    world = o.matrix_world.copy()
    o.parent = parent
    o.matrix_parent_inverse = parent.matrix_world.inverted()
    o.matrix_world = world


pivots = {
    "stick_L": (-1.0, -2.2, 0.55),
    "stick_R": (1.0, -2.2, 0.55),
    "yoke": (0.0, -1.86, 1.3),
    "pedal_L": (-0.82, -1.24, 0.15),
    "pedal_R": (0.82, -1.24, 0.15),
}
nodes = {}
for name, loc in pivots.items():
    nodes[name] = empty(name, loc)
    for o in joined.get(name, []):
        adopt(o, nodes[name])
for s in "LR":
    for o in joined.get("trigger_" + s, []):
        o.name = "trigger_" + s
        adopt(o, nodes["stick_" + s])


# 6. new parts: throttle slider beside the stores screen, Starlance marks ---------------------------------
def box(name, size, centre, mat, parent=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + Vector(centre)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(bpy.data.materials[mat])
    if parent is not None:
        adopt(o, parent)
    return o


TH = (-1.68, -0.3, 0.95)  # a vertical throttle slot beside the stores screen; the knob slides up to boost
throttle = empty("throttle", TH)
box("throttle_slot", (0.1, 0.04, 0.56), TH, "Soft black rubber")
box("throttle_rail", (0.02, 0.05, 0.5), (TH[0], TH[1] - 0.005, TH[2]), "Edge steel")
box("throttle_knob", (0.17, 0.08, 0.07), (TH[0], TH[1] - 0.05, TH[2]), "Edge steel", throttle)
box("throttle_grip", (0.12, 0.09, 0.025), (TH[0], TH[1] - 0.052, TH[2]), "Amber switch lights", throttle)


def decal(name, x0, x1, z0, z1, y, png, parent=None):
    """A flat, glowing panel facing the pilot (-Y) carrying one Starlance mark."""
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new("UVMap")
    for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = (u, v)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    img = bpy.data.images.load(os.path.join(BRAND, png))
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    tex = m.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    m.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    m.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 0.8
    bsdf.inputs["Roughness"].default_value = 0.6
    me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if parent is not None:
        adopt(o, parent)


decal("brand_wall_L", -4.05, -3.57, 2.62, 3.1, -0.135, "emblem.png")
decal("brand_wall_R", 3.59, 4.13, 2.64, 3.12, -0.135, "wordmark.png")
decal("brand_yoke", -0.21, 0.21, 1.27, 1.64, -2.1, "yoke.png", nodes["yoke"])

# 7. export -------------------------------------------------------------------------------------
for i in list(bpy.data.images):
    if i.users == 0:
        bpy.data.images.remove(i)
    elif i.size[0] > 1024:
        i.scale(1024, 1024)
bpy.ops.outliner.orphans_purge(do_recursive=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_cameras=False,
    export_lights=False,
    export_yup=True,
    export_image_format="JPEG",
    export_jpeg_quality=85,
    use_visible=False,
)
