// Ground clutter: flakes, pebbles and small half-buried rocks scattered along the course and over the
// arena floor in one instanced mesh (one draw). Positions sit on `groundHeight`, sizes follow a
// power law (many small, few large), colours run red to ochre to dark so no two read alike.
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** Every control says which way to move it. */
export const CLUTTER = {
  /** Instances along the course and in the arena. Up: denser litter, more triangles (4 each). */
  count: 18000,
  /** Metres either side of the course axis they spread over. */
  spread: 55,
  /** Size range in metres (radius). The power law puts most near the low end. */
  size: [0.12, 0.9] as const,
  /** Palette, dark crust to pale flake. */
  colours: [0x4a2a20, 0x7a3f2e, 0x9a5a3a, 0xb87a4c, 0xd2a070],
};

const hash = (n: number): number => {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
};

/** A 4-triangle chunk, hand-built: the Wasm engine has no TetrahedronGeometry. */
function tetra(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    "position",
    new Float32BufferAttribute(
      [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1].map((v) => v * 0.6),
      3,
    ),
  );
  g.setIndex([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]);
  g.computeVertexNormals();
  return g;
}

export function createGroundClutter(
  at: (s: number, l: number, out: Vector3) => Vector3,
  groundHeight: (x: number, z: number) => number,
  length: number,
  arenaCenter: Vector3,
  arenaRadius: number,
): InstancedMesh {
  const C = CLUTTER;
  const material = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const mesh = new InstancedMesh(tetra(), material, C.count);
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const sc = new Vector3();
  const c = new Color();
  const pal = C.colours.map((hex) => new Color(hex));
  for (let i = 0; i < C.count; i += 1) {
    const r = (k: number): number => hash(i * 7 + k);
    if (i % 4 === 3) {
      // Arena floor: uniform over the disc.
      const a = r(1) * Math.PI * 2;
      const d = Math.sqrt(r(2)) * arenaRadius;
      p.set(arenaCenter.x + Math.cos(a) * d, 0, arenaCenter.z + Math.sin(a) * d);
    } else at(r(1) * length, (r(2) * 2 - 1) * C.spread, p);
    const size = C.size[0] + (C.size[1] - C.size[0]) * r(3) ** 3;
    // Flat flakes lie down; chunks sit up. Half-buried either way.
    const flat = 0.35 + 0.65 * r(4);
    sc.set(size * (0.8 + 0.6 * r(5)), size * flat, size * (0.8 + 0.6 * r(6)));
    q.setFromAxisAngle(new Vector3(0, 1, 0), r(7) * Math.PI * 2);
    p.y = groundHeight(p.x, p.z) - sc.y * 0.3;
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
    const t = r(8) * (pal.length - 1);
    const k = Math.floor(t);
    c.copy(pal[k] as Color).lerp(pal[Math.min(pal.length - 1, k + 1)] as Color, t - k);
    mesh.setColorAt(i, c.multiplyScalar(0.8 + 0.4 * r(9)));
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  return mesh;
}
