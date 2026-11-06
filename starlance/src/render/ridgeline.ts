// Far ridgeline: a baked heightmap ring that rises 2 km either side of the course and around the
// arena. The heightmap is ridged multifractal noise under a domain warp (sharp crests, drainage
// gullies, meandering spurs), capped by flat mesa tops where a slow noise says "hard layer"; the mesh
// is shaded by slope (red strata on steep faces, warm sand on the gentle ones, never white). The
// height fog turns it paler with distance, so the horizon reads as layered silhouettes.
// Source: procedural, no scanned data (the Fab heightmap pack ships as an Unreal pack only).
import { BufferGeometry, Color, Float32BufferAttribute, type Vector3 } from "three";
import { noise3 } from "./rocks.js";

/** Every control says which way to move it. */
export const RIDGE = {
  /** Metres between samples. Down: finer crests, more triangles. */
  cell: 60,
  /** Metres from the course axis where the ground starts to rise, and where it is full height. */
  clear: [2000, 3300] as const,
  /** Tallest crest above the plain (m). */
  peak: 520,
  /** Mesa cap height range (m) and how sharp the break from slope to cap is (m). */
  cap: [150, 340] as const,
  /** Metres per strata terrace on steep faces. */
  layer: 110,
};

const STRATA = [0x7a3f2e, 0x8a4a38, 0x6b3a30, 0x9a5a40, 0x74463f].map((hex) => new Color(hex));
const SAND = new Color(0x9a5f3c);
const FAR = new Color(0x9c7466);

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Distance from (x, z) to the segment a-b on the ground plane. */
function segmentDistance(x: number, z: number, a: Vector3, b: Vector3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

/** The heightmap: metres above the plain at (x, z) before the course mask. */
function heightmap(x: number, z: number, seed: number): number {
  // Domain warp: crests meander instead of running straight.
  const wx = x + 650 * noise3(x * 0.00045, 1, z * 0.00045, seed);
  const wz = z + 650 * noise3(x * 0.00045, 2, z * 0.00045, seed + 1);
  let sum = 0;
  let amp = 1;
  let freq = 0.00085;
  let norm = 0;
  let weight = 1;
  for (let o = 0; o < 5; o += 1) {
    // Each octave is turned 37 degrees, so the lattice never lines the crests up.
    const a = o * 0.64;
    const rx = wx * Math.cos(a) - wz * Math.sin(a);
    const rz = wx * Math.sin(a) + wz * Math.cos(a);
    const n = 1 - Math.abs(noise3(rx * freq, o * 5.1, rz * freq, seed + 7 * o) * 1.6);
    const v = Math.max(0, n) ** 1.5;
    sum += amp * v * weight;
    weight = Math.min(1, v * 2); // detail only on the crests, valleys stay smooth
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  // A slow envelope varies crest heights so the peaks never repeat.
  const env = 0.45 + 1.1 * (0.5 + noise3(x * 0.0004, 6, z * 0.0004, seed + 11));
  const raw = RIDGE.peak * (sum / norm) * 1.7 * env;
  // Hard caprock: a slow noise picks the cap level; above it the crest flattens into a mesa top.
  const cap =
    RIDGE.cap[0] +
    (RIDGE.cap[1] - RIDGE.cap[0]) * (0.5 + noise3(x * 0.0007, 9, z * 0.0007, seed + 3));
  const soft = 25;
  const top = cap + soft * Math.log(1 + Math.exp((raw - cap) / soft)) * 0.12;
  const mesa = noise3(x * 0.0011, 4, z * 0.0011, seed + 5) > -0.25;
  const h = mesa ? Math.min(raw, top) : raw;
  // Strata: soft terraces in the rock, so the flanks step like layered sandstone.
  const u = h / RIDGE.layer;
  const lay = Math.floor(u);
  return (lay + smooth(0.7, 0.95, u - lay) * 0.85 + (u - lay) * 0.15) * RIDGE.layer;
}

export function ridgelineGeometry(start: Vector3, arena: Vector3, seed = 5): BufferGeometry {
  const x0 = -7000;
  const x1 = 7000;
  const z1 = start.z + 1500;
  const z0 = arena.z - 6500;
  const nx = Math.round((x1 - x0) / RIDGE.cell);
  const nz = Math.round((z1 - z0) / RIDGE.cell);
  const w = nx + 1;
  const hts = new Float32Array(w * (nz + 1));
  for (let j = 0; j <= nz; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const x = x0 + i * RIDGE.cell;
      const z = z0 + j * RIDGE.cell;
      const mask = smooth(RIDGE.clear[0], RIDGE.clear[1], segmentDistance(x, z, start, arena));
      hts[j * w + i] = mask * heightmap(x, z, seed);
    }
  }
  const pos: number[] = [];
  const col: number[] = [];
  const c = new Color();
  for (let j = 0; j <= nz; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const h = hts[j * w + i] as number;
      const hl = hts[j * w + Math.max(0, i - 1)] as number;
      const hr = hts[j * w + Math.min(nx, i + 1)] as number;
      const hd = hts[Math.max(0, j - 1) * w + i] as number;
      const hu = hts[Math.min(nz, j + 1) * w + i] as number;
      const slope = Math.hypot(hr - hl, hu - hd) / (2 * RIDGE.cell);
      // Steep faces: banded red strata; gentle ground: warm sand. Lighter toward the crest.
      const u = h / RIDGE.layer;
      const layer = Math.floor(u);
      // Colour blends smoothly from one stratum to the next: no per-layer random, so no stripes.
      c.copy(STRATA[((layer % 5) + 5) % 5] as Color).lerp(
        STRATA[(((layer + 1) % 5) + 5) % 5] as Color,
        smooth(0, 1, u - layer),
      );
      c.lerp(SAND, 1 - smooth(0.12, 0.5, slope));
      c.multiplyScalar(0.42 + 0.3 * smooth(0, 400, h));
      // Aerial perspective by band: the farther the range from the course, the dustier and lighter.
      const range = segmentDistance(x0 + i * RIDGE.cell, z0 + j * RIDGE.cell, start, arena);
      c.lerp(FAR, 0.5 * smooth(2200, 6500, range));
      pos.push(x0 + i * RIDGE.cell, h - 6, z0 + j * RIDGE.cell);
      col.push(c.r, c.g, c.b);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const a = j * w + i;
      const b = a + w;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
