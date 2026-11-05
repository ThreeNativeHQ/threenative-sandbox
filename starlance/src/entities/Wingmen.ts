import type { Object3D, Vector3 } from "three";
import type { GameCtx, World } from "../world.js";

export interface IWingman {
  readonly position: Vector3;
  shield: number;
  alive: boolean;
  /** True while an enemy is tailing this wingman. */
  chased: boolean;
}

/** Two allied fighters in formation. STUB from the coordinator; the enemies lane fills it. */
export class Wingmen {
  readonly members: IWingman[] = [];

  /** `playerModel` is the loaded starfighter scene; clone it, never re-parent it. */
  constructor(
    readonly ctx: GameCtx,
    readonly playerModel: Object3D,
  ) {}

  update(_w: World, _dt: number): void {}

  debug(): Record<string, unknown> {
    return { alive: this.members.filter((m) => m.alive).length };
  }
}
