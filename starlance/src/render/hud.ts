import type { PerspectiveCamera } from "three";
import type { World } from "../world.js";
import type { GameState } from "../state.js";

export interface IHud {
  update(w: World, state: Readonly<GameState>, dt: number): void;
  dispose(): void;
}

/**
 * In-scene HUD attached to the camera (native-safe: no DOM). STUB from the coordinator; the look
 * lane builds shield bar, boost gauge, hit counter, bomb count, reticles, lock box and banners.
 */
export function createHud(_camera: PerspectiveCamera): IHud {
  return { update() {}, dispose() {} };
}
