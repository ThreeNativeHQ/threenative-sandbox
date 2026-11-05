// Test-only (`?lookbook=1`): every enemy/item/bolt mesh and a few explosions, parked in front of the
// camera, so one capture shows the whole look. Not part of the game.
import { Group, type Object3D, type PerspectiveCamera, Vector3 } from "three";
import type { World } from "../world.js";
import {
  type BoltKind,
  type ItemKind,
  boltMesh,
  bossMesh,
  fighterMesh,
  itemMesh,
  turretMesh,
} from "./enemyLook.js";

export function lookbook(w: World, camera: PerspectiveCamera, mode: number) {
  const g = new Group();
  camera.add(g);
  const put = (o: Object3D, x: number, y: number, z: number, ry = 0, rx = 0, s = 1) => {
    o.position.set(x, y, z);
    o.rotation.set(rx, ry, 0);
    o.scale.setScalar(s);
    g.add(o);
  };
  if (mode === 1) {
    put(fighterMesh(), -9, 3, -22, Math.PI + 0.6, 0.25);
    put(turretMesh(), -3.5, 2, -22, Math.PI + 0.5, 0.3);
    (["laser", "twin", "hyper", "homing", "bomb", "enemy"] as BoltKind[]).forEach((k, i) =>
      put(boltMesh(k), 3 + i * 2.4, 4, -22, Math.PI / 2 + 0.3),
    );
    (["laser", "bomb", "wing", "silverRing", "goldRing"] as ItemKind[]).forEach((k, i) =>
      put(itemMesh(k), -9 + i * 4.2, -3.5, -22, 0.5, 0.2, k.endsWith("Ring") ? 0.45 : 1),
    );
  } else if (mode === 2) {
    put(fighterMesh(), -3.2, 0.6, -10, Math.PI + 0.7, 0.3, 1.4);
    put(fighterMesh(), 3.4, -0.6, -12, -0.5, 0.2, 1.4);
    put(turretMesh(), 0, -3.6, -13, Math.PI + 0.3, 0.2, 1.3);
    (["laser", "hyper", "homing", "bomb", "enemy"] as BoltKind[]).forEach((k, i) =>
      put(boltMesh(k), -6 + i * 3, 3.4, -14, Math.PI / 2 + 0.2),
    );
  } else {
    const boss = bossMesh();
    put(boss.root, 0, -3, -105, Math.PI / 2 + 0.35, 0.3);
    boss.setOpen(
      Number(/[?&,]open=([\d.]+)/.exec(String(globalThis.location?.search ?? ""))?.[1] ?? 0.8),
    );
  }
  const _v = new Vector3();
  let t = 0;
  return (dt: number) => {
    t += dt;
    if (t > 1.1) {
      t = 0;
      camera.updateMatrixWorld(true);
      if (mode === 1) {
        w.fx.explode(camera.localToWorld(_v.set(-8, -9, -30)), 3);
        w.fx.explode(camera.localToWorld(_v.set(8, -9, -45)), 9);
      }
      w.fx.spark(camera.localToWorld(_v.set(0, -6, -22)));
    }
  };
}
