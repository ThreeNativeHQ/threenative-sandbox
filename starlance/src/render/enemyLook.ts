// Meshes for everything the enemies lane spawns. STUB from the coordinator: plain shapes so the
// combat lanes can run; the look lane replaces each factory body, keeping the signatures.
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
  TorusGeometry,
} from "three";

export type BoltKind = "laser" | "twin" | "hyper" | "homing" | "bomb" | "enemy";
export type ItemKind = "laser" | "bomb" | "wing" | "silverRing" | "goldRing";

const hull = new MeshStandardMaterial({ color: 0x3a2a55, roughness: 0.5, metalness: 0.4 });

export function fighterMesh(): Object3D {
  return new Mesh(new BoxGeometry(3, 0.8, 2.4), hull);
}

export function turretMesh(): Object3D {
  return new Mesh(new BoxGeometry(2, 2, 2), hull);
}

export function itemMesh(kind: ItemKind): Object3D {
  const ring = kind === "silverRing" || kind === "goldRing";
  const color = kind === "goldRing" ? 0xffc040 : kind === "silverRing" ? 0xdde4ee : 0x40c0ff;
  return new Mesh(
    ring ? new TorusGeometry(3, 0.35, 8, 32) : new BoxGeometry(1.2, 1.2, 1.2),
    new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4 }),
  );
}

export function boltMesh(kind: BoltKind): Object3D {
  const color = kind === "enemy" ? 0xff7a20 : kind === "bomb" ? 0xff3060 : 0x9ff6ff;
  return new Mesh(
    new SphereGeometry(kind === "bomb" ? 0.6 : 0.25, 8, 6),
    new MeshBasicMaterial({ color }),
  );
}

export interface IBossLook {
  readonly root: Object3D;
  /** Three weak-point turrets, children of `root`. */
  readonly weakPoints: readonly Object3D[];
  readonly core: Object3D;
}

export function bossMesh(): IBossLook {
  const root = new Group();
  root.add(new Mesh(new BoxGeometry(60, 10, 40), hull));
  const weakPoints = [-20, 0, 20].map((x) => {
    const m = new Mesh(new BoxGeometry(4, 4, 4), hull);
    m.position.set(x, 7, 0);
    root.add(m);
    return m;
  });
  const core = new Mesh(
    new SphereGeometry(4, 16, 12),
    new MeshStandardMaterial({ color: 0xff3060 }),
  );
  core.position.set(0, -6, 0);
  root.add(core);
  return { root, weakPoints, core };
}

/** An allied fighter: a clone of the player's model so it reads as the same squadron. */
export function wingmanMesh(playerModel: Object3D): Object3D {
  return playerModel.clone();
}
