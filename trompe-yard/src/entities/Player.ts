import { type ICtx, SkeletalMesh3D } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { type AnimationClip, Group, MathUtils, type Object3D } from "three";
import { type IMinimalConventions, preparePlayerConventions } from "../conventions.js";
import type { ITouchInput } from "../render/touch-controls.js";
import type { GameState } from "../state.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.14;
const JUMP_SPEED = 5;
const MOVE_SPEED = 3;
/** Capsule for a 1.8 m figure: 0.6 m half-height plus a 0.3 m radius at each end. */
const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
const SPAWN = { x: -2, y: HALF_HEIGHT + RADIUS + 0.05, z: 0 } as const;

/** The clips `assets/mannequin.glb` ships, by the name this file plays them under. */
const CLIPS = {
  idle: "Idle_Loop",
  jog: "Jog_Fwd_Loop",
  jumpStart: "Jump_Start",
  jumpLoop: "Jump_Loop",
  jumpLand: "Jump_Land",
} as const;

export interface IPlayerModel {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

export class Player {
  readonly mesh: Group;
  readonly body: CharacterBody3D;
  readonly character: SkeletalMesh3D;
  #conventions: IMinimalConventions;
  #coyoteTime = 0;
  #jumpBuffer = 0;
  #jumps = 0;
  #coyoteJumps = 0;
  #wasGrounded = true;
  #landing = 0;

  /**
   * `model` is the loaded `mannequin.glb` — Quaternius' Universal Animation Library mannequin
   * (CC0), recoloured and cut to the locomotion clips. Swap in any rigged glTF with the same clip
   * roles by editing `CLIPS`; `requiredClips` fails the load, by name, if one is missing.
   */
  constructor(ctx: GameCtx, model: IPlayerModel) {
    this.mesh = new Group();
    this.character = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      requiredClips: Object.values(CLIPS),
      strideRoot: this.mesh,
    });
    const figure = this.character.root;
    figure.traverse((object) => {
      object.castShadow = true;
    });
    // Feet at the bottom of the capsule, sunk one centimetre so a sole never floats on the floor.
    figure.position.y = -(HALF_HEIGHT + RADIUS) - 0.01;
    // The model faces +Z; start facing into the level, away from the camera.
    figure.rotation.y = Math.PI;
    this.mesh.add(figure);
    this.mesh.position.set(SPAWN.x, SPAWN.y, SPAWN.z);
    this.#conventions = preparePlayerConventions(figure);
    this.character.play(CLIPS.idle);
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  update(ctx: GameCtx, dt: number, touch?: ITouchInput): void {
    this.#coyoteTime = Math.max(0, this.#coyoteTime - dt);
    this.#jumpBuffer = Math.max(0, this.#jumpBuffer - dt);
    if (this.body.grounded) this.#coyoteTime = COYOTE_TIME;
    if (ctx.input.justPressed("jump") || touch?.jumpPressed === true)
      this.#jumpBuffer = JUMP_BUFFER;
    let jumped = false;
    if (this.#jumpBuffer > 0 && this.#coyoteTime > 0) {
      this.body.velocity.y = JUMP_SPEED;
      this.#jumpBuffer = 0;
      this.#coyoteTime = 0;
      this.#jumps += 1;
      this.#coyoteJumps += 1;
      jumped = true;
    }
    const move = ctx.input.vector("move");
    if (touch !== undefined) {
      move.x += touch.move.x;
      move.y += touch.move.y;
      move.clampLength(0, 1);
    }
    this.body.velocity.x = move.x * MOVE_SPEED;
    this.body.velocity.z = -move.y * MOVE_SPEED;
    this.body.moveAndSlide(dt);
    this.#conventions.applyGrounding(0, dt);
    this.#animate(dt, move.length(), jumped);
  }

  /** Faces the direction of travel and picks a clip from what the body is actually doing. */
  #animate(dt: number, speed: number, jumped: boolean): void {
    const figure = this.character.root;
    if (speed > 0.05) {
      const heading = Math.atan2(this.body.velocity.x, this.body.velocity.z);
      const turn = MathUtils.euclideanModulo(heading - figure.rotation.y + Math.PI, Math.PI * 2);
      figure.rotation.y += (turn - Math.PI) * Math.min(1, dt * 12);
    }
    const grounded = this.body.grounded;
    this.#landing -= dt;
    if (jumped) this.character.play(CLIPS.jumpStart, { fade: 0.08, mode: "once" });
    else if (!grounded && this.character.finished)
      this.character.play(CLIPS.jumpLoop, { fade: 0.15 });
    else if (grounded && !this.#wasGrounded) {
      this.#landing = 0.25;
      this.character.play(CLIPS.jumpLand, { fade: 0.06, mode: "once" });
    } else if (grounded && this.#landing <= 0)
      this.character.play(speed > 0.05 ? CLIPS.jog : CLIPS.idle, { fade: 0.2 });
    this.#wasGrounded = grounded;
    this.character.update(dt);
  }

  debug(): Record<string, unknown> {
    return {
      coyoteJumps: this.#coyoteJumps,
      grounded: this.body.grounded,
      groundClearance: this.#conventions.groundSnap.clearance,
      groundCorrectionEnabled: this.#conventions.groundSnap.enabled,
      jumps: this.#jumps,
      normaliseFactor: this.#conventions.normaliseFactor,
      position: this.mesh.position.toArray(),
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
