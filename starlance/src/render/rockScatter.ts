// Where the rocks stand: hoodoo towers (six distinct forms, leaning, scaled non-uniformly), boulder
// clusters, and cap-rock mesas (four forms, no 1:1 repeats). Pure placement: the forms live in
// rockForms.ts and the hit spheres are derived from the same radius profile and lean axis, so the
// ship collides with what the player sees.
import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import { ARENA_RADIUS, type Rail, type IRailFrame, SECTION } from "../entities/Rail.js";
import type { IObstacle } from "../world.js";
import { boulderGeometry, hoodooAxis, hoodooKit, hoodooReach, mesaGeometry } from "./rockForms.js";
import { soften } from "./rocks.js";

const TAU = Math.PI * 2;

export interface IPlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  tint: number;
}

export interface IScatterEnv {
  readonly rail: Rail;
  readonly frame: IRailFrame;
  readonly groundHeight: (x: number, z: number) => number;
  readonly obstacles: IObstacle[];
  /** World point `l` metres right of the path at `s`. */
  readonly at: (s: number, l: number, out: Vector3) => Vector3;
  readonly nearArch: (s: number) => boolean;
  readonly seed: number;
}

/** One static mesh: every rock of a cell baked into world space, so a cell costs one draw. */
export interface IBatch {
  readonly geo: BufferGeometry;
  /** Mesas carry no UVs (they are scaled up to 170x), so they take the flat-grain material. */
  readonly mesa: boolean;
}

/** Bakes placed copies of forms into one world-space geometry (positions, normals, tint, uv). */
function bake(
  items: readonly { geo: BufferGeometry; p: IPlacement }[],
  seed: number,
): BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const { geo } of items) {
    nv += geo.getAttribute("position").count;
    ni += geo.getIndex()?.count ?? geo.getAttribute("position").count;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const col = new Float32Array(nv * 3);
  const tex = new Float32Array(nv * 2);
  const idx = new Uint32Array(ni);
  const rnd = rng(seed);
  let v = 0;
  let k = 0;
  for (const { geo, p } of items) {
    const P = geo.getAttribute("position");
    const N = geo.getAttribute("normal");
    const C = geo.getAttribute("color");
    const T = geo.getAttribute("uv");
    const cos = Math.cos(p.yaw);
    const sin = Math.sin(p.yaw);
    const tr = p.tint;
    const tg = p.tint * (0.9 + rnd() * 0.1);
    const tb = p.tint * (0.84 + rnd() * 0.16);
    for (let i = 0; i < P.count; i += 1) {
      const x = P.getX(i) * p.sx;
      const y = P.getY(i) * p.sy;
      const z = P.getZ(i) * p.sz;
      const o = (v + i) * 3;
      pos[o] = x * cos + z * sin + p.x;
      pos[o + 1] = y + p.y;
      pos[o + 2] = -x * sin + z * cos + p.z;
      // The inverse-transpose of a scale is its reciprocal.
      const nx = N.getX(i) / p.sx;
      const ny = N.getY(i) / p.sy;
      const nz = N.getZ(i) / p.sz;
      const l = Math.hypot(nx, ny, nz) || 1;
      nor[o] = (nx * cos + nz * sin) / l;
      nor[o + 1] = ny / l;
      nor[o + 2] = (-nx * sin + nz * cos) / l;
      col[o] = C.getX(i) * tr;
      col[o + 1] = C.getY(i) * tg;
      col[o + 2] = C.getZ(i) * tb;
      if (T) {
        tex[(v + i) * 2] = T.getX(i);
        tex[(v + i) * 2 + 1] = T.getY(i);
      }
    }
    const ix = geo.getIndex();
    const n = ix?.count ?? P.count;
    for (let i = 0; i < n; i += 1) idx[k + i] = v + (ix?.getX(i) ?? i);
    v += P.count;
    k += n;
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new Float32BufferAttribute(pos, 3));
  out.setAttribute("normal", new Float32BufferAttribute(nor, 3));
  soften(col);
  out.setAttribute("color", new Float32BufferAttribute(col, 3));
  out.setAttribute("uv", new Float32BufferAttribute(tex, 2));
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

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

/** Fills the instance lists for every rock batch and pushes the hit spheres. */
export function scatterRocks(e: IScatterEnv): IBatch[] {
  // ponytail: test-only seam for A/B frame cost (`?rocks=none`); the playtest bridge cannot write state.
  if (/[?&]rocks=none/.test(String(globalThis.location?.search ?? ""))) return [];
  const { rail, groundHeight, obstacles, at } = e;
  const rnd = rng(e.seed);
  const range = (a: number, b: number): number => a + (b - a) * rnd();
  const pick = <T>(...xs: T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  // Rocks are grouped by 350 m of course and each cell is baked into one static mesh: one draw per
  // cell (an InstancedMesh per form would cost a draw per form per cell) that frustum-culls as a cell.
  let cell = 0;
  const batch = (geo: BufferGeometry, mesa = false) => {
    const cells = new Map<number, IPlacement[]>();
    return {
      geo,
      mesa,
      cells,
      add: (placement: IPlacement): void => {
        const list = cells.get(cell) ?? [];
        cells.set(cell, list);
        list.push(placement);
      },
    };
  };
  const p = new Vector3();

  const hoodoos = hoodooKit().map((kit) => ({ kit, ...batch(kit.geo), far: batch(kit.low) }));
  const [tallA, tallB, midA, midB, stubA, stubB] = hoodoos as [
    (typeof hoodoos)[0],
    (typeof hoodoos)[0],
    (typeof hoodoos)[0],
    (typeof hoodoos)[0],
    (typeof hoodoos)[0],
    (typeof hoodoos)[0],
  ];
  // Boulders: big angular blocks and cheaper small ones, three forms of each.
  const bigRocks = [1.5, 1.8, 2.1].map((r, i) => batch(boulderGeometry(r, 14 + i * 5, 2)));
  const smallRocks = [0.9, 1.1, 1.3].map((r, i) => batch(boulderGeometry(r, 40 + i * 3, 1)));
  const mesas = [
    [36, 22, 4, 16],
    [40, 24, 3, 17],
    [36, 22, 5, 18],
    [40, 22, 3, 19],
  ].map(([sides, rows, layers, seed]) =>
    batch(
      mesaGeometry({
        radius: 1,
        height: 1,
        sides: sides as number,
        rows: rows as number,
        layers: layers as number,
        seed: seed as number,
      }),
      true,
    ),
  );

  type Hoodoo = (typeof hoodoos)[0];
  type Form = ReturnType<typeof batch>;
  const placeHoodoo = (h: Hoodoo, s: number, l: number, scale: number, hit: boolean): void => {
    at(s, l, p);
    const gy = groundHeight(p.x, p.z);
    const sy = scale * range(0.85, 1.2);
    const sx = scale * range(0.85, 1.15);
    const sz = scale * range(0.85, 1.15);
    const yaw = rnd() * TAU;
    (Math.abs(l) < 70 ? h : h.far).add({
      x: p.x,
      y: gy,
      z: p.z,
      yaw,
      sx,
      sy,
      sz,
      tint: range(0.85, 1.1),
    });
    if (!hit) return;
    const { kit } = h;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    // Spheres follow the leaning axis (rotated by the instance yaw) and the visible radius.
    for (let tt = 0.06; tt < 0.95; tt += Math.max(0.1, (kit.radius * 0.9) / (kit.height * sy))) {
      const y = gy - 1.5 + tt * (kit.height + 1.5) * sy;
      if (y > 36) break;
      const [ax, az] = hoodooAxis(kit.radius, kit.seed, tt);
      const lx = ax * sx;
      const lz = az * sx;
      obstacles.push({
        center: new Vector3(p.x + cos * lx + sin * lz, y, p.z - sin * lx + cos * lz),
        radius: Math.max(1.3, hoodooReach(kit.geo, tt) * Math.max(sx, sz) * 0.9 + 0.35),
      });
    }
  };
  const placeRock = (
    b: Form,
    x: number,
    z: number,
    scale: number,
    r: number,
    hit: boolean,
  ): void => {
    const gy = groundHeight(x, z);
    b.add({
      x,
      y: gy,
      z,
      yaw: rnd() * TAU,
      sx: scale * range(0.85, 1.2),
      sy: scale * range(0.8, 1.2),
      sz: scale * range(0.85, 1.2),
      tint: range(0.8, 1.1),
    });
    if (hit)
      obstacles.push({
        center: new Vector3(x, gy + 0.4 * r * scale, z),
        radius: r * scale * 0.95 + 0.4,
      });
  };
  /** A cluster: one big block with a few smaller ones tumbled around it. */
  const cluster = (x: number, z: number, big: number, hit: boolean): void => {
    placeRock(pick(...bigRocks), x, z, big, 1.8, hit);
    const n = Math.floor(range(2, 6));
    for (let k = 0; k < n; k += 1) {
      const a = rnd() * TAU;
      const d = range(1.6, 3.4) * big;
      const small = rnd() < 0.55;
      placeRock(
        small ? pick(...smallRocks) : pick(...bigRocks),
        x + Math.cos(a) * d,
        z + Math.sin(a) * d,
        small ? range(0.5, 1.1) : range(0.45, 0.8) * big,
        small ? 1.1 : 1.8,
        hit,
      );
    }
  };

  // Section A: dunes, towers standing in and around the corridor, a few stubs between them.
  for (let s = 140; s < SECTION.canyon - 60; s += range(24, 44)) {
    cell = Math.floor(s / 350);
    const inside = rnd() < 0.3;
    const side = rnd() < 0.5 ? -1 : 1;
    const l = inside ? range(-14, 14) : side * range(24, 110);
    const h = inside ? pick(tallB, midA, midB, midB, tallA) : pick(midA, tallA, tallA, tallB, midB);
    placeHoodoo(h, s, l, range(0.85, 1.2), inside);
    if (rnd() < 0.45)
      placeHoodoo(
        pick(stubA, stubB),
        s + range(-12, 12),
        l + range(-18, 18),
        range(0.7, 1.2),
        false,
      );
  }
  // Section B: a few boulders and low towers in the corridor, tall rock only in the walls.
  for (let s = SECTION.canyon + 70; s < SECTION.plain - 90; s += range(55, 100)) {
    cell = Math.floor(s / 350);
    if (e.nearArch(s)) continue;
    const l = range(-12, 12);
    if (rnd() < 0.5) placeHoodoo(pick(stubA, stubB, midB), s, l, range(0.8, 1.05), true);
    else {
      at(s, l, p);
      cluster(p.x, p.z, range(0.9, 1.3), true);
    }
  }
  // Section C: open plain, sparse rock in the corridor.
  for (let s = SECTION.plain + 40; s < rail.length - 220; s += range(70, 120)) {
    cell = Math.floor(s / 350);
    const inside = rnd() < 0.45;
    const side = rnd() < 0.5 ? -1 : 1;
    const l = inside ? range(-13, 13) : side * range(30, 120);
    placeHoodoo(pick(tallA, tallB, midA, midB), s, l, range(0.85, 1.15), inside);
  }
  // Boulder clusters on the ground: parallax at 30 m/s; those within 40 m of the path are solid.
  for (let s = 20; s < rail.length; s += range(26, 52)) {
    cell = Math.floor(s / 350);
    if (s > SECTION.canyon - 20 && s < SECTION.plain + 20 && rnd() < 0.6) continue;
    const l = (rnd() < 0.5 ? -1 : 1) * range(6, 95);
    at(s, l, p);
    cluster(p.x, p.z, range(0.8, 1.9), Math.abs(l) < 40);
  }

  // Mesas: flat-topped, flanking section C, a skyline everywhere, and a ring around the arena.
  const mesa = (x: number, z: number, r: number, h: number): void => {
    pick(...mesas).add({
      x,
      y: groundHeight(x, z) - 1,
      z,
      yaw: rnd() * TAU,
      sx: r * range(0.85, 1.15),
      sy: h,
      sz: r * range(0.7, 1.1),
      tint: range(0.8, 1.05),
    });
  };
  const f = e.frame;
  for (let s = SECTION.plain - 100; s < rail.length; s += range(110, 190)) {
    cell = Math.floor(s / 350);
    for (const side of [-1, 1]) {
      at(s, side * range(110, 420), p);
      mesa(p.x, p.z, range(22, 62), range(16, 52));
    }
  }
  for (let s = 100; s < rail.length; s += range(200, 320)) {
    cell = Math.floor(s / 350);
    const side = rnd() < 0.5 ? -1 : 1;
    if (s > SECTION.canyon - 100 && s < SECTION.plain + 100) continue;
    at(s, side * range(520, 1500), p);
    mesa(p.x, p.z, range(70, 170), range(45, 130));
  }
  cell = 1000; // the arena: ring mesas and floor clusters share one cell
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
  // Boulder clusters on the arena floor, clear of the middle.
  for (let k = 0; k < 14; k += 1) {
    const a = rnd() * TAU;
    const rr = range(60, ARENA_RADIUS - 10);
    cluster(
      rail.arenaCenter.x + Math.cos(a) * rr,
      rail.arenaCenter.z + Math.sin(a) * rr,
      range(0.8, 1.6),
      false,
    );
  }
  const all = [...hoodoos, ...hoodoos.map((h) => h.far), ...bigRocks, ...smallRocks, ...mesas];
  const out: IBatch[] = [];
  for (const mesa of [false, true]) {
    const byCell = new Map<number, { geo: BufferGeometry; p: IPlacement }[]>();
    for (const b of all.filter((x) => x.mesa === mesa))
      for (const [c, list] of b.cells) {
        const items = byCell.get(c) ?? [];
        byCell.set(c, items);
        for (const p of list) items.push({ geo: b.geo, p });
      }
    for (const [c, items] of byCell) out.push({ geo: bake(items, c + 7), mesa });
  }
  return out;
}
