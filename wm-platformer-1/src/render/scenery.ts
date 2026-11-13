// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The world past the route: layered cliffs, a castle, a windmill and an airship. None of it
// collides and none of it is ever within a shadow's reach of the fox, which is the whole point of
// putting it here: it is what makes 100 m of ground read as a place rather than a corridor. The
// waterfalls that hang off the cliffs live next door in `waterfall.ts`.
import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { flat, mottle, toon } from "./materials.js";
import { C } from "./palette.js";

function mesh(geometry: BufferGeometry, material: Material, cast = true): Mesh {
  const m = new Mesh(geometry, material);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

/** Distant castle with two towers, matching the skyline the route is heading for. */
export function castle(rng: () => number): Group {
  const group = new Group();
  const brick = toon(C.brick);
  const brickDark = toon(C.brickDark);
  group.add(placed(new BoxGeometry(9, 14, 8), brick, 0, 7, 0));
  for (const x of [-4.5, 4.5]) {
    group.add(placed(new CylinderGeometry(2.2, 2.5, 17, 10), brick, x, 8.5, 0));
    group.add(placed(new CylinderGeometry(2.7, 2.7, 1, 10), brickDark, x, 17.2, 0));
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      group.add(
        placed(
          new BoxGeometry(0.7, 1.1, 0.7),
          brickDark,
          x + Math.cos(a) * 2.3,
          18.2,
          Math.sin(a) * 2.3,
        ),
      );
    }
  }
  for (let i = -4; i <= 4; i += 1)
    group.add(placed(new BoxGeometry(0.8, 1.2, 0.8), brickDark, i * 1.05, 14.6, 3.6));
  group.add(placed(new BoxGeometry(3, 4.4, 0.6), toon(C.woodDark), 0, 2.2, 4.1));
  for (const [x, y] of [
    [-2.6, 9],
    [2.6, 9],
    [0, 10.5],
  ] as const) {
    group.add(placed(new PlaneGeometry(1.7, 1.7), flat(0x2f6fa8), x, y, 4.05));
    group.add(placed(new TorusGeometry(0.95, 0.16, 6, 12), brickDark, x, y, 4.05));
  }
  group.add(placed(new CylinderGeometry(0.08, 0.08, 5, 5), toon(C.metal), 0, 16.5, 0));
  // Motes on the battlements, so the silhouette is not a stack of clean cylinders.
  for (let i = 0; i < 12; i += 1)
    group.add(
      placed(
        new BoxGeometry(0.3, 0.3, 0.3),
        brickDark,
        (rng() - 0.5) * 9,
        14.6 + rng() * 4,
        4 + rng(),
      ),
    );
  return group;
}

/** Windmill. `spin` advances the sails. */
export function windmill(): { group: Group; spin(dt: number): void } {
  const group = new Group();
  group.add(placed(new CylinderGeometry(1.5, 2.3, 7, 10), toon(0xe6d9c2), 0, 3.5, 0));
  group.add(placed(new ConeGeometry(2.1, 2.2, 10), toon(C.roof), 0, 8.1, 0));
  const hub = new Group();
  hub.position.set(0, 6.6, 2);
  group.add(hub);
  for (let i = 0; i < 4; i += 1) {
    const arm = new Group();
    arm.rotation.z = (i / 4) * Math.PI * 2;
    hub.add(arm);
    arm.add(placed(new BoxGeometry(0.18, 4.4, 0.18), toon(C.woodDark), 0, 2.2, 0));
    arm.add(placed(new BoxGeometry(0.9, 3.2, 0.08), toon(0xf6f0e2), 0.6, 2.4, 0.12));
  }
  return {
    group,
    spin(dt: number): void {
      hub.rotation.z += dt * 0.55;
    },
  };
}

/** Zeppelin drifting across the sky. */
export function airship(): Group {
  const group = new Group();
  const hull = mesh(new CapsuleGeometry(1.5, 4.4, 6, 12), toon(0xb9c4cc), false);
  hull.rotation.z = Math.PI / 2;
  group.add(hull);
  const fin = mesh(new BoxGeometry(0.12, 1.4, 1.6), toon(0x8e9aa4), false);
  fin.position.x = -3.5;
  group.add(fin);
  const gondola = mesh(new BoxGeometry(1.8, 0.7, 0.9), toon(C.woodDark), false);
  gondola.position.y = -1.7;
  group.add(gondola);
  for (const x of [-0.6, 0.6]) {
    const cable = mesh(new CylinderGeometry(0.04, 0.04, 1.1, 4), toon(0x6b6b6b), false);
    cable.position.set(x, -1.1, 0);
    group.add(cable);
  }
  return group;
}

/** A mottled cliff face, the unit every backdrop layer is built from. */
export function cliff(width: number, height: number, depth: number, rng: () => number): Group {
  const group = new Group();
  const segments = (n: number): number => Math.max(1, Math.min(6, Math.round(n / 3)));
  const rock = new Mesh(
    mottle(
      new BoxGeometry(width, height, depth, segments(width), segments(height), segments(depth)),
      0.24,
      rng,
    ),
    toon(C.rock, { flat: true, vertexColors: true }),
  );
  group.add(rock);
  for (let i = 1; i < 4; i += 1)
    group.add(
      placed(
        new BoxGeometry(width * 0.99, 0.8, depth + 0.2),
        toon(i % 2 ? C.rockDark : C.rockLight),
        0,
        height / 2 - i * 3.5,
        0,
      ),
    );
  for (let i = 0; i < 5; i += 1) {
    const boulder = new Mesh(
      new SphereGeometry(1 + rng() * 1.6, 6, 5),
      toon(rng() < 0.5 ? C.rockDark : C.rockLight, { flat: true }),
    );
    boulder.userData.faceted = true;
    boulder.position.set((rng() - 0.5) * width * 0.9, (rng() - 0.5) * height * 0.9, depth / 2);
    group.add(boulder);
  }
  group.add(
    placed(new BoxGeometry(width + 0.6, 1.4, depth + 0.6), toon(C.grass), 0, height / 2, 0),
  );
  group.add(
    placed(new BoxGeometry(width + 0.3, 0.9, depth + 0.3), toon(C.dirt), 0, height / 2 - 1.1, 0),
  );
  return group;
}

function placed(
  geometry: BufferGeometry,
  material: Material,
  x: number,
  y: number,
  z: number,
): Mesh {
  const m = mesh(geometry, material);
  m.position.set(x, y, z);
  return m;
}
