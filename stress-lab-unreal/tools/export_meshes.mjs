// Writes meshes/stress-meshes.gltf: the stress lab's three.js primitives with the exact parameters of
// `stress-lab/src/render/stress.ts`, so Unreal draws the same triangles. Run: node tools/export_meshes.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  PlaneGeometry,
} from "../../stress-lab/node_modules/three/build/three.module.js";

const here = dirname(fileURLToPath(import.meta.url));
const MESHES = {
  Ground: new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  Trunk: new CylinderGeometry(0.12, 0.2, 1, 7).translate(0, 0.5, 0),
  Canopy: new ConeGeometry(1, 1, 9).translate(0, 0.5, 0),
  Rock: new DodecahedronGeometry(0.5, 0),
  House: new BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  Roof: new ConeGeometry(0.8, 0.6, 4).rotateY(Math.PI / 4).translate(0, 0.3, 0),
  Crate: new BoxGeometry(1, 1, 1),
  Barrel: new CylinderGeometry(0.4, 0.4, 1, 12),
  // One fire sprite: the material billboards it and moves it (build_level.py, FIRE_WPO).
  FireQuad: new PlaneGeometry(1, 1),
};

const chunks = [];
let offset = 0;
const bufferViews = [];
const accessors = [];
function push(array, target, type, componentType, minMax) {
  const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  chunks.push(bytes);
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
  offset += bytes.length;
  const pad = (4 - (offset % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    offset += pad;
  }
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
  const accessor = {
    bufferView: bufferViews.length - 1,
    componentType,
    count: array.length / size,
    type,
  };
  if (minMax) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < array.length; i += 3)
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], array[i + k]);
        max[k] = Math.max(max[k], array[i + k]);
      }
    Object.assign(accessor, { min, max });
  }
  accessors.push(accessor);
  return accessors.length - 1;
}

const meshes = [];
const nodes = [];
const triangles = {};
for (const [name, geometry] of Object.entries(MESHES)) {
  const g = geometry.index === null ? geometry : geometry.toNonIndexed();
  const count = g.attributes.position.count;
  const index = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) index[i] = i;
  triangles[name] = count / 3;
  const attributes = {
    POSITION: push(new Float32Array(g.attributes.position.array), 34962, "VEC3", 5126, true),
    NORMAL: push(new Float32Array(g.attributes.normal.array), 34962, "VEC3", 5126),
    TEXCOORD_0: push(new Float32Array(g.attributes.uv.array), 34962, "VEC2", 5126),
  };
  const indices = push(index, 34963, "SCALAR", 5125);
  meshes.push({ name, primitives: [{ attributes, indices, material: 0 }] });
  nodes.push({ name, mesh: meshes.length - 1 });
}

const buffer = Buffer.concat(chunks);
const gltf = {
  asset: { version: "2.0", generator: "stress-lab-unreal/tools/export_meshes.mjs" },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes,
  meshes,
  materials: [{ name: "Placeholder", pbrMetallicRoughness: { metallicFactor: 0 } }],
  buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString("base64")}` }],
  bufferViews,
  accessors,
};
const out = join(here, "..", "meshes", "stress-meshes.gltf");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(gltf));
console.log(`wrote ${out}`, JSON.stringify(triangles));
