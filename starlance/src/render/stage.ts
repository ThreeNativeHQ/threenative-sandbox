// Ember Rift: an original red-ochre desert course. Everything here is generated geometry in the
// guide's look (warm terracotta / ochre / rust, faceted rock, no green); the Poly Haven textures
// only carry grain and are remapped to warm tones in the material, so no moss colour survives.
import { markStatic } from "@threenative/core";
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
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
  mx_noise_float,
  positionWorld,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { ARENA_RADIUS, type Rail, SECTION, railFrame } from "../entities/Rail.js";
import type { IObstacle } from "../world.js";
import {
  boulderGeometry,
  hoodooGeometry,
  hoodooProfile,
  mesaGeometry,
  rockMaterial,
} from "./rocks.js";

export interface IStageTextures {
  readonly groundDiff: Texture;
  readonly groundNormal: Texture;
  readonly groundRough: Texture;
  readonly rockDiff: Texture;
  readonly rockNormal: Texture;
  readonly rockRough: Texture;
}

export interface IStage {
  readonly root: Group;
  /** Static hit spheres the ship must dodge. */
  readonly obstacles: readonly IObstacle[];
  /** Ground surface height at a world point (the base plane is y = 0). */
  groundHeight(x: number, z: number): number;
  /** Moves the soft ground shadow under the ship. Call once per frame (the HUD does). */
  trackShip(position: Vector3): void;
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

interface IPlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  tint: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();

function instanced(
  geo: BufferGeometry,
  mat: MeshStandardNodeMaterial,
  list: IPlacement[],
  seed: number,
) {
  const rnd = rng(seed);
  const mesh = new InstancedMesh(geo, mat, Math.max(1, list.length));
  mesh.count = list.length;
  list.forEach((p, i) => {
    _q.setFromAxisAngle(UP, p.yaw);
    _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(p.sx, p.sy, p.sz));
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(
      i,
      _c.setRGB(p.tint, p.tint * (0.9 + rnd() * 0.1), p.tint * (0.84 + rnd() * 0.16)),
    );
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  return mesh;
}

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

export function buildStage(rail: Rail, t: IStageTextures): IStage {
  const root = new Group();
  const f = railFrame();
  const obstacles: IObstacle[] = [];
  const zCanyon = rail.frame(SECTION.canyon, f).position.z;

  // ---- ground ---------------------------------------------------------------------------------
  const duneEnvelope = (x: number, z: number): number =>
    (1 - smooth(-zCanyon - 220, -zCanyon + 120, -z)) *
    (1 - smooth(500, 700, Math.abs(x))) *
    (1 - smooth(150, 300, z));
  const groundHeight = (x: number, z: number): number => {
    const a = duneEnvelope(x, z);
    if (a <= 0) return 0;
    const h =
      1.4 +
      0.9 * Math.sin(0.013 * x + 0.021 * z) +
      0.8 * Math.sin(0.007 * x - 0.015 * z + 1.7) +
      0.35 * Math.sin(0.04 * x + 0.03 * z + 0.6);
    return Math.max(0, h) * (DUNE_PEAK / 3.45) * a;
  };

  for (const map of [t.groundDiff, t.groundNormal, t.groundRough]) {
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
    map.anisotropy = 8;
  }
  t.groundDiff.colorSpace = SRGBColorSpace;
  const ground = new MeshStandardNodeMaterial({
    metalness: 0,
    normalMap: t.groundNormal,
    roughnessMap: t.groundRough,
    roughness: 1,
  });
  ground.roughnessNode = float(0.93);
  {
    // Anti-tiling: the diffuse grain is sampled a second time at 0.27x the tiling scale and turned
    // 37 degrees, then the two lumas are blended by world noise, so the 30 m repeat never lines up
    // across an open dune; a slower noise drifts the tone +/-15% so the sand reads as patches.
    const grey = vec3(0.299, 0.587, 0.114);
    const a37 = (37 * Math.PI) / 180;
    const ca = Math.cos(a37);
    const sa = Math.sin(a37);
    const u2 = uv().mul(0.27);
    const turned = vec2(u2.x.mul(ca).sub(u2.y.mul(sa)), u2.x.mul(sa).add(u2.y.mul(ca)));
    const luma = mix(
      dot(texture(t.groundDiff).rgb, grey),
      dot(texture(t.groundDiff, turned).rgb, grey),
      mx_noise_float(positionWorld.xz.mul(0.015), 0.5, 0.5),
    );
    let col = mix(rgb(0x6a2d1c), rgb(0xc2663a), smoothstep(0.05, 0.6, luma));
    col = mix(col, rgb(0xe3a56b), smoothstep(0.5, 0.9, luma).mul(0.8));
    const patch = sin(positionWorld.x.mul(0.0031).add(1.3)).mul(
      sin(positionWorld.z.mul(0.0023).add(0.4)),
    );
    col = mix(col, col.mul(vec3(0.7, 0.58, 0.54)), patch.mul(0.5).add(0.5).mul(0.65));
    col = col.mul(smoothstep(0, 3, positionWorld.y).mul(0.35).add(0.82));
    col = col.mul(mx_noise_float(positionWorld.xz.mul(0.01), 0.15, 1));
    // The arena: a pale packed-sand floor with painted rings that give speed and range cues.
    const r = length(positionWorld.xz.sub(vec2(rail.arenaCenter.x, rail.arenaCenter.z)));
    col = mix(col, rgb(0xdba66c), smoothstep(ARENA_RADIUS + 30, ARENA_RADIUS - 10, r).mul(0.55));
    let rings = smoothstep(6, 2, r.sub(75).abs());
    for (const r0 of [150, 225, 300]) rings = rings.max(smoothstep(6, 2, r.sub(r0).abs()));
    ground.colorNode = mix(col, col.mul(vec3(0.42, 0.32, 0.3)), rings.mul(0.9));
  }

  const grid = (
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    cell: number,
    h: (x: number, z: number) => number,
  ) => {
    const nx = Math.max(1, Math.round((x1 - x0) / cell));
    const nz = Math.max(1, Math.round((z1 - z0) / cell));
    const pos: number[] = [];
    const uv: number[] = [];
    for (let j = 0; j <= nz; j += 1) {
      for (let i = 0; i <= nx; i += 1) {
        const x = x0 + ((x1 - x0) * i) / nx;
        const z = z0 + ((z1 - z0) * j) / nz;
        pos.push(x, h(x, z), z);
        uv.push(x / TILE, z / TILE);
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
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  const dunes = new Mesh(grid(-720, 720, zCanyon - 140, 320, 14, groundHeight), ground);
  dunes.receiveShadow = true;
  const far = new Mesh(
    grid(-9000, 9000, rail.arenaCenter.z - 9000, 9000, 18000, () => -0.3),
    ground,
  );
  far.receiveShadow = true;
  // The flat ground nearer than the far plane: the course corridor, full detail, no gap in the mist.
  const flat = new Mesh(
    grid(-900, 900, rail.arenaCenter.z - 800, zCanyon - 100, 300, () => 0),
    ground,
  );
  root.add(dunes, flat, far);

  // ---- rock -----------------------------------------------------------------------------------
  // One rock material for the spires and mesas: rocks.ts carries the strata palette in a vertex
  // colour and samples the grain triplanar in world space, so the mesas' non-uniform sx=r, sy=h
  // scale cannot stretch the texture into bands.
  const rockSpire = rockMaterial(t);
  const rockMesa = rockSpire;
  const rockWall = warmRock(t, 0x401a10, 0x9a4228, 0xd8804a);
  rockWall.vertexColors = true;
  rockWall.side = DoubleSide;

  type Bucket = { geo: BufferGeometry; list: IPlacement[]; mat: MeshStandardNodeMaterial };
  const bucket = (geo: BufferGeometry, mat: MeshStandardNodeMaterial): Bucket => ({
    geo,
    list: [],
    mat,
  });
  // The mesh and the hit spheres share one radius-by-height profile per spire size.
  const profileS = hoodooProfile(5, 0.4, 1.1);
  const profileM = hoodooProfile(4, 0.5, 2.3);
  const profileL = hoodooProfile(7, 0.35, 0.4);
  const spireS = bucket(hoodooGeometry(15, 2.6, profileS, 8, 18, 11), rockSpire);
  const spireM = bucket(hoodooGeometry(27, 3.6, profileM, 9, 20, 12), rockSpire);
  const spireL = bucket(hoodooGeometry(44, 5.2, profileL, 10, 24, 13), rockSpire);
  const boulderA = bucket(boulderGeometry(1.6, 14, 10, 6), rockSpire);
  const boulderB = bucket(boulderGeometry(2.2, 15, 9, 6), rockSpire);
  const mesaA = bucket(
    mesaGeometry({ radius: 1, height: 1, sides: 14, rows: 10, layers: 4, seed: 16 }),
    rockMesa,
  );
  const mesaB = bucket(
    mesaGeometry({ radius: 1, height: 1, sides: 12, rows: 9, layers: 3, seed: 17 }),
    rockMesa,
  );
  const buckets = [spireS, spireM, spireL, boulderA, boulderB, mesaA, mesaB];
  const spireProfile = new Map<Bucket, { h: number; r: number; p: (t: number) => number }>([
    [spireS, { h: 15, r: 2.6, p: profileS }],
    [spireM, { h: 27, r: 3.6, p: profileM }],
    [spireL, { h: 44, r: 5.2, p: profileL }],
  ]);
  const rnd = rng(2026);
  const range = (a: number, b: number): number => a + (b - a) * rnd();
  const pick = <T>(...xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

  /** World point `l` metres right of the path at `s`. */
  const at = (s: number, l: number, out: Vector3): Vector3 => {
    rail.frame(s, f);
    return out.copy(f.position).addScaledVector(f.right, l);
  };
  const place = (b: Bucket, s: number, l: number, scale = 1, hit = false): void => {
    at(s, l, _p);
    const gy = groundHeight(_p.x, _p.z);
    const sy = scale * range(0.9, 1.15);
    b.list.push({
      x: _p.x,
      y: gy,
      z: _p.z,
      yaw: rnd() * TAU,
      sx: scale,
      sy,
      sz: scale,
      tint: range(0.8, 1.1),
    });
    const prof = spireProfile.get(b);
    if (hit && prof !== undefined) {
      for (const tt of [0.08, 0.3, 0.52, 0.74]) {
        const y = gy - 1.5 + tt * (prof.h + 1.5) * sy;
        if (y > 34) break;
        obstacles.push({
          center: new Vector3(_p.x, y, _p.z),
          radius: Math.max(1.3, prof.r * prof.p(tt) * scale * 0.92 + 0.5),
        });
      }
    } else if (hit) {
      obstacles.push({
        center: new Vector3(_p.x, gy + 1.2 * scale, _p.z),
        radius: 2 * scale + 0.6,
      });
    }
  };
  const nearArch = (s: number): boolean => ARCH_S.some((a) => Math.abs(a - s) < 55);

  // Section A: dunes, spires standing in and around the corridor.
  for (let s = 140; s < SECTION.canyon - 60; s += range(24, 44)) {
    const inside = rnd() < 0.3;
    const side = rnd() < 0.5 ? -1 : 1;
    const l = inside ? range(-14, 14) : side * range(24, 110);
    const b = inside ? pick(spireS, spireM, spireM, spireL) : pick(spireM, spireL, spireL, spireS);
    place(b, s, l, range(0.85, 1.2), inside);
  }
  // Section B: a few boulders and low fangs in the corridor, tall rock only in the walls.
  for (let s = SECTION.canyon + 70; s < SECTION.plain - 90; s += range(55, 100)) {
    if (nearArch(s)) continue;
    const l = range(-12, 12);
    if (rnd() < 0.5) place(pick(spireS, spireS, spireM), s, l, range(0.8, 1.05), true);
    else place(pick(boulderA, boulderB), s, l, range(1.1, 1.7), true);
  }
  // Section C: open plain, sparse rock in the corridor.
  for (let s = SECTION.plain + 40; s < rail.length - 220; s += range(70, 120)) {
    const inside = rnd() < 0.45;
    const side = rnd() < 0.5 ? -1 : 1;
    const l = inside ? range(-13, 13) : side * range(30, 120);
    place(pick(spireS, spireM, spireL), s, l, range(0.85, 1.15), inside);
  }
  // Boulder scatter on the ground: parallax at 30 m/s.
  for (let s = 20; s < rail.length; s += range(5, 11)) {
    if (s > SECTION.canyon - 20 && s < SECTION.plain + 20) {
      if (rnd() < 0.6) continue;
    }
    const l = (rnd() < 0.5 ? -1 : 1) * range(5, 95);
    // Boulders within 40 m of the path are solid: they register as obstacles the ship collides with.
    place(pick(boulderA, boulderB), s, l, range(0.5, 2.2), Math.abs(l) < 40);
  }

  // Mesas: flat-topped, flanking section C, a skyline everywhere, and a ring around the arena.
  const mesa = (x: number, z: number, r: number, h: number): void => {
    const b = rnd() < 0.5 ? mesaA : mesaB;
    b.list.push({
      x,
      y: groundHeight(x, z) - 1,
      z,
      yaw: rnd() * TAU,
      sx: r,
      sy: h,
      sz: r * range(0.7, 1.1),
      tint: range(0.8, 1.05),
    });
  };
  for (let s = SECTION.plain - 100; s < rail.length; s += range(110, 190)) {
    for (const side of [-1, 1]) {
      at(s, side * range(110, 420), _p);
      mesa(_p.x, _p.z, range(22, 62), range(16, 52));
    }
  }
  for (let s = 100; s < rail.length; s += range(200, 320)) {
    const side = rnd() < 0.5 ? -1 : 1;
    if (s > SECTION.canyon - 100 && s < SECTION.plain + 100) continue;
    at(s, side * range(520, 1500), _p);
    mesa(_p.x, _p.z, range(70, 170), range(45, 130));
  }
  rail.frame(rail.length, f);
  const approach = Math.atan2(f.position.z - rail.arenaCenter.z, f.position.x - rail.arenaCenter.x);
  for (let k = 0; k < 28; k += 1) {
    const a = (k / 28) * TAU + range(-0.05, 0.05);
    const d = Math.atan2(Math.sin(a - approach), Math.cos(a - approach));
    if (Math.abs(d) < 0.5) continue; // the gate the course enters by
    const rr = ARENA_RADIUS + range(55, 110);
    mesa(
      rail.arenaCenter.x + Math.cos(a) * rr,
      rail.arenaCenter.z + Math.sin(a) * rr,
      range(45, 82),
      range(42, 95),
    );
  }
  // Boulders on the arena floor, clear of the middle.
  for (let k = 0; k < 40; k += 1) {
    const a = rnd() * TAU;
    const rr = range(60, ARENA_RADIUS - 10);
    const b = pick(boulderA, boulderB);
    b.list.push({
      x: rail.arenaCenter.x + Math.cos(a) * rr,
      y: 0,
      z: rail.arenaCenter.z + Math.sin(a) * rr,
      yaw: rnd() * TAU,
      sx: 1,
      sy: 1,
      sz: 1,
      tint: range(0.8, 1.1),
    });
  }

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

  for (const b of buckets) {
    if (b.list.length === 0) continue;
    root.add(instanced(b.geo, b.mat, b.list, 99));
  }

  // ---- canyon walls ---------------------------------------------------------------------------
  {
    const rows: [number, number][] = [
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
    const S0 = SECTION.canyon - 160;
    const S1 = SECTION.plain + 160;
    const step = 14;
    const rw = rng(77);
    const pos: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    for (const side of [-1, 1]) {
      const grid: Vector3[][] = [];
      const shade: number[][] = [];
      for (let s = S0; s <= S1; s += step) {
        const env =
          smooth(SECTION.canyon - 60, SECTION.canyon + 180, s) *
          (1 - smooth(SECTION.plain - 180, SECTION.plain + 40, s));
        const width = 24 + 5 * Math.sin(s * 0.017 + side) + 3 * Math.sin(s * 0.05);
        const line: Vector3[] = [];
        const lit: number[] = [];
        for (const [d, h] of rows) {
          // Shake every vertex along the course too, so no seam runs straight down the cliff.
          rail.frame(s + (d > 1 ? (rw() - 0.5) * step * 0.8 : 0), f);
          const hh = Math.max(-1, h * env + (h > 2 ? (rw() - 0.5) * 9 * env : 0));
          const dd = width + d + (d > 1 ? (rw() - 0.5) * 8 : 0);
          line.push(
            new Vector3(
              f.position.x + f.right.x * side * dd,
              Math.max(-1, hh),
              f.position.z + f.right.z * side * dd,
            ),
          );
          // Fake the shadow a low sun leaves in a canyon: dark base, lit crest.
          lit.push(0.38 + 0.62 * smooth(0, 38, Math.max(0, hh)));
        }
        grid.push(line);
        shade.push(lit);
      }
      for (let i = 0; i < grid.length - 1; i += 1) {
        for (let j = 0; j < rows.length - 1; j += 1) {
          const corner = (ii: number, jj: number): void => {
            const v = (grid[ii] as Vector3[])[jj] as Vector3;
            pos.push(v.x, v.y, v.z);
            uv.push(
              (S0 + ii * step) / ROCK_TILE,
              (rows[jj] as [number, number])[0] / 18 + v.y / ROCK_TILE,
            );
            const c = (shade[ii] as number[])[jj] as number;
            col.push(c, c * 0.95, c * 0.92);
          };
          corner(i, j);
          corner(i, j + 1);
          corner(i + 1, j);
          corner(i, j + 1);
          corner(i + 1, j + 1);
          corner(i + 1, j);
        }
      }
    }
    const wall = new Mesh(soup(pos, uv, col), rockWall);
    root.add(wall);
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

  return {
    root,
    obstacles,
    groundHeight,
    trackShip(p) {
      blob.visible = true;
      const gy = groundHeight(p.x, p.z);
      const alt = Math.max(0, p.y - gy);
      blob.position.set(p.x, gy + 0.08, p.z);
      blob.scale.setScalar(4 + alt * 0.12);
      strength.value = 0.5 * Math.max(0, 1 - alt / 45);
    },
  };
}
