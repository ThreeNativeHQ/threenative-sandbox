/**
 * Reproducible source of the four `GUNNER_GRIP_ARMS` quaternions in `src/render/aircrew.ts`.
 *
 * Reads a baked grip pose (a GLB with a `gunner-grip` action, e.g. root's Blender MCP bake) and the
 * shipped pilot rig, verifies the two share one rest pose bone by bone — the condition that makes
 * copying bone-local quaternions valid — then prints the constants and the hand-to-hinge distances.
 *
 *   node tools/extract-gunner-grip.mjs [baked.glb] [assets/carrier-aircraft-pilot.glb]
 */
import { readFile } from "node:fs/promises";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

globalThis.ProgressEvent ??= class ProgressEvent extends Event {};

async function load(path) {
  const bytes = await readFile(path);
  const header = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + header).toString());
  for (const m of json.materials ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  delete json.textures;
  delete json.images;
  json.buffers[0].uri =
    "data:application/octet-stream;base64," + bytes.subarray(28 + header).toString("base64");
  return new GLTFLoader().parseAsync(JSON.stringify(json), "");
}

const bakedPath = process.argv[2] ?? "/tmp/douglas-gunner-grip-pose.glb";
const pilotPath = process.argv[3] ?? "assets/carrier-aircraft-pilot.glb";
const baked = await load(bakedPath);
const pilot = await load(pilotPath);

const grip = baked.animations.find((clip) => clip.name === "gunner-grip");
if (!grip) throw new Error(`${bakedPath} has no gunner-grip clip.`);
const bakedSit = baked.animations.find((clip) => clip.name === "sit");
const shippedSit = pilot.animations.find((clip) => clip.name === "sit");
if (!bakedSit || !shippedSit) throw new Error("both files must ship a sit clip.");

/** The chain the grip changes; rest space must match across all of it before any value is reused. */
const ARMS = ["upperarm_l", "lowerarm_l", "upperarm_r", "lowerarm_r"];
const CHECK = [...ARMS, "clavicle_l", "clavicle_r", "hand_l", "hand_r", "pelvis", "spine_01", "Head"];

const nodeRest = (gltf) => {
  const map = new Map();
  const walk = (node) => {
    map.set(node.name.replace(/^Bone:/, ""), node);
    for (const child of node.children) walk(child);
  };
  walk(gltf.scene);
  return map;
};
const bakedRest = nodeRest(baked);
const pilotRest = nodeRest(pilot);
let failed = 0;
for (const name of CHECK) {
  const a = bakedRest.get(name);
  const b = pilotRest.get(name);
  if (!a || !b) {
    console.error(`rest-space MISSING ${name}`);
    failed += 1;
    continue;
  }
  const dq = ["x", "y", "z", "w"].reduce((m, k) => Math.max(m, Math.abs(a.quaternion[k] - b.quaternion[k])), 0);
  const dp = ["x", "y", "z"].reduce((m, k) => Math.max(m, Math.abs(a.position[k] - b.position[k])), 0);
  if (dq > 1e-5 || dp > 1e-5) {
    console.error(`rest-space DIFFERS ${name}: dq=${dq} dp=${dp}`);
    failed += 1;
  }
}
if (failed) throw new Error("baked pose and shipped rig do not share one rest space; do not graft.");
console.log(`rest space verified on ${CHECK.length} bones (${bakedPath} vs ${pilotPath}).`);

const quat = (clip, bone) => clip.tracks.find((t) => t.name === `${bone}.quaternion`).values.slice(0, 4);
console.log("\nexport const GUNNER_GRIP_ARMS: Readonly<Record<string, readonly [number, number, number, number]>> = Object.freeze({");
for (const bone of ARMS) {
  const v = Array.from(quat(grip, bone)).map((n) => +n.toFixed(5));
  console.log(`  ${bone}: [${v.join(", ")}],`);
}
console.log("});");
console.log(`\ngrip clip duration ${grip.duration}s; ${grip.tracks.length} tracks.`);
