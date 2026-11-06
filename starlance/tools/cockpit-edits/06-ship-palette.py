# Match the starfighter (assets/starfighter.glb): its armour is violet, its lights cyan. The cockpit's
# blue paint is multiplied toward the ship's violet (a Multiply mix the glTF exporter ships as
# baseColorFactor), and the amber switch lights become the ship's ion cyan. Names stay: the game's
# cockpitLook.ts keys its finish table on them.
import bpy
VIOLET = (0.62, 0.42, 1.0, 1.0)
CYAN = (0.12, 0.85, 1.0, 1.0)
for name in ("Worn blue graphite | microtexture", "Cobalt painted armor",
             "Lateral blue instrument housing painted surface",
             "Lateral blue instrument housing.001 painted surface"):
    m = bpy.data.materials.get(name)
    if m is None:
        continue
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    link = bsdf.inputs["Base Color"].links[0]
    if link.from_node.type == "MIX" and link.from_node.label == "ship tint":
        continue
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type, mix.blend_type, mix.label = "RGBA", "MULTIPLY", "ship tint"
    mix.inputs["Factor"].default_value = 1.0
    nt.links.new(link.from_socket, mix.inputs["A"])
    mix.inputs["B"].default_value = VIOLET
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
m = bpy.data.materials["Amber switch lights"]
bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = CYAN
bsdf.inputs["Emission Color"].default_value = CYAN
print("ok")
