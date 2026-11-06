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
import { boulderGeometry as boulderForm, merge as mergeGeometry } from "./rockForms.js";
import {
  dot,
  float,
  mix,
  mx_noise_float,
  normalWorld,
  positionWorld,
  sin,
  smoothstep,
  texture,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

const TAU = Math.PI * 2;
const TILE_BROAD = 3.4; // metres per scan repeat (world space; the scan covers 2 m)

export const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---- seeded 3D value noise ---------------------------------------------------------------------

export function hash(x: number, y: number, z: number, s: number): number {
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
export const STRATA = [0xc4713a, 0xa8472b, 0xd69a5c, 0x8f3b26, 0xcf8a50, 0xb85c34].map(hex);
export const DUST = hex(0xe0b27c);
export const CAP = hex(0x84402a);
export const CREAM = hex(0xe2c394);
export const DEEP = hex(0x4a1a10);
/** Hard layers (red, orange, oxblood) swell and hold; soft ones (cream, tan) recede and pit. */
export const HARD = [0xb5482a, 0xdc7a34, 0xa23a22, 0x8e3320, 0xcf6a30].map(hex);
export const SOFT = [0xe6c595, 0xd9a468, 0xecd2a4, 0xcf9a62].map(hex);
const _a = new Color();
/** Hash in [0, 1). */
export const h01 = (a: number, b: number, c: number, s: number): number =>
  hash(a, b, c, s) * 0.5 + 0.5;

// ---- the revolve builder -----------------------------------------------------------------------

export interface IVert {
  x: number;
  y: number;
  z: number;
  c: Color;
}

/**
 * `lines` rings of `sides` vertices, joined with wrapped indices (no seam), fan-closed at the top.
 * `fn` fills one vertex; normals come from `computeVertexNormals`, so the surface is smooth. With
 * `uv` the seam column is doubled (so the texture wraps `around` times without a smear) and the
 * mesh gains UVs: u around the ring, v = height / `tile`.
 */
export function lathe(
  sides: number,
  lines: number,
  fn: (j: number, k: number, v: IVert) => void,
  uv?: { around: number; tile: number },
): BufferGeometry {
  const cols = uv === undefined ? sides : sides + 1;
  const count = lines * cols + 1;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const tex = new Float32Array(count * 2);
  const v: IVert = { x: 0, y: 0, z: 0, c: new Color() };
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let j = 0; j < lines; j += 1) {
    for (let k = 0; k < cols; k += 1) {
      fn(j, k % sides, v);
      const n = j * cols + k;
      const i = n * 3;
      pos[i] = v.x;
      pos[i + 1] = v.y;
      pos[i + 2] = v.z;
      col[i] = v.c.r;
      col[i + 1] = v.c.g;
      col[i + 2] = v.c.b;
      if (uv !== undefined) {
        tex[n * 2] = (k / sides) * uv.around;
        tex[n * 2 + 1] = v.y / uv.tile;
      }
      if (j === lines - 1 && k < sides) {
        cx += v.x / sides;
        cy += v.y / sides;
        cz += v.z / sides;
      }
    }
  }
  const last = lines * cols * 3;
  pos[last] = cx;
  pos[last + 1] = cy;
  pos[last + 2] = cz;
  const top = (lines - 1) * cols * 3;
  col[last] = col[top] as number;
  col[last + 1] = col[top + 1] as number;
  col[last + 2] = col[top + 2] as number;
  tex[lines * cols * 2] = 0;
  tex[lines * cols * 2 + 1] = cy / (uv?.tile ?? 1);
  const next = (k: number): number => (uv === undefined ? (k + 1) % sides : k + 1);
  const idx: number[] = [];
  for (let j = 0; j < lines - 1; j += 1) {
    for (let k = 0; k < sides; k += 1) {
      const a = j * cols + k;
      const b = j * cols + next(k);
      const c = (j + 1) * cols + k;
      const d = (j + 1) * cols + next(k);
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let k = 0; k < sides; k += 1) {
    idx.push(lines * cols, (lines - 1) * cols + next(k), (lines - 1) * cols + k);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new Float32BufferAttribute(col, 3));
  if (uv !== undefined) g.setAttribute("uv", new Float32BufferAttribute(tex, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (uv !== undefined) {
    // The doubled seam column was shaded from one side each: give both the average.
    const n = g.getAttribute("normal");
    for (let j = 0; j < lines; j += 1) {
      const a = j * cols;
      const b = a + sides;
      const x = n.getX(a) + n.getX(b);
      const y = n.getY(a) + n.getY(b);
      const z = n.getZ(a) + n.getZ(b);
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / l, y / l, z / l);
      n.setXYZ(b, x / l, y / l, z / l);
    }
  }
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// ---- material ----------------------------------------------------------------------------------

/**
 * Pulls baked palette colours (flat r,g,b triples) toward grey and rescales their value, so the vertex
 * colour tints the scanned albedo instead of painting over it: `chroma` keeps that share of the hue.
 */
export function soften(col: Float32Array | number[], chroma = 0.45, gain = 5.6): void {
  for (let i = 0; i < col.length; i += 3) {
    const r = col[i] as number;
    const g = col[i + 1] as number;
    const b = col[i + 2] as number;
    const l = r * 0.299 + g * 0.587 + b * 0.114;
    col[i] = (l + (r - l) * chroma) * gain;
    col[i + 1] = (l + (g - l) * chroma) * gain;
    col[i + 2] = (l + (b - l) * chroma) * gain;
  }
}

export interface IRockTextures {
  /** Scanned layered sandstone (Fab/Quixel "Layered Rock Cliff", 2 m scan): albedo, GL normal, roughness. */
  readonly cliffDiff: Texture;
  /** Tangent-space normals. Used only with `detail: true`, which needs UVs on every mesh. */
  readonly cliffNormal?: Texture;
  readonly cliffRough: Texture;
}

/**
 * One rock material for every rock mesh: the scanned sandstone supplies albedo and roughness,
 * sampled triplanar in world space at three scales so a non-uniform instance scale never stretches it
 * and the tiling never repeats; the vertex colour is only a gentle tint (strata hue, cavity shade), softened by `soften`.
 */
export function rockMaterial(t: IRockTextures, detail = false): MeshStandardNodeMaterial {
  for (const m of [t.cliffDiff, t.cliffRough, t.cliffNormal]) {
    if (m === undefined) continue;
    m.wrapS = RepeatWrapping;
    m.wrapT = RepeatWrapping;
    m.anisotropy = 8;
  }
  t.cliffDiff.colorSpace = SRGBColorSpace;
  const mat = new MeshStandardNodeMaterial({ metalness: 0, roughness: 1 });
  mat.vertexColors = true; // the Wasm engine has no vertexColor() node: the tint is softened at bake time (soften)
  if (detail && t.cliffNormal !== undefined) {
    // Relief the geometry cannot hold: a tangent-space normal map on UVs (a world-space normal node
    // is refused by the owned engine). Meshes using this material must carry a `uv` attribute.
    mat.normalMap = t.cliffNormal;
    mat.normalScale.set(1.1, 1.1);
  }
  const w = normalWorld.abs().pow(4);
  const bf = w.div(w.x.add(w.y).add(w.z));
  const grey = vec3(0.299, 0.587, 0.114);
  const tri = (tex: Texture, tile: number) => {
    const q = positionWorld.div(tile);
    return texture(tex, q.zy).rgb
      .mul(bf.x)
      .add(texture(tex, q.xz).rgb.mul(bf.y))
      .add(texture(tex, q.xy).rgb.mul(bf.z));
  };
  // Broad scan colour at TILE_BROAD, fissure/grain contrast at a quarter and a fifteenth of it.
  const broad = tri(t.cliffDiff, TILE_BROAD);
  const mid = dot(tri(t.cliffDiff, TILE_BROAD / 4.1), grey);
  const fine = dot(tri(t.cliffDiff, TILE_BROAD / 15), grey);
  const contrast = mid.mul(1.8).add(0.55).mul(fine.mul(1.5).add(0.62));
  const pw = positionWorld;
  const drift = mx_noise_float(pw.mul(0.045)).mul(0.16).add(1);
  // Sand settles on upward faces (ledges, caps, talus).
  const sand = smoothstep(0.6, 0.95, normalWorld.y).mul(0.35);
  mat.colorNode = mix(broad, vec3(0.92, 0.68, 0.45), sand).mul(contrast).mul(drift);
  mat.roughnessNode = tri(t.cliffRough, TILE_BROAD / 2).r.mul(0.5).add(0.55);
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

const CLIFF_H = 56; // metres, nominal, at full envelope
const TALUS_H = 4; // the scree apron at the foot
const LAYERS = 7;
const WALL_TILE = 5; // metres per normal-map repeat on the canyon wall
const CHUNK = 48; // fine stations (2 m) per render chunk
const BOTTOM = -30; // the closed solid's floor, far under the ground
const lerpTable = (xs: readonly number[], ys: readonly number[], x: number): number => {
  let i = 0;
  while (i < xs.length - 2 && x > (xs[i + 1] as number)) i += 1;
  const t = (x - (xs[i] as number)) / ((xs[i + 1] as number) - (xs[i] as number));
  return (ys[i] as number) + ((ys[i + 1] as number) - (ys[i] as number)) * t;
};
/** How far the cliff face leans back from its foot at nominal height h: sheer low, rounded high. */
const lean = (h: number): number => lerpTable([0, 10, 24, 40, 56], [0, 0.5, 2.5, 6, 14], h);
/** The slope beyond the cliff top, relative to the lip: [distance, height]. */
const SLOPE: readonly (readonly [number, number])[] = [
  [8, 3],
  [16, 5],
  [28, -4],
  [42, -14],
  [67, -27],
  [92, -40],
  [119, -48],
  [146, -56],
];

interface IPt {
  d: number;
  h: number;
  c: Color;
}

/**
 * Both canyon walls as one closed solid, returned as ~100 m render chunks (each frustum-culls on its
 * own). The cross-section is built per station from rock layers of uneven thickness: each riser is a
 * hard (red, swelling, overhanging) or soft (cream, scooped) band broken into blocks along the wall,
 * every shelf between them is a sharp tread of dust, the foot is a scree apron with fallen blocks and
 * beyond the lip the land rolls away. Fractures cut down every layer as chimneys. A skirt under the
 * wall and end caps close it, so no angle shows a paper-thin plate.
 */
export function canyonWallChunks(coarse: readonly IWallStation[], seed: number): BufferGeometry[] {
  // Half the station spacing, so joints and ragged lips resolve at 2 m.
  const stations: IWallStation[] = [];
  coarse.forEach((a, i) => {
    stations.push(a);
    const b = coarse[i + 1];
    if (b === undefined) return;
    const m = (p: number, q: number): number => (p + q) / 2;
    stations.push({
      x: m(a.x, b.x),
      z: m(a.z, b.z),
      rx: m(a.rx, b.rx),
      rz: m(a.rz, b.rz),
      width: [m(a.width[0], b.width[0]), m(a.width[1], b.width[1])],
      env: m(a.env, b.env),
    });
  });
  const scree: BufferGeometry[] = [];
  const screeChunk: number[] = [];
  const pos: number[] = [];
  const col: number[] = [];
  const tex: number[] = [];
  const idxs: number[][] = [];
  const chunk = (i: number): number => Math.floor(i / CHUNK);
  const c = new Color();
  for (const side of [-1, 1]) {
    const rows: IPt[][] = stations.map((st, i) => {
      const px = st.x + st.rx * side * 40;
      const pz = st.z + st.rz * side * 40;
      const k = st.env;
      const pts: IPt[] = [];
      const add = (d: number, nh: number, color: Color, shade: number): void => {
        // nh is the nominal height; the envelope scales it and sinks the wall where it fades.
        const h = nh * k - 6 * (1 - k);
        pts.push({ d, h, c: new Color().copy(color).multiplyScalar(shade) });
      };
      // Fractures: chimneys cut back through every layer; soft layers are cut deeper.
      const chim = (soft: number): number =>
        (3 + 3 * soft) *
        (1 - smooth(0, 0.14, Math.abs(noise3(px * 0.045, 0.4, pz * 0.045, seed + 3)))) *
        k;
      // Foot: a scree apron leaning on the cliff.
      for (let m = 0; m <= 5; m += 1) {
        const u = m / 5;
        const bump = 0.9 * fbm3(px * 0.3 + m, 2, pz * 0.3, seed + 8, 2);
        add(
          -3 + 6.7 * u + bump,
          TALUS_H * u ** 0.85 + 0.6 * bump * u,
          _a.copy(DUST).lerp(STRATA[(m + seed) % 6] as Color, 0.45 + 0.35 * h01(m, i, side, seed)),
          0.45 + 0.4 * u,
        );
      }
      // Angular fallen blocks on the apron, one every ~14 m a side.
      if (i % 7 === (side + 1) / 2 + 2 && k > 0.5) {
        const u = 0.12 + 0.7 * h01(i, 20, side, seed);
        const size = 0.5 + 2 * h01(i, 21, side, seed) ** 2;
        const rock = boulderForm(size, seed * 13 + i, 1);
        const d = (st.width[side < 0 ? 0 : 1] as number) - 3 + 6.7 * u;
        rock.rotateY(i * 1.7);
        rock.translate(
          st.x + st.rx * side * d,
          TALUS_H * u ** 0.85 * k - 6 * (1 - k) - 0.3 * size,
          st.z + st.rz * side * d,
        );
        scree.push(rock);
        screeChunk.push(chunk(i));
      }
      // Layers: uneven thickness, hardness alternating with noise.
      const b: number[] = [TALUS_H];
      for (let m = 1; m < LAYERS; m += 1)
        b.push(
          TALUS_H +
            ((CLIFF_H - TALUS_H) * (m + 0.45 * noise3(px * 0.011, m * 2.3, pz * 0.011, seed + 2))) /
              LAYERS,
        );
      b.push(CLIFF_H);
      const hard: number[] = [];
      const prot: number[] = [];
      for (let m = 0; m < LAYERS; m += 1) {
        const hd =
          m === LAYERS - 1
            ? 1
            : Math.min(
                1,
                Math.max(
                  0,
                  0.5 +
                    0.9 * noise3(px * 0.008, m * 3.1, pz * 0.008, seed + 1) +
                    (m % 2 === 0 ? 0.22 : -0.22),
                ),
              );
        hard.push(hd);
        prot.push(-(hd - 0.45) * 6);
      }
      let lipD = 0;
      for (let m = 0; m < LAYERS; m += 1) {
        const hb = b[m] as number;
        const ht = b[m + 1] as number;
        const hd = hard[m] as number;
        const first = pts.length;
        const pal = hd > 0.5 ? HARD : SOFT;
        const base = pal[Math.floor(h01(m, 5, side, seed) * pal.length)] as Color;
        const next = prot[m + 1] ?? prot[m];
        const ovh = Math.max(0, (prot[m] as number) - (next as number)); // the layer above sticks out over this one
        // Masonry: each layer breaks into blocks along the wall, each pushed in or out a little.
        const jid = Math.floor((i * 2) / 6.5 + 0.35 * noise3(px * 0.05, m, pz * 0.05, seed + 12));
        const joint = 2.6 * (h01(jid, m, side, seed + 13) - 0.5) * k;
        const blockTone = 0.88 + 0.22 * h01(jid, m, side, seed + 14);
        const face = (f: number): number => {
          const h = hb + (ht - hb) * f;
          const belly = (1 - hd) * 1.6 * Math.sin(Math.PI * f) - hd * 0.9 * Math.sin(Math.PI * f);
          const bump =
            1.8 * fbm3(px * 0.06 + side * 9, h * 0.12, pz * 0.06, seed + 4, 3) +
            0.9 * fbm3(px * 0.4, h * 0.35, pz * 0.4, seed + 5, 2);
          const alcove = 7 * Math.max(0, fbm3(px * 0.018 + 4, h * 0.02, pz * 0.018, seed + 9, 2));
          // 3.5 m of bias keeps every block, overhang and alcove out of the flight corridor.
          return Math.max(
            -1,
            lean(h) + 3.5 + (prot[m] as number) + belly + bump + alcove * k + chim(1 - hd) + joint,
          );
        };
        const lam = (f: number): number =>
          0.86 + 0.26 * h01(Math.floor(f * 3 + m * 5), 6, side, seed);
        for (const f of [0, 0, 0.35, 0.7, 1, 1]) {
          const h = hb + (ht - hb) * f;
          const foot = f === 0 ? 0.62 : 0.8 + 0.2 * smooth(0, 0.4, f);
          const under = 1 - 0.55 * Math.min(1, ovh / 2.5) * smooth(0.7, 1, f);
          // Pairs at f = 0 and f = 1 hold the sharp corner: the first of each pair ends the shelf or the riser.
          const rag = f === 1 ? 1.2 * (h01(i, m, side, seed + 15) - 0.5) : 0;
          add(
            face(f) + rag,
            h,
            base,
            blockTone * foot * under * lam(f) * (1 - 0.16 * (1 - hd) * Math.sin(Math.PI * f)),
          );
        }
        lipD = face(1);
        // The shelf between this lip and the next riser is a tread of dust.
        if (m < LAYERS - 1) (pts[pts.length - 1] as IPt).c.lerp(DUST, 0.6);
        if (m > 0) (pts[first] as IPt).c.lerp(DUST, 0.6);
      }
      // Beyond the lip the land rolls away; strata colour fades into dust.
      SLOPE.forEach(([dd, dh], q) => {
        const bump = 2.2 * fbm3(px * 0.03 + q, 1, pz * 0.03, seed + 6, 3) * k;
        add(
          lipD + dd + bump,
          CLIFF_H + dh + 0.6 * bump,
          _a.copy(DUST).lerp(HARD[1] as Color, 0.3 + 0.1 * (q % 3)),
          0.95,
        );
      });
      return pts;
    });
    const base = pos.length / 3;
    const np = (rows[0] as IPt[]).length;
    stations.forEach((st, i) => {
      for (const p of rows[i] as IPt[]) {
        const dist = (st.width[side < 0 ? 0 : 1] as number) + p.d;
        pos.push(st.x + st.rx * side * dist, p.h, st.z + st.rz * side * dist);
        c.copy(p.c);
        // The low sun leaves a canyon floor in shade: dark base, lit crest.
        c.multiplyScalar(0.4 + 0.6 * smooth(0, 38, Math.max(0, p.h)));
        col.push(c.r, c.g, c.b);
        // Planar UVs along the wall: u along the course, v = height + depth (risers and treads both advance).
        tex.push((i * 2) / WALL_TILE + side * 3.7, (p.h + p.d) / WALL_TILE);
      }
    });
    const ns = stations.length;
    const flip = side === 1;
    const quad = (ch: number, a: number, b2: number, cc: number, d: number): void => {
      const list = (idxs[ch] ??= []);
      if (flip) list.push(a, b2, cc, b2, d, cc);
      else list.push(a, cc, b2, b2, cc, d);
    };
    for (let i = 0; i < ns - 1; i += 1)
      for (let q = 0; q < np - 1; q += 1) {
        const a = base + i * np + q;
        quad(chunk(i), a, a + 1, a + np, a + np + 1);
      }
    // Closing: a skirt down from the foot and the far edge, and an end cap at each end.
    const skirt = (at: (i: number) => number): void => {
      const start = pos.length / 3;
      for (let i = 0; i < ns; i += 1) {
        const o = (base + at(i)) * 3;
        pos.push(pos[o] as number, BOTTOM, pos[o + 2] as number);
        col.push(0.2, 0.1, 0.08);
        tex.push(0, 0);
      }
      for (let i = 0; i < ns - 1; i += 1)
        quad(chunk(i), base + at(i), start + i, base + at(i + 1), start + i + 1);
    };
    skirt((i) => i * np);
    skirt((i) => i * np + np - 1);
    for (const i of [0, ns - 1]) {
      const start = pos.length / 3;
      for (let q = 0; q < np; q += 1) {
        const o = (base + i * np + q) * 3;
        pos.push(pos[o] as number, BOTTOM, pos[o + 2] as number);
        col.push(0.2, 0.1, 0.08);
        tex.push(0, 0);
      }
      for (let q = 0; q < np - 1; q += 1) {
        const a = base + i * np + q;
        if (i === 0) quad(0, a + 1, a, start + q + 1, start + q);
        else quad(chunk(ns - 2), a, a + 1, start + q, start + q + 1);
      }
    }
  }
  // One smooth-normal pass over the whole run, then split into chunks with their own vertex subsets,
  // so each chunk frustum-culls and the seams stay invisible.
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setIndex(idxs.flat());
  g.computeVertexNormals();
  const nor = g.getAttribute("normal");
  return idxs.map((list, ch) => {
    const remap = new Map<number, number>();
    const p: number[] = [];
    const n: number[] = [];
    const k: number[] = [];
    const t2: number[] = [];
    const ix = list.map((v) => {
      let m = remap.get(v);
      if (m === undefined) {
        m = remap.size;
        remap.set(v, m);
        p.push(pos[v * 3] as number, pos[v * 3 + 1] as number, pos[v * 3 + 2] as number);
        n.push(nor.getX(v), nor.getY(v), nor.getZ(v));
        k.push(col[v * 3] as number, col[v * 3 + 1] as number, col[v * 3 + 2] as number);
        t2.push(tex[v * 2] as number, tex[v * 2 + 1] as number);
      }
      return m;
    });
    const part = new BufferGeometry();
    part.setAttribute("position", new Float32BufferAttribute(p, 3));
    part.setAttribute("normal", new Float32BufferAttribute(n, 3));
    part.setAttribute("color", new Float32BufferAttribute(k, 3));
    part.setAttribute("uv", new Float32BufferAttribute(t2, 2));
    part.setIndex(ix);
    const merged = mergeGeometry([part, ...scree.filter((_, j) => screeChunk[j] === ch)]);
    soften(merged.getAttribute("color").array as Float32Array);
    return merged;
  });
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
