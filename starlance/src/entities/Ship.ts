import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Group,
  MathUtils,
  Matrix4,
  type Object3D,
  Quaternion,
  Vector2,
  Vector3,
} from "three";
import { normaliseToMetres, softCircleDataTexture } from "@threenative/core";
import { railFrame } from "./Rail.js";
import type { World } from "../world.js";

/** Cruise speed along the course, m/s (game-owned; no card). */
export const CRUISE_SPEED = 30;
/** Corridor half extents around the path, metres (rails-path-progress, fox_play.c:4468-4470). */
export const CORRIDOR = { halfWidth: 14, headroom: 13.6, floorOverGround: 0.8 } as const;
export const SHIELD_START = 255;

const D2R = Math.PI / 180;
const EDGE_WARNING = 2; // rails-path-progress, fox_play.c:3963
// pitch-yaw (fox_play.c:3580-3613): stick x0.75, rotated by bank, x0.68, source stick range 70.
const STICK_SCALE = 0.75;
// Mouse aim: the cursor's offset from screen centre is the stick, full at 55% of the half-screen.
const MOUSE_DEAD = 0.06;
const MOUSE_FULL = 0.55;
// Airframe inertia, game-owned: the stick the ship flies eases toward the input (~0.25 s lag).
const STICK_INERTIA = 0.12;
const TARGET_SCALE = 0.68;
const YAW_MAX = 70 * STICK_SCALE * TARGET_SCALE * D2R;
const TURN_RATE = 69 * D2R; // base rate, rad/s
const RAIL_TURN = 1.4; // rails widen turns (fox_play.c:3928)
const ROLL_STICK = 0.6 * 70 * D2R; // roll target = stick x * 0.6 (fox_play.c:3669)
// banking (fox_play.c:3368-3395)
const BANK_MAX = 90 * D2R;
const BANK_SMOOTH = 0.2;
const BANK_LIMIT = 300 * D2R;
// barrel-roll (fox_play.c:3401-3405, 4853-4857)
const TAP_WINDOW = 0.33;
const ROLL_RATE = 900 * D2R;
const ROLL_TIME = 0.33;
const ROLL_SETTLE = 150 * D2R; // 5 deg/upd closes the last of the turn
const ROLL_LATERAL = 1.5;
// arwing-boost / arwing-brake (fox_play.c:4962-5168)
const BOOST_SPEED = 18;
const BRAKE_SPEED = -12;
const GAUGE_FILL = 1; // per second: 1 s to fill
const GAUGE_RECOVER = 1 / 6; // per second: 6 s to recover
const SPEED_ACCEL = 30; // m/s^2, game-owned
// somersault-loop (fox_play.c:3747-3765, 4982-4983)
const LOOP_RATE = 150 * D2R;
const LOOP_LIFT = 1.2; // 2 u/upd * 0.02 m * 30
const LOOP_REFILL = (2 / 90) * 30;
// u-turn (fox_demo.c:1395-1472, fox_play.c:5102-5135)
const UTURN_RATE = 180 * D2R;
const UTURN_ROLLOUT = 360 * D2R;
const ARENA_YAW_RATE = 100 * D2R;
const ARENA_PITCH_RATE = 80 * D2R;
const ARENA_PITCH_MAX = 70 * D2R;
const ARENA_CEILING = 220;
const ARENA_FLOOR = 0.2;
const ARENA_EDGE_MARGIN = 25; // start the forced U-turn this far inside the radius
// shield-damage (fox_play.c:858-900, 4414, 5465-5482)
const DRAIN_RATE = 60;
const INVULNERABLE_TIME = 0.67;
const KNOCKBACK = 0.4;
const WARNINGS = [100, 50] as const;
// wing-damage (fox_play.c:822-959, 3363, 3680) and terrain-collision (fox_play.c:1692-1770)
const WING_MAX = 60;
const WING_SIDE_HIT = 20;
const WING_VERTICAL_HIT = 15;
const WING_BANK = 17 * D2R;
const WING_DRIFT = 5; // m/s sideways toward the broken wing, game-owned
const WING_SINK = 1.5; // m/s down, game-owned
const SCRAPE_HEIGHT = 0.26;
const SCRAPE_DAMAGE = 21;
// Obstacle contact (game-owned): rocks are solid, so the hull is pushed to the rock's surface.
const HULL_R = 2.2;
const OBSTACLE_DAMAGE = 40;
const GOLD_CAP = 383;
const GOLD_RINGS_FOR_CAP = 3;

const _basis = new Matrix4();
const _tmp = new Vector3();
const _hit = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qc = new Quaternion();
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);
const _stick = new Vector2();
const _mouse = new Vector2();
const _rot = new Vector2();
const _d = new Vector3(); // spark contact point

/** Per-update smoothing fraction `f` at 30 Hz, converted to this step's length. */
const smooth = (f: number, dt: number): number => 1 - (1 - f) ** (30 * dt);
const chase = (value: number, target: number, maxStep: number): number =>
  value + MathUtils.clamp(target - value, -maxStep, maxStep);

/**
 * The player starfighter: rail flight (offset from the path), barrel roll, boost/brake, somersault,
 * all-range arena flight with the U-turn, and the shield/wing damage model. Angles are radians
 * inside, degrees in `debug()`. Yaw is positive turning right, pitch positive nose up, bank
 * positive right wing down.
 */
export class Ship {
  readonly mesh = new Group();
  /** World position (same object as `mesh.position`). */
  readonly position = this.mesh.position;
  /** Unit nose direction in world space, roll excluded. Shots leave along it. */
  readonly forward = new Vector3(0, 0, -1);
  readonly right = new Vector3(1, 0, 0);
  readonly up = new Vector3(0, 1, 0);
  /** Rail mode: metres right/up of the path in the rail frame. */
  readonly offset = new Vector2();
  mode: "rail" | "arena" = "rail";
  speed = CRUISE_SPEED;
  /** True while a barrel roll spins; enemy shots deflect. */
  rolling = false;
  invulnerable = false;
  shield = SHIELD_START;
  shieldMax = SHIELD_START;
  /** Boost/brake gauge 0..1 (card 0..90). */
  boost = 0;
  boostLatched = false;
  readonly wings = { left: WING_MAX, right: WING_MAX };
  alive = true;
  rolls = 0;
  loops = 0;
  uturns = 0;
  goldRings = 0;
  /** Rail mode: true within 2 m of the corridor edge. */
  edgeWarning = false;

  readonly #fx: ShipFx;
  #fxAdded = false;
  readonly #frame = railFrame();
  readonly #railQ = new Quaternion();
  readonly #arenaCenter = new Vector3();
  #arenaRadius = 0;
  #w: World | undefined;
  #time = 0;
  #yaw = 0;
  #pitch = 0;
  #shoulder = 0; // smoothed Q/E bank
  #stickRoll = 0; // smoothed stick roll
  #wingBank = 0;
  #barrel = 0; // signed barrel-roll angle
  #barrelDir = 0;
  #barrelTime = 0;
  #lastTap = { left: -10, right: -10 };
  #loop = 0; // somersault pitch, 0..2pi
  #uturn = 0; // 0 idle, else half-loop pitch so far
  #uturnActive = false;
  #invert = 0; // roll-out after the half loop, radians left to unwind
  #pendingDamage = 0;
  #pendingHeal = 0;
  #invulnTimer = 0;
  #warned = [false, false];
  #knock = new Vector2();
  #autoStick = new Vector2();
  #flown = new Vector2(); // stick after inertia
  #raw = new Vector2(); // stick before inertia: gestures read this
  #mouseLive = false;
  #autoBoost = false;

  constructor(model: Object3D) {
    // starfighter.glb: nose on +Z, 15.2-unit wingspan on X (checked in a capture). Turn the nose to -Z,
    // centre it, and scale it to 5 m (4 m read too small against the chase camera).
    model.rotation.y = Math.PI;
    normaliseToMetres(model, { axis: "longest", metres: 5 });
    model.updateMatrixWorld(true);
    const centre = new Box3().setFromObject(model).getCenter(new Vector3());
    model.position.sub(centre);
    model.traverse((object) => {
      object.castShadow = true;
    });
    this.mesh.add(model);
    // Raw glb points (nose +Z, rear -Z): the ion strip and the wingtips, mapped into hull space.
    const toHull = (x: number, y: number, z: number): Vector3 =>
      model.localToWorld(new Vector3(x, y, z));
    this.#fx = new ShipFx(this.mesh, {
      engines: [toHull(-0.35, 0.07, -2.45), toHull(0.35, 0.07, -2.45)],
      wingtips: [toHull(-7.4, -0.4, -3.3), toHull(7.4, -0.4, -3.3)],
      wings: [toHull(-4, -0.3, -2), toHull(4, -0.3, -2)],
    });
  }

  update(w: World, dt: number): void {
    this.#w = w;
    this.#time += dt;
    if (!this.alive) {
      this.#drain(dt);
      this.#updateFx(w, dt);
      return;
    }
    const stick = this.#readStick(w, dt);
    const bankInput = w.ctx.input.pressed("bankRight")
      ? 1
      : w.ctx.input.pressed("bankLeft")
        ? -1
        : 0;
    this.#updateBank(dt, stick, bankInput);
    this.#updateBarrel(w, dt);
    this.#updateGauge(w, dt);
    this.#updateLoops(w, dt);
    if (this.mode === "rail") this.#flyRail(w, dt, stick);
    else this.#flyArena(w, dt, stick);
    this.#updateDamage(w, dt);
    this.#collide(w);
    this.#orient();
    this.#updateFx(w, dt);
  }

  /** Exhaust, contrails and damage smoke; the pools live in world space under one group. */
  #updateFx(w: World, dt: number): void {
    const f =
      this.speed >= CRUISE_SPEED
        ? (this.speed - CRUISE_SPEED) / BOOST_SPEED
        : (this.speed - CRUISE_SPEED) / -BRAKE_SPEED;
    const trailing =
      this.alive &&
      (this.rolling || this.#loop > 0 || this.#uturnActive || this.speed > CRUISE_SPEED + 6);
    if (!this.#fxAdded) {
      this.#fxAdded = true;
      w.ctx.add(this.#fx.root);
    }
    this.#fx.update(
      dt,
      w.camera.quaternion,
      w.camera.position,
      f,
      trailing,
      this.wings.left,
      this.wings.right,
      WING_MAX,
    );
  }

  // ---------------------------------------------------------------------------------- input

  #readStick(w: World, dt: number): Vector2 {
    const input = w.ctx.input;
    const move = input.vector("move");
    const mouse = this.#mouseStick(w);
    let x = move.x + input.axis("stickX") + mouse.x;
    let y = move.y - input.axis("stickY") + mouse.y; // gamepad Y axis is +down
    if (w.autopilot) {
      this.#autopilot(w);
      x = this.#autoStick.x;
      y = this.#autoStick.y;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    // Aerodynamics: the airframe follows the stick with lag, so turns ease in and out.
    return _stick.copy(this.#flown.lerp(this.#raw.set(x, y), smooth(STICK_INERTIA, dt)));
  }

  /** Cursor offset from screen centre as a stick, after the mouse first moves (+y up). */
  #mouseStick(w: World): Vector2 {
    const p = w.ctx.input.raw.pointer.position;
    const { width, height } = w.ctx.viewport.size;
    this.#mouseLive ||= p.x !== 0 || p.y !== 0;
    if (!this.#mouseLive) return _mouse.set(0, 0);
    _mouse.set((p.x / width) * 2 - 1, 1 - (p.y / height) * 2);
    const len = _mouse.length();
    const k = MathUtils.clamp((len - MOUSE_DEAD) / (MOUSE_FULL - MOUSE_DEAD), 0, 1);
    return len > 0 ? _mouse.multiplyScalar(k / len) : _mouse;
  }

  /** Stick x0.75 rotated by the shoulder bank (pitch-yaw card): up while banked right turns right. */
  #rotated(stick: Vector2): Vector2 {
    const c = Math.cos(this.#shoulder);
    const s = Math.sin(this.#shoulder);
    return _rot.set(
      (stick.x * c + stick.y * s) * STICK_SCALE,
      (-stick.x * s + stick.y * c) * STICK_SCALE,
    );
  }

  /** Banked past 10 degrees doubles the turn rate (pitch-yaw card). */
  get #bankMul(): number {
    return Math.abs(this.#shoulder) > 10 * D2R ? 2 : 1;
  }

  // ---------------------------------------------------------------------------------- roll

  #updateBank(dt: number, stick: Vector2, bankInput: number): void {
    const f = smooth(BANK_SMOOTH, dt);
    const limit = BANK_LIMIT * dt;
    this.#shoulder += MathUtils.clamp((bankInput * BANK_MAX - this.#shoulder) * f, -limit, limit);
    this.#stickRoll += MathUtils.clamp((stick.x * ROLL_STICK - this.#stickRoll) * f, -limit, limit);
    this.#wingBank = chase(this.#wingBank, this.#wingSide * WING_BANK, limit);
  }

  /** -1 left wing broken, +1 right wing broken, 0 neither or both. */
  get #wingSide(): number {
    return (this.wings.right === 0 ? 1 : 0) - (this.wings.left === 0 ? 1 : 0);
  }

  #updateBarrel(w: World, dt: number): void {
    const input = w.ctx.input;
    if (!this.rolling) {
      for (const side of ["left", "right"] as const) {
        const action = side === "left" ? "bankLeft" : "bankRight";
        if (!input.justPressed(action)) continue;
        if (this.#time - this.#lastTap[side] <= TAP_WINDOW) {
          this.rolling = true;
          this.rolls += 1;
          this.#barrel = 0;
          this.#barrelTime = 0;
          this.#barrelDir = side === "right" ? 1 : -1;
          this.#lastTap[side] = -10;
        } else this.#lastTap[side] = this.#time;
      }
    }
    if (!this.rolling) return;
    this.#barrelTime += dt;
    const step = this.#barrelTime <= ROLL_TIME ? ROLL_RATE * dt : ROLL_SETTLE * dt;
    this.#barrel = Math.min(Math.PI * 2, this.#barrel + step);
    if (this.#barrel >= Math.PI * 2 - 1e-3) {
      this.rolling = false;
      this.#barrel = 0;
    }
  }

  get #barrelAngle(): number {
    return this.#barrel * this.#barrelDir;
  }

  // ---------------------------------------------------------------------------------- boost / brake

  #updateGauge(w: World, dt: number): void {
    const input = w.ctx.input;
    const wantBoost = input.pressed("boost") || (w.autopilot && this.#autoBoost);
    const wantBrake = input.pressed("brake");
    const busy = this.#loop > 0 || this.#uturnActive;
    let target = CRUISE_SPEED;
    if (!this.boostLatched && !busy && (wantBoost || wantBrake) && wantBoost !== wantBrake) {
      this.boost = Math.min(1, this.boost + GAUGE_FILL * dt);
      target = CRUISE_SPEED + (wantBoost ? BOOST_SPEED : BRAKE_SPEED);
      if (this.boost >= 1) this.boostLatched = true;
    } else if (!busy) {
      this.boost = Math.max(0, this.boost - GAUGE_RECOVER * dt);
      if (this.boost === 0) this.boostLatched = false;
    }
    this.speed = chase(this.speed, target, SPEED_ACCEL * dt);
  }

  // ---------------------------------------------------------------------------------- somersault / u-turn

  #updateLoops(w: World, dt: number): void {
    const input = w.ctx.input;
    const climbing = this.#raw.y > 0.5; // the gesture reads the raw stick, not the lagged one
    if (this.#loop === 0 && !this.#uturnActive && !this.rolling && climbing) {
      if (this.mode === "rail" && input.justPressed("boost")) this.#loop = 1e-6;
      else if (this.mode === "arena" && input.justPressed("brake")) this.#startUturn();
    }
    if (this.#loop > 0) {
      this.#loop += LOOP_RATE * dt;
      this.offset.y += LOOP_LIFT * dt;
      this.boost = Math.min(1, this.boost + LOOP_REFILL * dt);
      if (this.#loop >= 350 * D2R) {
        this.#loop = 0;
        this.loops += 1;
      }
    }
    if (this.#uturnActive) {
      this.#uturn += UTURN_RATE * dt;
      this.#pitch = chase(this.#pitch, 0, 60 * D2R * dt);
      if (this.#uturn >= Math.PI) {
        // Half loop done: the hull is inverted and flying back. Re-express as yaw + 180 and roll 180.
        this.#yaw += Math.PI;
        this.#pitch = 0;
        this.#uturn = 0;
        this.#uturnActive = false;
        this.#invert = Math.PI;
        this.uturns += 1;
      }
    }
    if (this.#invert > 0) this.#invert = Math.max(0, this.#invert - UTURN_ROLLOUT * dt);
  }

  #startUturn(): void {
    this.#uturnActive = true;
    this.#uturn = 1e-6;
  }

  // ---------------------------------------------------------------------------------- rail flight

  #flyRail(w: World, dt: number, stick: Vector2): void {
    const r = this.#rotated(stick);
    const rate = TURN_RATE * this.#bankMul * RAIL_TURN * dt;
    this.#yaw = chase(this.#yaw, r.x * TARGET_SCALE * 70 * D2R, rate);
    this.#pitch = chase(this.#pitch, r.y * TARGET_SCALE * 70 * D2R, rate);
    const lateral = (this.rolling ? ROLL_LATERAL : 1) * CRUISE_SPEED;
    // A broken wing drags the ship toward that side and down.
    this.offset.x +=
      Math.sin(this.#yaw) * lateral * dt + this.#wingSide * WING_DRIFT * dt + this.#knock.x;
    this.offset.y += Math.sin(this.#pitch) * lateral * dt - this.#sink * dt + this.#knock.y;
    this.#knock.set(0, 0);
    w.rail.s += this.speed * dt;
    const f = w.rail.frame(w.rail.s, this.#frame);
    const floor =
      w.stage.groundHeight(f.position.x, f.position.z) + CORRIDOR.floorOverGround - f.position.y;
    this.offset.x = MathUtils.clamp(this.offset.x, -CORRIDOR.halfWidth, CORRIDOR.halfWidth);
    this.offset.y = MathUtils.clamp(this.offset.y, floor, CORRIDOR.headroom);
    this.edgeWarning =
      Math.abs(this.offset.x) > CORRIDOR.halfWidth - EDGE_WARNING ||
      this.offset.y > CORRIDOR.headroom - EDGE_WARNING;
    this.position
      .copy(f.position)
      .addScaledVector(f.right, this.offset.x)
      .addScaledVector(f.up, this.offset.y);
    this.#railQ.setFromRotationMatrix(
      _basis.makeBasis(f.right, f.up, _tmp.copy(f.forward).negate()),
    );
  }

  /** Sink speed of a ship with a broken wing, m/s. */
  get #sink(): number {
    return this.wings.left === 0 || this.wings.right === 0 ? WING_SINK : 0;
  }

  // ---------------------------------------------------------------------------------- arena flight

  #flyArena(w: World, dt: number, stick: Vector2): void {
    if (!this.#uturnActive) {
      const r = this.#rotated(stick);
      this.#yaw += (r.x / STICK_SCALE) * ARENA_YAW_RATE * this.#bankMul * dt;
      if (r.y !== 0)
        this.#pitch = MathUtils.clamp(
          this.#pitch + (r.y / STICK_SCALE) * ARENA_PITCH_RATE * dt,
          -ARENA_PITCH_MAX,
          ARENA_PITCH_MAX,
        );
      else this.#pitch = chase(this.#pitch, 0, 30 * D2R * dt);
      this.#forced();
    }
    this.#aim(this.#uturnActive ? this.#uturn : 0, true);
    this.position
      .addScaledVector(this.forward, this.speed * dt)
      .addScaledVector(this.right, this.#wingSide * WING_DRIFT * dt)
      .addScaledVector(AXIS_Y, -this.#sink * dt);
    this.position.x += this.#knock.x;
    this.position.y += this.#knock.y;
    this.#knock.set(0, 0);
    // The arena wall: never outside the circle, and a heading that points out forces a U-turn.
    _tmp.copy(this.position).sub(this.#arenaCenter).setY(0);
    const dist = _tmp.length();
    if (dist > this.#arenaRadius) {
      _tmp.multiplyScalar(this.#arenaRadius / dist);
      this.position.x = this.#arenaCenter.x + _tmp.x;
      this.position.z = this.#arenaCenter.z + _tmp.z;
    }
    const ground = w.stage.groundHeight(this.position.x, this.position.z);
    this.position.y = MathUtils.clamp(this.position.y, ground + ARENA_FLOOR, ARENA_CEILING);
    this.#railQ.identity();
  }

  /** Leaving the radius forces the U-turn; the flip starts 25 m inside the edge. */
  #forced(): void {
    _tmp.copy(this.#arenaCenter).sub(this.position).setY(0);
    const dist = _tmp.length();
    if (dist < this.#arenaRadius - ARENA_EDGE_MARGIN) return;
    _hit.copy(this.forward).setY(0);
    if (_hit.dot(_tmp) < 0) this.#startUturn();
  }

  /** Fills `forward`/`right`/`up` from yaw, pitch (+ any loop pitch) and the rail frame. */
  #aim(loop: number, includeLoop: boolean): void {
    const pitch = this.#pitch + (includeLoop ? loop : 0);
    _qa.setFromAxisAngle(AXIS_Y, -this.#yaw);
    _qb.setFromAxisAngle(AXIS_X, pitch);
    _qa.multiply(_qb);
    if (this.mode === "rail") _qa.premultiply(this.#railQ);
    this.forward.set(0, 0, -1).applyQuaternion(_qa);
    this.right.set(1, 0, 0).applyQuaternion(_qa);
    this.up.set(0, 1, 0).applyQuaternion(_qa);
  }

  // ---------------------------------------------------------------------------------- orientation

  #orient(): void {
    if (this.mode === "rail") this.#aim(0, false);
    else this.#aim(this.#uturnActive ? this.#uturn : 0, true);
    const bank =
      this.#shoulder + this.#stickRoll + this.#wingBank + this.#barrelAngle + this.#invert;
    // Build the hull: base * yaw * (pitch + somersault) * roll.
    _qa.setFromAxisAngle(AXIS_Y, -this.#yaw);
    _qb.setFromAxisAngle(
      AXIS_X,
      this.#pitch + this.#loop + (this.mode === "arena" ? this.#uturn : 0),
    );
    _qa.multiply(_qb);
    _qc.setFromAxisAngle(AXIS_Z, -bank);
    _qa.multiply(_qc);
    if (this.mode === "rail") _qa.premultiply(this.#railQ);
    this.mesh.quaternion.copy(_qa);
  }

  // ---------------------------------------------------------------------------------- damage

  /** A hit of `damage` shield points from a world point `from`. Ignored while invulnerable. */
  takeHit(damage: number, from: Vector3): void {
    if (this.invulnerable || !this.alive) return;
    this.#pendingDamage += damage;
    this.invulnerable = true;
    this.#invulnTimer = INVULNERABLE_TIME;
    // Hit direction in the ship's frame decides the wing: side hit -20, vertical hit -15 random wing.
    _hit.copy(from).sub(this.position);
    const side = _hit.dot(this.right);
    const vertical = _hit.dot(this.up);
    const ahead = Math.abs(_hit.dot(this.forward));
    if (Math.abs(side) > ahead * 0.5 && Math.abs(side) >= Math.abs(vertical))
      this.#damageWing(side < 0 ? "left" : "right", WING_SIDE_HIT);
    else if (Math.abs(vertical) > ahead * 0.5)
      this.#damageWing(Math.random() < 0.5 ? "left" : "right", WING_VERTICAL_HIT);
    // Knockback 0.4 m away from the source, in the ship's right/up plane.
    this.#knock.set(-side, -vertical);
    if (this.#knock.lengthSq() > 0) this.#knock.normalize().multiplyScalar(KNOCKBACK);
    const w = this.#w;
    w?.cameraRig.shake(Math.min(1, 0.4 + damage / 60));
    w?.sfx("hit");
  }

  #damageWing(side: "left" | "right", amount: number): void {
    const before = this.wings[side];
    this.wings[side] = Math.max(0, before - amount);
    if (before > 0 && this.wings[side] === 0) this.#w?.weapons.resetLaser();
  }

  #drain(dt: number): void {
    const step = DRAIN_RATE * dt;
    if (this.#pendingDamage > 0) {
      const d = Math.min(this.#pendingDamage, step);
      this.#pendingDamage -= d;
      this.shield = Math.max(0, this.shield - d);
      if (this.shield === 0) this.alive = false;
    }
    if (this.#pendingHeal > 0 && this.alive) {
      const h = Math.min(this.#pendingHeal, step);
      this.#pendingHeal -= h;
      this.shield = Math.min(this.shieldMax, this.shield + h);
    }
  }

  #updateDamage(w: World, dt: number): void {
    this.#drain(dt);
    for (const [i, level] of WARNINGS.entries()) {
      if (this.shield < level && !this.#warned[i]) {
        this.#warned[i] = true;
        w.sfx("alarm");
      } else if (this.shield >= level) this.#warned[i] = false;
    }
    if (this.invulnerable) {
      this.#invulnTimer -= dt;
      if (this.#invulnTimer <= 0) this.invulnerable = false;
    } else if (
      this.position.y - w.stage.groundHeight(this.position.x, this.position.z) <
      SCRAPE_HEIGHT
    ) {
      // terrain-collision: a scrape costs 21; no scenery test while invulnerable.
      this.takeHit(SCRAPE_DAMAGE, _hit.copy(this.position).addScaledVector(AXIS_Y, -1));
      if (this.mode === "arena") this.#pitch = Math.max(this.#pitch, 15 * D2R);
    }
  }

  /**
   * Scenery contact, as sf64 does it (fox_play.c:1722, cards terrain-collision and shield-damage):
   * no push-out and no solid walls. A touch while the mercy window is closed costs a hit; `takeHit`
   * applies the 0.4 m knockback, picks the wing and opens the 0.67 s window that skips these tests.
   */
  #collide(w: World): void {
    if (this.invulnerable) return;
    for (const o of w.stage.obstacles) {
      if (this.position.distanceTo(o.center) >= o.radius + HULL_R) continue;
      this.takeHit(OBSTACLE_DAMAGE, o.center);
      w.fx.spark(_d.copy(this.position).sub(o.center).setLength(o.radius).add(o.center));
      return;
    }
  }

  heal(points: number): void {
    this.#pendingHeal += points;
  }

  /** Gold ring: called once per ring; the third raises the shield cap to 383. */
  addGoldRing(): void {
    this.goldRings += 1;
    if (this.goldRings >= GOLD_RINGS_FOR_CAP) this.shieldMax = GOLD_CAP;
  }

  repairWings(): void {
    this.wings.left = WING_MAX;
    this.wings.right = WING_MAX;
  }

  enterArena(center: Vector3, radius: number): void {
    this.mode = "arena";
    this.#arenaCenter.copy(center);
    this.#arenaRadius = radius;
    this.#yaw = Math.atan2(this.forward.x, -this.forward.z);
    this.#pitch = Math.asin(MathUtils.clamp(this.forward.y, -1, 1));
    this.#loop = 0;
    this.offset.set(0, 0);
  }

  // ---------------------------------------------------------------------------------- autopilot

  /** Test-only: aim at the nearest live target ahead, dodge obstacles, circle the boss in the arena. */
  #autopilot(w: World): void {
    const out = this.#autoStick.set(0, 0);
    this.#autoBoost = false;
    let best: { position: Vector3 } | undefined;
    let bestDist = Infinity;
    for (const target of w.enemies.targets) {
      if (!target.alive) continue;
      _tmp.copy(target.position).sub(this.position);
      const ahead = _tmp.dot(this.mode === "rail" ? this.#railForward() : this.forward);
      const dist = _tmp.length();
      if (ahead > 0 && dist < bestDist && (this.mode === "arena" || dist < 400)) {
        best = target;
        bestDist = dist;
      }
    }
    if (this.mode === "rail") {
      const f = this.#frame;
      out.x = -this.offset.x * 0.12;
      out.y = -this.offset.y * 0.12;
      if (best !== undefined) {
        _tmp.copy(best.position).sub(this.position);
        const dz = _tmp.dot(f.forward);
        out.x = Math.atan2(_tmp.dot(f.right), dz) / YAW_MAX;
        out.y = Math.atan2(_tmp.dot(f.up), dz) / YAW_MAX;
      }
      for (const o of w.stage.obstacles) {
        _tmp.copy(o.center).sub(this.position);
        const ahead = _tmp.dot(f.forward);
        if (ahead < 0 || ahead > 90) continue;
        const lateral = _tmp.dot(f.right);
        const height = _tmp.dot(f.up);
        if (Math.hypot(lateral, height) < o.radius + 4) {
          out.x += (lateral >= 0 ? -1 : 1) * 1.5;
          out.y += (height >= 0 ? -1 : 1) * 0.5;
        }
      }
      return;
    }
    // Arena: pursue a point 70 m to the side of the target, which circles it.
    if (best === undefined) {
      _tmp.copy(this.#arenaCenter).sub(this.position).setY(0);
      out.x = this.#headingError(_tmp) * 2;
      return;
    }
    _tmp.copy(best.position).sub(this.position);
    _hit.set(-_tmp.z, 0, _tmp.x).setLength(70);
    _tmp.add(_hit);
    out.x = MathUtils.clamp(this.#headingError(_tmp) * 2, -1, 1);
    const horizontal = Math.hypot(_tmp.x, _tmp.z);
    out.y = MathUtils.clamp((Math.atan2(_tmp.y, horizontal) - this.#pitch) * 2, -1, 1);
  }

  #railForward(): Vector3 {
    return this.#frame.forward;
  }

  /** Signed yaw (radians, +right) from the nose to a world direction's horizontal part. */
  #headingError(dir: Vector3): number {
    const want = Math.atan2(dir.x, -dir.z);
    return MathUtils.euclideanModulo(want - this.#yaw + Math.PI, Math.PI * 2) - Math.PI;
  }

  // ---------------------------------------------------------------------------------- debug

  /** Hull bank in radians (shoulder + stick + wing bias, barrel roll excluded), +right wing down. */
  /** Stick the airframe flies after inertia: x right, y up, each -1..1 (keyboard, gamepad, mouse aim). */
  get stick(): Readonly<Vector2> {
    return this.#flown;
  }

  get bankRadians(): number {
    return this.#shoulder + this.#stickRoll + this.#wingBank;
  }

  /** Arena yaw in radians, +right. Unlike `heading` it does not flip mid-loop during a U-turn. */
  get yawRadians(): number {
    return this.#yaw;
  }

  get heading(): number {
    return MathUtils.euclideanModulo(Math.atan2(this.forward.x, -this.forward.z) / D2R, 360);
  }

  debug(): Record<string, unknown> {
    return {
      mode: this.mode,
      position: this.position.toArray(),
      offsetX: this.offset.x,
      offsetY: this.offset.y,
      speed: this.speed,
      pace:
        this.speed > CRUISE_SPEED + 1
          ? "boost"
          : this.speed < CRUISE_SPEED - 1
            ? "brake"
            : "cruise",
      boost: this.boost,
      boostLatched: this.boostLatched,
      bank: this.bankRadians / D2R,
      rollAngle: this.#barrelAngle / D2R,
      rolling: this.rolling,
      rolls: this.rolls,
      loops: this.loops,
      uturns: this.uturns,
      heading: this.heading,
      arenaDistance:
        this.mode === "arena"
          ? _tmp.copy(this.position).sub(this.#arenaCenter).setY(0).length()
          : 0,
      edgeWarning: this.edgeWarning,
      shield: this.shield,
      shieldMax: this.shieldMax,
      wingsLeft: this.wings.left,
      wingsRight: this.wings.right,
      alive: this.alive,
      invulnerable: this.invulnerable,
    };
  }
}

// ---------------------------------------------------------------------------------- effects

const FX_TILT = new Vector3();
interface IParticle {
  readonly mesh: Mesh;
  readonly velocity: Vector3;
  age: number;
  life: number;
  size: number;
}

/** A fixed ring of billboard quads: no allocation after construction, oldest slot recycled. */
class Pool {
  readonly items: IParticle[] = [];
  #next = 0;

  constructor(
    root: Group,
    count: number,
    geometry: PlaneGeometry,
    private readonly makeMaterial: () => MeshBasicMaterial,
    private readonly growth: number,
    private readonly gravity: number,
    private readonly fades: boolean,
  ) {
    for (let i = 0; i < count; i += 1) {
      const mesh = new Mesh(geometry, makeMaterial());
      mesh.visible = false;
      mesh.frustumCulled = false;
      root.add(mesh);
      this.items.push({ mesh, velocity: new Vector3(), age: 0, life: 0, size: 0 });
    }
  }

  emit(at: Vector3, vx: number, vy: number, vz: number, life: number, size: number): void {
    const p = this.items[this.#next]!;
    this.#next = (this.#next + 1) % this.items.length;
    p.mesh.position.copy(at);
    p.velocity.set(vx, vy, vz);
    p.age = 0;
    p.life = life;
    p.size = size;
    p.mesh.visible = true;
  }

  update(dt: number, camera: Quaternion): void {
    for (const p of this.items) {
      if (!p.mesh.visible) continue;
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        p.mesh.visible = false;
        continue;
      }
      p.velocity.y -= this.gravity * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.quaternion.copy(camera);
      // Additive streaks fade by shrinking; smoke keeps its size and fades by opacity.
      p.mesh.scale.setScalar(
        p.size * (this.fades ? 1 + (this.growth - 1) * t : (1 - t) * this.growth),
      );
      if (this.fades) (p.mesh.material as MeshBasicMaterial).opacity = 0.55 * (1 - t);
    }
  }
}

const RIBBON_POINTS = 26;
const RIBBON_HALF_WIDTH = 0.07;
/** Visible length of a contrail behind its wingtip, metres, whatever the speed. */
const RIBBON_LENGTH = 6.5;
/** Brightness at the head; additive, so this is the peak. */
const RIBBON_HEAD = 0.5;
const _dir = new Vector3();
const _side = new Vector3();
const _view = new Vector3();

/**
 * A camera-facing streak that follows a point: the last 26 fixed steps of a wingtip as one strip.
 * Writes into fixed typed arrays; once the source stops feeding it, the streak fades out.
 */
class Ribbon {
  readonly mesh: Mesh;
  readonly #points: Vector3[] = [];
  readonly #strength = new Float32Array(RIBBON_POINTS);
  readonly #positions = new Float32Array(RIBBON_POINTS * 2 * 3);
  readonly #colors = new Float32Array(RIBBON_POINTS * 2 * 3);
  readonly #geometry = new BufferGeometry();

  constructor(
    private readonly tint: Color,
    initial: Vector3,
  ) {
    for (let i = 0; i < RIBBON_POINTS; i += 1) this.#points.push(initial.clone());
    const index: number[] = [];
    for (let i = 0; i < RIBBON_POINTS - 1; i += 1) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.#geometry.setIndex(index);
    this.#geometry.setAttribute(
      "position",
      new BufferAttribute(this.#positions, 3).setUsage(35048),
    );
    this.#geometry.setAttribute("color", new BufferAttribute(this.#colors, 3).setUsage(35048));
    this.mesh = new Mesh(
      this.#geometry,
      new MeshBasicMaterial({
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
        transparent: true,
        vertexColors: true,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  update(head: Vector3, feeding: boolean, camera: Vector3): void {
    for (let i = RIBBON_POINTS - 1; i > 0; i -= 1) {
      this.#points[i]!.copy(this.#points[i - 1]!);
      this.#strength[i] = this.#strength[i - 1]!;
    }
    this.#points[0]!.copy(head);
    this.#strength[0] = feeding ? 1 : 0;
    let any = false;
    let along = 0;
    for (let i = 0; i < RIBBON_POINTS; i += 1) {
      const p = this.#points[i]!;
      const next = this.#points[Math.min(i + 1, RIBBON_POINTS - 1)]!;
      const prev = this.#points[Math.max(i - 1, 0)]!;
      _dir.copy(prev).sub(next);
      _side.copy(_view.copy(p).sub(camera)).cross(_dir);
      if (i > 0) along += p.distanceTo(prev);
      // Cut by distance, not by tick: width tapers to 0 and light fades on a curve over 6.5 m.
      const taper = Math.max(0, 1 - along / RIBBON_LENGTH);
      if (_side.lengthSq() > 1e-8) _side.normalize().multiplyScalar(RIBBON_HALF_WIDTH * taper);
      const fade = this.#strength[i]! * RIBBON_HEAD * taper ** 2;
      if (fade > 0.01) any = true;
      const o = i * 6;
      this.#positions[o] = p.x + _side.x;
      this.#positions[o + 1] = p.y + _side.y;
      this.#positions[o + 2] = p.z + _side.z;
      this.#positions[o + 3] = p.x - _side.x;
      this.#positions[o + 4] = p.y - _side.y;
      this.#positions[o + 5] = p.z - _side.z;
      for (const k of [0, 3]) {
        this.#colors[o + k] = this.tint.r * fade;
        this.#colors[o + k + 1] = this.tint.g * fade;
        this.#colors[o + k + 2] = this.tint.b * fade;
      }
    }
    this.mesh.visible = any;
    if (any) {
      (this.#geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
      (this.#geometry.getAttribute("color") as BufferAttribute).needsUpdate = true;
    }
  }
}

/**
 * Ship effects. Engine exhaust: two violet outer and cyan inner additive cones on the rear
 * thrusters, flickering, long and bright under boost, short and dim under brake. Contrails: soft
 * streaks off both wingtips during a roll, loop, U-turn or boost. A damaged wing trails smoke, and
 * a broken one throws sparks. All `toneMapped: false`; none use a render hook.
 */
class ShipFx {
  readonly root = new Group();
  readonly #cones: { outer: Mesh; inner: Mesh }[] = [];
  readonly #ribbons: Ribbon[] = [];
  readonly #eye = new Vector3();
  readonly #smoke: Pool;
  readonly #sparks: Pool;
  readonly #tmp = new Vector3();
  #t = 0;
  #smokeClock = 0;
  #sparkClock = 0;
  #seed = 12345;

  constructor(
    private readonly hull: Group,
    private readonly anchors: { engines: Vector3[]; wingtips: Vector3[]; wings: Vector3[] },
  ) {
    const glow = softCircleDataTexture(32, 0.15);
    const quad = new PlaneGeometry(1, 1);
    const additive =
      (r: number, g: number, b: number): (() => MeshBasicMaterial) =>
      () =>
        new MeshBasicMaterial({
          blending: AdditiveBlending,
          color: new Color(r, g, b),
          depthWrite: false,
          map: glow,
          toneMapped: false,
          transparent: true,
        });
    // Cone axis: base at the thruster, apex 1 m behind (+Z is aft in hull space).
    const cone = new ConeGeometry(1, 1, 14, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    const coneMaterial = (r: number, g: number, b: number): MeshBasicMaterial =>
      new MeshBasicMaterial({
        blending: AdditiveBlending,
        color: new Color(r, g, b),
        depthWrite: false,
        side: DoubleSide,
        toneMapped: false,
        transparent: true,
      });
    for (const at of anchors.engines) {
      const outer = new Mesh(cone, coneMaterial(0.45, 0.3, 1.6)); // violet-cyan, #7a5cd6 family
      const inner = new Mesh(cone, coneMaterial(0.4, 1.5, 2.2)); // cyan ion #1fd9ff family
      for (const m of [outer, inner]) {
        m.position.copy(at);
        m.frustumCulled = false;
        hull.add(m);
      }
      this.#cones.push({ outer, inner });
    }
    for (const tip of anchors.wingtips) {
      const ribbon = new Ribbon(new Color(0.5, 1.5, 2.2), hull.localToWorld(tip.clone()));
      this.root.add(ribbon.mesh);
      this.#ribbons.push(ribbon);
    }
    this.#smoke = new Pool(
      this.root,
      16,
      quad,
      () =>
        new MeshBasicMaterial({
          color: new Color(0.12, 0.1, 0.14),
          depthWrite: false,
          map: glow,
          toneMapped: false,
          transparent: true,
        }),
      4,
      -1.6,
      true,
    );
    this.#sparks = new Pool(this.root, 20, quad, additive(2.4, 1.0, 0.25), 1, 9, false);
  }

  #rand(): number {
    this.#seed = (Math.imul(this.#seed, 1664525) + 1013904223) >>> 0;
    return this.#seed / 4294967296;
  }

  update(
    dt: number,
    camera: Quaternion,
    eye: Vector3,
    pace: number,
    trailing: boolean,
    left: number,
    right: number,
    wingMax: number,
  ): void {
    this.#t += dt;
    // Exhaust: pace is -1 (full brake) .. +1 (full boost).
    const boost = Math.max(0, pace);
    const length = pace >= 0 ? 1.1 + 2.6 * boost : 1.1 + 0.7 * pace;
    const bright = pace >= 0 ? 0.65 + 0.35 * boost : 0.3 + 0.35 * (1 + pace);
    for (const [i, { outer, inner }] of this.#cones.entries()) {
      const flicker =
        1 + 0.14 * Math.sin(this.#t * 71 + i * 2.1) + 0.07 * Math.sin(this.#t * 133 + i);
      const girth = 1 + 0.3 * boost;
      outer.scale.set(0.15 * girth, 0.15 * girth, length * flicker);
      inner.scale.set(0.06 * girth, 0.06 * girth, length * 0.7 * flicker);
      (outer.material as MeshBasicMaterial).opacity = 0.5 * bright;
      (inner.material as MeshBasicMaterial).opacity = bright;
    }
    // Contrails: one streak per wingtip, fed while rolling, looping, turning or boosting.
    for (const [i, tip] of this.anchors.wingtips.entries()) {
      this.hull.localToWorld(this.#tmp.copy(tip));
      this.#ribbons[i]!.update(this.#tmp, trailing, this.#eye.copy(eye));
    }
    // Damage: any lost wing points smoke, a broken wing throws sparks as well.
    this.#smokeClock += dt;
    this.#sparkClock += dt;
    const hp = [left, right];
    for (const [i, wing] of this.anchors.wings.entries()) {
      const points = hp[i]!;
      if (points >= wingMax) continue;
      const broken = points <= 0;
      if (this.#smokeClock >= (broken ? 1 / 26 : 1 / 10)) {
        this.hull.localToWorld(this.#tmp.copy(wing));
        this.#smoke.emit(
          this.#tmp,
          (this.#rand() - 0.5) * 0.6,
          1.2,
          (this.#rand() - 0.5) * 0.6,
          0.9,
          broken ? 0.9 : 0.6,
        );
      }
      if (broken && this.#sparkClock >= 1 / 14) {
        this.hull.localToWorld(this.#tmp.copy(wing));
        FX_TILT.set(this.#rand() - 0.5, this.#rand() * 0.6, this.#rand() - 0.5).multiplyScalar(5);
        this.#sparks.emit(this.#tmp, FX_TILT.x, FX_TILT.y, FX_TILT.z, 0.4, 0.14);
      }
    }
    if (this.#smokeClock >= 1 / 26) this.#smokeClock = 0;
    if (this.#sparkClock >= 1 / 14) this.#sparkClock = 0;
    this.#smoke.update(dt, camera);
    this.#sparks.update(dt, camera);
  }
}
