import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const [name, budget] of [["enterprise", 33000], ["hornet", 350000], ["b25-mitchell", 26000], ["akagi", 250000]]) {
  const bytes = readFileSync(new URL(`../assets/${name}.glb`, import.meta.url));
  assert.equal(bytes.toString("ascii", 0, 4), "glTF");
  const gltf = JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
  const primitives = gltf.meshes.flatMap((mesh) => mesh.primitives);
  const triangles = primitives.reduce((total, primitive) => total + gltf.accessors[primitive.indices].count / 3, 0);
  assert(triangles > 1000 && triangles <= budget, `${name}: ${triangles} triangles exceeds ${budget}`);
  assert(gltf.images.length > 0 && gltf.images.every((image) => image.bufferView !== undefined), `${name}: embedded textures missing`);
  assert(gltf.bufferViews.every((view) => view.byteStride === undefined), `${name}: interleaved attributes`);
  if (name === "hornet") assert(gltf.nodes.every((node) => !node.name?.startsWith("wing_l")), "Parked aircraft remain attached to Hornet");
  console.log(`${name}: ${triangles} triangles, ${gltf.images.length} embedded textures; pass`);
}
