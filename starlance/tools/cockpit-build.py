"""Builds assets/cockpit.glb from the source cockpit .blend. Run:

  blender -b <cockpit.blend> --python tools/cockpit-build.py -- <out.glb>
  pnpm exec gltf-transform optimize <out.glb> assets/cockpit.glb --flatten false --join false \
    --instance false --palette false --compress false --vertex-layout separate --texture-compress false
  pnpm exec gltf-transform jpeg assets/cockpit.glb assets/cockpit.glb --formats png \
    --slots metallicRoughnessTexture --quality 85
  uv run --with pillow --with numpy --with scikit-image python -I tools/texture-squeeze.py \
    assets/cockpit.glb assets/cockpit.glb

What it does: drops the hidden, text, light, camera, glazing, screen-texture and third-party-brand
objects; replaces the brand marks with Starlance's (tools/cockpit-brand/*.png); joins the static
parts per material; and keeps the moving parts as named nodes that src/render/cockpit.ts drives:
yoke (hub, arms, grips and column on one pivot, with trigger_L/R), pedal_L/R, throttle,
lamp_L0..3 / lamp_R0..3.
"""

import os
import re
import sys

import bmesh
import numpy as np
import bpy
from mathutils import Vector

OUT = sys.argv[-1]

DROP = re.compile(
    r"^(HUD |Display line|Outside view backdrop|Yoke face inset|Heading tape|Canopy inner glazing|"
    r"Red fox insignia|Tactical fighter display|Crew communications display|Radar display|"
    r"Lower communications console|Lower weapons console|Crew portrait|Radar contact|Signal bar|"
    r"Comms indicator|Status gauge)"
)
STICK = re.compile(r"^(Ergonomic grip|Grip armored cap|Grip cap inset|Grip cap screw|Trigger black surround)")
TRIGGER = re.compile(r"^Trigger luminous red")
YOKE = re.compile(r"^(Yoke center shell|Yoke metal shaft|Yoke arm|Yoke pivot|Yoke crossbar|Yoke centerpiece|Yoke Starlance emblem)")
PEDAL = re.compile(r"^(Pilot pedal|Pedal grip)")
LAMP = re.compile(r"^Switch lens")

# The yoke rig (yoke_pitch > yoke_roll > hub, arms, grips) is keyframed for the Blender preview: ship
# its rest pose only; the game drives the one "yoke" node itself.
bpy.context.scene.frame_set(1)
for o in bpy.data.objects:
    o.animation_data_clear()
# Collections outside the scene (Cycles light linking) would keep joined-away objects alive.
_linked = set(bpy.context.scene.collection.children_recursive)
for c in list(bpy.data.collections):
    if c not in _linked:
        bpy.data.collections.remove(c)
YOKE_FOOT = tuple(bpy.data.objects["yoke_pitch"].matrix_world.translation)
for o in bpy.data.objects:  # step 1 deletes the rig's empties: keep their children where they stand
    if o.parent is not None:
        world = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = world
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


# The wing housings are one extruded profile cut off square at the pilot's end, a flat wall facing the
# eye. The real wing sweeps on: pull the tail rearward and shrink it toward its outer-bottom corner.
def taper_housing(o, reach=2.4, back=1.6, pinch=0.8):
    side = 1.0 if o.data.vertices[0].co.x > 0 else -1.0
    pivot = (6.0 * side, 1.9)
    y0 = -0.13
    for v in o.data.vertices:
        t = max(0.0, min(1.0, 1.0 - (v.co.y - y0) / reach))
        t *= t
        k = 1.0 - pinch * t
        v.co.x = pivot[0] + (v.co.x - pivot[0]) * k
        v.co.z = pivot[1] + (v.co.z - pivot[1]) * k
        v.co.y -= back * t
    o.data.update()
    # the baked weighted normals are stale after the move: recompute them from the new faces
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
        bpy.ops.object.shade_smooth()
for o in list(bpy.data.objects):
    if o.name.startswith("Lateral blue instrument housing"):
        taper_housing(o)


# glTF carries image maps, not node graphs: the .blend's grime, AO and hue nodes would export as
# nothing. Wire each PBR map straight into its socket (cockpitLook.ts owns the tint and the wear) and
# drop links the exporter cannot follow. The hull paint keeps the name cockpitLook.ts finishes.
RENAME = {"Cobalt chipped paint": "Cobalt painted armor", "Console worn steel (shell)": "Console worn steel"}
for o in bpy.data.objects:
    for slot in o.material_slots:
        if slot.material and slot.material.name in RENAME:
            slot.material = bpy.data.materials.get(RENAME[slot.material.name]) or slot.material
for name, new in RENAME.items():
    m = bpy.data.materials.get(name)
    if m is not None and new not in bpy.data.materials:
        m.name = new
SOCKET = {"_Color": "Base Color", "_Roughness": "Roughness", "_Metalness": "Metallic"}
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    nt = m.node_tree
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        continue
    for name in ("Base Color", "Roughness", "Metallic", "Normal", "Alpha", "Emission Color"):
        sock = bsdf.inputs[name]
        if sock.is_linked and sock.links[0].from_node.type not in ("TEX_IMAGE", "NORMAL_MAP"):
            nt.links.remove(sock.links[0])
    for n in nt.nodes:
        if n.type == "TEX_IMAGE" and n.image:
            for tag, name in SOCKET.items():
                if tag in n.image.name and not bsdf.inputs[name].is_linked:
                    nt.links.new(n.outputs["Color"], bsdf.inputs[name])
        if n.type == "NORMAL_MAP" and not bsdf.inputs["Normal"].is_linked:
            nt.links.new(n.outputs["Normal"], bsdf.inputs["Normal"])
    if m.name == "Cobalt painted armor" and bsdf.inputs["Base Color"].is_linked:
        nt.links.remove(bsdf.inputs["Base Color"].links[0])  # the scan is re-hued in Blender: ship the tint only
        bsdf.inputs["Base Color"].default_value = (0.04, 0.13, 0.62, 1)

# Box-project UVs (1 unit = 1.25 m) onto parts modelled without any: the hull pods and console shells.
for o in bpy.data.objects:
    if o.type == "MESH" and not o.data.uv_layers:
        me = o.data
        uv = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            n = poly.normal
            ax = max(range(3), key=lambda i: abs(n[i]))
            a, b = [i for i in range(3) if i != ax]
            for li in poly.loop_indices:
                co = o.matrix_world @ me.vertices[me.loops[li].vertex_index].co
                uv.data[li].uv = (co[a] * 0.8, co[b] * 0.8)

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
    elif STICK.match(n) or YOKE.match(n):
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
    "yoke": YOKE_FOOT,  # the column foot, so the handle leans about it
    "pedal_L": (-0.82, -1.24, -0.22),
    "pedal_R": (0.82, -1.24, -0.22),
}
nodes = {}
for name, loc in pivots.items():
    nodes[name] = empty(name, loc)
    for o in joined.get(name, []):
        adopt(o, nodes[name])
for s in "LR":
    for o in joined.get("trigger_" + s, []):
        o.name = "trigger_" + s
        adopt(o, nodes["yoke"])


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


TH = (-1.68, -0.3, 0.55)  # a vertical throttle slot beside the stores screen; the knob slides up to boost
throttle = empty("throttle", TH)
box("throttle_slot", (0.1, 0.04, 0.56), TH, "Soft black rubber")
box("throttle_rail", (0.02, 0.05, 0.5), (TH[0], TH[1] - 0.005, TH[2]), "Edge steel")
box("throttle_knob", (0.17, 0.08, 0.07), (TH[0], TH[1] - 0.05, TH[2]), "Edge steel", throttle)
box("throttle_grip", (0.12, 0.09, 0.025), (TH[0], TH[1] - 0.052, TH[2]), "Amber switch lights", throttle)


BRAND_IMAGES = {"emblem-alpha", "wordmark-alpha", "spear-alpha.png"}  # keyed marks (alpha) in the .blend


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
