// Rock forms for the red-desert course: eroded hoodoo towers (tafoni pits, hard/soft strata, hard cap,
// scree and a dust apron merged into one draw), angular half-buried boulders, and cap-rock mesas.
// Everything is generated geometry with the strata palette and the cavity shading baked into vertex
// colour; `rocks.ts` owns the shared material that samples grain in world space.
import { BufferGeometry, Color, Float32BufferAttribute, IcosahedronGeometry } from "three";
import {
  CAP,
  CREAM,
  DEEP,
  DUST,
  HARD,
  SOFT,
  STRATA,
  fbm3,
  h01,
  hash,
  lathe,
  noise3,
  smooth,
} from "./rocks.js";

const TAU = Math.PI * 2;
const _c = new Color();

// ---- merge ---------------------------------------------------------------------------------------

/** Concatenates indexed or flat geometries that all carry position, normal, colour and uv. */
export function merge(parts: readonly BufferGeometry[]): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const tex: number[] = [];
  const idx: number[] = [];
  for (const g of parts) {
    const base = pos.length / 3;
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i += 1) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      for (const [out, name] of [
        [nor, "normal"],
        [col, "color"],
      ] as const) {
        const a = g.getAttribute(name);
        out.push(a.getX(i), a.getY(i), a.getZ(i));
      }
      const t = g.getAttribute("uv");
      tex.push(t?.getX(i) ?? 0, t?.getY(i) ?? 0);
    }
    const ix = g.getIndex();
    for (let i = 0; i < (ix?.count ?? p.count); i += 1) idx.push(base + (ix?.getX(i) ?? i));
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  out.setAttribute("color", new Float32BufferAttribute(col, 3));
  out.setAttribute("uv", new Float32BufferAttribute(tex, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// ---- tafoni --------------------------------------------------------------------------------------

/**
 * Cellular pit mask on a cylinder: `u` runs 0..cols around (it tiles), `v` is metres up in cell
 * units. `depth` is 0 outside a pit and rises steeply to 1 on the floor; `rim` marks the lip.
 * `cover` (0-1) is the share of cells that hold a pit; the pit is wider than it is tall.
 */
function pitMask(
  u: number,
  v: number,
  cols: number,
  seed: number,
  cover: number,
  out: { depth: number; rim: number },
): void {
  out.depth = 0;
  out.rim = 0;
  const ci0 = Math.floor(u);
  const cj0 = Math.floor(v);
  for (let di = -1; di <= 1; di += 1) {
    for (let dj = -1; dj <= 1; dj += 1) {
      const ci = ci0 + di;
      const cj = cj0 + dj;
      const w = ((ci % cols) + cols) % cols;
      if (h01(w, cj, 1, seed) > cover) continue;
      const fx = ci + 0.3 + 0.4 * h01(w, cj, 2, seed);
      const fy = cj + 0.3 + 0.4 * h01(w, cj, 3, seed);
      const rho = 0.3 + 0.22 * h01(w, cj, 4, seed);
      const d = Math.hypot(u - fx, (v - fy) * 1.3) / rho;
      const k = 1 - d;
      if (k <= 0) continue;
      out.depth = Math.max(out.depth, smooth(0, 0.3, k));
      out.rim = Math.max(out.rim, smooth(0.05, 0.2, k) * (1 - smooth(0.2, 0.4, k)));
    }
  }
}

// ---- boulders ------------------------------------------------------------------------------------

/**
 * An angular rock: an icosphere clipped by random planes (a rough polyhedron), flat-shaded, with
 * the lower part sunk below y = 0. Colour: strata bands, sand on the up faces, dark at the contact.
 */
export function boulderGeometry(radius: number, seed: number, detail = 3): BufferGeometry {
  const g = new IcosahedronGeometry(1, detail);
  const planes: [number, number, number, number][] = [];
  for (let k = 0; k < 9; k += 1) {
    const a = h01(k, 0, 0, seed) * TAU;
    const y = hash(k, 1, 0, seed) * 0.9;
    const l = Math.sqrt(1 - y * y);
    planes.push([Math.cos(a) * l, y, Math.sin(a) * l, 0.68 + 0.26 * h01(k, 2, 0, seed)]);
  }
  const sx = 1 + 0.35 * hash(1, 5, 0, seed);
  const sz = 1 + 0.35 * hash(2, 5, 0, seed);
  const sy = 0.5 + 0.28 * h01(3, 5, 0, seed);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i += 1) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    let r = 1.2;
    for (const [nx, ny, nz, d] of planes) {
      const dp = x * nx + y * ny + z * nz;
      if (dp > 0.05) r = Math.min(r, d / dp);
    }
    r *=
      1 +
      0.06 * fbm3(x * 3 + 7, y * 3, z * 3, seed, 2) +
      0.05 * fbm3(x * 9, y * 9, z * 9, seed + 1, 2);
    p.setXYZ(i, x * r * sx * radius, (y * r * sy + 0.14) * radius, z * r * sz * radius);
  }
  g.computeVertexNormals();
  const n = g.getAttribute("normal");
  // Flat faces: project each along its dominant normal axis (a 3 m tile), so a face has no stretch.
  const tex = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i += 1) {
    const [ax, ay, az] = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
    const top = ay >= ax && ay >= az;
    tex[i * 2] = (top ? p.getX(i) : ax >= az ? p.getZ(i) : p.getX(i)) / 3;
    tex[i * 2 + 1] = (top ? p.getZ(i) : p.getY(i)) / 3;
  }
  g.setAttribute("uv", new Float32BufferAttribute(tex, 2));
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i += 1) {
    const face = Math.floor(i / 3);
    const h = p.getY(i) / radius;
    const band = Math.floor(
      h * 3.2 + 1.2 * fbm3(p.getX(i) / radius, 1, p.getZ(i) / radius, seed + 3),
    );
    _c.copy(((band + seed) % 3 === 0 ? SOFT : HARD)[(band + seed + 6) % 4] as Color);
    _c.lerp(DUST, 0.3 * smooth(0.55, 0.95, n.getY(i)));
    _c.lerp(DUST, 0.4 * (1 - smooth(0.02, 0.22, h)));
    _c.multiplyScalar(
      (0.55 + 0.45 * smooth(-0.05, 0.4, h)) * (0.88 + 0.22 * h01(face, 1, 0, seed)),
    );
    col[i * 3] = _c.r;
    col[i * 3 + 1] = _c.g;
    col[i * 3 + 2] = _c.b;
  }
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---- hoodoos -------------------------------------------------------------------------------------

/** Height fraction where the caprock slab starts; everything above it is the overhanging cap. */
export const CAP_T = 0.87;

/**
 * Radius factor from base (t = 0) to tip (t = 1): a broad flared foot, a stack of 5-7 drums of uneven
 * height (hard ones wide and shouldered, soft ones cut back) that step in and out sharply, and a flat
 * caprock slab that overhangs the shaft with a vertical lobed edge and a flat top. Mesh and hit spheres share it.
 */
export function hoodooProfile(lumps: number, cap: number, phase = 1): (t: number) => number {
  const hh = (i: number): number => {
    const x = Math.sin(i * 12.9898 + phase * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const n = 4 + Math.round(lumps / 4);
  const edges: number[] = [0];
  const widths: number[] = [];
  for (let i = 0; i < n; i += 1) widths.push(0.55 + 0.9 * hh(i));
  const total = widths.reduce((a, c) => a + c, 0);
  for (let i = 0; i < n; i += 1) edges.push((edges[i] as number) + ((widths[i] as number) / total) * CAP_T);
  const hard = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? hh(i + 20) > 0.25 : hh(i + 20) > 0.7));
  const drum = Array.from({ length: n }, (_, i) =>
    hard[i] ? 1.0 + 0.3 * hh(i + 40) : 0.6 + 0.16 * hh(i + 40),
  );
  const taper = (t: number): number => 0.74 - 0.3 * t;
  const capR = 1.5 + cap * 0.8;
  return (t) => {
    const flare = 1 + 0.95 * Math.exp(-t / 0.05);
    let i = 0;
    while (i < n - 1 && t >= (edges[i + 1] as number)) i += 1;
    const lo = edges[i] as number;
    const f = Math.min(1, Math.max(0, (t - lo) / ((edges[i + 1] as number) - lo)));
    const prev = i > 0 ? (drum[i - 1] as number) : (drum[0] as number);
    let r = (drum[i] as number) * (hard[i] ? 1 - 0.08 * smooth(0.3, 1, f) + 0.07 * Math.sin(f * Math.PI * 2) : 1 - 0.14 * Math.sin(f * Math.PI));
    r = prev + (r - prev) * smooth(0, Math.min(0.25, 0.012 / ((edges[i + 1] as number) - lo)), f);
    const shaft = taper(Math.min(t, CAP_T)) * flare * (t < CAP_T ? r : (drum[n - 1] as number));
    if (t < CAP_T) return shaft;
    const c = (t - CAP_T) / (1 - CAP_T);
    // Undercut: the slab springs out from the shaft over its first fifth, then runs vertical.
    const out = 1 + (capR - 1) * smooth(0, 0.22, c);
    const top = 1 - smooth(0.985, 1, t);
    return Math.max(0.02, shaft * out * (0.9 + 0.1 * (1 - c)) * top);
  };
}

/** Where the trunk axis sits at height fraction `t`: a lean that grows with the square of height. */
export function hoodooAxis(radius: number, seed: number, t: number): [number, number] {
  const a = h01(7, 0, 0, seed) * TAU;
  const m = radius * 0.34 * t * t;
  return [Math.cos(a) * m, Math.sin(a) * m];
}

export function hoodooGeometry(
  height: number,
  radius: number,
  profile: (t: number) => number,
  sides: number,
  rows: number,
  seed: number,
  sink = 1.5,
): BufferGeometry {
  const layers = 8 + (Math.abs(seed) % 5);
  const cell = 0.3 * radius;
  const cols = Math.max(4, Math.round((TAU * radius * 0.6) / cell));
  const pit = { depth: 0, rim: 0 };
  const fine = { depth: 0, rim: 0 };
  const tower = lathe(
    sides,
    rows + 1,
    (j, k, v) => {
      const t = j / rows;
      const a = ((k + hash(k, j, 0, seed) * 0.12) / sides) * TAU;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const y = -sink + t * (height + sink);
      const lump = 1 + 0.12 * fbm3(dx * 1.3 + 5, t * 2.1, dz * 1.3, seed + 1, 3);
      // The cap is not round: a lobed, scalloped edge.
      const capMask = smooth(CAP_T - 0.004, CAP_T + 0.01, t);
      const lobe = 1 + capMask * (0.16 * Math.sin(a * 3 + seed) + 0.1 * Math.sin(a * 5 + seed * 2.3) + 0.05 * Math.sin(a * 11 + seed));
      // Under and in the cap the face is fluted: vertical grooves like rain runnels.
      const flute =
        smooth(CAP_T, CAP_T + 0.02, t) *
        (1 - smooth(0.97, 1, t)) *
        0.06 *
        Math.abs(Math.sin(a * 9 + 3 * fbm3(dx * 2, t, dz * 2, seed + 17, 2)));
      const el = 0.28 * Math.sin(t * 3.1 + seed);
      // Strata: layers of uneven thickness; a hard one swells and holds, a soft one is cut back and pits.
      const u = t * layers + 0.8 * fbm3(dx * 1.1, t * 1.5, dz * 1.1, seed + 2, 2);
      const L = Math.floor(u);
      const fr = u - L;
      const hard = h01(L, 0, 0, seed + 3);
      const swell = Math.sqrt(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, fr))));
      const bulge = (0.03 + 0.06 * hard) * (swell - 0.65);
      // Vertical fractures: narrow grooves along long noise valleys.
      const crack =
        1 - smooth(0, 0.05, Math.abs(noise3(dx * 3.2 + 1, t * 0.35, dz * 3.2, seed + 4)));
      const patch = smooth(-0.12, 0.3, fbm3(dx * 1.4 + 3, t * 2.4, dz * 1.4, seed + 5, 2));
      const open = (1 - smooth(CAP_T - 0.05, CAP_T - 0.01, t)) * (1 - 0.7 * hard);
      const cover = (0.4 + 0.6 * patch) * open;
      pitMask((a / TAU) * cols, y / (cell * 1.5), cols, seed, cover, pit);
      pitMask((a / TAU) * cols * 2, y / (cell * 0.75), cols * 2, seed + 50, cover * 0.7, fine);
      const hole = Math.max(pit.depth, 0.5 * fine.depth);
      const rough =
        0.03 * fbm3(dx * 7, t * 18, dz * 7, seed + 6, 2) +
        0.035 * fbm3(dx * 3, t * 7, dz * 3, seed + 16, 2) * (1 + smooth(CAP_T - 0.05, CAP_T, t));
      const r = Math.max(
        0.05 * radius,
        radius *
          profile(t) *
          lump *
          lobe *
          (1 + bulge + rough - flute) *
          (1 - 0.55 * pit.depth - 0.2 * fine.depth - 0.1 * crack),
      );
      const [ax, az] = hoodooAxis(radius, seed, t);
      v.x = ax + dx * (1 + el) * r;
      v.z = az + dz * (1 - el) * r;
      v.y = y;
      // Colour: layer hue (red, orange, cream), hard cap, dust at the foot; cavities baked dark.
      const pal = hard > 0.4 ? HARD : SOFT;
      _c.copy(pal[Math.floor(h01(L, 5, 0, seed) * pal.length)] as Color);
      const lam = Math.floor(u * 4.3 + 1.5 * fbm3(dx * 1.5, t * 3, dz * 1.5, seed + 8, 2));
      _c.multiplyScalar(
        (0.82 + 0.3 * h01(lam, 7, 0, seed)) * (1 - 0.3 * (1 - smooth(0, 0.07, fr))),
      );
      _c.multiplyScalar(0.92 + 0.16 * fbm3(dx * 4, t * 14, dz * 4, seed + 7, 2));
      _c.lerp(CAP, 0.72 * smooth(CAP_T - 0.005, CAP_T + 0.005, t));
      _c.lerp(DUST, 0.6 * (1 - smooth(0.02, 0.14, t)));
      _c.lerp(CREAM, 0.4 * Math.max(pit.rim, fine.rim));
      const ao =
        1 -
        0.8 * hole -
        0.45 * crack -
        0.28 * (1 - swell) -
        0.55 * smooth(CAP_T - 0.07, CAP_T - 0.003, t) * (1 - smooth(CAP_T, CAP_T + 0.01, t));
      _c.lerp(DEEP, 0.5 * hole);
      _c.multiplyScalar((0.62 + 0.38 * smooth(0, 0.2, t)) * Math.max(0.12, ao));
      v.c.copy(_c);
    },
    { around: Math.max(2, Math.round((TAU * radius * 0.8) / 5)), tile: 5 },
  );
  // Scree around the foot, merged so the tower stays one draw.
  const t0 = sink / (height + sink);
  const foot = radius * profile(t0) * 1.05;
  const parts: BufferGeometry[] = [tower];
  const nScree = 6 + Math.floor(h01(8, 0, 0, seed) * 5);
  for (let i = 0; i < nScree; i += 1) {
    const a = h01(i, 9, 0, seed) * TAU;
    const size = radius * (0.06 + 0.2 * h01(i, 10, 0, seed) ** 2);
    const rock = boulderGeometry(size, seed * 31 + i, 1);
    const d = foot * (0.95 + 0.8 * h01(i, 11, 0, seed));
    rock.rotateY(a * 3);
    rock.translate(Math.cos(a) * d, -0.15 * size, Math.sin(a) * d);
    parts.push(rock);
  }
  const out = merge(parts);
  // The trunk's true horizontal reach per height (scree excluded), for the hit spheres.
  const P = tower.getAttribute("position");
  const reach: number[] = [];
  for (let q = 0; q <= REACH_STEPS; q += 1) {
    const tt = q / REACH_STEPS;
    const y = -sink + tt * (height + sink);
    const [ax, az] = hoodooAxis(radius, seed, tt);
    let r = 0;
    for (let i = 0; i < P.count; i += 1)
      if (Math.abs(P.getY(i) - y) < (height + sink) / REACH_STEPS)
        r = Math.max(r, Math.hypot(P.getX(i) - ax, P.getZ(i) - az));
    reach.push(r);
  }
  out.userData.reach = reach;
  return out;
}

const REACH_STEPS = 40;

/** Widest horizontal extent of a hoodoo trunk from its axis at height fraction `t`. */
export function hoodooReach(geo: BufferGeometry, t: number): number {
  const r = geo.userData.reach as number[];
  const f = Math.min(1, Math.max(0, t)) * REACH_STEPS;
  const i = Math.min(REACH_STEPS - 1, Math.floor(f));
  return Math.max(r[i] as number, r[i + 1] as number);
}

// ---- mesas and buttes ----------------------------------------------------------------------------

export interface IMesaOptions {
  /** Nominal footprint radius at the cliff (scaled by the instance). */
  radius: number;
  /** Nominal height (scaled by the instance). */
  height: number;
  /** Vertices per ring (36-48). */
  sides: number;
  /** Rings up the wall (24-32). */
  rows: number;
  /** Strata layers: each a cliff band swelling over a shelf. */
  layers: number;
  seed: number;
}

const TOP_RINGS = 3;

/**
 * A cap-rock mesa at unit size: a wandering footprint, a talus skirt, fluted cliffs stepping back in
 * shelves, and a hard cap that overhangs a shadowed undercut.
 */
export function mesaGeometry(o: IMesaOptions): BufferGeometry {
  const { radius: R, height: H, rows, layers, seed: s } = o;
  const sides = Math.max(o.sides, 40);
  const rim = new Float32Array(sides);
  const rimHeight = new Float32Array(sides);
  return lathe(sides, rows + 1 + TOP_RINGS, (j, k, v) => {
    const a = ((k + hash(k, j, 0, s) * 0.15) / sides) * TAU;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // The footprint wanders: bays and headlands, the same at every height so the cliffs stay sheer.
    const plan = 1 + 0.2 * fbm3(dx * 1.2 + s, 0.5, dz * 1.2, s + 11, 3);
    if (j > rows) {
      const f = 1 - (j - rows) / (TOP_RINGS + 1);
      const r = (rim[k] as number) * f * (1 + 0.05 * hash(k, j, 1, s) * (1 - f));
      v.x = dx * r;
      v.z = dz * r;
      v.y =
        (rimHeight[k] as number) +
        H * (0.015 * (1 - f * f) + 0.01 * fbm3(dx * 2 + 4, 0.5, dz * 2, s + 9, 2));
      v.c.copy(DUST).lerp(STRATA[(s + 2) % STRATA.length] as Color, 0.4);
      v.c.multiplyScalar(0.9 + 0.14 * fbm3(v.x * 3, 2, v.z * 3, s + 10, 2));
      return;
    }
    const t = j / rows;
    const u = Math.max(0, t * layers + 0.8 * fbm3(dx * 1.3 + 3, t * 1.6, dz * 1.3, s, 2));
    const L = Math.floor(u);
    const fr = u - L;
    const hard = h01(L, 0, 0, s + 20);
    const swell = Math.sqrt(Math.sin(Math.PI * Math.min(0.999, Math.max(0.001, fr))));
    const shelf = (0.012 + 0.03 * hard) * (swell - 0.6);
    const stair = 1 - 0.03 * Math.min(L + smooth(0.8, 1, fr), layers);
    const talus = 1 + 0.5 * (1 - smooth(0, 0.22, t)) ** 1.6;
    const flute = 1 - smooth(0, 0.2, Math.abs(noise3(dx * 3.3 + 9, t * 0.5, dz * 3.3, s + 2)));
    const gully = -0.12 * flute * smooth(0.1, 0.3, t);
    const rough = 0.03 * fbm3(dx * 5 + 5, t * 5, dz * 5, s + 3, 3);
    const cap =
      0.06 * smooth(0.855, 0.875, t) -
      0.055 * smooth(0.79, 0.835, t) * (1 - smooth(0.855, 0.875, t));
    const r = R * plan * (stair * talus * (1 + gully + rough + shelf) + cap);
    v.x = dx * r;
    v.z = dz * r;
    v.y = j === 0 ? -0.04 * H : t * H + 0.005 * H * fbm3(dx * 3, t * 3, dz * 3, s + 5, 2);
    if (j === rows) {
      rim[k] = r;
      rimHeight[k] = v.y;
    }
    const pal = hard > 0.4 ? HARD : SOFT;
    v.c.copy(pal[Math.floor(h01(L, 5, 0, s) * pal.length)] as Color);
    v.c.multiplyScalar(0.84 + 0.3 * h01(Math.floor(u * 3.7), 6, 0, s));
    v.c.lerp(DUST, 0.5 * (1 - smooth(0.03, 0.24, t)));
    v.c.lerp(CAP, 0.65 * smooth(0.86, 0.9, t));
    const under = smooth(0.74, 0.8, t) * (1 - smooth(0.835, 0.86, t));
    v.c.multiplyScalar(
      (1 + 1.5 * gully) *
        (0.66 + 0.34 * smooth(0, 0.3, t)) *
        (1 - 0.5 * under) *
        (0.92 + 0.14 * hash(k, j, 2, s)) *
        (0.8 + 0.2 * swell),
    );
  });
}

// ---- kits ----------------------------------------------------------------------------------------

export interface IHoodoo {
  /** Full detail, for towers near the flight path. */
  readonly geo: BufferGeometry;
  /** The same tower at about two fifths of the triangles, for the far flanks. */
  readonly low: BufferGeometry;
  readonly height: number;
  readonly radius: number;
  readonly seed: number;
}

/** [height, radius, lumps, cap, phase, sides, rows, lowSides, lowRows]: tall, slender, wide, medium, stubby. */
const HOODOO_SPECS: readonly (readonly number[])[] = [
  [46, 7.4, 9, 0.5, 0.4, 72, 72, 48, 44],
  [38, 5.2, 11, 0.35, 2.1, 64, 60, 40, 36],
  [28, 5.6, 7, 0.55, 3.7, 56, 48, 36, 30],
  [24, 4.2, 10, 0.3, 5.2, 48, 40, 32, 28],
  [13, 4.2, 6, 0.4, 1.3, 44, 28, 28, 20],
  [17, 3.0, 8, 0.45, 4.4, 40, 30, 26, 22],
];

/** Six distinct hoodoos (seeds differ, so no two share a silhouette); stage picks and scales them. */
export function hoodooKit(): IHoodoo[] {
  return HOODOO_SPECS.map(([height, radius, lumps, cap, phase, sides, rows, lsides, lrows], i) => {
    const profile = hoodooProfile(lumps as number, cap as number, phase as number);
    const seed = 11 + i * 7;
    const make = (sd: number, rw: number): BufferGeometry =>
      hoodooGeometry(height as number, radius as number, profile, sd, rw, seed);
    return {
      geo: make(sides as number, rows as number),
      low: make(lsides as number, lrows as number),
      height: height as number,
      radius: radius as number,
      seed,
    };
  });
}
