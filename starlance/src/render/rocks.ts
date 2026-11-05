// Ember Rift rock: seeded fractal-noise heightmaps revolved into smooth, indexed meshes. Mesas and
// buttes carry terraced strata (cliff bands, short ledges), a talus skirt and a cap-rock rim; hoodoos
// are stacked eroded discs under a cap; boulders are flattened noise spheres. Colour lives in a vertex
// attribute (strata bands, dust on ledges, crevice shade) and the Poly Haven grain is sampled in world
// space (triplanar), so a non-uniform instance scale never stretches the texture into bands.
import {
  BufferGeometry,
  Color,
  CatmullRomCurve3,
  Float32BufferAttribute,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from "three";
import {
  dot,
  float,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  smoothstep,
  texture,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

const TAU = Math.PI * 2;
const ROCK_TILE = 14; // metres per grain repeat (world space)

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- seeded 3D value noise ---------------------------------------------------------------------

function hash(x: number, y: number, z: number, s: number): number {
  let h =
    (Math.imul(x, 0x27d4eb2d) ^
      Math.imul(y, 0x165667b1) ^
      Math.imul(z, 0x9e3779b1) ^
      Math.imul(s + 1, 0x85ebca6b)) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Smooth value noise in about [-0.7, 0.7]. */
export function noise3(x: number, y: number, z: number, s: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(0, 1, x - ix);
  const fy = smooth(0, 1, y - iy);
  const fz = smooth(0, 1, z - iz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number): number => hash(ix + dx, iy + dy, iz + dz, s);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy),
    l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}

/** Fractal noise: `oct` octaves, each twice the frequency and half the weight, normalised. */
export function fbm3(x: number, y: number, z: number, s: number, oct = 3): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < oct; i += 1) {
    sum += amp * noise3(x * freq, y * freq, z * freq, s + i * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// ---- palette (hex goes through Color, so the vertex values are in the working colour space) ------

const hex = (h: number): Color => new Color(h);
const STRATA = [0xc4713a, 0xa8472b, 0xd69a5c, 0x8f3b26, 0xcf8a50, 0xb85c34].map(hex);
const DUST = hex(0xe0b27c);
const CAP = hex(0x84402a);
const _a = new Color();

// ---- the revolve builder -----------------------------------------------------------------------

interface IVert {
  x: number;
  y: number;
  z: number;
  c: Color;
}

/**
 * `lines` rings of `sides` vertices, joined with wrapped indices (no seam), fan-closed at the top.
 * `fn` fills one vertex; normals come from `computeVertexNormals`, so the surface is smooth.
 */
function lathe(
  sides: number,
  lines: number,
  fn: (j: number, k: number, v: IVert) => void,
): BufferGeometry {
  const count = lines * sides + 1;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const v: IVert = { x: 0, y: 0, z: 0, c: new Color() };
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let j = 0; j < lines; j += 1) {
    for (let k = 0; k < sides; k += 1) {
      fn(j, k, v);
      const i = (j * sides + k) * 3;
      pos[i] = v.x;
      pos[i + 1] = v.y;
      pos[i + 2] = v.z;
      col[i] = v.c.r;
      col[i + 1] = v.c.g;
      col[i + 2] = v.c.b;
      if (j === lines - 1) {
        cx += v.x / sides;
        cy += v.y / sides;
        cz += v.z / sides;
      }
    }
  }
  const last = lines * sides * 3;
  pos[last] = cx;
  pos[last + 1] = cy;
  pos[last + 2] = cz;
  const top = (lines - 1) * sides * 3;
  col[last] = col[top] as number;
  col[last + 1] = col[top + 1] as number;
  col[last + 2] = col[top + 2] as number;
  const idx: number[] = [];
  for (let j = 0; j < lines - 1; j += 1) {
    for (let k = 0; k < sides; k += 1) {
      const k1 = (k + 1) % sides;
      const a = j * sides + k;
      const b = j * sides + k1;
      const c = (j + 1) * sides + k;
      const d = (j + 1) * sides + k1;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let k = 0; k < sides; k += 1) {
    idx.push(lines * sides, (lines - 1) * sides + ((k + 1) % sides), (lines - 1) * sides + k);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---- mesas and buttes --------------------------------------------------------------------------

export interface IMesaOptions {
  /** Nominal footprint radius at the cliff, metres (the talus skirt widens it). */
  radius: number;
  /** Nominal height, metres. */
  height: number;
  /** Vertices per ring (24-40). */
  sides: number;
  /** Rings up the wall (24-40). */
  rows: number;
  /** Strata layers: each one a cliff band plus a short ledge. */
  layers: number;
  seed: number;
}

const TOP_RINGS = 3;

export function mesaGeometry(o: IMesaOptions): BufferGeometry {
  const { radius: R, height: H, sides, rows, layers, seed: s } = o;
  const rim = new Float32Array(sides);
  const rimHeight = new Float32Array(sides);
  return lathe(sides, rows + 1 + TOP_RINGS, (j, k, v) => {
    const jitter = hash(k, j, 0, s) * 0.18;
    const a = ((k + jitter) / sides) * TAU;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    if (j > rows) {
      // Top: a mostly flat plate with a slight crown and a ragged edge.
      const f = 1 - (j - rows) / (TOP_RINGS + 1);
      const r = (rim[k] as number) * f * (1 + 0.05 * hash(k, j, 1, s) * (1 - f));
      v.x = dx * r;
      v.z = dz * r;
      v.y =
        (rimHeight[k] as number) +
        H * (0.02 * (1 - f * f) + 0.012 * fbm3((v.x / R) * 2 + 4, 0.5, (v.z / R) * 2, s + 9, 2));
      v.c.copy(DUST).lerp(STRATA[(s + 2) % STRATA.length] as Color, 0.35);
      v.c.multiplyScalar(0.92 + 0.12 * fbm3((v.x / R) * 3, 2, (v.z / R) * 3, s + 10, 2));
      return;
    }
    const t = j / rows;
    // Layer coordinate; the angle-dependent warp makes the ledges wander up and down the butte.
    const u = Math.max(0, t * layers + 0.7 * fbm3(dx * 1.3 + 3, t * 1.6, dz * 1.3, s, 2));
    const layer = Math.floor(u);
    const fr = u - layer;
    const stair = layer + smooth(0.72, 1, fr);
    const base = 1 - 0.036 * Math.min(stair, layers);
    const talus = 1 + 0.4 * (1 - smooth(0, 0.2, t)) ** 1.7;
    const n = noise3(dx * 2.4 + 9, t * 0.7, dz * 2.4, s + 2);
    const gully = -0.11 * (1 - smooth(0, 0.18, Math.abs(n))); // vertical erosion grooves
    const rough = 0.045 * fbm3(dx * 4 + 5, t * 4, dz * 4, s + 3, 3);
    const lip = 0.06 * smooth(0.84, 1, t) * fbm3(dx * 2.5, 1.3, dz * 2.5, s + 4, 2);
    const cap =
      0.05 * smooth(0.89, 0.91, t) - 0.03 * smooth(0.82, 0.86, t) * (1 - smooth(0.89, 0.91, t));
    const r = R * (base * talus * (1 + gully + rough + lip) + cap);
    v.x = dx * r;
    v.z = dz * r;
    v.y = j === 0 ? -0.04 * H : t * H + 0.006 * H * fbm3(dx * 3, t * 3, dz * 3, s + 5, 2);
    if (j === rows) {
      rim[k] = r;
      rimHeight[k] = v.y;
    }
    // Colour: strata band, pale dust on the ledges and talus, dark varnished cap, shaded grooves.
    v.c.copy(STRATA[(layer + s) % STRATA.length] as Color);
    if (layer % 2 === 1) v.c.lerp(DUST, 0.22);
    v.c.lerp(DUST, 0.45 * smooth(0.72, 1, fr));
    v.c.lerp(DUST, 0.7 * (1 - smooth(0.04, 0.22, t)));
    v.c.lerp(_a.copy(CAP), 0.6 * smooth(0.9, 0.93, t));
    v.c.multiplyScalar(
      (1 + 1.4 * gully) * (0.7 + 0.3 * smooth(0, 0.3, t)) * (0.94 + 0.12 * hash(k, j, 2, s)),
    );
  });
}

// ---- hoodoos -----------------------------------------------------------------------------------

/**
 * Radius factor from base (t = 0) to tip (t = 1) of a hoodoo: a flared foot, a neck eroded into
 * stacked discs, a cap-rock slab and a rounded top. The mesh and the hit spheres share it.
 */
export function hoodooProfile(discs: number, cap: number, phase = 1): (t: number) => number {
  return (t) => {
    const flare = 1 + 0.75 * Math.exp(-t / 0.07);
    const body = 0.56 - 0.2 * t;
    const disc = 1 + 0.2 * Math.tanh(2.2 * Math.sin(t * discs * TAU + phase));
    const slab = 1 + cap * smooth(0.78, 0.82, t) * (1 - smooth(0.92, 0.95, t));
    const dome = t > 0.96 ? Math.sqrt(Math.max(0.01, 1 - ((t - 0.96) / 0.04) ** 2)) : 1;
    return flare * body * disc * slab * dome;
  };
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
  return lathe(sides, rows + 1, (j, k, v) => {
    const t = j / rows;
    const a = ((k + hash(k, j, 0, seed) * 0.15) / sides) * TAU;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const n = noise3(dx * 2.2 + 5, t * 1.2, dz * 2.2, seed + 1);
    const groove = -0.09 * (1 - smooth(0, 0.2, Math.abs(n)));
    const rough = 0.07 * fbm3(dx * 3.5, t * 6, dz * 3.5, seed + 2, 3);
    const r = Math.max(0.04, radius * profile(t) * (1 + groove + rough));
    v.x = dx * r;
    v.z = dz * r;
    v.y = -sink + t * (height + sink);
    const band = Math.floor(t * 7 + 0.5 * fbm3(dx, t * 2, dz, seed + 3, 2));
    v.c.copy(STRATA[(band + seed) % STRATA.length] as Color);
    v.c.lerp(DUST, 0.5 * (1 - smooth(0.02, 0.2, t)) + 0.18 * (band % 2));
    v.c.lerp(_a.copy(CAP), 0.5 * smooth(0.78, 0.84, t));
    v.c.multiplyScalar((1 + 1.5 * groove) * (0.72 + 0.28 * smooth(0, 0.25, t)));
  });
}

// ---- boulders ----------------------------------------------------------------------------------

/** A flattened noise-displaced sphere, half sunk in the ground. */
export function boulderGeometry(
  radius: number,
  seed: number,
  sides = 14,
  rows = 9,
): BufferGeometry {
  return lathe(sides, rows + 1, (j, k, v) => {
    const phi = -0.4 + (j / rows) * (Math.PI / 2 + 0.4 - 0.02);
    const a = ((k + hash(k, j, 0, seed) * 0.2) / sides) * TAU;
    const dx = Math.cos(a) * Math.cos(phi);
    const dz = Math.sin(a) * Math.cos(phi);
    const dy = Math.sin(phi);
    const n =
      1 +
      0.3 * fbm3(dx * 1.1 + 7, dy * 1.1, dz * 1.1, seed, 2) +
      0.1 * fbm3(dx * 3, dy * 3, dz * 3, seed + 5, 2);
    v.x = dx * radius * n;
    v.z = dz * radius * n;
    v.y = dy * radius * 0.62 * n;
    v.c.copy(STRATA[(seed + (j % 2)) % STRATA.length] as Color).lerp(DUST, 0.25);
    v.c.multiplyScalar(
      (0.78 + 0.26 * smooth(-0.4, 0.6, phi)) * (0.92 + 0.16 * hash(k, j, 3, seed)),
    );
  });
}

// ---- material ----------------------------------------------------------------------------------

export interface IRockTextures {
  readonly rockDiff: Texture;
}

/**
 * One rock material for every rock mesh: the vertex colour carries the palette, and the grain
 * texture only modulates it, sampled triplanar in world space plus a slow world-noise tone drift.
 */
export function rockMaterial(t: IRockTextures): MeshStandardNodeMaterial {
  t.rockDiff.wrapS = RepeatWrapping;
  t.rockDiff.wrapT = RepeatWrapping;
  t.rockDiff.anisotropy = 8;
  t.rockDiff.colorSpace = SRGBColorSpace;
  const mat = new MeshStandardNodeMaterial({ metalness: 0.05, roughness: 0.92 });
  mat.vertexColors = true;
  const p = positionWorld.mul(1 / ROCK_TILE);
  const w = normalWorld.abs().pow(4);
  const bf = w.div(w.x.add(w.y).add(w.z));
  const grey = vec3(0.299, 0.587, 0.114);
  const luma = dot(texture(t.rockDiff, p.zy).rgb, grey)
    .mul(bf.x)
    .add(dot(texture(t.rockDiff, p.xz).rgb, grey).mul(bf.y))
    .add(dot(texture(t.rockDiff, p.xy).rgb, grey).mul(bf.z));
  const drift = mx_noise_float(positionWorld.mul(0.045)).mul(0.14).add(1);
  const grain = mix(float(0.5), float(1.2), smoothstep(0.1, 0.75, luma));
  // Sand settles on upward faces (ledges, caps, talus) and the steep faces stay rust.
  const sand = smoothstep(0.6, 0.95, normalWorld.y).mul(0.45);
  mat.colorNode = mix(vec3(1, 0.93, 0.88), vec3(1.2, 1.1, 0.92), sand).mul(grain.mul(drift));
  return mat;
}

// ---- canyon walls ------------------------------------------------------------------------------

/** One slice of the course: its centre, the right vector, the half-width of the floor and the wall height gain (0-1). */
export interface IWallStation {
  x: number;
  z: number;
  rx: number;
  rz: number;
  /** Floor half-width on the left (-1) and right (+1) side. */
  width: readonly [number, number];
  env: number;
}

/** Cross-section from the floor edge outward: [distance from the edge, height] at full envelope. */
const WALL_PROFILE: readonly (readonly [number, number])[] = [
  [0, -1],
  [0.5, 10],
  [2.5, 24],
  [6, 40],
  [14, 56],
  [28, 61],
  [56, 42],
  [106, 16],
  [160, 0],
];
const LAYER_M = 9; // metres per strata layer on a canyon cliff

/**
 * Both canyon walls as one indexed mesh: the cross-section is resampled finely, cliffs step back in
 * ledges every layer, and fractal noise pushes every vertex along the face normal. Normals are smooth.
 */
export function canyonWallGeometry(
  stations: readonly IWallStation[],
  seed: number,
): BufferGeometry {
  const pts: { d: number; h: number }[] = [];
  WALL_PROFILE.forEach(([d, h], i) => {
    const next = WALL_PROFILE[i + 1];
    if (next === undefined) return pts.push({ d, h });
    const n = Math.min(12, Math.ceil(Math.hypot(next[0] - d, next[1] - h) / (i < 5 ? 2.5 : 6)));
    for (let m = 0; m < n; m += 1)
      pts.push({ d: d + ((next[0] - d) * m) / n, h: h + ((next[1] - h) * m) / n });
  });
  const np = pts.length;
  // Outward normal in the (d, h) plane (toward the air: up and toward the floor on a cliff).
  const nrm = pts.map((_, q) => {
    const a = pts[Math.max(0, q - 1)] as { d: number; h: number };
    const b = pts[Math.min(np - 1, q + 1)] as { d: number; h: number };
    const dd = b.d - a.d;
    const dh = b.h - a.h;
    const l = Math.hypot(dd, dh) || 1;
    return { nd: -dh / l, nh: dd / l };
  });
  const ns = stations.length;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new Color();
  for (const side of [-1, 1]) {
    const base = pos.length / 3;
    stations.forEach((st, i) => {
      pts.forEach((p, q) => {
        const { nd, nh } = nrm[q] as { nd: number; nh: number };
        const cliff = Math.min(1, Math.abs(nd) * 1.6);
        const px = st.x + st.rx * side * 40;
        const pz = st.z + st.rz * side * 40;
        const hh = Math.max(-1, p.h * st.env);
        const u = Math.max(0, hh / LAYER_M + 0.7 * fbm3(px * 0.012, 3, pz * 0.012, seed, 2));
        const layer = Math.floor(u);
        const fr = u - layer;
        const stair = layer + smooth(0.8, 1, fr);
        const amp = (1.2 + 5 * cliff) * st.env;
        const bump =
          amp * fbm3(px * 0.03 + side * 9, hh * 0.05, pz * 0.03, seed + 1, 3) +
          0.9 * cliff * fbm3(px * 0.2, hh * 0.25, pz * 0.2, seed + 2, 2) +
          0.35 * cliff * fbm3(px * 0.7, hh * 0.8, pz * 0.7, seed + 4, 2);
        const gully =
          -3.2 *
          cliff *
          st.env *
          (1 - smooth(0, 0.16, Math.abs(noise3(px * 0.05, 0.4, pz * 0.05, seed + 3))));
        const dist =
          st.width[side < 0 ? 0 : 1] + p.d + 2.2 * stair * cliff * st.env + (bump + gully) * nd;
        const y = Math.max(-1, hh + (bump + gully) * nh * 0.5);
        pos.push(st.x + st.rx * side * dist, y, st.z + st.rz * side * dist);
        c.copy(STRATA[(layer + seed) % STRATA.length] as Color);
        if (layer % 2 === 1) c.lerp(DUST, 0.22);
        c.lerp(DUST, 0.35 * smooth(0.8, 1, fr) * cliff);
        c.lerp(DUST, 0.5 * (1 - cliff) * smooth(8, 0, hh));
        // The low sun leaves a canyon floor in shade: dark base, lit crest.
        c.multiplyScalar(
          (0.38 + 0.62 * smooth(0, 38, Math.max(0, hh))) * (0.94 + 0.12 * hash(i, q, side, seed)),
        );
        col.push(c.r, c.g, c.b);
      });
    });
    const flip = side === 1;
    for (let i = 0; i < ns - 1; i += 1) {
      for (let q = 0; q < np - 1; q += 1) {
        const a = base + i * np + q;
        const b = a + 1;
        const cc = a + np;
        const d = cc + 1;
        if (flip) idx.push(a, b, cc, b, d, cc);
        else idx.push(a, cc, b, b, cc, d);
      }
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

// ---- arches ------------------------------------------------------------------------------------

/**
 * A smooth eroded tube along `path` (a plane containing Z's normal, i.e. XY or a vertical line).
 * Radii `rz` (along Z) and `rr` (across the path) are per path point; the path is subdivided through
 * a Catmull-Rom curve. Both ends are open: they sink into the ground.
 */
export function tubeGeometry(
  path: Vector3[],
  rz: number[],
  rr: number[],
  sides: number,
  seed: number,
  subdiv = 3,
): BufferGeometry {
  const curve = new CatmullRomCurve3(path, false, "centripetal");
  const n = (path.length - 1) * subdiv;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const c = new Color();
  const tan = new Vector3();
  const bin = new Vector3();
  const p = new Vector3();
  for (let i = 0; i <= n; i += 1) {
    const u = i / n;
    curve.getPoint(u, p);
    curve.getTangent(u, tan);
    bin.crossVectors(tan, new Vector3(0, 0, 1)).normalize();
    const f = u * (path.length - 1);
    const i0 = Math.min(path.length - 2, Math.floor(f));
    const w = f - i0;
    const z = (rz[i0] as number) * (1 - w) + (rz[i0 + 1] as number) * w;
    const r = (rr[i0] as number) * (1 - w) + (rr[i0 + 1] as number) * w;
    for (let k = 0; k < sides; k += 1) {
      const a = (k / sides) * TAU;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const bump =
        1 +
        0.16 * fbm3(ca * 1.2 + 3, sa * 1.2, u * 9, seed, 3) -
        0.1 * (1 - smooth(0, 0.2, Math.abs(noise3(ca * 2 + 7, sa * 2, u * 6, seed + 1))));
      pos.push(
        p.x + bin.x * sa * r * bump,
        p.y + bin.y * sa * r * bump,
        p.z + ca * z * bump + bin.z * sa * r * bump,
      );
      const band = Math.floor(u * 9 + 0.6 * fbm3(ca, sa, u * 3, seed + 2, 2));
      c.copy(STRATA[(band + seed) % STRATA.length] as Color);
      if (band % 2 === 1) c.lerp(DUST, 0.22);
      c.lerp(DUST, 0.5 * (1 - smooth(0, 0.08, Math.min(u, 1 - u))));
      c.multiplyScalar(
        (0.62 + 0.38 * smooth(0, 0.18, Math.min(u, 1 - u))) * (0.94 + 0.12 * hash(k, i, 0, seed)),
      );
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < sides; k += 1) {
      const k1 = (k + 1) % sides;
      const a = i * sides + k;
      const b = i * sides + k1;
      const cc = (i + 1) * sides + k;
      const d = (i + 1) * sides + k1;
      idx.push(a, cc, b, b, cc, d);
    }
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(pos, 3));
  out.setAttribute("color", new Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}
