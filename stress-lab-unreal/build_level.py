"""Builds /Game/Stress: the ThreeNative stress lab (`stress-lab/src/scenes/Stress.ts`, `real` preset) in
stock Unreal Engine 5.8.3. Runs in the editor, then quits:

    UnrealEditor StressLab.uproject -RenderOffscreen -unattended -nosplash -nosound -stdout \
        -ExecutePythonScript=<abs path>/build_level.py

Same numbers as Stress.ts: the seeded random (createRandom(4242), an LCG), its call order, the world
size in metres, the layer counts and every colour from `src/render/stress.ts`. The level starts from
the stock default level (/Engine/Maps/Templates/Template_Default: sun, Sky Atmosphere, sky light,
volumetric clouds, height fog), which is the look the ThreeNative sky copies.

three.js is Y up, right-handed, metres. Unreal is Z up, left-handed, centimetres: (x, y, z) maps to
(x, z, y) * 100, as in the engine repo's tools/unreal-reference/build_level.py.
"""
import json
import math
import os

import unreal

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_MAP = "/Engine/Maps/Templates/Template_Default"
LEVEL = "/Game/Stress"

# --- Stress.ts constants (`real` preset) ---------------------------------------------------------
COUNTS = {"trees": 4000, "rocks": 6000, "houses": 120, "props": 600, "crowd": 120, "bodies": 300,
          "fires": 12, "firePerEmitter": 1500, "lights": 16}
WORLD = 180.0
TOWN = 45.0
BODY_SIZE = 0.6
SEED = 4242
# PerspectiveCamera(60) is a vertical FOV; Unreal's camera FOV is horizontal, at 16:9.
VFOV = 60.0
HFOV = math.degrees(2 * math.atan(math.tan(math.radians(VFOV / 2)) * 16 / 9))
SUN_DIRECTION = (0.555, 0.742, 0.38)  # render/sky.ts, toward the sun

# --- render/stress.ts look ------------------------------------------------------------------------
LOOK = {
    "Ground": (0x5D6B3A, 0.95),
    "Trunk": (0x5A4030, 0.9),
    "Canopy": (0x2F5A2A, 0.8),
    "Rock": (0x7C7A74, 0.85),
    "Wall": (0xC9B99A, 0.9),
    "Roof": (0x8A3B2C, 0.7),
    "Body": (0xB07A3A, 0.7),
}
TORCH = {"color": 0xFF9A4A, "intensity": 30.0, "range": 14.0}

asset_tools = unreal.AssetToolsHelpers.get_asset_tools()
level_subsystem = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
actor_subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
subobjects = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
mel = unreal.MaterialEditingLibrary


def log(message):
    unreal.log("TNSTRESS " + message)


# --- seeded random: @threenative/core createRandom(seed), bit for bit ------------------------------
class Random:
    def __init__(self, seed):
        self.state = seed & 0xFFFFFFFF

    def __call__(self):
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296.0


# --- coordinates ----------------------------------------------------------------------------------
def to_unreal(x, y, z):
    return unreal.Vector(x * 100.0, z * 100.0, y * 100.0)


def scale_to_unreal(sx, sy, sz):
    return unreal.Vector(sx, sz, sy)


def euler_xyz_to_quat(rx, ry, rz):
    """three.js Quaternion.setFromEuler, order XYZ."""
    c1, c2, c3 = math.cos(rx / 2), math.cos(ry / 2), math.cos(rz / 2)
    s1, s2, s3 = math.sin(rx / 2), math.sin(ry / 2), math.sin(rz / 2)
    return (s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3)


def rotation_to_unreal(rx, ry, rz):
    """The axis swap is a reflection: a rotation keeps its angle and its axis becomes -swap(axis)."""
    x, y, z, w = euler_xyz_to_quat(rx, ry, rz)
    return unreal.Quat(-x, -z, -y, w).rotator()


def transform(position, rotation=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)):
    return unreal.Transform(to_unreal(*position), rotation_to_unreal(*rotation), scale_to_unreal(*scale))


def look_rotation(position, target):
    a, b = to_unreal(*position), to_unreal(*target)
    d = unreal.Vector(b.x - a.x, b.y - a.y, b.z - a.z)
    return unreal.Rotator(roll=0.0, pitch=math.degrees(math.atan2(d.z, math.hypot(d.x, d.y))),
                          yaw=math.degrees(math.atan2(d.y, d.x)))


# --- colour ---------------------------------------------------------------------------------------
def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_from_hex(value):
    """three.js reads a hex colour as sRGB and stores it linear. A material parameter is linear."""
    r, g, b = (value >> 16) & 255, (value >> 8) & 255, value & 255
    return unreal.LinearColor(srgb_to_linear(r / 255), srgb_to_linear(g / 255), srgb_to_linear(b / 255), 1.0)


def linear_from_hsl(h, s, l):
    """three.js Color.setHSL: HSL in sRGB, stored linear. Converted once, here."""
    def hue(p, q, t):
        t %= 1.0
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * 6 * (2 / 3 - t)
        return p
    q = l * (1 + s) if l <= 0.5 else l + s - l * s
    p = 2 * l - q
    rgb = (hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3))
    return unreal.LinearColor(*[srgb_to_linear(c) for c in rgb], 1.0)


# --- assets ---------------------------------------------------------------------------------------
def import_file(path, folder):
    task = unreal.AssetImportTask()
    task.filename = path
    task.destination_path = folder
    task.automated = True
    task.replace_existing = True
    task.save = True
    asset_tools.import_asset_tasks([task])
    paths = [str(p) for p in task.imported_object_paths]
    log("imported " + json.dumps(paths))
    return [unreal.load_asset(p) for p in paths]


def find(assets, cls, name):
    for asset in assets:
        if isinstance(asset, cls) and asset.get_name().endswith(name):
            return asset
    raise RuntimeError(f"no {cls.__name__} named {name} in {[a.get_name() for a in assets]}")


def new_asset(name, folder, cls, factory):
    path = f"{folder}/{name}"
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        unreal.EditorAssetLibrary.delete_asset(path)
    return asset_tools.create_asset(name, folder, cls, factory)


def lit_material():
    """One master: base colour and roughness parameters, metallic 0, as MeshStandardMaterial."""
    material = new_asset("M_Stress", "/Game/Materials", unreal.Material, unreal.MaterialFactoryNew())
    color = mel.create_material_expression(material, unreal.MaterialExpressionVectorParameter, -400, 0)
    color.set_editor_property("parameter_name", "BaseColor")
    rough = mel.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -400, 200)
    rough.set_editor_property("parameter_name", "Roughness")
    rough.set_editor_property("default_value", 0.9)
    mel.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(rough, "", unreal.MaterialProperty.MP_ROUGHNESS)
    material.set_editor_property("used_with_instanced_static_meshes", True)
    mel.recompile_material(material)
    unreal.EditorAssetLibrary.save_loaded_asset(material)
    return material


def instance(parent, name, color, roughness):
    mic = new_asset(name, "/Game/Materials", unreal.MaterialInstanceConstant,
                    unreal.MaterialInstanceConstantFactoryNew())
    mel.set_material_instance_parent(mic, parent)
    mel.set_material_instance_vector_parameter_value(mic, "BaseColor", color)
    mel.set_material_instance_scalar_parameter_value(mic, "Roughness", roughness)
    unreal.EditorAssetLibrary.save_loaded_asset(mic)
    return mic


# render/stress.ts fireMaterial + firePositions, per particle. `R` is the instance's own random, the
# stand-in for hash(instanceIndex + salt). Each particle loops on its own life `t`: it rises 3.2 m,
# narrows from a 0.7 m ring and shrinks, cooling from yellow to red. Units here are centimetres.
FIRE_WPO = """
float r1 = frac(sin(R * 7919.0 + 1.0 * 78.233) * 43758.5453);
float r2 = frac(sin(R * 7919.0 + 2.0 * 78.233) * 43758.5453);
float r3 = frac(sin(R * 7919.0 + 3.0 * 78.233) * 43758.5453);
float r4 = frac(sin(R * 7919.0 + 4.0 * 78.233) * 43758.5453);
float t = frac(T * (r1 * 0.5 + 0.45) + r2);
float angle = r3 * 6.2831853 + t * 2.0;
float radius = r4 * 70.0 * (1.0 - t * 0.8);
float3 centre = float3(cos(angle) * radius, sin(angle) * radius, t * 320.0);
float size = ((1.0 - t) * 0.35 + 0.08) * 100.0;
float3 right = normalize(View.ViewToTranslatedWorld[0].xyz);
float3 up = normalize(View.ViewToTranslatedWorld[1].xyz);
float2 corner = float2(P.x, P.z) / 100.0;
return centre + (right * corner.x + up * corner.y) * size - P;
"""
FIRE_COLOR = """
float r1 = frac(sin(R * 7919.0 + 1.0 * 78.233) * 43758.5453);
float r2 = frac(sin(R * 7919.0 + 2.0 * 78.233) * 43758.5453);
float t = frac(T * (r1 * 0.5 + 0.45) + r2);
float heat = 1.0 - t;
float puff = max(0.0, 1.0 - length(UV - 0.5) * 2.0);
return float3(1.0, heat * 0.7 + 0.15, heat * heat * 0.25) * heat * 0.9 * puff * Gain;
"""


def custom(material, code, output_type, inputs, x, y):
    node = mel.create_material_expression(material, unreal.MaterialExpressionCustom, x, y)
    node.set_editor_property("code", code)
    node.set_editor_property("output_type", output_type)
    pins = []
    for name, _ in inputs:
        pin = unreal.CustomInput()
        pin.set_editor_property("input_name", name)
        pins.append(pin)
    node.set_editor_property("inputs", pins)
    for name, source in inputs:
        mel.connect_material_expressions(source, "", node, name)
    return node


def fire_material():
    material = new_asset("M_Fire", "/Game/Materials", unreal.Material, unreal.MaterialFactoryNew())
    material.set_editor_property("blend_mode", unreal.BlendMode.BLEND_ADDITIVE)
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    material.set_editor_property("two_sided", True)
    material.set_editor_property("used_with_instanced_static_meshes", True)
    time = mel.create_material_expression(material, unreal.MaterialExpressionTime, -900, 0)
    rand = mel.create_material_expression(material, unreal.MaterialExpressionPerInstanceRandom, -900, 150)
    local = mel.create_material_expression(material, unreal.MaterialExpressionLocalPosition, -900, 300)
    uv = mel.create_material_expression(material, unreal.MaterialExpressionTextureCoordinate, -900, 450)
    gain = mel.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -900, 600)
    gain.set_editor_property("parameter_name", "Gain")
    gain.set_editor_property("default_value", 1.0)
    wpo = custom(material, FIRE_WPO, unreal.CustomMaterialOutputType.CMOT_FLOAT3,
                 [("T", time), ("R", rand), ("P", local)], -400, 0)
    color = custom(material, FIRE_COLOR, unreal.CustomMaterialOutputType.CMOT_FLOAT3,
                   [("T", time), ("R", rand), ("UV", uv), ("Gain", gain)], -400, 400)
    mel.connect_material_property(wpo, "", unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)
    mel.connect_material_property(color, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    mel.recompile_material(material)
    unreal.EditorAssetLibrary.save_loaded_asset(material)
    return material


# --- level helpers --------------------------------------------------------------------------------
def add_component(actor, cls):
    root = subobjects.k2_gather_subobject_data_for_instance(actor)[0]
    handle, reason = subobjects.add_new_subobject(
        unreal.AddNewSubobjectParams(parent_handle=root, new_class=cls, blueprint_context=None))
    if not unreal.SubobjectDataBlueprintFunctionLibrary.is_handle_valid(handle):
        raise RuntimeError(f"add {cls.__name__} to {actor.get_actor_label()}: {reason}")
    data = unreal.SubobjectDataBlueprintFunctionLibrary.get_data(handle)
    return unreal.SubobjectDataBlueprintFunctionLibrary.get_object(data)


def no_collision(actor):
    for component in actor.get_components_by_class(unreal.PrimitiveComponent):
        component.set_collision_profile_name("NoCollision")


def mesh_actor(mesh, material, xf, label, cast_shadow=True):
    actor = actor_subsystem.spawn_actor_from_object(mesh, xf.translation, xf.rotation.rotator())
    actor.set_actor_scale3d(xf.scale3d)
    actor.set_actor_label(label)
    component = actor.static_mesh_component
    component.set_material(0, material)
    component.set_editor_property("cast_shadow", cast_shadow)
    return actor


def instanced(label, mesh, material, transforms, cast_shadow=True, bounds_scale=1.0):
    actor = actor_subsystem.spawn_actor_from_class(unreal.Actor, unreal.Vector(0, 0, 0))
    actor.set_actor_label(label)
    ism = add_component(actor, unreal.InstancedStaticMeshComponent)
    ism.set_editor_property("static_mesh", mesh)
    ism.set_material(0, material)
    ism.set_editor_property("cast_shadow", cast_shadow)
    ism.set_editor_property("bounds_scale", bounds_scale)
    ism.set_collision_profile_name("NoCollision")
    ism.add_instances(transforms, False, True)
    return actor


# --- build ----------------------------------------------------------------------------------------
def build():
    meshes = import_file(os.path.join(HERE, "meshes", "stress-meshes.gltf"), "/Game/Meshes")
    mesh = {name: find(meshes, unreal.StaticMesh, name)
            for name in ("Ground", "Trunk", "Canopy", "Rock", "House", "Roof", "Crate", "Barrel", "FireQuad")}
    meshes_editor = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    meshes_editor.add_simple_collisions(mesh["Crate"], unreal.ScriptCollisionShapeType.BOX)
    fire_settings = mesh["FireQuad"].get_editor_property("nanite_settings")
    fire_settings.set_editor_property("enabled", False)
    mesh["FireQuad"].set_editor_property("nanite_settings", fire_settings)
    for m in mesh.values():
        unreal.EditorAssetLibrary.save_loaded_asset(m)
    nanite = {name: m.get_editor_property("nanite_settings").get_editor_property("enabled") for name, m in mesh.items()}
    log("nanite " + json.dumps(nanite))

    import_file(os.path.join(HERE, "..", "stress-lab", "assets", "mannequin.glb"), "/Game/Mannequin")
    mannequin = [unreal.load_asset(p) for p in unreal.EditorAssetLibrary.list_assets("/Game/Mannequin", True)]
    skeletal = next(a for a in mannequin if isinstance(a, unreal.SkeletalMesh))
    walk = find(mannequin, unreal.AnimSequence, "Walk_Loop")
    log(f"mannequin {skeletal.get_path_name()} walk {walk.get_path_name()}")

    lit = lit_material()
    mat = {name: instance(lit, f"MI_{name}", linear_from_hex(c), r) for name, (c, r) in LOOK.items()}
    props = [instance(lit, f"MI_Prop{i:03d}", linear_from_hsl((i * 0.137) % 1, 0.45, 0.45), 0.6 + (i % 5) * 0.06)
             for i in range(COUNTS["props"])]
    fire = fire_material()

    if not level_subsystem.new_level_from_template(LEVEL, TEMPLATE_MAP):
        raise RuntimeError("new_level_from_template failed for " + LEVEL)
    for actor in actor_subsystem.get_all_level_actors():
        kind = actor.get_class().get_name()
        if kind == "StaticMeshActor" and actor.get_actor_label() == "Floor":
            actor_subsystem.destroy_actor(actor)
        elif kind == "DirectionalLight":
            actor.set_actor_rotation(look_rotation(SUN_DIRECTION, (0.0, 0.0, 0.0)), False)

    random = Random(SEED)

    def spot(avoid_town):
        while True:
            x = (random() * 2 - 1) * WORLD
            z = (random() * 2 - 1) * WORLD
            if not avoid_town or abs(x) > TOWN or abs(z) > TOWN:
                return x, z

    ground = mesh_actor(mesh["Ground"], mat["Ground"], transform((0, 0, 0), scale=(WORLD * 2, 1, WORLD * 2)),
                        "Ground", cast_shadow=False)
    no_collision(ground)
    # The physics floor: Stress.ts's fixed 360 x 1 x 360 m box, half a metre below the ground.
    floor = actor_subsystem.spawn_actor_from_object(unreal.load_asset("/Engine/BasicShapes/Cube"),
                                                    to_unreal(0, -0.5, 0))
    floor.set_actor_scale3d(unreal.Vector(WORLD * 2, WORLD * 2, 1))
    floor.set_actor_label("PhysicsFloor")
    floor.set_actor_hidden_in_game(True)
    floor.static_mesh_component.set_editor_property("cast_shadow", False)

    trunks, canopies = [], []
    for _ in range(COUNTS["trees"]):
        x, z = spot(True)
        height = 5 + random() * 7
        spin = random() * math.pi * 2
        trunks.append(transform((x, 0, z), (0, spin, 0), (1, height * 0.45, 1)))
        canopies.append(transform((x, height * 0.3, z), (0, spin, 0), (height * 0.28, height * 0.75, height * 0.28)))
    instanced("Trunks", mesh["Trunk"], mat["Trunk"], trunks)
    instanced("Canopies", mesh["Canopy"], mat["Canopy"], canopies)

    rocks = []
    for _ in range(COUNTS["rocks"]):
        x, z = spot(False)
        s = 0.3 + random() * 1.6
        rx, ry = random() * 3, random() * 3
        rocks.append(transform((x, s * 0.2, z), (rx, ry, 0), (s, s * 0.7, s)))
    instanced("Rocks", mesh["Rock"], mat["Rock"], rocks)

    columns = math.ceil(math.sqrt(COUNTS["houses"]))
    for i in range(COUNTS["houses"]):
        w = 4 + random() * 4
        h = 3 + random() * 4
        cx = ((i % columns) / (columns - 1 or 1) - 0.5) * TOWN * 1.8
        cz = ((i // columns) / (columns - 1 or 1) - 0.5) * TOWN * 1.8
        px = cx + (random() - 0.5) * 3
        pz = cz + (random() - 0.5) * 3
        turn = math.floor(random() * 4) * (math.pi / 2)
        walls = mesh_actor(mesh["House"], mat["Wall"], transform((px, 0, pz), (0, turn, 0), (w, h, w * 0.8)),
                           f"House{i:03d}_Walls")
        roof = mesh_actor(mesh["Roof"], mat["Roof"], transform((px, h, pz), (0, turn, 0), (w * 0.9, w * 0.5, w * 0.75)),
                          f"House{i:03d}_Roof")
        no_collision(walls)
        no_collision(roof)

    for i in range(COUNTS["props"]):
        s = 0.5 + random() * 0.6
        x = (random() * 2 - 1) * TOWN
        z = (random() * 2 - 1) * TOWN
        turn = random() * math.pi
        prop = mesh_actor(mesh["Crate"] if i % 2 == 0 else mesh["Barrel"], props[i],
                          transform((x, s / 2, z), (0, turn, 0), (s, s, s)), f"Prop{i:03d}")
        no_collision(prop)

    # Walkers: Stress.ts moves each holder on its circle at `speed / radius` rad/s, facing along it.
    # A rotating-movement component does the same natively: yaw rate about a pivot at the circle centre.
    for i in range(COUNTS["crowd"]):
        radius = 6 + random() * (TOWN - 8)
        speed = 1.2 + random() * 0.4
        phase = random() * math.pi * 2
        position = (math.cos(phase) * radius, 0, math.sin(phase) * radius)
        actor = actor_subsystem.spawn_actor_from_object(skeletal, to_unreal(*position),
                                                        rotation_to_unreal(0, -phase, 0))
        actor.set_actor_label(f"Walker{i:03d}")
        component = actor.get_editor_property("skeletal_mesh_component")
        component.set_editor_property("animation_mode", unreal.AnimationMode.ANIMATION_SINGLE_NODE)
        component.set_editor_property("animation_data",
                                      unreal.SingleAnimationPlayData(anim_to_play=walk, saved_looping=True,
                                                                     saved_playing=True, saved_position=0.0,
                                                                     saved_play_rate=1.0))
        component.set_editor_property("cast_shadow", True)
        component.set_collision_profile_name("NoCollision")
        mover = add_component(actor, unreal.RotatingMovementComponent)
        mover.set_editor_property("rotation_rate", unreal.Rotator(roll=0.0, pitch=0.0,
                                                                   yaw=math.degrees(speed / radius)))
        mover.set_editor_property("pivot_translation", unreal.Vector(-radius * 100.0, 0.0, 0.0))
        mover.set_editor_property("rotation_in_local_space", True)

    # Bodies: dropped once here as Stress.ts does at enter; runtime.py re-drops them every 8 s with the
    # random stream that continues from here.
    for i in range(COUNTS["bodies"]):
        pile = i % 6
        x = math.cos(pile) * 12 + random() * 3
        z = math.sin(pile) * 12 + random() * 3
        body = mesh_actor(mesh["Crate"], mat["Body"],
                          transform((x, 4 + (i / 6) * 0.7, z), scale=(BODY_SIZE, BODY_SIZE, BODY_SIZE)),
                          f"Body{i:03d}")
        body.tags = ["StressBody", f"i{i}"]
        component = body.static_mesh_component
        component.set_mobility(unreal.ComponentMobility.MOVABLE)
        component.set_collision_profile_name("PhysicsActor")
        component.set_simulate_physics(True)
        component.set_mass_override_in_kg("", 4.0, True)

    count = max(COUNTS["fires"], COUNTS["lights"])
    rings = [(math.cos(i / count * math.pi * 2) * TOWN * 0.7, math.sin(i / count * math.pi * 2) * TOWN * 0.7)
             for i in range(count)]
    quads = [unreal.Transform() for _ in range(COUNTS["firePerEmitter"])]
    for i, (x, z) in enumerate(rings[:COUNTS["fires"]]):
        actor = instanced(f"Fire{i:02d}", mesh["FireQuad"], fire, quads, cast_shadow=False, bounds_scale=8.0)
        actor.set_actor_location(to_unreal(x, 0, z), False, False)
    for i, (x, z) in enumerate(rings[:COUNTS["lights"]]):
        torch = actor_subsystem.spawn_actor_from_class(unreal.PointLight, to_unreal(x, 2.5, z))
        torch.set_actor_label(f"Torch{i:02d}")
        light = torch.point_light_component
        light.set_mobility(unreal.ComponentMobility.MOVABLE)
        light.set_editor_property("intensity_units", unreal.LightUnits.CANDELAS)
        light.set_editor_property("intensity", TORCH["intensity"])
        light.set_editor_property("attenuation_radius", TORCH["range"] * 100.0)
        light.set_editor_property("light_color", unreal.Color(r=0xFF, g=0x9A, b=0x4A, a=255))
        light.set_editor_property("use_inverse_squared_falloff", True)
        # three.js PointLight casts no shadow unless asked; Stress.ts does not ask.
        light.set_editor_property("cast_shadows", False)

    camera = actor_subsystem.spawn_actor_from_class(unreal.CameraActor, to_unreal(70, 24, 0),
                                                    look_rotation((70, 24, 0), (0, 2, 0)))
    camera.set_actor_label("StressCamera")
    camera.tags = ["StressCamera"]
    camera.set_editor_property("auto_activate_for_player", unreal.AutoReceiveInput.PLAYER0)
    lens = camera.get_editor_property("camera_component")
    lens.set_editor_property("field_of_view", HFOV)
    lens.set_editor_property("aspect_ratio", 16 / 9)
    lens.set_editor_property("constrain_aspect_ratio", False)

    level_subsystem.save_current_level()
    with open(os.path.join(HERE, "layout.json"), "w") as f:
        json.dump({"note": "Written by build_level.py. runtime.py continues the random stream for body drops.",
                   "randomState": random.state, "counts": COUNTS, "hfov": HFOV, "nanite": nanite}, f, indent=1)
    log("built " + LEVEL)


try:
    build()
    with open(os.path.join(HERE, "Saved", "build.exit"), "w") as f:
        f.write("0")
except Exception as error:  # the editor exit status says nothing about the script
    unreal.log_error("TNSTRESS build failed: " + repr(error))
    import traceback
    unreal.log_error(traceback.format_exc())
    with open(os.path.join(HERE, "Saved", "build.exit"), "w") as f:
        f.write("1")
