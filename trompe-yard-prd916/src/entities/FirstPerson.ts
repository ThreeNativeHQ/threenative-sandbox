import type { ICtx } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Group, MathUtils, type PerspectiveCamera } from "three";
import type { GameState } from "../state.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

// Same look feel and pitch range as the shooter kit's FpsPlayer.
const LOOK_SENSITIVITY = 0.0022;
const PITCH_MIN = MathUtils.degToRad(-66);
const PITCH_MAX = MathUtils.degToRad(72);
const WALK_SPEED = 3.2;
const SPRINT_SPEED = 6;
const JUMP_SPEED = 4.5;
/** Capsule for a 1.8 m person; the eye sits 1.65 m above the feet. */
const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
const EYE_ABOVE_CENTRE = 1.65 - (HALF_HEIGHT + RADIUS);

/**
 * Walk the level in first person: click to capture the mouse, WASD to move, Shift to sprint,
 * Space to jump. The camera is the eye, placed after physics so it never trails the body.
 */
export class FirstPerson {
  readonly mesh = new Group();
  readonly body: CharacterBody3D;
  yaw = 0;
  pitch = 0;
  #jumps = 0;

  constructor(ctx: GameCtx, spawn: { x: number; y: number; z: number }, yaw = 0) {
    this.yaw = yaw;
    this.mesh.position.set(spawn.x, spawn.y, spawn.z);
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  update(ctx: GameCtx, dt: number): void {
    const look = ctx.input.vector("look");
    this.yaw -= look.x * LOOK_SENSITIVITY;
    this.pitch = MathUtils.clamp(this.pitch - look.y * LOOK_SENSITIVITY, PITCH_MIN, PITCH_MAX);
    const move = ctx.input.vector("move");
    const speed = ctx.input.pressed("sprint") ? SPRINT_SPEED : WALK_SPEED;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    // forward is -Z at yaw 0; right is +X
    this.body.velocity.x = (-sin * move.y + cos * move.x) * speed;
    this.body.velocity.z = (-cos * move.y - sin * move.x) * speed;
    if (this.body.grounded && ctx.input.justPressed("jump")) {
      this.body.velocity.y = JUMP_SPEED;
      this.#jumps += 1;
    }
    this.body.moveAndSlide(dt);
  }

  /** Call after physics has stepped, so the eye uses the solved position. */
  placeCamera(camera: PerspectiveCamera): void {
    camera.position.set(
      this.mesh.position.x,
      this.mesh.position.y + EYE_ABOVE_CENTRE,
      this.mesh.position.z,
    );
    camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  debug(): Record<string, unknown> {
    return {
      grounded: this.body.grounded,
      jumps: this.#jumps,
      position: this.mesh.position.toArray(),
      yaw: this.yaw,
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
