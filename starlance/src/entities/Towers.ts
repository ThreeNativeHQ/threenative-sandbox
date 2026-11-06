import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import { BufferGeometry, Float32BufferAttribute, Mesh, Quaternion, Vector3 } from "three";
import { type IChunk, brokenTriangles, stump, stumpTop, towerChunks } from "../render/towerChunks.js";
import type { ITower } from "../render/rockScatter.js";
import type { IStage } from "../render/stage.js";
import type { GameCtx, IObstacle, World } from "../world.js";

// Shot-down towers: the baked tower mesh loses everything above a stump and three chunks of its own
// geometry become rigid bodies that topple onto a local height-field of the ground. A chunk that
// stops moving for a second is frozen into scenery (body disposed), so the cost is bounded.
const LIVE_GROUPS = 4; // oldest group freezes early past this
const PATCH = 192; // m: the ground patch under a falling tower, wide enough for a 55 m trunk
const PATCH_N = 49; // height samples per side (4 m apart)
const DENSITY = 150; // kg per m3 of bounding box: sets mass only, the shape sets the inertia
const SHOVE = [1.5, 3.5, 6] as const; // m/s of sideways push per chunk, low to high: the top topples furthest
const TIP = [2.5, 3.5, 5] as const; // m/s the chunk's top is knocked, one tick: spins it over instead of sliding
const SETTLE_SPEED = 0.15; // m/s of drift that still counts as stopped
const SETTLE_TIME = 1; // s stopped before a chunk freezes
const DRAG = 1.2; // 1/s of horizontal braking on a chunk lying on the ground: no convex hull rolls to a stop on its own
const MAX_AGE = 15; // s: anything still moving then freezes where it is

interface IPiece {
  readonly mesh: Mesh;
  readonly hull: Float32Array;
  /** Farthest the centre can sit above the ground while the chunk touches it. */
  readonly reach: number;
  body: RigidBody3D | null;
  still: number;
  readonly last: Vector3;
}
interface IDebris {
  readonly ground: RigidBody3D;
  readonly stump: RigidBody3D;
  readonly stumpMesh: Mesh;
  readonly pieces: IPiece[];
  age: number;
}

const _v = new Vector3();
const hullShape = (points: Float32Array): CollisionShape3D => {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(points, 3));
  return CollisionShape3D.fromMesh(new Mesh(g), "convexHull");
};

export class Towers {
  broken = 0;
  readonly lastBreak = new Vector3();
  /** Wall time of the slowest break so far, ms: the one-off hitch of slicing and building bodies. */
  slowestBreakMs = 0;
  /*TEMP*/ phases = "";
  readonly #owner = new Map<IObstacle, ITower>();
  readonly #debris: IDebris[] = [];
  readonly #frozen: IPiece[] = [];
  readonly sites: readonly ITower[];

  constructor(
    readonly ctx: GameCtx,
    readonly stage: IStage,
  ) {
    this.sites = stage.towers;
    for (const t of this.sites) for (const s of t.spheres) this.#owner.set(s, t);
  }

  /** A shot of `damage` struck `sphere` at `at`, travelling along `dir`. */
  hit(w: World, sphere: IObstacle, damage: number, at: Vector3, dir: Vector3): void {
    const tower = this.#owner.get(sphere);
    if (tower === undefined || tower.broken) return;
    tower.hp -= damage;
    if (tower.hp <= 0) this.#break(w, tower, at, dir);
  }

  /** An explosion of `radius` at `at`: every standing tower with a sphere inside it takes `damage`. */
  blast(w: World, at: Vector3, radius: number, damage: number): void {
    for (const tower of this.sites) {
      if (tower.broken) continue;
      const near = tower.spheres.find((s) => s.center.distanceTo(at) - s.radius <= radius);
      if (near === undefined) continue;
      tower.hp -= damage;
      if (tower.hp <= 0) this.#break(w, tower, at, _v.copy(near.center).sub(at));
    }
  }

  update(dt: number): void {
    for (const d of this.#debris) {
      d.age += dt;
      for (const p of d.pieces) if (p.body !== null) this.#watch(p, d, dt);
    }
    for (let i = this.#debris.length - 1; i >= 0; i -= 1) {
      const d = this.#debris[i] as IDebris;
      if (d.pieces.some((p) => p.body !== null)) continue;
      d.ground.dispose();
      d.stump.dispose();
      this.#frozen.push(...d.pieces);
      this.#debris.splice(i, 1);
    }
    const over = this.#debris.length - LIVE_GROUPS;
    for (let i = 0; i < over; i += 1) for (const p of (this.#debris[i] as IDebris).pieces) this.#freeze(p);
  }

  #watch(p: IPiece, d: IDebris, dt: number): void {
    const moved = _v.copy(p.mesh.position).distanceTo(p.last) / Math.max(dt, 1e-6);
    p.last.copy(p.mesh.position);
    const { x, y, z } = p.mesh.position;
    const grounded = y - this.stage.groundHeight(x, z) < p.reach + 0.5;
    p.still = grounded && moved < SETTLE_SPEED ? p.still + dt : 0;
    if (grounded && p.body !== null) {
      const v = p.body.linearVelocity;
      const k = -DRAG * p.body.mass;
      p.body.applyForce({ x: v.x * k, y: 0, z: v.z * k });
    }
    const lost = p.mesh.position.y < this.stage.groundHeight(p.mesh.position.x, p.mesh.position.z) - 15;
    if (p.still >= SETTLE_TIME || d.age > MAX_AGE || lost) this.#freeze(p);
  }

  #freeze(p: IPiece): void {
    if (p.body === null) return;
    p.body.dispose();
    p.body = null;
  }

  #break(w: World, tower: ITower, at: Vector3, push: Vector3): void {
    const t0 = performance.now();
    /*TEMP*/ const ph: number[] = [];
    /*TEMP*/ const lap = (): void => void ph.push(Math.round(performance.now() - t0));
    const { kit, place } = tower;
    tower.broken = true;
    this.broken += 1;
    this.lastBreak.set(place.x, place.y, place.z);
    const { ctx } = this;
    const { spireMaterial: material, obstacles: list } = this.stage;
    const yaw = new Quaternion().setFromAxisAngle(_v.set(0, 1, 0), place.yaw);
    const base = new Vector3(place.x, place.y, place.z);

    // Ship obstacles: only the stump's spheres stay.
    const top = place.y + stumpTop(kit) * place.sy;
    const gone = new Set(tower.spheres.filter((s) => s.center.y > top));
    let kept = 0;
    for (const o of list) if (!gone.has(o)) list[kept++] = o;
    list.length = kept;

    /*TEMP*/ lap();
    // The baked mesh: degenerate every triangle above the stump.
    const geo = tower.geo as BufferGeometry;
    const index = geo.getIndex();
    if (index !== null) {
      const raw = index.array as Uint32Array;
      for (const t of brokenTriangles(kit)) raw.fill(0, tower.start + t, tower.start + t + 3);
      index.needsUpdate = true;
    }

    /*TEMP*/ lap();
    // Colliders: a ground patch, and the stump as a fixed hull so chunks land on it.
    const step = PATCH / (PATCH_N - 1);
    const heights = new Float32Array(PATCH_N * PATCH_N);
    for (let ix = 0; ix < PATCH_N; ix += 1)
      for (let iz = 0; iz < PATCH_N; iz += 1)
        heights[iz + ix * PATCH_N] = this.stage.groundHeight(
          place.x - PATCH / 2 + ix * step,
          place.z - PATCH / 2 + iz * step,
        );
    const ground = new RigidBody3D({
      physics: ctx.physics,
      position: { x: place.x, y: 0, z: place.z },
      shape: CollisionShape3D.heightfield(PATCH_N, PATCH_N, heights, { x: PATCH, y: 1, z: PATCH }),
      type: "fixed",
    });
    /*TEMP*/ lap();
    const s = stump(kit, place);
    const stumpMesh = new Mesh(s.cap, material);
    stumpMesh.renderOrder = 1;
    stumpMesh.position.copy(base);
    stumpMesh.quaternion.copy(yaw);
    ctx.add(stumpMesh);
    const stumpBody = new RigidBody3D({
      object: stumpMesh,
      physics: ctx.physics,
      shape: hullShape(s.hull),
      type: "fixed",
    });

    /*TEMP*/ lap();
    // Chunks, shoved away from the hit (a blast pushes from its centre, a bolt along its heading).
    const dir = new Vector3(push.x, 0, push.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const pieces = towerChunks(kit, place).map((c: IChunk, i): IPiece => {
      const mesh = new Mesh(c.geo, material);
      mesh.renderOrder = 1;
      mesh.position.copy(c.centre).applyQuaternion(yaw).add(base);
      mesh.position.y += 0.05 * (i + 1); // a gap, so touching hulls do not start interpenetrated
      mesh.quaternion.copy(yaw);
      ctx.add(mesh);
      c.geo.computeBoundingBox();
      const size = c.geo.boundingBox?.getSize(new Vector3()) ?? new Vector3(1, 1, 1);
      const body = new RigidBody3D({
        mass: size.x * size.y * size.z * DENSITY,
        object: mesh,
        physics: ctx.physics,
        shape: hullShape(c.hull),
        type: "dynamic",
      });
      const shove = SHOVE[i] as number;
      body.linearVelocity = { x: dir.x * shove, y: 0, z: dir.z * shove };
      // One tick of force at the chunk's top is an impulse there: a push and a topple in one.
      const f = (body.mass * 60 * (TIP[i] as number));
      body.applyForceAtPoint(
        { x: dir.x * f, y: 0, z: dir.z * f },
        { x: mesh.position.x, y: mesh.position.y + size.y / 2, z: mesh.position.z },
      );
      return {
        mesh,
        hull: c.hull,
        reach: Math.max(size.x, size.y, size.z) / 2,
        body,
        still: 0,
        last: mesh.position.clone(),
      };
    });
    /*TEMP*/ lap();
    this.#debris.push({ ground, stump: stumpBody, stumpMesh, pieces, age: 0 });

    w.fx.explode(_v.copy(base).setY(top), Math.min(10, kit.radius * 1.4));
    w.fx.explode(at, 4);
    w.sfx("explosion", base);
    w.cameraRig.shake(0.35);
    /*TEMP*/ lap(); this.phases = `${this.phases} [${ph.join(",")}]`;
    this.slowestBreakMs = Math.max(this.slowestBreakMs, performance.now() - t0);
  }

  debug(): Record<string, unknown> {
    const pieces = [...this.#frozen, ...this.#debris.flatMap((d) => d.pieces)];
    let speed = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const p of pieces) {
      if (p.body !== null) {
        const v = p.body.linearVelocity;
        speed = Math.max(speed, Math.hypot(v.x, v.y, v.z));
      }
      // Height of the chunk's lowest outline point over the ground below it: ~0 when it rests.
      p.mesh.updateMatrixWorld(true);
      let low = Number.POSITIVE_INFINITY;
      for (let i = 0; i < p.hull.length; i += 3) {
        _v.set(p.hull[i] as number, p.hull[i + 1] as number, p.hull[i + 2] as number);
        p.mesh.localToWorld(_v);
        low = Math.min(low, _v.y - this.stage.groundHeight(_v.x, _v.z));
      }
      min = Math.min(min, low);
      max = Math.max(max, low);
    }
    return {
      /*TEMP*/ phases: this.phases,
      /*TEMP*/ dbg: pieces.map((p) => { const v = p.body?.linearVelocity; return `${p.body ? "live" : "frozen"} v=${v ? Math.hypot(v.x, v.y, v.z).toFixed(2) : 0} y=${p.mesh.position.y.toFixed(1)} still=${p.still.toFixed(1)} reach=${p.reach.toFixed(1)}`; }).join(" | "),
      broken: this.broken,
      slowestBreakMs: this.slowestBreakMs,
      standing: this.sites.length - this.broken,
      pieces: pieces.length,
      frozenPieces: pieces.filter((p) => p.body === null).length,
      maxLiveSpeed: speed,
      // No chunks yet: sentinels that fail the "resting on the ground" bounds.
      minClearance: pieces.length > 0 ? min : -999,
      maxClearance: pieces.length > 0 ? max : 999,
    };
  }
}
