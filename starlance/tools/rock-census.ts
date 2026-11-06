// Node census of the rock scatter: instances, triangles and hit spheres per batch (no GPU, no culling).
// Run: npx esbuild tools/rock-census.ts --bundle --platform=node --format=esm --outfile=/tmp/rock-census.mjs && node /tmp/rock-census.mjs
import { Vector3 } from "three";
import { Rail, SECTION, railFrame } from "../src/entities/Rail";
import { type IWallStation, canyonWallChunks } from "../src/render/rocks";
import { scatterRocks } from "../src/render/rockScatter";

const rail = new Rail();
const f = railFrame();
const obstacles: { center: Vector3; radius: number }[] = [];
const at = (s: number, l: number, out: Vector3): Vector3 => {
  rail.frame(s, f);
  return out.copy(f.position).addScaledVector(f.right, l);
};
const t0 = performance.now();
const batches = scatterRocks({ rail, frame: f, groundHeight: () => 0, obstacles, at, nearArch: () => false, seed: 2026 });
const ms = performance.now() - t0;
let total = 0;
for (const b of batches) total += (b.geo.getIndex()?.count ?? 0) / 3;
console.log(`baked meshes ${batches.length} (draws if all visible), tris if all drawn ${total}, obstacles ${obstacles.length}, build ${ms.toFixed(0)} ms`);

// The canyon wall as stage.ts builds it.
const sm = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const stations: IWallStation[] = [];
for (let s = SECTION.canyon - 160; s <= SECTION.plain + 160; s += 4) {
  const env = sm(SECTION.canyon - 60, SECTION.canyon + 180, s) * (1 - sm(SECTION.plain - 180, SECTION.plain + 40, s));
  const width = (side: number): number => 24 + 5 * Math.sin(s * 0.017 + side) + 3 * Math.sin(s * 0.05);
  rail.frame(s, f);
  stations.push({ x: f.position.x, z: f.position.z, rx: f.right.x, rz: f.right.z, width: [width(-1), width(1)], env });
}
const t1 = performance.now();
const walls = canyonWallChunks(stations, 77);
const tris = walls.map((g) => (g.getIndex()?.count ?? 0) / 3);
console.log(`wall chunks ${walls.length}, tris total ${tris.reduce((a, b) => a + b, 0)}, per chunk ~${Math.round(tris.reduce((a, b) => a + b, 0) / walls.length)}, build ${(performance.now() - t1).toFixed(0)} ms`);
