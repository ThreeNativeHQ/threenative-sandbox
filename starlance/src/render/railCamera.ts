import { CameraShake } from "@threenative/core";
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import { railFrame } from "../entities/Rail.js";
import { CRUISE_SPEED } from "../entities/Ship.js";
import type { World } from "../world.js";

// camera-rails (fox_play.c:6080-6137)
const SETBACK = 10.5;
const OFFSET_SHARE = 0.78;
const ROLL_SHARE = 0.3;
// camera-all-range (fox_play.c:6277-6330)
const ARENA_SETBACK = 8;
const YAW_LEAD = 2;
const ARENA_ROLL_SHARE = 0.3;
// Game-owned framing: eye above the hull, look point above it too, so the ship sits low-middle.
const EYE_HEIGHT = 0.5;
const LOOK_HEIGHT = -5;
const LOOK_AHEAD = 30;
const BOOST_PULL_BACK = 4; // boost-camera: pulls back
const BRAKE_PULL_IN = 2.5; // brake-camera: pulls in
const DISTANCE_SMOOTH = 0.1; // per 30 Hz update
// Cockpit view: the eye in hull space (nose -Z), where the pilot sits.
const COCKPIT_EYE = new Vector3(0, 0.35, -0.6);
const CHASE_FOV = 60;
// Cockpit lens: 12% tighter than the source scene's 27 mm (41 deg tall at 16:9), so the canopy and
// the upper screens fill the frame and the lower screens sit on its bottom edge. Wider screens keep
// the shell's width, not its height, so no edge ever looks past the modelled walls.
const COCKPIT_FOV = 36.5;
const COCKPIT_MAX_HFOV = 90; // deg; the canopy plate in the glb closes everything past the arch
const CHASE_NEAR = 0.1;
const COCKPIT_NEAR = 0.02; // the cockpit is a 0.9 m bubble

const _eye = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
const _frame = railFrame();

/**
 * Chase camera for rail and all-range flight. Rail: the eye sits 8 m behind and follows the ship's
 * offset x0.78, so the ship drifts off-centre toward the corridor edge instead of staying glued.
 * Arena: the eye trails the heading and the look target leads the turn. `shake` goes through core's
 * `CameraShake`, which returns an offset and never writes the camera.
 */
export class RailCamera {
  readonly #shake = new CameraShake({
    amplitude: new Vector3(0.35, 0.35, 0.15),
    rotationAmplitude: new Vector3(0.02, 0.02, 0.03),
    frequency: 16,
    decay: 6,
    curve: Math.sin,
  });
  #setback = SETBACK;
  #camYaw: number | undefined;
  /** True while the camera sits at the pilot's eye (`cockpit` input toggles it). */
  cockpit = false;
  /** Set once `cockpit.glb` has loaded; `C` does nothing before that. */
  cockpitReady = false;
  /** Numbers the cockpit writes each frame (control travel, minimap contacts) for `debug()`. */
  readonly cockpitState: Record<string, number | boolean> = {
    yokeRoll: 0,
    yokeRollDeg: 0,
    yokePitchDeg: 0,
    throttle: 0,
    pedalBoost: 0,
    pedalBrake: 0,
    triggerFire: 0,
    triggerCharge: 0,
    lampsLit: 0,
    mapContacts: 0,
    yokeRight: false,
    yokeBack: false,
    yokeLeansRight: false,
    yokeLeansLeft: false,
    yokePulledBack: false,
    yokePushedIn: false,
    throttleForward: false,
    pedalDown: false,
    triggerFired: false,
    charging: false,
    mapHasContacts: false,
  };

  constructor(readonly camera: PerspectiveCamera) {
    camera.fov = CHASE_FOV;
    camera.near = 0.1;
    camera.far = 20_000;
    camera.updateProjectionMatrix();
  }

  update(w: World, dt: number): void {
    const ship = w.ship;
    if (this.cockpitReady && w.ctx.input.justPressed("cockpit")) this.cockpit = !this.cockpit;
    if (!ship.alive) this.cockpit = false; // the wreck is worth watching from outside
    let fov = CHASE_FOV;
    if (this.cockpit) {
      const reach = Math.tan(MathUtils.degToRad(COCKPIT_MAX_HFOV / 2)) / this.camera.aspect;
      fov = Math.min(COCKPIT_FOV, MathUtils.radToDeg(2 * Math.atan(reach)));
    }
    const near = this.cockpit ? COCKPIT_NEAR : CHASE_NEAR;
    if (this.camera.fov !== fov || this.camera.near !== near) {
      this.camera.fov = fov;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    if (this.cockpit) {
      // Rides the hull: its quaternion already carries yaw, pitch, roll, loops and the barrel roll.
      this.camera.position
        .copy(COCKPIT_EYE)
        .applyQuaternion(ship.mesh.quaternion)
        .add(ship.position);
      this.camera.quaternion.copy(ship.mesh.quaternion);
      this.#camYaw = undefined;
      this.#applyShake(dt);
      return;
    }
    const k = 1 - (1 - DISTANCE_SMOOTH) ** (30 * dt);
    let roll: number;
    if (ship.mode === "rail") {
      // Boost pulls the camera back, brake pulls it in, both smoothed.
      const pull =
        ship.speed >= CRUISE_SPEED
          ? ((ship.speed - CRUISE_SPEED) / 18) * BOOST_PULL_BACK
          : ((ship.speed - CRUISE_SPEED) / 12) * BRAKE_PULL_IN;
      this.#setback += (SETBACK + pull - this.#setback) * k;
      const f = w.rail.frame(w.rail.s, _frame);
      const ox = ship.offset.x * OFFSET_SHARE;
      const oy = ship.offset.y * OFFSET_SHARE;
      _eye
        .copy(f.position)
        .addScaledVector(f.right, ox)
        .addScaledVector(f.up, oy + EYE_HEIGHT)
        .addScaledVector(f.forward, -this.#setback);
      _aim
        .copy(f.position)
        .addScaledVector(f.right, ox)
        .addScaledVector(f.up, oy + LOOK_HEIGHT)
        .addScaledVector(f.forward, LOOK_AHEAD);
      roll = ship.bankRadians * ROLL_SHARE;
      this.#camYaw = undefined;
    } else {
      this.#setback += (ARENA_SETBACK - this.#setback) * k;
      const heading = ship.yawRadians;
      this.#camYaw ??= heading;
      const lag =
        MathUtils.euclideanModulo(heading - this.#camYaw + Math.PI, Math.PI * 2) - Math.PI;
      this.#camYaw += lag * k;
      _dir.set(Math.sin(this.#camYaw), 0, -Math.cos(this.#camYaw));
      _eye
        .copy(ship.position)
        .addScaledVector(_dir, -ARENA_SETBACK)
        .addScaledVector(AXIS_UP, EYE_HEIGHT);
      // The look target leads the turn: heading + 2x the lag between nose and camera.
      const lead = this.#camYaw + lag * (1 + YAW_LEAD);
      _aim
        .copy(ship.position)
        .add(_dir.set(Math.sin(lead), 0, -Math.cos(lead)).multiplyScalar(LOOK_AHEAD))
        .setY(
          ship.position.y + LOOK_HEIGHT + MathUtils.clamp(ship.forward.y, -0.3, 0.3) * LOOK_AHEAD,
        );
      roll = lag * ARENA_ROLL_SHARE;
    }
    this.camera.position.copy(_eye);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(_aim);
    this.camera.rotateZ(-roll); // roll is positive banking right
    this.#applyShake(dt);
  }

  #applyShake(dt: number): void {
    if (this.#shake.active) {
      const offset = this.#shake.update(dt);
      this.camera.position.addScaledVector(AXIS_UP, offset.position.y);
      this.camera.translateX(offset.position.x);
      this.camera.rotateX(offset.rotation.x);
      this.camera.rotateY(offset.rotation.y);
      this.camera.rotateZ(offset.rotation.z);
    }
  }

  /** Adds a transient shake; strength 0..1. */
  shake(strength: number): void {
    const s = MathUtils.clamp(strength, 0, 1);
    this.#shake.amplitude.set(0.35, 0.35, 0.15).multiplyScalar(s);
    this.#shake.rotationAmplitude.set(0.02, 0.02, 0.03).multiplyScalar(s);
    this.#shake.trigger();
  }

  debug(): Record<string, unknown> {
    return {
      position: this.camera.position.toArray(),
      cockpit: this.cockpit,
      ...this.cockpitState,
      setback: this.#setback,
      shaking: this.#shake.active,
    };
  }
}

const AXIS_UP = new Vector3(0, 1, 0);
