import type { Vector3 } from "three";
import type { GameCtx } from "../world.js";

export interface IFx {
  /** An explosion of `size` metres (fighter ~3, boss part ~8). */
  explode(at: Vector3, size: number): void;
  /** A small spark burst: shield hit, deflected shot, ground scrape. */
  spark(at: Vector3): void;
  update(dt: number): void;
  dispose(): void;
}

/** Particle effects. STUB from the coordinator; the look lane builds them on GPUParticles3D. */
export function createFx(_ctx: GameCtx): IFx {
  return { explode() {}, spark() {}, update() {}, dispose() {} };
}
