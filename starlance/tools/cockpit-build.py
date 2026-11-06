"""Builds assets/cockpit.glb from the source cockpit .blend. Run:

  blender -b <cockpit.blend> --python tools/cockpit-build.py -- <out.glb>
  pnpm exec gltf-transform optimize <out.glb> assets/cockpit.glb --flatten false --join false \
    --instance false --palette false --compress false --vertex-layout separate --texture-compress false
  pnpm exec gltf-transform jpeg assets/cockpit.glb assets/cockpit.glb --formats png \
    --slots metallicRoughnessTexture --quality 85

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
import numpy as np
import bpy
from mathutils import Vector

OUT = sys.argv[-1]

DROP = re.compile(
    r"^(HUD |Yoke face inset|Heading tape|Canopy inner glazing|"
    r"Red fox insignia|Tactical fighter display|Crew communications display|Radar display|"
    r"Lower communications console|Lower weapons console|Crew portrait|Radar contact|Signal bar|"
    r"Comms indicator|Status gauge)"
)
STICK = re.compile(r"^(Ergonomic grip|Grip armored cap|Grip cap inset|Grip cap screw|Trigger black surround)")
TRIGGER = re.compile(r"^Trigger luminous red")
YOKE = re.compile(r"^(Yoke center shell|Yoke metal shaft|Yoke arm|Yoke pivot|Yoke crossbar|Yoke centerpiece|Yoke fox stencil)")
PEDAL = re.compile(r"^(Pilot pedal|Pedal grip)")
LAMP = re.compile(r"^Switch lens")

# The canopy window's outline (the glazing sheet is dropped below), in Blender x, z at y = 0.1.
_glass = bpy.data.objects["Canopy inner glazing"]
WINDOW = [(v.co.x, v.co.z) for v in _glass.data.vertices]
WINDOW_Y = 0.42  # the back of the canopy frame
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
    "stick_L": (-1.0, -2.2, -0.45),
    "stick_R": (1.0, -2.2, -0.45),
    "yoke": (0.0, -1.5, -0.5),  # the base of the shaft, so the handle leans about its foot
    "pedal_L": (-0.82, -1.24, -0.85),
    "pedal_R": (0.82, -1.24, -0.85),
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
# Shorter and a little thicker, so a grip clears the lower screens (it sits nearer the eye than they do,
# so it projects outward over them): the cockpit's source grips are 1.3 m tall.
for s in "LR":
    nodes["stick_" + s].scale = (1.0, 1.0, 0.6)
# The yoke is one rigid group (hub, two grips, column) on one pivot at the column foot, lifted so a stub
# of the column shows under the head at the bottom edge.
nodes["yoke"].location.z += 0.2


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


TH = (-1.68, -0.3, -0.05)  # a vertical throttle slot beside the stores screen; the knob slides up to boost
throttle = empty("throttle", TH)
box("throttle_slot", (0.1, 0.04, 0.56), TH, "Soft black rubber")
box("throttle_rail", (0.02, 0.05, 0.5), (TH[0], TH[1] - 0.005, TH[2]), "Edge steel")
box("throttle_knob", (0.17, 0.08, 0.07), (TH[0], TH[1] - 0.05, TH[2]), "Edge steel", throttle)
box("throttle_grip", (0.12, 0.09, 0.025), (TH[0], TH[1] - 0.052, TH[2]), "Amber switch lights", throttle)


def canopy_plate():
    """The roof and cheek panels round the canopy window. The source scene frames the arch tight; a
    wider lens past it looked out over its edges, so this solid sheet (hole = the window) closes them."""
    cx = sum(p[0] for p in WINDOW) / len(WINDOW)
    cz = sum(p[1] for p in WINDOW) / len(WINDOW)
    # Convex window, ordered by angle round its centre.
    ring = sorted(WINDOW, key=lambda p: math.atan2(p[1] - cz, p[0] - cx))
    X0, X1, Z0, Z1 = -14.0, 14.0, -1.0, 14.0
    outer = []
    for x, z in ring:  # push each window vertex radially out to the big rectangle
        dx, dz = x - cx, z - cz
        k = min(
            ((X1 if dx > 0 else X0) - cx) / dx if dx else 1e9,
            ((Z1 if dz > 0 else Z0) - cz) / dz if dz else 1e9,
        )
        outer.append((cx + dx * k, cz + dz * k))
    bm = bmesh.new()
    inner_v = [bm.verts.new((x, WINDOW_Y, z)) for x, z in ring]
    outer_v = [bm.verts.new((x, WINDOW_Y, z)) for x, z in outer]
    corners = {c: bm.verts.new((c[0], WINDOW_Y, c[1])) for c in ((X0, Z0), (X1, Z0), (X1, Z1), (X0, Z1))}
    n = len(ring)
    for i in range(n):
        j = (i + 1) % n
        a, b = outer[i], outer[j]
        quad = [inner_v[i], inner_v[j], outer_v[j], outer_v[i]]
        bm.faces.new(quad)
        # Consecutive outer points on different rectangle edges leave a corner to fill.
        for (cxx, czz), cv in corners.items():
            if all(abs(p[0] - cxx) < 1e-6 or abs(p[1] - czz) < 1e-6 for p in (a, b)) and a[0] != b[0] and a[1] != b[1]:
                bm.faces.new([outer_v[i], outer_v[j], cv])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:  # face the pilot (-Y), double-sided anyway
        if f.normal.y > 0:
            f.normal_flip()
    me = bpy.data.meshes.new("canopy_plate")
    bm.to_mesh(me)
    bm.free()
    lining = bpy.data.materials.new("Cockpit headliner")
    lining.use_nodes = True
    bsdf = next(n for n in lining.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.004, 0.004, 0.005, 1)
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.0
    me.materials.append(lining)
    o = bpy.data.objects.new("static_canopy_plate", me)
    bpy.context.scene.collection.objects.link(o)
    uv = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        v = me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = (v.x * 0.25, v.z * 0.25)
    return o


canopy_plate()


BRAND_IMAGES = {"emblem-alpha", "wordmark-alpha", "spear-alpha.png"}  # keyed marks (alpha) in the .blend

# Red trigger caps on the two handgrips (the arms), in the yoke group.
_red = bpy.data.materials.get("Red switch") or bpy.data.materials.new("Red switch")
for sx in (-1, 1):
    box("yoke_cap_" + ("L" if sx < 0 else "R"), (0.13, 0.07, 0.13), (sx * 0.66, -2.03, 0.72), _red.name, nodes["yoke"])

# 6b. ambient occlusion into vertex colours (COLOR_0 multiplies the albedo): every seam, bevel and
# corner reads dark, and the interior sits under its canopy. Baked at the rest pose.

AO_FLOOR = 0.22  # the darkest a fully-enclosed vertex gets
AO_SKIP = re.compile(r"^(lamp_|brand_|throttle_grip)")
meshes = [o for o in bpy.data.objects if o.type == "MESH" and not AO_SKIP.match(o.name)]
for o in meshes:
    if "AO" not in o.data.color_attributes:
        o.data.color_attributes.new(name="AO", type="BYTE_COLOR", domain="CORNER")
    o.data.color_attributes.active_color = o.data.color_attributes["AO"]
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = int(os.environ.get("AO_SAMPLES", "32"))
if scene.world is None:
    scene.world = bpy.data.worlds.new("w")
scene.world.light_settings.distance = 0.9
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
for o in meshes:
    attr = o.data.color_attributes["AO"]
    buf = np.zeros(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get("color", buf)
    buf = buf.reshape(-1, 4)
    buf[:, :3] = AO_FLOOR + (1 - AO_FLOOR) * buf[:, :3]
    if o.name.startswith("static_canopy_plate"):
        buf[:, :3] = 0.15  # a lining behind the frame: never lit by the sky
    attr.data.foreach_set("color", buf.reshape(-1))
print("AO baked on", len(meshes), "meshes")

# Edge wear mask for the material look: a second UV layer "WEAR" (TEXCOORD_1 in the glb),
# u = convexity (outer edges, where paint chips), v = concavity (seams, where grime gathers).
for o in meshes:
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    convex = np.zeros(len(bm.verts), dtype=np.float32)
    concave = np.zeros(len(bm.verts), dtype=np.float32)
    count = np.zeros(len(bm.verts), dtype=np.float32)
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        a = e.calc_face_angle_signed(0.0)
        for v in e.verts:
            count[v.index] += 1
            if a > 0:
                convex[v.index] += a
            else:
                concave[v.index] -= a
    bm.free()
    count = np.maximum(count, 1)
    convex = np.clip(convex / count / 0.6, 0, 1)  # 0.6 rad of mean bend is fully convex
    concave = np.clip(concave / count / 0.6, 0, 1)
    loops = np.zeros(len(me.loops), dtype=np.int32)
    me.loops.foreach_get("vertex_index", loops)
    # Shipped as a second UV set (TEXCOORD_1): u = convexity, v = concavity. A second colour attribute
    # (COLOR_1) loses the web renderer, and AO already rides COLOR_0.
    wear = me.uv_layers.new(name="WEAR")
    uv = np.stack([convex[loops], concave[loops]], axis=1).astype(np.float32)
    wear.data.foreach_set("uv", uv.reshape(-1))
    me.color_attributes.active_color = me.color_attributes["AO"]

# 7. export -------------------------------------------------------------------------------------
for i in list(bpy.data.images):
    if i.users == 0:
        bpy.data.images.remove(i)
        continue
    brand = i.name in BRAND_IMAGES  # keyed marks keep their alpha
    limit = 512 if brand else 1024
    if max(i.size) > limit:
        k = limit / max(i.size)
        i.scale(round(i.size[0] * k), round(i.size[1] * k))
    i.file_format = "PNG" if brand else "JPEG"
bpy.ops.outliner.orphans_purge(do_recursive=True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_cameras=False,
    export_lights=False,
    export_yup=True,
    export_image_format="AUTO",
    export_jpeg_quality=85,
    export_vertex_color="ACTIVE",
    export_active_vertex_color_when_no_material=True,
    use_visible=False,
)
