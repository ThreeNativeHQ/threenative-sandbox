// Ember Rift: an original red-ochre desert course. Everything here is generated geometry in the
// guide's look (warm terracotta / ochre / rust, faceted rock, no green); the Poly Haven textures
// only carry grain and are remapped to warm tones in the material, so no moss colour survives.
import { markStatic } from "@threenative/core";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  BufferGeometry,
  type Camera,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from "three";
import {
  dot,
  float,
  length,
  mix,
  positionWorld,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { ARENA_RADIUS, type Rail, SECTION, railFrame } from "../entities/Rail.js";
import type { IObstacle } from "../world.js";
import { type IWallStation, canyonWallChunks, rockMaterial } from "./rocks.js";
import { type ITower, scatterRocks } from "./rockScatter.js";
import { createGroundDust } from "./ambientDust.js";
import { createSkyBodies } from "./planet.js";
import { SUN_DIRECTION } from "./sky.js";
import { createGroundClutter } from "./groundClutter.js";
import { desertGround } from "./groundLook.js";
import { ridgelineGeometry } from "./ridgeline.js";

export interface IStageTextures {
  readonly groundDiff: Texture;
  readonly groundNormal: Texture;
  readonly groundRough: Texture;
  readonly rockDiff: Texture;
  readonly rockNormal: Texture;
  readonly rockRough: Texture;
  /** Scanned layered sandstone (Fab/Quixel "Layered Rock Cliff"): the rock kit's albedo, normal and roughness. */
  readonly cliffDiff: Texture;
  readonly cliffNormal: Texture;
  readonly cliffRough: Texture;
}

export interface IStage {
  readonly root: Group;
  /** Static hit spheres the ship must dodge; a tower that breaks removes its own. */
  readonly obstacles: IObstacle[];
  /** Towers a laser or bomb can break, and the material their chunks share with the standing rock. */
  readonly towers: readonly ITower[];
  readonly spireMaterial: Material;
  /** Ground surface height at a world point (the base plane is y = 0). */
  groundHeight(x: number, z: number): number;
  /** Moves the soft ground shadow under the ship. Call once per frame (the HUD does). */
  trackShip(position: Vector3, camera: Camera, dt: number): void;
}

const TILE = 30; // metres per ground texture repeat
const ROCK_TILE = 12;
const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);
/** Arch centres, metres along the course (canyon section). */
export const ARCH_S = [1750, 2000, 2300, 2650, 2950] as const;
/** Named render override: course altitude over the dunes. */
const DUNE_PEAK = 5;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgb = (hex: number) => {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
};

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Non-indexed triangles from (position, uv) corners: flat faces, faceted look. */
function soup(positions: number[], uvs: number[], colors?: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  if (colors !== undefined) g.setAttribute("color", new Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * A jagged tube swept along `path` (N = +Z, so the path must stay in a plane that contains Z's
 * normal, i.e. the XY plane or a vertical line). Ring i has half-extents `rz[i]` (along Z) and
 * `rr[i]` (across the path); `jitter` shakes every vertex so each face catches the light on its own.
 */
function sweep(
  path: Vector3[],
  rz: number[],
  rr: number[],
  sides: number,
  jitter: number,
  seed: number,
  capTop = false,
): BufferGeometry {
  const rnd = rng(seed);
  const n = path.length;
  const rings = path.map((p, i) => {
    const t = new Vector3()
      .subVectors(path[Math.min(i + 1, n - 1)] as Vector3, path[Math.max(i - 1, 0)] as Vector3)
      .normalize();
    const b = new Vector3().crossVectors(t, new Vector3(0, 0, 1));
    return Array.from({ length: sides }, (_, k) => {
      const a = ((k + (rnd() - 0.5) * 0.3) / sides) * TAU;
      const j = 1 + (rnd() - 0.5) * 2 * jitter;
      const v = p.clone();
      v.z += Math.cos(a) * (rz[i] as number) * j;
      v.addScaledVector(b, Math.sin(a) * (rr[i] as number) * j);
      if (i > 0 && i < n - 1) v.addScaledVector(t, (rnd() - 0.5) * jitter * 2);
      return v;
    });
  });
  const along: number[] = [0];
  for (let i = 1; i < n; i += 1)
    along.push((along[i - 1] as number) + (path[i] as Vector3).distanceTo(path[i - 1] as Vector3));
  const pos: number[] = [];
  const uv: number[] = [];
  const push = (v: Vector3, k: number, i: number, span: number): void => {
    pos.push(v.x, v.y, v.z);
    uv.push((k / sides) * span, (along[i] as number) / ROCK_TILE);
  };
  for (let i = 0; i < n - 1; i += 1) {
    const span = Math.max(1, (TAU * Math.max(rz[i] as number, rr[i] as number)) / ROCK_TILE);
    for (let k = 0; k < sides; k += 1) {
      const k1 = (k + 1) % sides;
      const a = (rings[i] as Vector3[])[k] as Vector3;
      const b = (rings[i] as Vector3[])[k1] as Vector3;
      const c = (rings[i + 1] as Vector3[])[k] as Vector3;
      const d = (rings[i + 1] as Vector3[])[k1] as Vector3;
      push(a, k, i, span);
      push(b, k + 1, i, span);
      push(c, k, i + 1, span);
      push(b, k + 1, i, span);
      push(d, k + 1, i + 1, span);
      push(c, k, i + 1, span);
    }
  }
  if (capTop) {
    const top = rings[n - 1] as Vector3[];
    const centre = (path[n - 1] as Vector3).clone();
    for (let k = 0; k < sides; k += 1) {
      for (const v of [centre, top[k] as Vector3, top[(k + 1) % sides] as Vector3]) {
        pos.push(v.x, v.y, v.z);
        uv.push(v.x / ROCK_TILE, v.z / ROCK_TILE);
      }
    }
  }
  return soup(pos, uv);
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();

/** Remaps a grain texture to a warm 3-stop ramp by luminance: kills any green in the source. */
function warmRock(t: IStageTextures, dark: number, mid: number, light: number) {
  for (const map of [t.rockDiff, t.rockNormal, t.rockRough]) {
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
    map.anisotropy = 8;
  }
  t.rockDiff.colorSpace = SRGBColorSpace;
  const mat = new MeshStandardNodeMaterial({
    metalness: 0.08,
    normalMap: t.rockNormal,
    roughnessMap: t.rockRough,
    roughness: 0.9,
  });
  const luma = dot(texture(t.rockDiff).rgb, vec3(0.299, 0.587, 0.114));
  const lo = mix(rgb(dark), rgb(mid), smoothstep(0.0, 0.32, luma));
  mat.colorNode = mix(lo, rgb(light), smoothstep(0.3, 0.7, luma).mul(0.9));
  return mat;
}

/** `tick(fraction)` reports build progress 0..1 and may yield so a loading screen repaints. */
export async function buildStage(
  rail: Rail,
  t: IStageTextures,
  tick: (fraction: number) => Promise<void> = async () => undefined,
): Promise<IStage> {
  const root = new Group();
  const f = railFrame();
  const obstacles: IObstacle[] = [];
  const towers: ITower[] = [];
  const zCanyon = rail.frame(SECTION.canyon, f).position.z;

  // ---- ground ---------------------------------------------------------------------------------
  const duneEnvelope = (x: number, z: number): number =>
    (1 - smooth(-zCanyon - 220, -zCanyon + 120, -z)) *
    (1 - smooth(500, 700, Math.abs(x))) *
    (1 - smooth(150, 300, z));
  const zEnd = rail.arenaCenter.z - 800;
  // The course axis x at each z, so the ground near the ship's path can be a gentle wash.
  const axisZ: number[] = [];
  const axisX: number[] = [];
  for (let d = 0; d <= rail.length; d += 8) {
    rail.frame(d, f);
    axisZ.push(f.position.z);
    axisX.push(f.position.x);
  }
  const railX = (z: number): number => {
    // axisZ falls with distance along the rail: bisect for the segment holding z.
    let lo = 0;
    let hi = axisZ.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((axisZ[mid] as number) > z) lo = mid;
      else hi = mid;
    }
    const z0 = axisZ[lo] as number;
    const k = Math.min(1, Math.max(0, (z0 - z) / Math.max(1e-6, z0 - (axisZ[hi] as number))));
    return (axisX[lo] as number) * (1 - k) + (axisX[hi] as number) * k;
  };
  /**
   * Ground height: the dunes, then rolling relief everywhere (2-7 m over 60-400 m, with ridged gullies,
   * a gentle wash along the ship's path and a calm arena floor), then hills that rise out beyond
   * 170 m of the course to 85 m and close the horizon. Never below 0, so the canyon wall feet
   * (y = 0) stay buried in it; flat at the mesh border so it meets the far plane.
   */
  const groundHeight = (x: number, z: number): number => {
    const a = duneEnvelope(x, z);
    let h = 0;
    if (a > 0) {
      h =
        Math.max(
          0,
          1.4 +
            0.9 * Math.sin(0.013 * x + 0.021 * z) +
            0.8 * Math.sin(0.007 * x - 0.015 * z + 1.7) +
            0.35 * Math.sin(0.04 * x + 0.03 * z + 0.6),
        ) *
        (DUNE_PEAK / 3.45) *
        a;
    }
    const r = Math.hypot(x - rail.arenaCenter.x, z - rail.arenaCenter.z);
    const calm = 0.5 + 0.5 * smooth(ARENA_RADIUS - 40, ARENA_RADIUS + 120, r);
    const lateral = Math.abs(x - railX(z));
    const wash = 0.4 + 0.6 * smooth(20, 100, lateral);
    const roll = Math.max(
      0,
      2.4 +
        2.0 * Math.sin(0.017 * x + 0.011 * z + 0.4) +
        1.4 * Math.sin(0.034 * x - 0.026 * z + 2.1) +
        0.7 * Math.sin(0.071 * x + 0.059 * z),
    );
    // Dune ridges: 1 - |sin| has sharp crests and soft troughs; two warped crest lines at 105 m
    // and 60 m, a finer one at 40 m. They fade out 200-500 m from the axis (the mesh is coarser there).
    const wob = 14 * Math.sin(0.021 * z + 0.013 * x);
    const crest1 = (1 - Math.abs(Math.sin(0.03 * (x + wob) - 0.012 * z + 0.7))) ** 1.4;
    const crest2 =
      (1 - Math.abs(Math.sin(0.052 * x + 0.027 * z + 1.9 + 0.5 * Math.sin(0.04 * z)))) ** 1.4;
    const crest3 = 1 - Math.abs(Math.sin(0.08 * x - 0.06 * z + 2.2));
    const dunes = 8 * crest1 + 4.5 * crest2 + 1.6 * crest3;
    const local = 1 - smooth(200, 500, lateral);
    // Near flanks (20-150 m): isolated 1-3 m mounds, raised slab plates with a sharp edge, and the gullies between.
    const flank = (0.35 + 0.65 * smooth(12, 35, lateral)) * (1 - smooth(150, 300, lateral));
    const mounds =
      Math.max(0, Math.sin(0.045 * x + 0.031 * z + 1) * Math.sin(0.037 * z - 0.029 * x + 2)) **
        0.8 *
      3;
    const slabs =
      smooth(
        0.5,
        0.56,
        Math.sin(0.021 * x + 0.017 * z + 0.3) * Math.sin(0.015 * z - 0.019 * x + 1.1),
      ) * 1.8;
    h +=
      (roll * (1 - a) + (dunes + (mounds + slabs) * flank) * local) *
      calm *
      wash *
      (1 - 0.5 * a) *
      (1 - smooth(300, 800, Math.abs(x)));
    const open = 0.25 + 0.75 * smooth(ARENA_RADIUS - 20, ARENA_RADIUS + 150, r);
    const hills =
      85 *
      smooth(150, 800, Math.abs(x)) *
      (0.4 +
        0.3 * Math.sin(0.0071 * z + 0.0042 * x + 1) +
        0.3 * Math.sin(0.0113 * z - 0.0071 * x + 3));
    h += Math.max(0, hills) * open;
    return (
      h *
      (1 - smooth(2000, 2400, Math.abs(x))) *
      smooth(zEnd - 1400, zEnd - 1100, z) *
      (1 - smooth(1100, 1400, z))
    );
  };

  for (const map of [t.groundDiff]) {
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
    map.anisotropy = 8;
  }
  t.groundDiff.colorSpace = SRGBColorSpace;
  // No normal map: a map repeats on a fixed grid (7.5 m), and the owned engine rejects a node normal,
  // so the relief is geometry (the heightfield below) plus an emboss term in the colour.
  const ground = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.93 });
  {
    // Anti-tiling: the grain is sampled at three non-commensurate scales and rotations, blended by
    // slow world sines (weights always > 0.05), then re-contrasted so the average of three does not
    // wash out. No scale repeats on the same grid, so no tile is readable at any distance.
    const p = positionWorld.xz.div(TILE);
    const turn = (deg: number, k: number, ox: number, oy: number) => {
      const c = Math.cos((deg * Math.PI) / 180);
      const s = Math.sin((deg * Math.PI) / 180);
      const q = p.mul(k);
      return vec2(q.x.mul(c).sub(q.y.mul(s)).add(ox), q.x.mul(s).add(q.y.mul(c)).add(oy));
    };
    const grain = (q: Node<"vec2">) => dot(texture(t.groundDiff, q).rgb, vec3(0.299, 0.587, 0.114));
    const w = positionWorld.xz;
    const w0 = sin(w.x.mul(0.0071).add(w.y.mul(0.0043)))
      .mul(0.3)
      .add(0.35);
    const w1 = sin(w.y.mul(0.0059).sub(w.x.mul(0.0037)).add(2))
      .mul(0.3)
      .add(0.35);
    const w2 = sin(w.x.mul(0.011).add(w.y.mul(0.013)).add(4))
      .mul(0.25)
      .add(0.3);
    const sum = w0.add(w1).add(w2);
    const norm = sqrt(w0.mul(w0).add(w1.mul(w1)).add(w2.mul(w2))).div(sum);
    const q0 = turn(0, 1, 0, 0);
    const l0 = grain(q0);
    const l1 = grain(turn(37, 0.31, 0.27, 0.61));
    const l2 = grain(turn(-23, 1.7, 0.43, 0.12));
    const mean = float(0.14);
    // Emboss: the first layer's brightness against itself a few cm toward the sun reads as relief.
    const emboss = l0
      .sub(grain(q0.add(vec2(0.004, 0.004))))
      .mul(2.5)
      .min(0.12)
      .max(-0.12);
    const luma = w0
      .mul(l0.sub(mean))
      .add(w1.mul(l1.sub(mean)))
      .add(w2.mul(l2.sub(mean)))
      .div(sum)
      .div(norm)
      .add(emboss);
    let col = desertGround(luma);
    // The arena: a pale packed-sand floor with painted rings that give speed and range cues.
    const r = length(positionWorld.xz.sub(vec2(rail.arenaCenter.x, rail.arenaCenter.z)));
    col = mix(col, rgb(0xdba66c), smoothstep(ARENA_RADIUS + 30, ARENA_RADIUS - 10, r).mul(0.2));
    let rings = smoothstep(6, 2, r.sub(75).abs());
    for (const r0 of [150, 225, 300]) rings = rings.max(smoothstep(6, 2, r.sub(r0).abs()));
    ground.colorNode = mix(col, col.mul(vec3(0.42, 0.32, 0.3)), rings.mul(0.9));
  }

  /** A heightfield grid, `cx` by `cz` metres a cell (same `cz` in neighbours, so borders match). */
  const grid = (
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    cx: number,
    cz: number,
    h: (x: number, z: number) => number,
  ) => {
    const nx = Math.max(1, Math.round((x1 - x0) / cx));
    const nz = Math.max(1, Math.round((z1 - z0) / cz));
    const pos: number[] = [];
    for (let j = 0; j <= nz; j += 1) {
      for (let i = 0; i <= nx; i += 1) {
        const x = x0 + ((x1 - x0) * i) / nx;
        const z = z0 + ((z1 - z0) * j) / nz;
        pos.push(x, h(x, z), z);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < nz; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const a = j * (nx + 1) + i;
        const b = a + nx + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  // The course ground in three x bands over the whole z span (same z pitch inside a band, finer near
  // the axis): 10 m cells within 130 m, 20 m to 400 m, 50 m to 900 m, 100 m out to 2.4 km where the hills close the horizon.
  const CORE = 130;
  const z0 = zEnd - 1400;
  const z1 = 1400;
  const bands: [number, number, number, number][] = [
    [-2400, -900, 100, 20],
    [-900, -400, 50, 10],
    [-400, -CORE, 20, 10],
    [-CORE, CORE, 10, 10],
    [CORE, 400, 20, 10],
    [400, 900, 50, 10],
    [900, 2400, 100, 20],
  ];
  // One mesh (one draw) from the bands: they share no vertices, only borders.
  const land = new Mesh(
    mergeGeometries(bands.map(([x0, x1, cx, cz]) => grid(x0, x1, z0, z1, cx, cz, groundHeight))),
    ground,
  );
  land.receiveShadow = true;
  const far = new Mesh(
    grid(-9000, 9000, z0 - 9000, 9000, 18000, 18000, () => -0.3),
    ground,
  );
  far.receiveShadow = true;
  root.add(land, far);

  // ---- rock -----------------------------------------------------------------------------------
  // One rock material for the spires and mesas: rocks.ts carries the strata palette in a vertex
  // colour and samples the grain triplanar in world space, so the mesas' non-uniform sx=r, sy=h
  // scale cannot stretch the texture into bands.
  const rockSpire = rockMaterial(t, true);
  const rockMesa = rockMaterial(t);
  root.add(new Mesh(ridgelineGeometry(rail.frame(0, f).position, rail.arenaCenter), rockMesa));

  /** World point `l` metres right of the path at `s`. */
  const at = (s: number, l: number, out: Vector3): Vector3 => {
    rail.frame(s, f);
    return out.copy(f.position).addScaledVector(f.right, l);
  };
  const nearArch = (s: number): boolean => ARCH_S.some((a) => Math.abs(a - s) < 55);
  // Towers, boulder clusters and mesas: forms in rockForms.ts, placement and hit spheres in rockScatter.ts.
  await tick(0.05);
  const rockBatches = await scatterRocks(
    {
      rail,
      frame: f,
      groundHeight,
      obstacles,
      towers,
      at,
      nearArch,
      seed: 2026,
    },
    (k) => tick(0.2 + 0.48 * k),
  );
  root.add(createGroundClutter(at, groundHeight, rail.length, rail.arenaCenter, ARENA_RADIUS));

  // ---- arches ---------------------------------------------------------------------------------
  // Two legs and a half ring in one swept, jagged tube; the hole in the middle is the way through.
  const archPath: Vector3[] = [];
  const archRz: number[] = [];
  const archRr: number[] = [];
  const R = 11;
  const top = 14;
  const push = (x: number, y: number, w: number): void => {
    archPath.push(new Vector3(x, y, 0));
    archRz.push(w * 1.5);
    archRr.push(w);
  };
  for (const y of [-1.5, 3, 8.5]) push(-R, y, 3.9);
  for (let k = 0; k <= 10; k += 1) {
    const a = Math.PI - (k / 10) * Math.PI;
    push(Math.cos(a) * R, top + Math.sin(a) * R, 3.5 - Math.sin((k / 10) * Math.PI) * 0.9);
  }
  for (const y of [8.5, 3, -1.5]) push(R, y, 3.9);
  const archGeo = sweep(archPath, archRz, archRr, 7, 0.1, 21);
  const archMat = warmRock(t, 0x4a2012, 0xa84c2a, 0xe29458);
  const archs = new InstancedMesh(archGeo, archMat, ARCH_S.length);
  ARCH_S.forEach((s, i) => {
    at(s, 0, _p);
    rail.frame(s, f);
    const yaw = Math.atan2(-f.forward.x, -f.forward.z);
    _q.setFromAxisAngle(UP, yaw);
    _m.compose(new Vector3(_p.x, 0, _p.z), _q, _s.set(1, 1, 1));
    archs.setMatrixAt(i, _m);
    archs.setColorAt(i, _c.setRGB(1, 0.95, 0.9));
    const to = (lx: number, ly: number): Vector3 =>
      new Vector3(lx, ly, 0).applyQuaternion(_q).add(new Vector3(_p.x, 0, _p.z));
    for (const side of [-1, 1]) {
      for (const y of [1.5, 5.5, 9.5, 13]) obstacles.push({ center: to(side * R, y), radius: 3.7 });
    }
    for (const deg of [15, 35, 55, 75, 90, 105, 125, 145, 165]) {
      const a = (deg * Math.PI) / 180;
      obstacles.push({ center: to(Math.cos(a) * R, top + Math.sin(a) * R), radius: 3.5 });
    }
  });
  archs.instanceMatrix.needsUpdate = true;
  if (archs.instanceColor !== null) archs.instanceColor.needsUpdate = true;
  archs.computeBoundingSphere();
  archs.computeBoundingBox();
  root.add(archs);

  // Each baked rock mesh is unique geometry, so the projection can never batch it: renderOrder 1 files
  // it as an exact-lane draw instead of counting it toward the "unique geometry" decline warning.
  const solid = (geo: BufferGeometry, mat: MeshStandardNodeMaterial): Mesh => {
    const m = new Mesh(geo, mat);
    m.renderOrder = 1;
    return m;
  };
  for (const b of rockBatches) root.add(solid(b.geo, b.mesa ? rockMesa : rockSpire));

  await tick(0.7);
  // ---- canyon walls ---------------------------------------------------------------------------
  // Ledged, eroded cliffs from rocks.ts (strata colours in the vertex colour, world-space grain).
  {
    const S0 = SECTION.canyon - 160;
    const S1 = SECTION.plain + 160;
    const stations: IWallStation[] = [];
    for (let s = S0; s <= S1; s += 4) {
      const env =
        smooth(SECTION.canyon - 60, SECTION.canyon + 180, s) *
        (1 - smooth(SECTION.plain - 180, SECTION.plain + 40, s));
      const width = (side: number): number =>
        24 + 5 * Math.sin(s * 0.017 + side) + 3 * Math.sin(s * 0.05);
      rail.frame(s, f);
      stations.push({
        x: f.position.x,
        z: f.position.z,
        rx: f.right.x,
        rz: f.right.z,
        width: [width(-1), width(1)],
        env,
      });
    }
    for (const wall of canyonWallChunks(stations, 77)) root.add(solid(wall, rockSpire));
  }

  // ---- ship shadow ----------------------------------------------------------------------------
  const shadowMat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    color: 0x000000,
  });
  const strength = uniform(0.5);
  shadowMat.opacityNode = smoothstep(0.5, 0.05, length(uv().sub(0.5))).mul(strength);
  const blob = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat);
  blob.renderOrder = 2;
  blob.visible = false;
  blob.frustumCulled = false;
  root.add(blob);
  for (const child of root.children) if (child !== blob) markStatic(child);
  // Ground dust moves every frame, so it joins the root after the freeze.
  const dust = createGroundDust((mesh) => {
    root.add(mesh);
    return mesh;
  }, groundHeight);
  const skyBodies = createSkyBodies(SUN_DIRECTION);
  root.add(skyBodies.group);

  return {
    root,
    obstacles,
    towers,
    spireMaterial: rockSpire,
    groundHeight,
    trackShip(p, camera, dt) {
      dust.update(p, camera, Math.min(0.1, dt));
      skyBodies.update(camera);
      blob.visible = true;
      const gy = groundHeight(p.x, p.z);
      const alt = Math.max(0, p.y - gy);
      blob.position.set(p.x, gy + 0.08, p.z);
      blob.scale.setScalar(4 + alt * 0.12);
      strength.value = 0.5 * Math.max(0, 1 - alt / 45);
    },
  };
}
