import { Box3, Group, MathUtils, Matrix4, type Object3D, Vector3 } from "three";
import { normaliseToMetres } from "@threenative/core";
import { wingmanMesh } from "../render/enemyLook.js";
import type { GameCtx, ITarget, World } from "../world.js";
import { ARENA_RADIUS, type IRailFrame, railFrame } from "./Rail.js";

export interface IWingman {
  readonly position: Vector3;
  readonly forward: Vector3;
  readonly velocity: Vector3;
  shield: number;
  alive: boolean;
  /** True while an enemy is tailing this wingman. The HUD draws the help marker from this. */
  chased: boolean;
  /** True once shield hit 0: flying up and out. */
  retreating: boolean;
}

// wingmen card: shield 255 (fox_play.c:4752); wingmen 2 and 3 take doubled shot damage (fox_360.c:922-924).
const SHIELD = 255;
const DAMAGE_MULT = [1, 2];
// Rail formation slots: metres right, up and ahead of the ship.
const SLOTS = [
  [-8, 2.5, 30],
  [9, 4, 38],
] as const;
// wingmen card: roam speed 40 (fox_360 free roam), retreat speed 45 (fox_360 retreat).
const ROAM_SPEED = 40;
const RETREAT_SPEED = 45;
// Rail wing AI (game-owned, no card): the ally flies its own line in the rail frame.
const MAX_LAT = 22; // cruise wander band, |x| < 22 m
const MIN_UP = 2;
const MAX_UP = 12;
const ACCEL = 18; // m/s^2 of lateral/vertical steering
const MAX_STEER = 14; // m/s cap on lateral/vertical speed
const STEER_GAIN = 2; // per second: 7 m of error saturates the speed cap
const LEAD_MIN = 10; // along-track lead, metres ahead of the player's own `rail.s`
const LEAD_MAX = 40;
const EVADE_TIME = 2; // seconds of jink after being chased or hit
const HIT_MEMORY = 2; // a hit counts as "recently hit" for this long
const ROLL_TIME = 0.6; // barrel roll at the start of an evade
const JINK_RATE = 5; // rad/s of the side-to-side jink
const ENGAGE_RANGE = 150; // metres ahead an ally will pick a fight
const AIM_DOT = 0.98; // ~11 degrees: fire only with the nose on the foe
const AVOID = 6; // soft-avoid radius around the player, metres
const AVOID_SPEED = 10; // m/s pushed away inside that bubble
const TAU = Math.PI * 2;

type WingState = "cruise" | "engage" | "evade" | "regroup";

const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _back = new Vector3();
const _m = new Matrix4();
const _frame: IRailFrame = railFrame();

/** Accelerate `v` toward the speed that closes `to - from`, bounded by ACCEL and MAX_STEER. */
const seek = (v: number, from: number, to: number, dt: number): number =>
  v +
  MathUtils.clamp(
    MathUtils.clamp((to - from) * STEER_GAIN, -MAX_STEER, MAX_STEER) - v,
    -ACCEL * dt,
    ACCEL * dt,
  );

interface IMember extends IWingman {
  mesh: Group;
  index: number;
  fireT: number;
  waypoint: Vector3;
  waypointT: number;
  retreatT: number;
  placed: boolean;
  /** Rail-space flight: its own lateral x, vertical y, lead along the track, and how it got there. */
  state: WingState;
  lateral: number;
  height: number;
  vx: number;
  vy: number;
  lead: number;
  pace: number;
  targetX: number;
  targetY: number;
  targetT: number;
  evadeT: number;
  hitT: number;
  roll: number;
  rollT: number;
}

/** Two allied fighters: formation on the rail, free roam in the arena. */
export class Wingmen {
  readonly members: IMember[] = [];
  rescues = 0;
  #t = 0;
  #arena = false;

  /** `playerModel` is the loaded starfighter scene; clone it, never re-parent it. */
  constructor(
    readonly ctx: GameCtx,
    playerModel: Object3D,
  ) {
    for (let index = 0; index < 2; index += 1) {
      const model = wingmanMesh(playerModel);
      // Same normalisation as the player's ship: nose to -Z, centred, 4 m long.
      model.rotation.y = Math.PI;
      normaliseToMetres(model, { axis: "longest", metres: 4 });
      model.updateMatrixWorld(true);
      model.position.sub(new Box3().setFromObject(model).getCenter(new Vector3()));
      const mesh = new Group();
      mesh.add(model);
      mesh.visible = false;
      ctx.add(mesh);
      ctx.interpolate(mesh);
      this.members.push({
        mesh,
        index,
        position: mesh.position,
        forward: new Vector3(0, 0, -1),
        velocity: new Vector3(),
        shield: SHIELD,
        alive: true,
        chased: false,
        retreating: false,
        fireT: 1 + index * 0.4,
        waypoint: new Vector3(),
        waypointT: 0,
        retreatT: 0,
        placed: false,
        state: "cruise",
        lateral: 0,
        height: 0,
        vx: 0,
        vy: 0,
        lead: LEAD_MIN,
        pace: 1,
        targetX: 0,
        targetY: 0,
        targetT: 0,
        evadeT: 0,
        hitT: 0,
        roll: 0,
        rollT: 0,
      });
    }
  }

  /** Shot damage from an enemy (Enemies calls this). */
  hit(m: IWingman, damage: number): void {
    const mem = m as IMember;
    if (!mem.alive || mem.retreating) return;
    mem.hitT = HIT_MEMORY;
    mem.shield = Math.max(0, mem.shield - damage * (DAMAGE_MULT[mem.index] ?? 2));
    if (mem.shield === 0) {
      mem.retreating = true;
      mem.chased = false;
    }
  }

  update(w: World, dt: number): void {
    this.#t += dt;
    const ship = w.ship;
    if (ship.mode === "arena" && !this.#arena) {
      this.#arena = true;
      for (const m of this.members) {
        m.waypointT = 0;
        m.evadeT = 0;
        m.roll = 0;
      }
    }
    for (const m of this.members) {
      if (!m.alive) continue;
      m.velocity.copy(m.position);
      if (!m.placed) this.#place(w, m);
      if (m.retreating) this.#retreat(m, dt);
      else if (this.#arena) this.#roam(w, m, dt);
      else this.#formation(w, m, dt);
      m.velocity.sub(m.position).multiplyScalar(-1 / Math.max(dt, 1e-4));
      this.#orient(m);
      if (!m.retreating) this.#fire(w, m, dt);
    }
  }

  /** First placement: on its rail slot ahead of the player, never copied from the ship's transform. */
  #place(w: World, m: IMember): void {
    m.placed = true;
    const slot = SLOTS[m.index] as readonly [number, number, number];
    m.lateral = slot[0];
    m.height = slot[1];
    m.lead = MathUtils.clamp(slot[2], LEAD_MIN, LEAD_MAX);
    const f = w.rail.frame(w.rail.s + m.lead, _frame);
    m.position.copy(f.position).addScaledVector(f.right, m.lateral).addScaledVector(f.up, m.height);
    m.forward.copy(f.forward);
    m.mesh.visible = true;
    this.ctx.resetInterpolation(m.mesh);
  }

  /** Rail flight: the ally keeps its own line in the rail frame and steers it with inertia. */
  #formation(w: World, m: IMember, dt: number): void {
    // Its own pace along the track (±10% of the ship's speed) drifts the lead inside 10..40 m.
    m.lead += w.ship.speed * (m.pace - 1) * dt;
    if (m.lead <= LEAD_MIN || m.lead >= LEAD_MAX) {
      m.lead = MathUtils.clamp(m.lead, LEAD_MIN, LEAD_MAX);
      m.pace = 2 - m.pace;
    }
    const f = w.rail.frame(w.rail.s + m.lead, _frame);
    this.#think(w, m, dt, f);
    m.vx = seek(m.vx, m.lateral, m.targetX, dt);
    m.vy = seek(m.vy, m.height, m.targetY, dt);
    m.lateral += m.vx * dt;
    m.height += m.vy * dt;
    m.position.copy(f.position).addScaledVector(f.right, m.lateral).addScaledVector(f.up, m.height);
    m.forward.copy(f.forward);
    // Soft-avoid the player: never crowd the ship, push out along the rail's lateral axis.
    _a.copy(m.position).sub(w.ship.position);
    if (_a.lengthSq() < AVOID * AVOID) {
      const side = _a.dot(f.right) < 0 ? -1 : 1;
      m.vx = MathUtils.clamp(m.vx + side * ACCEL * 2 * dt, -AVOID_SPEED, AVOID_SPEED);
      m.targetX = m.lateral + side * AVOID * 2;
    }
  }

  /** State machine + the lateral/vertical target that state asks for. */
  #think(w: World, m: IMember, dt: number, f: IRailFrame): void {
    m.hitT = Math.max(0, m.hitT - dt);
    if (m.chased || m.hitT > 0) {
      // A fresh evade opens with a barrel roll, then keeps jinking while the threat holds.
      if (m.evadeT <= 0) m.rollT = ROLL_TIME;
      m.evadeT = EVADE_TIME;
    } else m.evadeT = Math.max(0, m.evadeT - dt);

    if (m.evadeT > 0) {
      m.state = "evade";
      m.rollT = Math.max(0, m.rollT - dt);
      m.roll = m.rollT > 0 ? TAU * (1 - m.rollT / ROLL_TIME) : 0;
      m.targetX = Math.sin(this.#t * JINK_RATE + m.index * Math.PI) * MAX_LAT * 0.8;
      m.targetY = m.height;
      return;
    }

    const foe = this.#acquire(w, m);
    if (foe !== null) {
      m.state = "engage";
      // Slide across to the foe's own lateral offset and shoot once the nose lines up.
      _a.copy(foe.position).sub(m.position);
      m.targetX = MathUtils.clamp(m.lateral + _a.dot(f.right), -MAX_LAT, MAX_LAT);
      m.targetY = MathUtils.clamp(m.height + _a.dot(f.up), MIN_UP, MAX_UP);
      return;
    }

    const was = m.state;
    if (was === "evade" || was === "engage") {
      m.state = "regroup";
      m.targetT = 0;
    }
    const slot = SLOTS[m.index] as readonly [number, number, number];
    if (m.state === "regroup") {
      // Back to its SLOTS position measured against the rail, not against the ship.
      m.targetX = slot[0];
      m.targetY = slot[1];
      if (Math.abs(m.lateral - slot[0]) < 3 && Math.abs(m.height - slot[1]) < 2) {
        m.state = "cruise";
        m.targetT = 0;
      }
    }
    if (m.state !== "cruise") return;
    m.targetT -= dt;
    if (m.targetT > 0) return;
    // Cruise: a fresh wander target every 2-4 s, at its own pace.
    const r = this.ctx.random;
    m.targetT = r.range(2, 4);
    m.targetX = r.range(-MAX_LAT, MAX_LAT);
    m.targetY = r.range(MIN_UP, MAX_UP);
    m.pace = r.range(0.9, 1.1);
  }

  /** The nearest live foe ahead of this wingman, within 150 m (engaged on). */
  #acquire(w: World, m: IMember): ITarget | null {
    let best: ITarget | null = null;
    let bd = ENGAGE_RANGE;
    for (const t of w.enemies.targets) {
      if (!t.alive) continue;
      _a.copy(t.position).sub(m.position);
      const d = _a.length();
      if (d < bd && _a.dot(m.forward) > 0) {
        bd = d;
        best = t;
      }
    }
    return best;
  }

  #roam(w: World, m: IMember, dt: number): void {
    const c = w.rail.arenaCenter;
    m.waypointT -= dt;
    if (m.waypointT <= 0 || m.position.distanceTo(m.waypoint) < 25) {
      const r = this.ctx.random;
      const a = r() * Math.PI * 2;
      const d = r.range(60, ARENA_RADIUS * 0.8);
      m.waypoint.set(c.x + Math.cos(a) * d, c.y + r.range(15, 70), c.z + Math.sin(a) * d);
      m.waypointT = 8;
    }
    // Turn toward the waypoint at a limited rate (wingmen card: chase turn 1.4 deg/update ~ 0.7 rad/s; roam turns a little faster).
    _a.copy(m.waypoint).sub(m.position).normalize();
    m.forward.lerp(_a, 1 - Math.exp(-1.2 * dt)).normalize();
    m.position.addScaledVector(m.forward, ROAM_SPEED * dt);
  }

  #retreat(m: IMember, dt: number): void {
    // Boost, climb and leave (wingmen card: retreat at speed 45, climbing).
    _a.copy(m.forward).setY(0).normalize().setY(0.9).normalize();
    m.forward.lerp(_a, 1 - Math.exp(-2 * dt)).normalize();
    m.position.addScaledVector(m.forward, RETREAT_SPEED * dt);
    m.retreatT += dt;
    if (m.retreatT > 6) {
      m.alive = false;
      m.mesh.visible = false;
    }
  }

  #orient(m: IMember): void {
    _right.crossVectors(m.forward, UP);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, m.forward).normalize();
    // Bank into its own lateral motion, plus any barrel roll it is flying.
    const bank = MathUtils.clamp(-m.velocity.dot(_right) * 0.04, -0.5, 0.5) + m.roll;
    _right.applyAxisAngle(m.forward, bank);
    _up.applyAxisAngle(m.forward, bank);
    _m.makeBasis(_right, _up, _back.copy(m.forward).negate());
    m.mesh.quaternion.setFromRotationMatrix(_m);
  }

  /** Allies shoot the nearest foe in front: wingmen card fire chance 0.4 per roll, 0.5 for wingman 1. */
  #fire(w: World, m: IMember, dt: number): void {
    m.fireT -= dt;
    if (m.fireT > 0) return;
    m.fireT = 0.5;
    if (this.ctx.random() > (m.index === 0 ? 0.5 : 0.4)) return;
    const target = w.enemies.nearestForAlly(m.position, m.forward, 160);
    if (target === null) return;
    // Only shoot with the nose on the foe: an ally engages, it does not spray.
    if (_a.copy(target.position).sub(m.position).normalize().dot(m.forward) < AIM_DOT) return;
    w.enemies.allyShot(m.position, target);
    w.sfx("laser", m.position);
  }

  debug(): Record<string, unknown> {
    return {
      alive: this.members.filter((m) => m.alive).length,
      chased: this.members.filter((m) => m.chased).length,
      rescues: this.rescues,
      members: this.members.map((m) => ({
        shield: m.shield,
        chased: m.chased,
        state: m.state,
        lead: m.lead,
      })),
    };
  }
}
