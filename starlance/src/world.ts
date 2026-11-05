// The shared contract every lane reads. Each module gets `update(w, dt)` with this object, so a
// module reaches what it needs without the scene threading arguments through.
import type { ICtx } from "@threenative/core";
import type { PerspectiveCamera, Vector3 } from "three";
import type { Enemies } from "./entities/Enemies.js";
import type { Rail } from "./entities/Rail.js";
import type { Ship } from "./entities/Ship.js";
import type { Weapons } from "./entities/Weapons.js";
import type { Wingmen } from "./entities/Wingmen.js";
import type { IFx } from "./render/fx.js";
import type { RailCamera } from "./render/railCamera.js";
import type { IStage } from "./render/stage.js";
import type { GameState } from "./state.js";

export type GameCtx = ICtx<GameState>;

export type SfxName =
  | "laser"
  | "charged"
  | "explosion"
  | "hit"
  | "lock"
  | "bomb"
  | "pickup"
  | "alarm";

/** Anything a player shot can hit and a lock can mark. Owned by `Enemies`. */
export interface ITarget {
  readonly id: number;
  /** World position, updated by the owner every tick. */
  readonly position: Vector3;
  readonly radius: number;
  readonly lockable: boolean;
  alive: boolean;
  /** Applies damage; returns true when this hit destroyed it. */
  damage(amount: number): boolean;
}

/** A static hit sphere on the course (spire, arch leg, canyon rock). Owned by `stage.ts`. */
export interface IObstacle {
  readonly center: Vector3;
  readonly radius: number;
}

export interface World {
  readonly ctx: GameCtx;
  readonly camera: PerspectiveCamera;
  readonly cameraRig: RailCamera;
  readonly rail: Rail;
  readonly ship: Ship;
  readonly weapons: Weapons;
  readonly enemies: Enemies;
  readonly wingmen: Wingmen;
  readonly stage: IStage;
  readonly fx: IFx;
  readonly sfx: (name: SfxName, at?: Vector3) => void;
  /** Test-only: `?autopilot=1` flies and aims for the full-run proof. False on native. */
  readonly autopilot: boolean;
}
