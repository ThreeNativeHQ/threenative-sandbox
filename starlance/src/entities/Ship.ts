import { Box3, Group, MathUtils, Matrix4, type Object3D, Vector2, Vector3 } from "three";
import { normaliseToMetres } from "@threenative/core";
import { railFrame } from "./Rail.js";
import type { World } from "../world.js";

/** Cruise speed along the course, m/s (game-owned; no card). */
export const CRUISE_SPEED = 30;
/** Corridor half extents around the path, metres (rails-path-progress, fox_play.c:4468-4470). */
export const CORRIDOR = { halfWidth: 14, headroom: 13.6, floorOverGround: 0.8 } as const;
export const SHIELD_START = 255;

const _basis = new Matrix4();
const _back = new Vector3();

/**
 * The player starfighter. STUB from the coordinator: flies the offset with the stick, no feel
 * rules yet. The flight lane replaces the body of `update` and the damage methods; the public
 * fields below are the contract other lanes read.
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
  readonly wings = { left: 60, right: 60 };
  alive = true;
  readonly #frame = railFrame();

  constructor(model: Object3D) {
    // starfighter.glb: nose on +Z, 15.2-unit wingspan on X (checked in a capture). Turn the nose to -Z,
    // centre it, and scale it to 4 m.
    model.rotation.y = Math.PI;
    normaliseToMetres(model, { axis: "longest", metres: 4 });
    model.updateMatrixWorld(true);
    const centre = new Box3().setFromObject(model).getCenter(new Vector3());
    model.position.sub(centre);
    model.traverse((object) => {
      object.castShadow = true;
    });
    this.mesh.add(model);
  }

  update(w: World, dt: number): void {
    const move = w.ctx.input.vector("move");
    if (this.mode === "rail") {
      this.offset.x = MathUtils.clamp(
        this.offset.x + move.x * 18 * dt,
        -CORRIDOR.halfWidth,
        CORRIDOR.halfWidth,
      );
      this.offset.y = MathUtils.clamp(this.offset.y + move.y * 18 * dt, -8, CORRIDOR.headroom);
      w.rail.s += this.speed * dt;
      const f = w.rail.frame(w.rail.s, this.#frame);
      this.position
        .copy(f.position)
        .addScaledVector(f.right, this.offset.x)
        .addScaledVector(f.up, this.offset.y);
      this.forward.copy(f.forward);
      this.right.copy(f.right);
      this.up.copy(f.up);
    } else {
      this.position.addScaledVector(this.forward, this.speed * dt);
    }
    _basis.makeBasis(this.right, this.up, _back.copy(this.forward).negate());
    this.mesh.quaternion.setFromRotationMatrix(_basis);
  }

  /** A hit of `damage` shield points from a world point `from`. Ignored while invulnerable. */
  takeHit(damage: number, _from: Vector3): void {
    if (this.invulnerable || !this.alive) return;
    this.shield = Math.max(0, this.shield - damage);
    if (this.shield === 0) this.alive = false;
  }

  heal(points: number): void {
    this.shield = Math.min(this.shieldMax, this.shield + points);
  }

  /** Gold ring: called once per ring; the flight lane applies the cap rule. */
  addGoldRing(): void {}

  repairWings(): void {
    this.wings.left = 60;
    this.wings.right = 60;
  }

  enterArena(_center: Vector3, _radius: number): void {
    this.mode = "arena";
  }

  debug(): Record<string, unknown> {
    return {
      mode: this.mode,
      position: this.position.toArray(),
      offsetX: this.offset.x,
      offsetY: this.offset.y,
      speed: this.speed,
      shield: this.shield,
      alive: this.alive,
    };
  }
}
