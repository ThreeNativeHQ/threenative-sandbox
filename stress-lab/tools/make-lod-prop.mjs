// PRD-898 `lods` layer: a static prop dense enough that the asset cook bakes a TN_discrete_lod chain.
// A noisy icosphere (detail 4, 5,120 triangles), deterministic, written once to assets/lod-prop.glb.
// The lab installs gltf-transform only under the CLI; import its core from the pnpm store.
import { createRequire } from "node:module";
const { Document, NodeIO } = createRequire(import.meta.url)(
  createRequire(import.meta.url).resolve("@gltf-transform/core", { paths: [new URL("../node_modules/.pnpm/node_modules", import.meta.url).pathname] }),
);
import { IcosahedronGeometry } from "three";

const geometry = new IcosahedronGeometry(0.5, 16).toNonIndexed();
const position = geometry.getAttribute("position");
// Merge to an indexed mesh with a shared-vertex noise, so the surface stays closed and simplifiable.
const key = (i) => `${position.getX(i).toFixed(5)},${position.getY(i).toFixed(5)},${position.getZ(i).toFixed(5)}`;
const index = new Map();
const vertices = [];
const indices = [];
for (let i = 0; i < position.count; i += 1) {
  const k = key(i);
  let at = index.get(k);
  if (at === undefined) {
    at = vertices.length / 3;
    index.set(k, at);
    const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
    const bump = 1 + 0.12 * Math.sin(x * 23) * Math.cos(y * 19) * Math.sin(z * 17);
    vertices.push(x * bump, y * bump * 0.8, z * bump);
  }
  indices.push(at);
}
const normals = new Float32Array(vertices.length);
for (let t = 0; t < indices.length; t += 3) {
  const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
  const e1 = [vertices[b] - vertices[a], vertices[b + 1] - vertices[a + 1], vertices[b + 2] - vertices[a + 2]];
  const e2 = [vertices[c] - vertices[a], vertices[c + 1] - vertices[a + 1], vertices[c + 2] - vertices[a + 2]];
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  for (const v of [a, b, c]) for (let k = 0; k < 3; k += 1) normals[v + k] += n[k];
}
for (let v = 0; v < normals.length; v += 3) {
  const l = Math.hypot(normals[v], normals[v + 1], normals[v + 2]) || 1;
  for (let k = 0; k < 3; k += 1) normals[v + k] /= l;
}
const doc = new Document();
const buffer = doc.createBuffer();
const prim = doc
  .createPrimitive()
  .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(vertices)).setBuffer(buffer))
  .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(normals).setBuffer(buffer))
  .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(indices)).setBuffer(buffer))
  .setMaterial(doc.createMaterial("stone").setBaseColorFactor([0.55, 0.5, 0.45, 1]).setRoughnessFactor(0.9));
const mesh = doc.createMesh("lodProp").addPrimitive(prim);
doc.createScene().addChild(doc.createNode("lodProp").setMesh(mesh));
await new NodeIO().write(new URL("../assets/lod-prop.glb", import.meta.url).pathname, doc);
console.log(`lod-prop.glb: ${indices.length / 3} triangles, ${vertices.length / 3} vertices`);
