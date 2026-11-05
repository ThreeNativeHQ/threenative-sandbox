import {
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";
import type { Rail } from "../entities/Rail.js";
import type { IObstacle } from "../world.js";

export interface IStageTextures {
  readonly groundDiff: Texture;
  readonly groundNormal: Texture;
  readonly groundRough: Texture;
  readonly rockDiff: Texture;
  readonly rockNormal: Texture;
  readonly rockRough: Texture;
}

export interface IStage {
  readonly root: Group;
  /** Static hit spheres the ship must dodge. */
  readonly obstacles: readonly IObstacle[];
  /** Ground surface height at a world point (the base plane is y = 0). */
  groundHeight(x: number, z: number): number;
}

/**
 * Ember Rift scenery. STUB from the coordinator: one textured ground plane under the course. The
 * look lane builds dunes, spires, the canyon, arches and the arena floor.
 */
export function buildStage(rail: Rail, t: IStageTextures): IStage {
  for (const map of [t.groundDiff, t.groundNormal, t.groundRough]) {
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
    map.repeat.set(400, 400);
  }
  t.groundDiff.colorSpace = SRGBColorSpace;
  const root = new Group();
  const ground = new Mesh(
    new PlaneGeometry(12_000, 12_000).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({
      map: t.groundDiff,
      normalMap: t.groundNormal,
      roughnessMap: t.groundRough,
    }),
  );
  ground.position.set(rail.arenaCenter.x * 0.5, 0, rail.arenaCenter.z * 0.5);
  ground.receiveShadow = true;
  root.add(ground);
  return { root, obstacles: [], groundHeight: () => 0 };
}
