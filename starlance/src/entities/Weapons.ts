import { type Object3D, Vector3 } from "three";
import { type BoltKind, boltMesh } from "../render/enemyLook.js";
import { type IShotFx, createShotFx } from "../render/shotFx.js";
import type { GameCtx, ITarget, World } from "../world.js";

// Numbers: cards laser-fire (fox_play.c:3044, 3315-3319; fox_beam.c:2356), charge-lock-on
// (fox_play.c:3192-3243), lock-on-tracking (fox_beam.c:1759, 2226-2242), smart-bomb
// (fox_play.c:3082-3089, 3285), item-pickups (fox_beam.c:671-677). Units: 0.02 m per source unit.
const BOLT_SPEED = 320; // m/s, laser-fire
const BOLT_LIFE = 0.29; // s, laser-fire
const REPEAT = 4 / 30; // hold repeats every 4 updates (7.5/s)
const DAMAGE = [10, 12, 15] as const; // item-pickups: single / twin / hyper
const CHARGE_FULL = 0.7; // s, charge-lock-on
const CHARGE_MIN = 0.33; // s, release threshold
const LOCK_HALF_BOX = 6; // m, lock-on-tracking
const LOCK_RANGE = 250; // m, scan along the aim ray
const HOMING_SPEED = 55; // m/s, lock-on-tracking
const HOMING_LIFE = 3;
const HOMING_BLAST = 6; // m, game-owned
const HOMING_DAMAGE = 40;
const BOMB_SPEED = 108; // m/s, smart-bomb (180 u/upd)
const BOMB_LIFE = 1.2;
const BOMB_BLAST = 25;
const BOMB_DAMAGE = 100;
const BOMB_MAX = 9;
// Wing guns on the 4 m model; the twin pair differs by 10 cm in height (laser-fire card).
const GUN_SIDE = 1.1;
const GUN_FORWARD = 1.2;
const GUN_DROP = 0.1;
const NOSE = 2;

interface Bolt {
  readonly mesh: Object3D;
  readonly kind: BoltKind;
  active: boolean;
  age: number;
  life: number;
  damage: number;
  radius: number;
  speed: number;
  readonly dir: Vector3;
  target: ITarget | null;
  trailT: number;
}

const _p0 = new Vector3();
const _p1 = new Vector3();
const _m = new Vector3();
const _d = new Vector3();
const _to = new Vector3();
const _at = new Vector3();
const _rel = new Vector3();
const _nose = new Vector3();
const NEG_Z = new Vector3(0, 0, -1);

/**
 * Player weapons: lasers, charge + lock + homing shot, smart bomb.
 * Swept segment-vs-sphere tests mean a 320 m/s bolt cannot tunnel through a 1 m target.
 */
export class Weapons {
  /** 0 single, 1 twin, 2 hyper. */
  // ponytail: test-only seam, `?laser=1|2` in the page URL starts at twin/hyper (playtest state is read-only).
  laserLevel = Math.min(
    2,
    Number(/[?&]laser=(\d)/.exec(String(globalThis.location?.search ?? ""))?.[1] ?? 0),
  );
  bombs = 3;
  /** Charge 0..1 while charge is held. */
  charge = 0;
  lockedTarget: ITarget | null = null;
  shotsFired = 0;
  homingShots = 0;
  bombsUsed = 0;
  kills = 0;

  readonly #bolts: Bolt[] = [];
  #bomb: Bolt | null = null;
  #prevHeld = false;
  #prevCharge = false;
  #hold = 0;
  #cool = 0;
  #lockSounded = false;
  #clock = 0;
  #prevBombKey = false;
  #lastApBomb = -10;

  readonly #fx: IShotFx;

  constructor(readonly ctx: GameCtx) {
    this.#fx = createShotFx(ctx);
  }

  update(w: World, dt: number): void {
    this.#clock += dt;
    const input = this.#readInput(w);

    if (input.fireJustPressed) {
      this.#fireLaser(w);
      this.#cool = REPEAT;
    } else if (input.fireHeld) {
      this.#cool -= dt;
      if (this.#cool <= 0) {
        this.#fireLaser(w);
        this.#cool += REPEAT;
      }
    }
    if (input.chargeJustPressed) {
      this.#hold = 0;
      this.#lockSounded = false;
    }
    if (input.chargeHeld) {
      this.#hold += dt;
      this.charge = Math.min(1, this.#hold / CHARGE_FULL);
      if (this.charge >= 1) this.#probe(w);
    }
    if (input.chargeReleased) {
      if (this.#hold > CHARGE_MIN) this.#fireHoming(w);
      this.#hold = 0;
      this.charge = 0;
      this.lockedTarget = null;
    }
    this.#fx.charge(
      _nose.copy(w.ship.position).addScaledVector(w.ship.forward, NOSE),
      w.ship.forward,
      this.charge,
      dt,
    );
    if (input.bomb && this.bombs > 0 && this.#bomb === null) this.#fireBomb(w);

    for (const b of this.#bolts) if (b.active) this.#stepBolt(w, b, dt);
    if (this.#bomb !== null) this.#stepBolt(w, this.#bomb, dt);
    this.#fx.update(dt);
  }

  upgradeLaser(): void {
    this.laserLevel = Math.min(2, this.laserLevel + 1);
  }

  addBomb(): void {
    this.bombs = Math.min(BOMB_MAX, this.bombs + 1);
  }

  /** A broken wing drops the laser back to single. */
  resetLaser(): void {
    this.laserLevel = 0;
  }

  // -- input -------------------------------------------------------------------------------------

  #readInput(w: World) {
    let held: boolean;
    let charge: boolean;
    let bomb: boolean;
    let justPressed = false;
    let chargePressed = false;
    let released = false;
    if (w.autopilot) {
      ({ held, charge, bomb } = this.#autopilot(w));
    } else {
      const input = this.ctx.input;
      held = input.pressed("fire");
      charge = input.pressed("charge");
      bomb = input.justPressed("bomb") || (input.pressed("bomb") && !this.#prevBombKey);
      this.#prevBombKey = input.pressed("bomb");
      justPressed = input.justPressed("fire");
      chargePressed = input.justPressed("charge");
      released = input.justReleased("charge");
    }
    justPressed ||= held && !this.#prevHeld;
    chargePressed ||= charge && !this.#prevCharge;
    released ||= !charge && this.#prevCharge;
    this.#prevHeld = held;
    this.#prevCharge = charge;
    // A tap shorter than one update presses and releases in the same call.
    return {
      fireHeld: held || justPressed,
      fireJustPressed: justPressed,
      chargeHeld: charge || chargePressed,
      chargeJustPressed: chargePressed,
      chargeReleased: released,
      bomb,
    };
  }

  /** Test-only pilot: short bursts, a 1 s+ charge hold (firing too) every 4 s, a bomb on a crowd. */
  #autopilot(w: World): { held: boolean; charge: boolean; bomb: boolean } {
    const c = this.#clock % 4;
    const locked = this.lockedTarget !== null;
    const charge = c >= 2.4 && (c < 3.4 || (!locked && c < 3.9));
    const held = c < 0.3 || (c >= 0.8 && c < 1.1) || (c >= 1.6 && c < 1.9) || charge;
    let bomb = false;
    if (this.bombs > 0 && this.#bomb === null && this.#clock - this.#lastApBomb > 3) {
      _at.copy(w.ship.position).addScaledVector(w.ship.forward, 60);
      let near = 0;
      for (const t of w.enemies.targets) if (t.alive && t.position.distanceTo(_at) < 30) near++;
      if (near >= 4) {
        bomb = true;
        this.#lastApBomb = this.#clock;
      }
    }
    return { held, charge, bomb };
  }

  // -- lasers ------------------------------------------------------------------------------------

  #fireLaser(w: World): void {
    const s = w.ship;
    const level = this.laserLevel;
    if (level === 0) {
      this.#spawnLaser(w, "laser", _p0.copy(s.position).addScaledVector(s.forward, NOSE));
    } else {
      const kind = level === 1 ? "twin" : "hyper";
      for (const side of [-1, 1]) {
        _p0
          .copy(s.position)
          .addScaledVector(s.forward, GUN_FORWARD)
          .addScaledVector(s.right, side * GUN_SIDE)
          .addScaledVector(s.up, side > 0 ? -GUN_DROP : 0);
        this.#spawnLaser(w, kind, _p0);
      }
    }
    this.shotsFired++;
    w.sfx("laser");
  }

  #spawnLaser(w: World, kind: BoltKind, from: Vector3): void {
    const b = this.#acquire(kind);
    const level = kind === "laser" ? 0 : kind === "twin" ? 1 : 2;
    b.life = BOLT_LIFE;
    b.damage = DAMAGE[level] ?? 10;
    b.radius = level === 2 ? 0.5 : 0.3;
    b.speed = BOLT_SPEED;
    b.target = null;
    this.#place(w, b, from, w.ship.forward);
    this.#fx.muzzle(from, w.ship.forward, level === 2);
  }

  // -- charge, lock, homing ----------------------------------------------------------------------

  /** Claims the nearest lockable target inside a 6 m half box around the aim ray. */
  #probe(w: World): void {
    const s = w.ship;
    const held = this.lockedTarget;
    if (held !== null && held.alive && _rel.copy(held.position).sub(s.position).dot(s.forward) > -5)
      return;
    this.lockedTarget = null;
    let best = LOCK_RANGE;
    for (const t of w.enemies.targets) {
      if (!t.alive || !t.lockable) continue;
      _rel.copy(t.position).sub(s.position);
      const along = _rel.dot(s.forward);
      if (along < 1 || along >= best) continue;
      const tol = LOCK_HALF_BOX + t.radius;
      if (Math.abs(_rel.dot(s.right)) > tol || Math.abs(_rel.dot(s.up)) > tol) continue;
      best = along;
      this.lockedTarget = t;
    }
    if (this.lockedTarget !== null && !this.#lockSounded) {
      this.#lockSounded = true;
      w.sfx("lock");
    }
  }

  #fireHoming(w: World): void {
    const s = w.ship;
    const b = this.#acquire("homing");
    b.life = HOMING_LIFE;
    b.damage = HOMING_DAMAGE;
    b.radius = 0.5;
    b.speed = HOMING_SPEED;
    b.target = this.lockedTarget;
    this.#place(w, b, _p0.copy(s.position).addScaledVector(s.forward, NOSE), s.forward);
    this.#fx.release(_p0, s.forward);
    this.homingShots++;
  }

  // -- bomb --------------------------------------------------------------------------------------

  #fireBomb(w: World): void {
    const s = w.ship;
    const b = this.#acquire("bomb");
    b.life = BOMB_LIFE;
    b.damage = BOMB_DAMAGE;
    b.radius = 0.6;
    b.speed = BOMB_SPEED;
    b.target = this.lockedTarget;
    this.#place(w, b, _p0.copy(s.position).addScaledVector(s.forward, NOSE), s.forward);
    this.#bomb = b;
    this.bombs--;
    this.bombsUsed++;
  }

  // -- shared bolt machinery ---------------------------------------------------------------------

  #acquire(kind: BoltKind): Bolt {
    const free = this.#bolts.find((b) => !b.active && b.kind === kind);
    if (free !== undefined) return free;
    const mesh = boltMesh(kind);
    mesh.visible = false;
    this.ctx.add(mesh);
    this.ctx.interpolate(mesh);
    const b: Bolt = {
      mesh,
      kind,
      active: false,
      age: 0,
      life: 0,
      damage: 0,
      radius: 0.3,
      speed: 0,
      dir: new Vector3(),
      target: null,
      trailT: 0,
    };
    this.#bolts.push(b);
    return b;
  }

  #place(_w: World, b: Bolt, at: Vector3, dir: Vector3): void {
    b.active = true;
    b.age = 0;
    b.trailT = 0;
    b.dir.copy(dir);
    b.mesh.position.copy(at);
    b.mesh.quaternion.setFromUnitVectors(NEG_Z, b.dir);
    b.mesh.visible = true;
    this.ctx.resetInterpolation(b.mesh);
  }

  #retire(b: Bolt): void {
    b.active = false;
    b.mesh.visible = false;
    if (b === this.#bomb) this.#bomb = null;
  }

  #stepBolt(w: World, b: Bolt, dt: number): void {
    b.age += dt;
    if (b.kind === "homing" || b.kind === "bomb") this.#steer(b, dt);
    _p0.copy(b.mesh.position);
    _p1.copy(_p0).addScaledVector(b.dir, b.speed * dt);

    // Swept test: earliest of every target and obstacle along p0 -> p1.
    let tHit = 2;
    let hitTarget: ITarget | null = null;
    for (const t of w.enemies.targets) {
      if (!t.alive) continue;
      const hit = segmentSphere(_p0, _p1, t.position, t.radius + b.radius);
      if (hit < tHit) {
        tHit = hit;
        hitTarget = t;
      }
    }
    let hitObstacle = false;
    for (const o of w.stage.obstacles) {
      const hit = segmentSphere(_p0, _p1, o.center, o.radius + b.radius);
      if (hit < tHit) {
        tHit = hit;
        hitTarget = null;
        hitObstacle = true;
      }
    }
    const ground = w.stage.groundHeight(_p1.x, _p1.z);
    if (_p1.y < ground && _p0.y >= ground) {
      tHit = Math.min(tHit, (_p0.y - ground) / Math.max(1e-6, _p0.y - _p1.y));
      hitTarget = null;
      hitObstacle = true;
    }

    const arrived =
      b.kind === "bomb" && b.target?.alive === true && _p1.distanceTo(b.target.position) < 1;
    if (tHit <= 1 || arrived) {
      _at.lerpVectors(_p0, _p1, Math.min(tHit, 1));
      if (b.kind === "homing") this.#detonate(w, b, _at, HOMING_BLAST, "charged");
      else if (b.kind === "bomb") this.#detonate(w, b, _at, BOMB_BLAST, "bomb");
      else {
        if (hitTarget !== null) {
          this.#fx.hitEnemy(_at, b.dir);
          if (hitTarget.damage(b.damage)) this.kills++;
        } else if (hitObstacle) this.#fx.hitGround(_at, b.dir);
        this.#retire(b);
      }
      return;
    }
    b.mesh.position.copy(_p1);
    if (b.kind === "homing" || b.kind === "bomb") {
      b.trailT += dt;
      if (b.trailT >= 1 / 60) {
        b.trailT = 0;
        this.#fx.trail(_p1);
      }
    }
    if (b.age >= b.life) {
      if (b.kind === "homing") this.#detonate(w, b, _p1, HOMING_BLAST, "charged");
      else if (b.kind === "bomb") this.#detonate(w, b, _p1, BOMB_BLAST, "bomb");
      else this.#retire(b);
    }
  }

  /** Turns the shot toward its target with a rate that ramps with age (lock-on-tracking). */
  #steer(b: Bolt, dt: number): void {
    const target = b.target;
    if (target === null || !target.alive) return;
    _to.copy(target.position).sub(b.mesh.position);
    if (_to.lengthSq() < 1e-6) return;
    _to.normalize();
    if (b.kind === "bomb") {
      b.dir.copy(_to);
    } else {
      const rate = Math.min(10, 2 + b.age * 8); // rad/s
      const angle = Math.acos(Math.min(1, Math.max(-1, b.dir.dot(_to))));
      b.dir.lerp(_to, Math.min(1, (rate * dt) / Math.max(angle, 1e-6))).normalize();
    }
    b.mesh.quaternion.setFromUnitVectors(NEG_Z, b.dir);
  }

  #detonate(w: World, b: Bolt, at: Vector3, radius: number, cue: "charged" | "bomb"): void {
    this.#blast(w, at, radius, b.damage);
    w.fx.explode(at, radius);
    this.#fx.shockwave(at, radius, cue === "bomb" ? 0.6 : 0.25);
    w.sfx(cue, at);
    if (cue === "bomb") w.cameraRig.shake(0.6);
    this.#retire(b);
  }

  #blast(w: World, at: Vector3, radius: number, damage: number): void {
    // Copy: a kill may remove the target from the live list mid-loop.
    for (const t of w.enemies.targets.slice()) {
      if (!t.alive) continue;
      _d.copy(t.position).sub(at);
      if (_d.length() - t.radius <= radius && t.damage(damage)) this.kills++;
    }
  }

  debug(): Record<string, unknown> {
    return {
      laserLevel: this.laserLevel,
      bombs: this.bombs,
      charge: this.charge,
      locked: this.lockedTarget !== null,
      shotsFired: this.shotsFired,
      homingShots: this.homingShots,
      bombsUsed: this.bombsUsed,
      bombInFlight: this.#bomb !== null,
      kills: this.kills,
    };
  }
}

/** Entry parameter in [0, 1] where segment a->b first touches the sphere, or 2 when it misses. */
function segmentSphere(a: Vector3, b: Vector3, c: Vector3, r: number): number {
  _m.copy(a).sub(c);
  const cc = _m.lengthSq() - r * r;
  if (cc <= 0) return 0;
  _d.copy(b).sub(a);
  const len2 = _d.lengthSq();
  const bq = _m.dot(_d);
  if (len2 === 0 || bq >= 0) return 2;
  const disc = bq * bq - len2 * cc;
  if (disc < 0) return 2;
  const t = (-bq - Math.sqrt(disc)) / len2;
  return t <= 1 ? t : 2;
}
