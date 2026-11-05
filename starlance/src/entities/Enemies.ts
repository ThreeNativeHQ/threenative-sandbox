import { alwaysRender } from "@threenative/core";
import { Box3, MathUtils, Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import {
  boltMesh,
  bossMesh,
  fighterMesh,
  type IBossLook,
  itemMesh,
  type ItemKind,
  turretMesh,
} from "../render/enemyLook.js";
import type { GameCtx, ITarget, World } from "../world.js";
import { type IRailFrame, railFrame } from "./Rail.js";

// ---- Tuning. Game-owned numbers (no card) unless a comment cites one. ----
const SHOT_SPEED = 60;
const SHOT_LIFE = 4;
const SHIP_R = 1.7;
const BODY_COOLDOWN = 1.0;
const ENTER = 3.2; // seconds a fighter takes to curve in
const WEAVE_D = 72; // metres ahead of the ship a weaving fighter holds
const LEAD = 280; // metres ahead of the ship that static things appear
// item-pickups: fox_edata_info.c:77 half-extent 120 units x 0.02 = 2.4 m; lockout fox_enmy.c:1728 8/30 s.
const PICKUP_R = 2.8;
const PICKUP_LOCKOUT = 8 / 30;
// item-pickups: drops live 1000 updates (fox_enmy.c:1740) = 33 s; wing repair 2000 updates (fox_enmy.c:2300).
const ITEM_LIFE = 1000 / 30;
const WING_LIFE = 2000 / 30;
const RING_R = 4.5;

const UP = new Vector3(0, 1, 0);
const NEG_Z = new Vector3(0, 0, -1);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
const _frame: IRailFrame = railFrame();
const _frame2: IRailFrame = railFrame();

type FoeKind = "fighter" | "chaser" | "carrier" | "turret" | "wall" | "bossTurret" | "core";
interface ISpec {
  hp: number;
  radius: number;
  explode: number;
}
const SPEC: Record<FoeKind, ISpec> = {
  fighter: { hp: 20, radius: 2.2, explode: 3 },
  chaser: { hp: 25, radius: 2.2, explode: 3 },
  carrier: { hp: 80, radius: 3.6, explode: 6 },
  turret: { hp: 40, radius: 1.8, explode: 3.5 },
  wall: { hp: 40, radius: 1.8, explode: 3.5 },
  bossTurret: { hp: 50, radius: 4.2, explode: 8 },
  core: { hp: 90, radius: 5, explode: 40 },
};

/** What a chaser tails: a wingman or the ship. */
interface IChase {
  readonly position: Vector3;
  readonly forward: Vector3;
  readonly velocity: Vector3;
}
interface IWing extends IChase {
  chased: boolean;
  alive: boolean;
  retreating: boolean;
}
interface IGroup {
  size: number;
  killed: number;
}

class Foe implements ITarget {
  alive = true;
  age = 0;
  hp: number;
  readonly radius: number;
  readonly position: Vector3;
  readonly prev = new Vector3();
  mesh: Object3D | null = null;
  key = "";
  // fighters
  side = 1;
  slotX = 0;
  slotY = 0;
  wd = WEAVE_D;
  hold = 8;
  dive = false;
  group: IGroup | null = null;
  // pursuit (chasers)
  target: IChase | null = null;
  wing: IWing | null = null;
  fireT = 0;
  fireInt = 1.4;
  constructor(
    readonly id: number,
    readonly kind: FoeKind,
    private readonly owner: Enemies,
  ) {
    this.hp = SPEC[kind].hp;
    this.radius = SPEC[kind].radius;
    this.position = new Vector3();
  }
  get lockable(): boolean {
    return this.alive && (this.kind !== "core" || this.owner.bossPhase === "core");
  }
  damage(amount: number): boolean {
    return this.owner.hurt(this, amount, false);
  }
}

interface IShot {
  mesh: Object3D;
  vel: Vector3;
  prev: Vector3;
  life: number;
  damage: number;
  deflected: boolean;
  ally: boolean;
}
interface IItem {
  kind: ItemKind;
  mesh: Object3D;
  life: number;
  lockout: number;
  heal: number;
  /** Course rings sit still and are flown through; drops drift toward the flight line. */
  course: boolean;
  s: number;
  forward: Vector3;
}

type Ev =
  | { at: number; k: "wave"; n: number; side: number; dives: number }
  | { at: number; k: "carrier"; side: number }
  | { at: number; k: "turret" | "wall"; s: number; x: number }
  | { at: number; k: "ring"; s: number; x: number; y: number; gold: boolean }
  | { at: number; k: "chaser" };

/** The course timeline, keyed by rail distance `at` (metres). Dunes 0-1500, canyon 1500-3200, plain 3200-. */
const EVENTS: Ev[] = (() => {
  const e: Ev[] = [];
  const wave = (at: number, n: number, side: number, dives: number) =>
    e.push({ at, k: "wave", n, side, dives });
  const carrier = (at: number, side: number) => e.push({ at, k: "carrier", side });
  const ground = (s: number, xs: number[]) =>
    xs.forEach((x) => e.push({ at: s - LEAD, k: "turret", s, x }));
  const walls = (s: number) =>
    [-1, 1].forEach((side) => e.push({ at: s - LEAD, k: "wall", s, x: side * 21 }));
  const ring = (s: number, x: number, y: number, gold: boolean) =>
    e.push({ at: s - LEAD, k: "ring", s, x, y, gold });
  // Dunes: a carrier on the flight line first, ground turrets between waves.
  carrier(150, 1);
  wave(230, 3, 1, 0);
  ground(380, [-16, 0, 16]);
  wave(520, 4, -1, 1);
  ground(700, [-20, 8, 20]);
  carrier(780, -1);
  wave(900, 3, 1, 0);
  e.push({ at: 900, k: "chaser" });
  ground(1000, [-14, 0, 14]);
  carrier(1180, 1);
  wave(1240, 4, -1, 1);
  ground(1380, [-18, 4, 18]);
  // Canyon: wall turrets in pairs every 150 m, denser waves.
  for (let s = 1650; s <= 3000; s += 100) walls(s);
  wave(1650, 4, 1, 1);
  carrier(1850, -1);
  wave(1960, 4, -1, 0);
  wave(2300, 5, 1, 1);
  e.push({ at: 2300, k: "chaser" });
  carrier(2550, 1);
  wave(2680, 4, -1, 1);
  wave(3000, 5, 1, 1);
  // Plain: big waves, turret clusters, then the arena.
  wave(3280, 5, -1, 1);
  carrier(3350, 1);
  ground(3400, [-18, 0, 18]);
  wave(3560, 5, 1, 1);
  e.push({ at: 3700, k: "chaser" });
  ground(3750, [-12, 6, 20]);
  wave(3850, 6, -1, 2);
  carrier(3950, -1);
  ground(4050, [-20, -4, 14]);
  wave(4120, 6, 1, 2);
  // Rings: silver along the line (the first is flown through at the default offset), gold in hard spots.
  for (const [s, x, y] of [
    [120, 0, 0],
    [330, -6, 3],
    [600, 5, -1],
    [860, -4, 4],
    [1130, 0, 2],
    [1420, 6, 0],
    [1700, -5, 1],
    [1980, 3, 3],
    [2260, -6, -1],
    [2540, 0, 4],
    [2850, 5, 2],
    [3150, -3, 0],
    [3450, 4, 3],
    [3800, -5, 1],
    [4150, 0, 2],
  ] as const)
    ring(s, x, y, false);
  for (const [s, x, y] of [
    [700, 10, -2],
    [1380, -10, 3],
    [1900, 9, -1],
    [2450, -9, 2],
    [3050, 10, 3],
    [3700, -10, 0],
  ] as const)
    ring(s, x, y, true);
  return e.sort((a, b) => a.at - b.at);
})();

const smooth = (u: number) => u * u * (3 - 2 * u);

/**
 * Everything hostile or collectable on the course: fighter waves, turrets, carriers, enemy shots,
 * items, rings, obstacle and body hits, and the arena boss. Mesh orientation convention for the look
 * lane: every enemy mesh has its nose on local -Z, like the ship.
 */
export class Enemies {
  /** Live, hittable targets. Weapons read this list every tick. */
  readonly targets: ITarget[] = [];
  kills = 0;
  allyKills = 0;
  bossDefeated = false;
  bossPhase: "none" | "turrets" | "core" | "dead" = "none";

  spawned = 0;
  shotsFired = 0;
  deflected = 0;
  itemsSpawned = 0;
  itemsCollected = 0;
  ringsCollected = 0;
  goldRings = 0;

  #foes: Foe[] = [];
  #shots: IShot[] = [];
  #freeShots: IShot[] = [];
  #items: IItem[] = [];
  #pool = new Map<string, Object3D[]>();
  /** Instances still kept out of the frustum cull for the startup compile; `#take`/`#shot` revive. */
  #warming = new Set<Object3D>();
  #nextId = 1;
  #evIndex = 0;
  #lastS = 0;
  dbgSrc: Record<string, number> = {};
  #src = "?";
  #delayed: { t: number; fn: () => void }[] = [];
  #shipVel = new Vector3();
  #shipPrev = new Vector3();
  #shipChase: IChase = { position: new Vector3(), forward: new Vector3(), velocity: this.#shipVel };
  #bodyCd = 0;
  #arenaTimer = 0;
  #arenaStarted = false;
  #boss: {
    look: IBossLook;
    theta: number;
    parts: Foe[];
    core: Foe;
    half: Vector3;
    center: Vector3;
    fireT: number[];
    coreT: number;
  } | null = null;
  #w: World | null = null;

  constructor(readonly ctx: GameCtx) {
    this.#warmPool();
  }

  // ---- mesh pool ----
  /**
   * One instance of every pooled kind, in the scene from construction: the startup warm-up compiles
   * the pipelines the render list holds, so a mesh this pool mints on first use compiles in the
   * middle of the fight and the first fighter reads as a hitch.
   *
   * `prewarm()` is not the tool here — it clones the materials and leaves them at zero opacity, so a
   * pooled enemy warmed with it comes back invisible when the pool shows it. These sit 500 m under
   * the ground, and `frustumCulled = false` is what keeps them in the compile's render list: a
   * hidden or frustum-culled mesh is dropped before its pipeline is built.
   */
  #warmPool(): void {
    const kinds: [string, () => Object3D][] = [
      ["fighter", fighterMesh],
      ["turret", turretMesh],
      ["carrier", fighterMesh],
      ...(["laser", "bomb", "wing", "silverRing", "goldRing"] as const).map(
        (kind): [string, () => Object3D] => [`item:${kind}`, () => itemMesh(kind)],
      ),
    ];
    for (const [key, make] of kinds) {
      const m = this.#newMesh(make);
      m.frustumCulled = false;
      m.position.set(0, -500, 0);
      this.#warming.add(m);
      this.#poolAdd(key, m);
    }
    for (const ally of [false, true]) {
      const s = this.#newShot(ally);
      s.mesh.frustumCulled = false;
      s.mesh.position.set(0, -500, 0);
      this.#warming.add(s.mesh);
      this.#freeShots.push(s);
    }
  }

  /** Hide the warm instances once first-use compilation has run them, so the pool stops drawing them. */
  #settleWarm(): void {
    for (const m of this.#warming) {
      m.visible = false;
      m.frustumCulled = true;
    }
    this.#warming.clear();
  }

  #newMesh(make: () => Object3D): Object3D {
    const m = this.ctx.add(make());
    this.ctx.interpolate(m);
    // A pooled mesh is under half a pixel while it is still far away; the projection gate would pop
    // it out of the frame exactly when a fighter comes at the player.
    alwaysRender(m);
    return m;
  }

  #take(key: string, make: () => Object3D): Object3D {
    let m = this.#pool.get(key)?.pop();
    if (m === undefined) m = this.#newMesh(make);
    else if (this.#warming.delete(m)) m.frustumCulled = true;
    m.visible = true;
    return m;
  }
  #put(key: string, m: Object3D): void {
    m.visible = false;
    this.#poolAdd(key, m);
  }
  #poolAdd(key: string, m: Object3D): void {
    let list = this.#pool.get(key);
    if (list === undefined) this.#pool.set(key, (list = []));
    list.push(m);
  }
  #place(m: Object3D, at: Vector3): void {
    m.position.copy(at);
    this.ctx.resetInterpolation(m);
  }

  // ---- foes ----
  #spawn(kind: FoeKind, at: Vector3, delayMesh = true): Foe {
    const f = new Foe(this.#nextId++, kind, this);
    f.position.copy(at);
    f.prev.copy(at);
    if (delayMesh) {
      f.key = kind === "chaser" ? "fighter" : kind === "wall" ? "turret" : kind;
      const make = f.key === "turret" ? turretMesh : fighterMesh;
      f.mesh = this.#take(f.key, make);
      f.mesh.scale.setScalar(kind === "carrier" ? 1.7 : 1);
      f.mesh.quaternion.identity();
      this.#place(f.mesh, at);
    }
    this.#foes.push(f);
    this.targets.push(f);
    this.spawned += 1;
    return f;
  }

  /** Remove a foe from play (killed, escaped or passed). */
  #release(f: Foe): void {
    f.alive = false;
    if (f.mesh !== null) this.#put(f.key, f.mesh);
    f.mesh = null;
    const i = this.#foes.indexOf(f);
    if (i >= 0) this.#foes.splice(i, 1);
    const j = this.targets.indexOf(f);
    if (j >= 0) this.targets.splice(j, 1);
    if (f.wing !== null && f.kind === "chaser") this.#unchase(f.wing);
  }

  #unchase(wing: IWing): void {
    if (!this.#foes.some((o) => o.alive && o.wing === wing)) wing.chased = false;
  }

  /** Applies damage from the player or an ally; returns true when it destroyed `f`. */
  hurt(f: Foe, amount: number, byAlly: boolean): boolean {
    if (!f.alive || this.#w === null) return false;
    f.hp -= amount;
    if (f.hp > 0) {
      this.#w.fx.spark(f.position);
      return false;
    }
    this.#kill(this.#w, f, byAlly);
    return true;
  }

  #kill(w: World, f: Foe, byAlly: boolean): void {
    if (byAlly) this.allyKills += 1;
    else this.kills += 1;
    w.fx.explode(f.position, SPEC[f.kind].explode);
    w.sfx("explosion", f.position);
    const wing = f.wing;
    this.#release(f);
    if (f.kind === "chaser" && wing !== null && !byAlly && !wing.chased) {
      w.wingmen.rescues += 1;
    }
    // Drops (item-pickups: per-kind chances, group drop when the last member dies).
    const rnd = w.ctx.random;
    if (f.group !== null) {
      f.group.killed += 1;
      if (f.group.killed === f.group.size) this.#drop(w, f.position, "silverRing", 32);
    } else if (f.kind === "carrier") this.#crate(w, f.position);
    else if (f.kind === "turret" && rnd() < 0.33) this.#crate(w, f.position);
    else if (f.kind === "wall" && rnd() < 0.25) this.#crate(w, f.position);
    else if (f.kind === "chaser" && rnd() < 0.5) this.#crate(w, f.position);
    if (f.kind === "bossTurret") this.#bossPartDied(w);
    else if (f.kind === "core") this.#bossDied(w);
  }

  // ---- items ----
  /** Supply crate priority (item-pickups): wing repair, silver star, laser, bomb. */
  #crate(w: World, at: Vector3): void {
    const s = w.ship;
    if (s.wings.left <= 0 || s.wings.right <= 0) this.#drop(w, at, "wing", 0);
    else if (s.shield < 128) this.#drop(w, at, "silverRing", 128);
    // The card says "lasers if still single"; below hyper keeps the whole ladder reachable.
    else if (w.weapons.laserLevel < 2) this.#drop(w, at, "laser", 0);
    else this.#drop(w, at, "bomb", 0);
  }

  #drop(w: World, at: Vector3, kind: ItemKind, heal: number): void {
    const item = this.#newItem(kind, at, false);
    item.heal = heal;
    item.lockout = PICKUP_LOCKOUT;
    if (heal > 32) item.mesh.scale.setScalar(1.5);
    this.itemsSpawned += 1;
    void w;
  }

  #newItem(kind: ItemKind, at: Vector3, course: boolean): IItem {
    const mesh = this.#take(`item:${kind}`, () => itemMesh(kind));
    mesh.scale.setScalar(1);
    mesh.quaternion.identity();
    this.#place(mesh, at);
    const item: IItem = {
      kind,
      mesh,
      life: kind === "wing" ? WING_LIFE : ITEM_LIFE,
      lockout: 0,
      heal: 32,
      course,
      s: 0,
      forward: new Vector3(0, 0, -1),
    };
    this.#items.push(item);
    return item;
  }

  #dropItem(item: IItem): void {
    this.#put(`item:${item.kind}`, item.mesh);
    this.#items.splice(this.#items.indexOf(item), 1);
  }

  #updateItems(w: World, dt: number): void {
    const ship = w.ship;
    for (let i = this.#items.length - 1; i >= 0; i -= 1) {
      const item = this.#items[i] as IItem;
      item.life -= dt;
      item.lockout -= dt;
      // A laser item turns into a wing repair while a wing is broken (item-pickups).
      if (item.kind === "laser" && (ship.wings.left <= 0 || ship.wings.right <= 0)) {
        // The pooled wing arrives wherever the pool parked it: keep the drop where the laser was.
        _a.copy(item.mesh.position);
        this.#put("item:laser", item.mesh);
        item.kind = "wing";
        item.mesh = this.#take("item:wing", () => itemMesh("wing"));
        this.#place(item.mesh, _a);
        item.life = WING_LIFE;
      }
      const m = item.mesh;
      _a.copy(m.position).sub(ship.position);
      const behind = -_a.dot(ship.forward);
      if (item.life <= 0 || (ship.mode === "rail" && behind > 60) || (item.course && behind > 30)) {
        this.#dropItem(item);
        continue;
      }
      if (!item.course) {
        m.rotation.y += dt * 2.2;
        // Drops ease toward the flight line so one is worth flying for.
        const k = 1 - Math.exp(-0.9 * dt);
        _a.negate();
        if (ship.mode === "rail") _a.addScaledVector(ship.forward, -_a.dot(ship.forward));
        else if (_a.lengthSq() > 70 * 70) _a.set(0, 0, 0);
        m.position.addScaledVector(_a, k);
      }
      if (item.lockout > 0 || !ship.alive) continue;
      let hit: boolean;
      if (item.course) {
        _a.copy(ship.position).sub(m.position);
        const along = _a.dot(item.forward);
        hit = Math.abs(along) < 2.2 && _a.addScaledVector(item.forward, -along).length() < RING_R;
      } else {
        hit = ship.position.distanceTo(m.position) < PICKUP_R;
      }
      if (!hit) continue;
      this.#collect(w, item);
      this.#dropItem(item);
    }
  }

  #collect(w: World, item: IItem): void {
    w.sfx("pickup", item.mesh.position);
    switch (item.kind) {
      case "laser":
        w.weapons.upgradeLaser();
        break;
      case "bomb":
        w.weapons.addBomb();
        break;
      case "wing":
        w.ship.repairWings();
        break;
      case "silverRing":
        w.ship.heal(item.heal);
        break;
      case "goldRing":
        w.ship.heal(item.heal);
        w.ship.addGoldRing();
        this.goldRings += 1;
        break;
    }
    if (item.kind === "silverRing" || item.kind === "goldRing") {
      if (item.course) this.ringsCollected += 1;
      else this.itemsCollected += 1;
      if (item.course) return;
    } else this.itemsCollected += 1;
    // Rings dropped by enemies count as rings, not items.
    if (item.kind === "silverRing" || item.kind === "goldRing") this.ringsCollected += 1;
  }

  // ---- shots ----
  #newShot(ally: boolean): IShot {
    return {
      mesh: this.#newMesh(() => boltMesh(ally ? "laser" : "enemy")),
      vel: new Vector3(),
      prev: new Vector3(),
      life: 0,
      damage: 0,
      deflected: false,
      ally,
    };
  }

  #shot(from: Vector3, dir: Vector3, speed: number, damage: number, ally: boolean): void {
    let s = this.#freeShots.pop();
    if (s === undefined) {
      if (this.#shots.length >= (ally ? 40 : 120)) return;
      s = this.#newShot(ally);
    } else if (this.#warming.delete(s.mesh)) s.mesh.frustumCulled = true;
    s.ally = ally;
    s.vel.copy(dir).normalize().multiplyScalar(speed);
    s.prev.copy(from);
    s.life = ally ? 1.4 : SHOT_LIFE;
    s.damage = damage;
    s.deflected = false;
    s.mesh.visible = true;
    s.mesh.lookAt(_d.copy(from).add(s.vel));
    this.#place(s.mesh, from);
    this.#shots.push(s);
    if (!ally) this.shotsFired += 1;
    if (!ally) this.dbgSrc[this.#src] = (this.dbgSrc[this.#src] ?? 0) + 1;
  }

  /** Aim point at a chased thing with a little lead and spread. */
  #aim(w: World, from: Vector3, tg: IChase, speed: number, spread: number, out: Vector3): Vector3 {
    const t = from.distanceTo(tg.position) / speed;
    out.copy(tg.position).addScaledVector(tg.velocity, t * 0.7);
    const r = w.ctx.random;
    out.x += r.range(-spread, spread);
    out.y += r.range(-spread, spread);
    out.z += r.range(-spread, spread);
    return out.sub(from);
  }

  /** Allied laser from `from` at `target` (Wingmen calls this). */
  allyShot(from: Vector3, target: ITarget): void {
    this.#shot(from, _b.copy(target.position).sub(from), 130, 8, true);
  }

  /** The nearest foe an ally may shoot: not the boss, and a chaser only after the player had a go. */
  nearestForAlly(from: Vector3, forward: Vector3, range: number): ITarget | null {
    let best: Foe | null = null;
    let bd = range;
    for (const f of this.#foes) {
      if (!f.alive || f.kind === "core") continue;
      if (f.kind === "chaser" && f.age < 9) continue;
      _a.copy(f.position).sub(from);
      const d = _a.length();
      if (d < bd && _a.dot(forward) > 0.6 * d) {
        bd = d;
        best = f;
      }
    }
    return best;
  }

  #updateShots(w: World, dt: number): void {
    const ship = w.ship;
    const wings = w.wingmen.members;
    for (let i = this.#shots.length - 1; i >= 0; i -= 1) {
      const s = this.#shots[i] as IShot;
      s.prev.copy(s.mesh.position);
      s.mesh.position.addScaledVector(s.vel, dt);
      s.life -= dt;
      let done = s.life <= 0;
      if (!done && s.ally) {
        for (const f of this.#foes) {
          if (!f.alive || f.kind === "core") continue;
          if (segDist(s.prev, s.mesh.position, f.position) < f.radius + 0.4) {
            this.hurt(f, f.kind === "bossTurret" ? s.damage * 0.5 : s.damage, true);
            done = true;
            break;
          }
        }
      } else if (!done && !s.deflected) {
        if (ship.alive && segDist(s.prev, s.mesh.position, ship.position) < SHIP_R + 0.3) {
          if (ship.rolling) {
            // A barrel roll bats the shot away (game rule).
            s.vel
              .copy(s.mesh.position)
              .sub(ship.position)
              .normalize()
              .multiplyScalar(SHOT_SPEED * 0.8)
              .addScaledVector(UP, 6);
            s.deflected = true;
            s.life = Math.min(s.life, 1.2);
            this.deflected += 1;
            w.fx.spark(s.mesh.position);
          } else {
            // `from` sits behind the shot on its path so the flight lane reads the side it came from.
            _a.copy(s.mesh.position).addScaledVector(s.vel, -0.08);
            ship.takeHit(s.damage, _a);
            w.fx.spark(s.mesh.position);
            done = true;
          }
        }
        if (!done) {
          for (const m of wings) {
            if (!m.alive) continue;
            if (segDist(s.prev, s.mesh.position, m.position) < 2.2) {
              w.wingmen.hit(m, s.damage);
              w.fx.spark(s.mesh.position);
              done = true;
              break;
            }
          }
        }
      }
      if (done) {
        s.mesh.visible = false;
        this.#shots.splice(i, 1);
        this.#freeShots.push(s);
      }
    }
  }

  // ---- spawning by timeline ----
  #spawnEvent(w: World, ev: Ev): void {
    const rail = w.rail;
    switch (ev.k) {
      case "wave": {
        const group: IGroup = { size: ev.n, killed: 0 };
        for (let i = 0; i < ev.n; i += 1) {
          const dive = i >= ev.n - ev.dives;
          this.#delayed.push({
            t: i * 0.35,
            fn: () => {
              const f = this.#spawn("fighter", _a.set(0, -500, 0));
              f.group = group;
              f.side = ev.side * (i % 2 === 0 ? 1 : -1);
              const c = i - (ev.n - 1) / 2;
              f.slotX = c * 9;
              f.slotY = Math.abs(c) * -2 + 2; // a shallow vee
              f.dive = dive;
              f.hold = 7 + (i % 3) * 0.8;
              f.fireInt = 1.2 + (i % 3) * 0.2;
              f.fireT = 3 + i * 0.3;
            },
          });
        }
        break;
      }
      case "carrier": {
        const f = this.#spawn("carrier", _a.set(0, -500, 0));
        f.side = ev.side;
        f.slotX = 0;
        f.slotY = 0;
        f.wd = 78;
        f.hold = 22;
        f.fireInt = 2.2;
        f.fireT = 5;
        break;
      }
      case "turret":
      case "wall": {
        rail.frame(ev.s, _frame);
        _a.copy(_frame.position).addScaledVector(_frame.right, ev.x);
        _a.y = ev.k === "turret" ? w.stage.groundHeight(_a.x, _a.z) + 1.2 : _frame.position.y + 3;
        const f = this.#spawn(ev.k, _a);
        f.fireInt = ev.k === "turret" ? 1.8 : 0.9;
        f.fireT = 1 + w.ctx.random() * f.fireInt;
        break;
      }
      case "ring": {
        rail.frame(ev.s, _frame);
        _a.copy(_frame.position)
          .addScaledVector(_frame.right, ev.x)
          .addScaledVector(_frame.up, ev.y);
        const item = this.#newItem(ev.gold ? "goldRing" : "silverRing", _a, true);
        item.s = ev.s;
        item.forward.copy(_frame.forward);
        item.mesh.quaternion.setFromRotationMatrix(
          _m.makeBasis(_frame.right, _frame.up, _frame.forward),
        );
        break;
      }
      case "chaser":
        this.#spawnChaser(w);
        break;
    }
  }

  /** An enemy fighter tails one free wingman (wingmen card: help request). */
  #spawnChaser(w: World): void {
    const wing = w.wingmen.members.find((m) => m.alive && !m.chased && !m.retreating) as
      | IWing
      | undefined;
    if (wing === undefined) return;
    const f = this.#spawn("chaser", _a.copy(wing.position).addScaledVector(wing.forward, -70));
    f.target = wing;
    f.wing = wing;
    f.fireInt = 0.9;
    f.fireT = 1.5;
    wing.chased = true;
  }

  // ---- per-foe behaviour ----
  #railPos(f: Foe, w: World, out: Vector3): boolean {
    const t = f.age;
    let d: number;
    let x: number;
    let y: number;
    const wob = (tw: number) => {
      d = f.wd + Math.sin(0.8 * tw) * 9;
      x = f.slotX + f.side * Math.sin(1.4 * tw) * 9;
      y = f.slotY + Math.sin(2.1 * tw) * 2.5;
    };
    d = x = y = 0;
    if (t < ENTER) {
      // Quadratic Bezier in rail-frame coordinates: a sweeping curve in from the side.
      const u = t / ENTER;
      const v = 1 - u;
      d = v * v * 210 + 2 * u * v * 150 + u * u * f.wd;
      x = v * v * f.side * 95 + 2 * u * v * -f.side * 35 + u * u * f.slotX;
      y = v * v * 22 + 2 * u * v * -4 + u * u * f.slotY;
    } else if (t - ENTER < f.hold) {
      wob(t - ENTER);
    } else {
      const u = (t - ENTER - f.hold) / (f.dive ? 2.2 : 2.6);
      if (u >= (f.dive ? 1.6 : 1)) return false;
      wob(f.hold);
      const d0 = d;
      const x0 = x;
      const y0 = y;
      const s = smooth(Math.min(u, 1));
      if (f.dive) {
        // Dive through the ship's line and out behind it.
        d = MathUtils.lerp(d0, -20, Math.min(u, 1)) - Math.max(0, u - 1) * 40;
        x = MathUtils.lerp(x0, w.ship.offset.x, s);
        y = MathUtils.lerp(y0, w.ship.offset.y, s);
      } else {
        d = MathUtils.lerp(d0, -60, s);
        x = MathUtils.lerp(x0, f.side * 110, s);
        y = MathUtils.lerp(y0, 40, s);
      }
    }
    w.rail.frame(w.rail.s + d, _frame2);
    out.copy(_frame2.position).addScaledVector(_frame2.right, x).addScaledVector(_frame2.up, y);
    return true;
  }

  /** Chasers follow a target from behind (rail: weaving across the player's line; arena: a tail). */
  #pursue(f: Foe, w: World, dt: number): boolean {
    let tg = f.target;
    if (tg === null || (f.wing !== null && (!f.wing.alive || f.wing.retreating))) {
      if (w.ship.mode === "rail") return false;
      f.wing = null;
      f.target = tg = this.#shipChase;
    }
    const arena = w.ship.mode === "arena";
    const r = f.wing !== null ? 15 : 28;
    _a.copy(tg.position).addScaledVector(tg.forward, -r);
    if (arena) {
      _b.crossVectors(tg.forward, UP).normalize();
      _a.addScaledVector(_b, Math.sin(1.1 * f.age) * 5);
    } else {
      // Swing across the ship's line now and then so the player can get a clear shot.
      _b.copy(tg.position).sub(w.ship.position);
      const k = 0.45 * (Math.cos(0.8 * f.age) - 1);
      _a.addScaledVector(w.ship.right, _b.dot(w.ship.right) * k);
      _a.addScaledVector(w.ship.up, _b.dot(w.ship.up) * k);
    }
    f.position.addScaledVector(tg.velocity, dt);
    _b.copy(_a).sub(f.position);
    _b.multiplyScalar(1 - Math.exp(-2.2 * dt));
    const max = 70 * dt;
    if (_b.length() > max) _b.setLength(max);
    f.position.add(_b);
    f.fireT -= dt;
    if (f.fireT <= 0 && f.position.distanceTo(tg.position) < 70) {
      f.fireT = f.fireInt;
this.#src = "pursue";
      this.#shot(
        f.position,
        this.#aim(w, f.position, tg, SHOT_SPEED, 0.5, _c),
        SHOT_SPEED,
        f.wing !== null ? 10 : 6,
        false,
      );
    }
    face(f, _b.copy(tg.forward), dt);
    return true;
  }

  #updateFoe(w: World, f: Foe, dt: number): void {
    f.age += dt;
    f.prev.copy(f.position);
    const ship = w.ship;
    switch (f.kind) {
      case "fighter":
      case "carrier": {
        if (ship.mode !== "rail") return this.#release(f);
        if (!this.#railPos(f, w, f.position)) return this.#release(f);
        const active = f.age > ENTER * 0.7 && f.age - ENTER < f.hold + (f.dive ? 1.5 : 0);
        f.fireT -= dt;
        if (active && f.fireT <= 0) {
          f.fireT = f.fireInt;
          const dmg = f.kind === "carrier" ? 16 : 12;
this.#src = "fighter";
          this.#shot(
            f.position,
            this.#aim(w, f.position, this.#shipChase, SHOT_SPEED, 1, _c),
            SHOT_SPEED,
            dmg,
            false,
          );
        }
        const relV = _b
          .copy(f.position)
          .sub(f.prev)
          .divideScalar(Math.max(dt, 1e-4))
          .sub(this.#shipVel);
        const breaking = f.age - ENTER >= f.hold;
        face(
          f,
          breaking && relV.lengthSq() > 4 ? relV : _c.copy(ship.position).sub(f.position),
          dt,
        );
        // Ramming: a fighter that touches the ship dies, the ship is hurt.
        if (ship.alive && f.position.distanceTo(ship.position) < f.radius + SHIP_R) {
          if (this.#bodyCd <= 0) {
            this.#bodyCd = BODY_COOLDOWN;
            ship.takeHit(f.kind === "carrier" ? 40 : 30, f.position);
          }
          w.fx.explode(f.position, SPEC[f.kind].explode);
          w.sfx("explosion", f.position);
          this.#release(f);
        }
        break;
      }
      case "chaser":
        if (!this.#pursue(f, w, dt)) this.#release(f);
        break;
      case "turret":
      case "wall": {
        _a.copy(f.position).sub(ship.position);
        const ahead = _a.dot(ship.forward);
        if (ship.mode === "rail" && ahead < -50) return this.#release(f);
        if (ship.mode !== "rail") return this.#release(f);
        if (f.mesh !== null) f.mesh.rotation.y = Math.atan2(_a.x, _a.z);
        f.fireT -= dt;
        if (f.fireT <= 0 && ahead < (f.kind === "turret" ? 170 : 55) && ahead > -10) {
          f.fireT = f.fireInt;
this.#src = "turret";
          this.#shot(
            f.position,
            this.#aim(w, f.position, this.#shipChase, 55, 1, _c),
            55,
            12,
            false,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  // ---- boss ----
  #spawnBoss(w: World): void {
    const look = bossMesh();
    this.ctx.add(look.root);
    this.ctx.interpolate(look.root);
    look.root.position.copy(w.rail.arenaCenter);
    look.root.position.y += 30;
    look.root.updateMatrixWorld(true);
    const box = new Box3().setFromObject(look.root);
    const half = box.getSize(new Vector3()).multiplyScalar(0.5);
    const parts = look.weakPoints.map(() => new Foe(this.#nextId++, "bossTurret", this));
    const core = new Foe(this.#nextId++, "core", this);
    this.#boss = {
      look,
      theta: 0,
      parts,
      core,
      half,
      center: new Vector3().copy(w.rail.arenaCenter),
      fireT: [4, 6, 8],
      coreT: 2,
    };
    look.core.scale.setScalar(0.3);
    this.ctx.resetInterpolation(look.root);
  }

  #syncBoss(dt: number): void {
    const b = this.#boss;
    if (b === null) return;
    b.theta += 0.12 * dt;
    b.look.root.position.set(
      b.center.x + Math.cos(b.theta) * 30,
      b.center.y + 30,
      b.center.z + Math.sin(b.theta) * 30,
    );
    b.look.root.rotation.y = b.theta * 0.5;
    b.look.root.updateMatrixWorld(true);
    b.look.weakPoints.forEach((o, i) => o.getWorldPosition((b.parts[i] as Foe).position));
    b.look.core.getWorldPosition(b.core.position);
  }

  #startBoss(w: World): void {
    const b = this.#boss;
    if (b === null) return;
    this.bossPhase = "turrets";
    for (const p of b.parts) {
      this.#foes.push(p);
      this.targets.push(p);
      this.spawned += 1;
    }
    void w;
  }

  #bossPartDied(w: World): void {
    const b = this.#boss;
    if (b === null || b.parts.some((p) => p.alive)) return;
    this.bossPhase = "core";
    this.#foes.push(b.core);
    this.targets.push(b.core);
    this.spawned += 1;
    w.sfx("alarm");
  }

  #bossDied(w: World): void {
    const b = this.#boss;
    this.bossPhase = "dead";
    this.bossDefeated = true;
    if (b !== null) {
      for (let i = 0; i < 6; i += 1) {
        _a.set(w.ctx.random.range(-20, 20), w.ctx.random.range(-4, 6), w.ctx.random.range(-12, 12));
        w.fx.explode(_a.add(b.look.root.position), 12 + i);
      }
    }
  }

  #updateBoss(w: World, dt: number): void {
    const b = this.#boss;
    if (b === null || this.bossPhase === "dead") return;
    const ship = w.ship;
    if (this.bossPhase === "core") {
      const s = b.look.core.scale.x;
      b.look.core.scale.setScalar(Math.min(1, s + dt * 0.8));
    }
    // Hatch follows the core scale (0.3 closed .. 1 open) once per update, no render hook.
    b.look.setOpen((b.look.core.scale.x - 0.3) / 0.7);
    // Body: the hull hurts (box from the mesh's own bounds).
    _a.copy(ship.position);
    b.look.root.worldToLocal(_a);
    if (
      ship.alive &&
      this.#bodyCd <= 0 &&
      Math.abs(_a.x) < b.half.x + SHIP_R &&
      Math.abs(_a.y) < b.half.y + SHIP_R &&
      Math.abs(_a.z) < b.half.z + SHIP_R
    ) {
      this.#bodyCd = BODY_COOLDOWN * 1.2;
      ship.takeHit(25, b.look.root.position);
    }
    // Fire: each live turret sprays a three-shot fan; the open core a wide five-shot fan.
    const near = ship.position.distanceTo(b.look.root.position) < 330;
    if (!near || !ship.alive) return;
    b.parts.forEach((p, i) => {
      if (!p.alive) return;
      b.fireT[i] = (b.fireT[i] as number) - dt;
      if ((b.fireT[i] as number) <= 0) {
        b.fireT[i] = 5;
        this.#fan(w, p.position, 3, 0.22, 45, 8);
      }
    });
    if (this.bossPhase === "core") {
      b.coreT -= dt;
      if (b.coreT <= 0) {
        b.coreT = 4;
        this.#fan(w, b.core.position, 5, 0.2, 45, 8);
      }
    }
  }

  #fan(w: World, from: Vector3, n: number, spread: number, speed: number, dmg: number): void {
    this.#aim(w, from, this.#shipChase, speed, 1.5, _c);
    for (let k = 0; k < n; k += 1) {
      _b.copy(_c).applyAxisAngle(UP, (k - (n - 1) / 2) * spread);
this.#src = "fan";
      this.#shot(from, _b, speed, dmg, false);
    }
  }

  // ---- arena ----
  #spawnArenaFighter(w: World, wing: IWing | null): void {
    const c = w.rail.arenaCenter;
    const ang = w.ctx.random() * Math.PI * 2;
    _a.set(c.x + Math.cos(ang) * 230, c.y + 25, c.z + Math.sin(ang) * 230);
    const f = this.#spawn("chaser", _a);
    f.fireInt = wing !== null ? 1.2 : 3;
    f.fireT = 2;
    if (wing !== null) {
      f.target = wing;
      f.wing = wing;
      wing.chased = true;
    } else f.target = this.#shipChase;
  }

  #updateArena(w: World, dt: number): void {
    if (!this.#arenaStarted) {
      this.#arenaStarted = true;
      for (const f of [...this.#foes])
        if (f.kind !== "bossTurret" && f.kind !== "core") this.#release(f);
      this.#startBoss(w);
      this.#arenaTimer = 6;
    }
    this.#arenaTimer -= dt;
    if (this.#arenaTimer <= 0 && this.bossPhase !== "dead") {
      this.#arenaTimer = 11;
      const chasers = this.#foes.filter((f) => f.kind === "chaser");
      if (chasers.length < 1) {
        const wing = w.wingmen.members.find((m) => m.alive && !m.chased && !m.retreating) as
          | IWing
          | undefined;
        this.#spawnArenaFighter(w, wing ?? null);
      }
    }
  }

  // ---- loop ----
  update(w: World, dt: number): void {
    this.#w = w;
    if (this.#warming.size > 0 && this.ctx.startup.compileSettled) this.#settleWarm();
    const ship = w.ship;
    // The ship's velocity from its own motion: shots lead it, chasers read it.
    if (dt > 0) this.#shipVel.copy(ship.position).sub(this.#shipPrev).divideScalar(dt);
    this.#shipPrev.copy(ship.position);
    this.#shipChase.position.copy(ship.position);
    this.#shipChase.forward.copy(ship.forward);
    this.#bodyCd -= dt;

    for (let i = this.#delayed.length - 1; i >= 0; i -= 1) {
      const d = this.#delayed[i] as { t: number; fn: () => void };
      d.t -= dt;
      if (d.t <= 0) {
        this.#delayed.splice(i, 1);
        d.fn();
      }
    }

    if (ship.mode === "rail") {
      const jumped = w.rail.s - this.#lastS > 50;
      this.#lastS = w.rail.s;
      while (this.#evIndex < EVENTS.length && (EVENTS[this.#evIndex] as Ev).at <= w.rail.s) {
        const ev = EVENTS[this.#evIndex] as Ev;
        this.#evIndex += 1;
        // A jump (`skipTo`) leaves what it flew past unspawned.
        if (jumped && ev.at < w.rail.s - 60) continue;
        this.#spawnEvent(w, ev);
      }
      if (this.#boss === null && w.rail.s > w.rail.length - 350) this.#spawnBoss(w);
    } else this.#updateArena(w, dt);
    if (this.#boss === null && ship.mode === "arena") this.#spawnBoss(w);
    this.#syncBoss(dt);

    for (const f of [...this.#foes]) {
      if (f.alive && f.kind !== "bossTurret" && f.kind !== "core") this.#updateFoe(w, f, dt);
    }
    this.#updateBoss(w, dt);
    this.#updateShots(w, dt);
    this.#updateItems(w, dt);
    // The pooled mesh carries the logic position. Nothing else moves a fighter, so a mesh left where
    // the pool parked it is the foe that looks frozen until it is recycled.
    for (const f of this.#foes) if (f.mesh !== null) f.mesh.position.copy(f.position);
  }

  /** Chaser offsets in the ship's frame [right, up, ahead]: where to aim to rescue a wingman. */
  #chaserRel(): number[] {
    const w = this.#w;
    const f = this.#foes.find((o) => o.kind === "chaser");
    if (w === null || f === undefined) return [];
    _a.copy(f.position).sub(w.ship.position);
    return [_a.dot(w.ship.right), _a.dot(w.ship.up), _a.dot(w.ship.forward)];
  }

  #nearest(): number {
    const p = this.#w?.ship.position;
    if (p === undefined) return -1;
    let d = 1e9;
    for (const i of this.#items) d = Math.min(d, i.mesh.position.distanceTo(p));
    return d;
  }

  debug(): Record<string, unknown> {
    return {
      alive: this.targets.length,
      kills: this.kills,
      allyKills: this.allyKills,
      spawned: this.spawned,
      shotsFired: this.shotsFired,
      deflected: this.deflected,
      itemsSpawned: this.itemsSpawned,
      itemsCollected: this.itemsCollected,
      ringsCollected: this.ringsCollected,
      goldRings: this.goldRings,
      bossPhase: this.bossPhase,
      bossDefeated: this.bossDefeated,
      itemsLive: this.#items.length,
      chaserRel: this.#chaserRel(),
      src: JSON.stringify(this.dbgSrc),
      bossHp: this.#boss === null ? 0 : this.#boss.parts.reduce((a, p) => a + Math.max(0, p.hp), 0) + Math.max(0, this.#boss.core.hp),
      nearestItem: this.#nearest(),
    };
  }
}

/** Smoothly turn a fighter's nose (local -Z) toward `dir`. */
function face(f: Foe, dir: Vector3, dt: number): void {
  if (f.mesh === null || dir.lengthSq() < 1e-6) return;
  _q.setFromUnitVectors(NEG_Z, dir.normalize());
  f.mesh.quaternion.slerp(_q, 1 - Math.exp(-8 * dt));
}

/** Shortest distance from point `c` to the segment `a`-`b`. */
function segDist(a: Vector3, b: Vector3, c: Vector3): number {
  _a.copy(b).sub(a);
  const len2 = _a.lengthSq();
  const t = len2 < 1e-9 ? 0 : MathUtils.clamp(_b.copy(c).sub(a).dot(_a) / len2, 0, 1);
  return _b.copy(a).addScaledVector(_a, t).distanceTo(c);
}
