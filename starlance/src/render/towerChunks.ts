// What a shot-down tower breaks into: the trunk's own triangles, split at three of its rings into a
// stump that stays and three chunks that fall. Cuts land on a ring, so a chunk's open end is a flat
// disc of the tower's real outline, and the break face is capped in a paler "fresh stone" colour.
// Geometry only: the physics lives in entities/Towers.ts.
import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { IHoodoo } from "./rockForms.js";
import type { IPlacement } from "./rockScatter.js";
import { soften } from "./rocks.js";

/** Cut heights as a fraction of the trunk's rings: stump | chunk 1 | chunk 2 | chunk 3 (the cap). */
const CUTS = [0.27, 0.53, 0.78] as const;
/** The break face is this much paler than the stone around it. */
const FRESH = 1.3;
const HULL_POINTS = 180;

interface IRing {
  y: number;
  /** Outline, deduplicated and sorted by angle about its centre. */
  readonly xz: readonly (readonly [number, number])[];
  readonly rgb: readonly [number, number, number];
}
interface IKitSlices {
  /** First index of each triangle: [stump, chunk 1, chunk 2, chunk 3]. */
  readonly tris: readonly (readonly number[])[];
  readonly rings: readonly IRing[];
}
const cache = new WeakMap<IHoodoo, IKitSlices>();

function slices(kit: IHoodoo): IKitSlices {
  const hit = cache.get(kit);
  if (hit) return hit;
  const geo = kit.geo;
  const P = geo.getAttribute("position");
  const C = geo.getAttribute("color");
  const py = (P as { array: ArrayLike<number> }).array;
  const index = geo.getIndex()?.array as ArrayLike<number>;
  const n = geo.userData.towerIndices as number;
  // Plain array reads throughout: this runs inside the frame that breaks the tower.
  let towerVerts = 0;
  for (let i = 0; i < n; i += 1) towerVerts = Math.max(towerVerts, (index[i] as number) + 1);
  const ys = [...new Set(Array.from({ length: towerVerts }, (_, v) => py[v * 3 + 1] as number))].sort(
    (a, b) => a - b,
  );
  const cutY = CUTS.map((f) => ys[Math.round(f * (ys.length - 1))] as number);
  const tris: number[][] = [[], [], [], []];
  for (let t = 0; t < n; t += 3) {
    const low = Math.min(
      py[(index[t] as number) * 3 + 1] as number,
      py[(index[t + 1] as number) * 3 + 1] as number,
      py[(index[t + 2] as number) * 3 + 1] as number,
    );
    let c = 0;
    for (const y of cutY) if (low >= y) c += 1;
    (tris[c] as number[]).push(t);
  }
  const rings = cutY.map((y): IRing => {
    const seen = new Map<string, number>();
    const rgb: [number, number, number] = [0, 0, 0];
    for (let v = 0; v < towerVerts; v += 1) {
      if (Math.abs((py[v * 3 + 1] as number) - y) > 1e-4) continue;
      seen.set(`${P.getX(v).toFixed(3)},${P.getZ(v).toFixed(3)}`, v);
    }
    const pts = [...seen.values()];
    for (const v of pts) {
      rgb[0] += C.getX(v) / pts.length;
      rgb[1] += C.getY(v) / pts.length;
      rgb[2] += C.getZ(v) / pts.length;
    }
    const cx = pts.reduce((s, v) => s + P.getX(v), 0) / pts.length;
    const cz = pts.reduce((s, v) => s + P.getZ(v), 0) / pts.length;
    const xz = pts
      .map((v): [number, number] => [P.getX(v), P.getZ(v)])
      .sort((a, b) => Math.atan2(a[1] - cz, a[0] - cx) - Math.atan2(b[1] - cz, b[0] - cx));
    return { y, xz, rgb };
  });
  const out = { tris, rings };
  cache.set(kit, out);
  return out;
}

export interface IChunk {
  /** In the tower's placement frame (scaled, not yawed), recentred on `centre`. */
  readonly geo: BufferGeometry;
  /** Placement-frame centroid, scaled, y measured from the tower's ground point. */
  readonly centre: Vector3;
  /** Decimated outline points for a convex hull, relative to `centre`. */
  readonly hull: Float32Array;
}

class Soup {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** A fan from the ring's centre; `up` faces the cap toward +y. */
  cap(ring: IRing, p: IPlacement, up: boolean): void {
    const pts = ring.xz.map(([x, z]) => [x * p.sx, z * p.sz] as const);
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
    const cz = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    const y = ring.y * p.sy;
    const base = this.pos.length / 3;
    for (const [x, z] of [[cx, cz], ...pts] as const) {
      this.pos.push(x, y, z);
      this.nor.push(0, up ? 1 : -1, 0);
      this.col.push(
        ring.rgb[0] * p.tint * FRESH,
        ring.rgb[1] * p.tint * FRESH * 0.95,
        ring.rgb[2] * p.tint * FRESH * 0.9,
      );
      this.uv.push(x / 5, z / 5);
    }
    for (let i = 1; i <= pts.length; i += 1)
      this.idx.push(base, base + (up ? (i % pts.length) + 1 : i), base + (up ? i : (i % pts.length) + 1));
  }
  /** Placement-frame triangles of the kit's trunk, scaled like the baked copy. */
  tris(kit: IHoodoo, p: IPlacement, first: readonly number[]): void {
    const g = kit.geo;
    const P = g.getAttribute("position");
    const N = g.getAttribute("normal");
    const C = g.getAttribute("color");
    const T = g.getAttribute("uv");
    const index = g.getIndex()?.array as ArrayLike<number>;
    const map = new Map<number, number>();
    for (const t of first)
      for (let k = 0; k < 3; k += 1) {
        const v = index[t + k] as number;
        let o = map.get(v);
        if (o === undefined) {
          o = this.pos.length / 3;
          map.set(v, o);
          this.pos.push(P.getX(v) * p.sx, P.getY(v) * p.sy, P.getZ(v) * p.sz);
          const nx = N.getX(v) / p.sx;
          const ny = N.getY(v) / p.sy;
          const nz = N.getZ(v) / p.sz;
          const l = Math.hypot(nx, ny, nz) || 1;
          this.nor.push(nx / l, ny / l, nz / l);
          this.col.push(C.getX(v) * p.tint, C.getY(v) * p.tint * 0.95, C.getZ(v) * p.tint * 0.9);
          this.uv.push(T?.getX(v) ?? 0, T?.getY(v) ?? 0);
        }
        this.idx.push(o);
      }
  }
  build(centre: Vector3 | undefined): IChunk {
    const n = this.pos.length / 3;
    const c = centre ?? new Vector3();
    if (!centre) {
      for (let i = 0; i < this.pos.length; i += 3) {
        c.x += this.pos[i] as number;
        c.y += this.pos[i + 1] as number;
        c.z += this.pos[i + 2] as number;
      }
      c.divideScalar(n);
    }
    const stride = Math.max(1, Math.floor(n / HULL_POINTS));
    const hull: number[] = [];
    for (let i = 0; i < n; i += stride)
      hull.push(
        (this.pos[i * 3] as number) - c.x,
        (this.pos[i * 3 + 1] as number) - c.y,
        (this.pos[i * 3 + 2] as number) - c.z,
      );
    for (let i = 0; i < this.pos.length; i += 3) {
      this.pos[i] = (this.pos[i] as number) - c.x;
      this.pos[i + 1] = (this.pos[i + 1] as number) - c.y;
      this.pos[i + 2] = (this.pos[i + 2] as number) - c.z;
    }
    soften(this.col);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new Float32BufferAttribute(this.nor, 3));
    geo.setAttribute("color", new Float32BufferAttribute(this.col, 3));
    geo.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return { geo, centre: c, hull: new Float32Array(hull) };
  }
}

/** Triangles whose first index the baked cell mesh must hide when the tower breaks (all but the stump). */
export function brokenTriangles(kit: IHoodoo): readonly number[] {
  return slices(kit).tris.slice(1).flat();
}

/** Builds the kit's slices now, so the first break of that form does not pay for them. */
export function prepareTower(kit: IHoodoo): void {
  slices(kit);
}

/** The three falling chunks, lowest first. */
export function towerChunks(kit: IHoodoo, p: IPlacement): IChunk[] {
  const s = slices(kit);
  return [1, 2, 3].map((c) => {
    const soup = new Soup();
    soup.tris(kit, p, s.tris[c] as number[]);
    soup.cap(s.rings[c - 1] as IRing, p, false);
    if (c < 3) soup.cap(s.rings[c] as IRing, p, true);
    return soup.build(undefined);
  });
}

/** The standing stump's break face (a world-space mesh) and its collider outline. */
export function stump(kit: IHoodoo, p: IPlacement): { cap: BufferGeometry; hull: Float32Array } {
  const s = slices(kit);
  const soup = new Soup();
  soup.cap(s.rings[0] as IRing, p, true);
  const cap = soup.build(new Vector3()).geo;
  const body = new Soup();
  body.tris(kit, p, s.tris[0] as number[]);
  return { cap, hull: body.build(new Vector3()).hull };
}

/** Local (unscaled) height of the stump's break face. */
export function stumpTop(kit: IHoodoo): number {
  return (slices(kit).rings[0] as IRing).y;
}
