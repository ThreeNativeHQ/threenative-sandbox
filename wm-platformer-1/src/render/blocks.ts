// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The three pieces of level furniture you can stand on or reach: a crate, the `?` block and the
// goal flag. Each takes a size, centres itself on its own origin, and — unlike the decoration in
// `props.ts` — each is handed to `buildStaticColliders` as walkable geometry.
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  PlaneGeometry,
  SphereGeometry,
} from "three";
import { toon } from "./materials.js";
import { C } from "./palette.js";

function mesh(geometry: BufferGeometry, material: Material): Mesh {
  const m = new Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Wooden crate with plank detail. The origin is its own centre, and `box` is the one mesh inside
 * it that collides — the planks are 2 cm proud of the faces and are decoration.
 */
export function crate(size = 1): { box: Mesh; group: Group } {
  const group = new Group();
  const box = mesh(new BoxGeometry(size, size, size), toon(C.wood));
  group.add(box);
  const half = size / 2 + 0.01;
  for (const [rx, ry, rz, px, pz] of [
    [0, 0, 0, 0, half],
    [0, Math.PI, 0, 0, -half],
    [0, Math.PI / 2, 0, half, 0],
    [0, -Math.PI / 2, 0, -half, 0],
  ] as const) {
    for (const y of [-size * 0.3, 0, size * 0.3]) {
      const plank = mesh(new BoxGeometry(size * 0.96, size * 0.24, 0.02), toon(C.woodDark));
      plank.rotation.set(rx, ry, rz);
      plank.position.set(px, y, pz);
      group.add(plank);
    }
  }
  return { box, group };
}

/** Classic '?' block, drawn from three boxes. The origin is its own centre. */
export function questionBlock(size = 1): { box: Mesh; group: Group } {
  const group = new Group();
  const box = mesh(new BoxGeometry(size, size, size), toon(0xe89b25));
  group.add(box);
  const half = size / 2 + 0.02;
  for (const [ry, px, pz] of [
    [0, 0, half],
    [Math.PI, 0, -half],
    [Math.PI / 2, half, 0],
    [-Math.PI / 2, -half, 0],
  ] as const) {
    const face = new Group();
    face.rotation.y = ry;
    face.position.set(px, 0, pz);
    group.add(face);
    const bar = mesh(new BoxGeometry(size * 0.34, size * 0.12, 0.02), toon(0xfff0c9));
    bar.position.set(0, size * 0.2, 0);
    const stem = mesh(new BoxGeometry(size * 0.12, size * 0.3, 0.02), toon(0xfff0c9));
    stem.position.set(size * 0.11, size * 0.02, 0);
    const dot = mesh(new BoxGeometry(size * 0.12, size * 0.12, 0.02), toon(0xfff0c9));
    dot.position.set(0, -size * 0.26, 0);
    face.add(bar, stem, dot);
  }
  return { box, group };
}

/** Goal flag on a pole. `cloth` is the plane `swayFlag` waves. */
export function goalFlag(): { cloth: Mesh; group: Group } {
  const group = new Group();
  const pole = mesh(new CylinderGeometry(0.1, 0.12, 6, 6), toon(C.metal));
  pole.position.y = 3;
  group.add(pole);
  const base = mesh(new CylinderGeometry(0.6, 0.75, 0.4, 10), toon(C.rockDark));
  base.position.y = 0.2;
  group.add(base);
  const cloth = mesh(new PlaneGeometry(1.8, 1.1, 8, 1), toon(0xff5a4a, { flat: true }));
  cloth.position.set(0.9, 5.2, 0);
  group.add(cloth);
  const ball = mesh(new SphereGeometry(0.16, 8, 6), toon(C.gold));
  ball.position.y = 6.1;
  group.add(ball);
  return { cloth, group };
}
