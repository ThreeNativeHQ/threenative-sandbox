import type { GameCtx, ITarget, World } from "../world.js";

/**
 * Everything hostile or collectable on the course: fighter waves, turrets, enemy shots, items,
 * rings, obstacle and ground hits, and the boss. STUB from the coordinator; the enemies lane fills it.
 */
export class Enemies {
  /** Live, hittable targets. Weapons read this list every tick. */
  readonly targets: ITarget[] = [];
  kills = 0;
  bossDefeated = false;

  constructor(readonly ctx: GameCtx) {}

  update(_w: World, _dt: number): void {}

  debug(): Record<string, unknown> {
    return { alive: this.targets.length, kills: this.kills, bossDefeated: this.bossDefeated };
  }
}
