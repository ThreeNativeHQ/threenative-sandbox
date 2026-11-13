import type { Vector3 } from "three";
import { FOX_FEEL } from "../entities/Fox.js";

type RespawnTarget = {
  body: { teleport(p: Vector3): void; velocity: { set(x: number, y: number, z: number): void } };
  mesh: { position: Vector3 };
};

/**
 * Hearts, the invulnerability window, and the ordered points a fall puts the fox back at.
 *
 * Three lives and a checkpoint per walkable stretch, which is the whole of the fox's failure
 * state: run out of hearts and the fox respawns at the last point it passed with a full set,
 * rather than the run ending. That is why this game has no lose screen, and why `hearts` reaching
 * zero is a transition rather than a terminal state.
 */
export class Checkpoints {
  readonly points: readonly Vector3[];
  readonly maxHearts: number;
  hearts: number;
  currentIndex = 0;
  respawns = 0;
  #invulnerable = 0;

  constructor(points: readonly Vector3[], maxHearts: number) {
    if (points.length === 0) throw new Error("Checkpoints requires at least one checkpoint.");
    if (!Number.isInteger(maxHearts) || maxHearts <= 0)
      throw new Error("Checkpoints requires a positive heart count.");
    this.points = points.map((point) => point.clone());
    this.maxHearts = maxHearts;
    this.hearts = maxHearts;
  }

  get invulnerable(): boolean {
    return this.#invulnerable > 0;
  }

  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) throw new Error("Checkpoints.update requires a valid dt.");
    this.#invulnerable = Math.max(0, this.#invulnerable - dt);
  }

  /** The fox blinks while invulnerable; the frame it is hidden on is the one it would read as a flicker. */
  blinks(time: number): boolean {
    return !this.invulnerable || Math.floor(time * FOX_FEEL.blinkRate) % 2 === 0;
  }

  pass(position: Vector3): void {
    while (this.currentIndex + 1 < this.points.length) {
      const next = this.points[this.currentIndex + 1];
      if (next === undefined || position.x < next.x) break;
      this.currentIndex += 1;
    }
  }

  hurt(target: RespawnTarget, fromX: number): boolean {
    if (this.#invulnerable > 0 || this.hearts <= 0) return false;
    this.hearts -= 1;
    this.#invulnerable = FOX_FEEL.invulnerabilityTime;
    // Knocked away from whatever hit it, and up, so a mushroom cannot chain into a second one.
    const away = Math.sign(target.mesh.position.x - fromX) || -1;
    target.body.velocity.set(away * FOX_FEEL.dashSpeed * 0.4, FOX_FEEL.jumpSpeed * 0.4, 0);
    return true;
  }

  respawn(target: RespawnTarget): void {
    const point = this.points[this.currentIndex];
    if (point === undefined) throw new Error(`Missing checkpoint ${this.currentIndex}.`);
    target.body.velocity.set(0, 0, 0);
    target.body.teleport(point);
    this.respawns += 1;
  }

  /** Out of hearts: the fox is put back with a full set, which is this game's only failure. */
  restore(): void {
    this.hearts = this.maxHearts;
    this.#invulnerable = FOX_FEEL.invulnerabilityTime;
  }
}
