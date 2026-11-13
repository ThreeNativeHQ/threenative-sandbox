import { type Group, Vector3 } from "three";
import { C } from "../render/palette.js";
import { coin, gem, star } from "../render/pickups.js";

export type PickupKind = "coin" | "gem" | "star";

/** How close the fox's centre has to come, in metres, for each kind to count as taken. */
const REACH: Record<PickupKind, number> = { coin: 1.15, gem: 1.4, star: 1.6 };

/**
 * One collectible: spins, bobs, and reports the moment the fox is close enough to take it.
 *
 * `home` is where it sits; the bob is measured from it, so a pickup taken mid-bob does not drag
 * the next frame's position with it. Nothing here allocates — the scene steps ninety of these a
 * frame and a Vector3 per pickup per frame is ninety of them a frame.
 */
export class Pickup {
  readonly mesh: Group;
  readonly kind: PickupKind;
  taken = false;
  readonly #home: Vector3;

  constructor(kind: PickupKind, x: number, y: number, z: number) {
    this.kind = kind;
    this.mesh = kind === "coin" ? coin() : kind === "gem" ? gem() : star();
    this.mesh.position.set(x, y, z);
    // A copy, not the live position: measuring the bob against the position it is writing is a
    // random walk, and a coin that drifts a metre up its own arc is a coin the fox cannot collect.
    this.#home = new Vector3(x, y, z);
  }

  /** The colour a pickup bursts in. */
  get burstColor(): number {
    return this.kind === "coin" ? C.gold : this.kind === "gem" ? C.gem : C.gold;
  }

  get reach(): number {
    return REACH[this.kind];
  }

  update(dt: number, time: number): void {
    if (this.taken) return;
    if (this.kind === "coin") this.mesh.rotation.y += dt * 3.2;
    else if (this.kind === "gem") {
      this.mesh.rotation.y += dt * 1.8;
      this.mesh.rotation.x = Math.sin(time * 2) * 0.2;
    } else this.mesh.rotation.y += dt * 1.4;
    this.mesh.position.y = this.#home.y + Math.sin(time * 2.4 + this.#home.x) * 0.14;
  }

  take(): void {
    this.taken = true;
    this.mesh.removeFromParent();
  }
}
