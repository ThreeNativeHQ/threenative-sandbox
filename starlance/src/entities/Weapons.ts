import type { GameCtx, ITarget, World } from "../world.js";

/**
 * Player weapons. STUB from the coordinator: the weapons lane fills lasers, charge/lock/homing and
 * bombs. Public fields are the contract the HUD, items and the ship read.
 */
export class Weapons {
  /** 0 single, 1 twin, 2 hyper. */
  laserLevel = 0;
  bombs = 3;
  /** Charge 0..1 while fire is held. */
  charge = 0;
  lockedTarget: ITarget | null = null;
  shotsFired = 0;

  constructor(readonly ctx: GameCtx) {}

  update(_w: World, _dt: number): void {}

  upgradeLaser(): void {
    this.laserLevel = Math.min(2, this.laserLevel + 1);
  }

  addBomb(): void {
    this.bombs = Math.min(9, this.bombs + 1);
  }

  /** A broken wing drops the laser back to single. */
  resetLaser(): void {
    this.laserLevel = 0;
  }

  debug(): Record<string, unknown> {
    return {
      laserLevel: this.laserLevel,
      bombs: this.bombs,
      charge: this.charge,
      locked: this.lockedTarget !== null,
      shotsFired: this.shotsFired,
    };
  }
}
