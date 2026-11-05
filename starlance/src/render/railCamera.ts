import { type PerspectiveCamera, Vector3 } from "three";
import type { World } from "../world.js";

const _eye = new Vector3();
const _aim = new Vector3();

/**
 * Chase camera for rail and all-range flight. STUB from the coordinator: a fixed offset behind
 * the ship. The flight lane implements cards camera-rails and camera-all-range and `shake`.
 */
export class RailCamera {
  constructor(readonly camera: PerspectiveCamera) {
    camera.fov = 60;
    camera.near = 0.1;
    camera.far = 20_000;
    camera.updateProjectionMatrix();
  }

  update(w: World, _dt: number): void {
    const ship = w.ship;
    _eye.copy(ship.position).addScaledVector(ship.forward, -8).addScaledVector(ship.up, 1.6);
    _aim.copy(ship.position).addScaledVector(ship.forward, 20);
    this.camera.position.copy(_eye);
    this.camera.up.copy(ship.up);
    this.camera.lookAt(_aim);
  }

  /** Adds a transient shake; strength 0..1. */
  shake(_strength: number): void {}

  debug(): Record<string, unknown> {
    return { position: this.camera.position.toArray() };
  }
}
