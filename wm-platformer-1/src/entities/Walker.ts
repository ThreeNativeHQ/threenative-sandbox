import type { Group } from "three";
import { C } from "../render/palette.js";
import { mushroom, snail } from "../render/walkers.js";

export type WalkerKind = "mushroom" | "snail";

/**
 * The key `@threenative/playtest` sets on an entity a scenario placed with `frozen: true`.
 *
 * It is written here rather than imported because the marker belongs to the test harness, and game
 * code that imports from a devDependency stops building for a native target. Honouring it is what
 * makes a stomp scenario reproducible: a walker left free drifts 1-2 m between the placement and
 * the stomp, which is the whole difference between landing on it and missing it.
 */
const PLAYTEST_FROZEN = "__threenativeFrozen";

export interface IWalkerOptions {
  /** Where the patrol turns around, in world x. */
  readonly from: number;
  readonly to: number;
  readonly speed: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A stompable walker: a mushroom that hops, or a snail that glides, patrolling between two x
 * positions. Purely kinematic — it is scenery that can be hit, not a physics body, so a stomp
 * costs one distance test and no query.
 */
export class Walker {
  /** The registry object, so a scenario can place and address this walker by name. */
  readonly mesh: Group;
  readonly kind: WalkerKind;
  readonly tags = ["walker"];
  alive = true;
  #direction = 1;
  #squash = 0;
  readonly #from: number;
  readonly #to: number;
  readonly #options: IWalkerOptions;

  constructor(kind: WalkerKind, x: number, options: IWalkerOptions) {
    this.kind = kind;
    this.#from = options.from;
    this.#to = options.to;
    this.#options = options;
    this.mesh = kind === "mushroom" ? mushroom() : snail();
    this.mesh.position.set(x, options.y, options.z);
  }

  /** The colour a stomp bursts in: the cap red, or the shell red. */
  get burstColor(): number {
    return this.kind === "mushroom" ? C.capRed : C.shellRed;
  }

  get y(): number {
    return this.mesh.position.y;
  }

  update(dt: number, time: number): void {
    if (this.mesh.userData[PLAYTEST_FROZEN] === true) return;
    if (!this.alive) {
      // Flattened, then gone: the squash is the only feedback a stomp gets before the count moves.
      this.#squash += dt;
      const flat = Math.max(0.02, 1 - this.#squash * 3);
      this.mesh.scale.set(1 + this.#squash * 1.2, flat, 1 + this.#squash * 1.2);
      if (this.#squash > 0.4) this.mesh.removeFromParent();
      return;
    }
    this.mesh.position.x += this.#direction * this.#options.speed * dt;
    if (this.mesh.position.x > this.#to) this.#direction = -1;
    if (this.mesh.position.x < this.#from) this.#direction = 1;
    this.mesh.rotation.y = this.#direction > 0 ? 0 : Math.PI;
    if (this.kind === "mushroom") {
      const hop = Math.abs(Math.sin(time * 4 + this.#from));
      this.mesh.position.y = this.#options.y + hop * 0.28;
      this.mesh.scale.y = 1 - hop * 0.1;
    } else {
      this.mesh.position.y = this.#options.y + Math.sin(time * 2.5 + this.#from) * 0.04;
    }
  }

  kill(): void {
    this.alive = false;
    this.#squash = 0;
  }
}
