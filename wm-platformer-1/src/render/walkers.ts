// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The two things that walk into the fox: a grumpy red-capped mushroom that hops, and a snail with
// a spiral shell that glides. Both are stompable and both are built from primitives, so the whole
// bestiary is two files' worth of code and zero asset bytes.
import { BoxGeometry, CapsuleGeometry, Group, Mesh, SphereGeometry, TorusGeometry } from "three";
import { toon } from "./materials.js";
import { C } from "./palette.js";

const TAU = Math.PI * 2;

/** Grumpy mushroom that patrols along X and hops as it goes. */
export function mushroom(): Group {
  const group = new Group();
  const stem = new Mesh(new CapsuleGeometry(0.36, 0.28, 4, 10), toon(C.spot));
  stem.position.y = 0.46;
  stem.castShadow = true;
  group.add(stem);

  const cap = new Mesh(
    new SphereGeometry(0.62, 12, 8, 0, TAU, 0, Math.PI / 2),
    toon(C.capRed, { flat: true }),
  );
  cap.position.y = 0.78;
  cap.scale.y = 0.85;
  cap.castShadow = true;
  group.add(cap);
  const rim = new Mesh(new TorusGeometry(0.61, 0.07, 6, 14), toon(C.capDark, { flat: true }));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.75;
  group.add(rim);

  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * TAU + 0.4;
    const spot = new Mesh(new SphereGeometry(0.13, 8, 6), toon(C.spot));
    spot.position.set(Math.cos(a) * 0.36, 0.96 + Math.sin(i) * 0.03, Math.sin(a) * 0.36);
    spot.scale.y = 0.5;
    group.add(spot);
  }

  // The face: two eyes under two brows, and a flat mouth. Three boxes and two spheres is the
  // difference between a prop and a character.
  for (const side of [-1, 1]) {
    const eye = new Mesh(new SphereGeometry(0.075, 8, 6), toon(C.ink));
    eye.position.set(0.15 * side, 0.56, 0.3);
    const brow = new Mesh(new BoxGeometry(0.16, 0.04, 0.03), toon(C.ink));
    brow.position.set(0.15 * side, 0.67, 0.34);
    brow.rotation.z = -0.4 * side;
    group.add(eye, brow);
  }
  const mouth = new Mesh(new BoxGeometry(0.18, 0.035, 0.03), toon(C.ink));
  mouth.position.set(0, 0.38, 0.34);
  group.add(mouth);
  return group;
}

/** Snail with a spiral shell of stacked tori. */
export function snail(): Group {
  const group = new Group();
  const body = new Mesh(new CapsuleGeometry(0.3, 0.75, 4, 10), toon(C.snailBody));
  body.rotation.z = Math.PI / 2;
  body.position.set(0.15, 0.3, 0);
  body.scale.set(1, 1, 0.85);
  body.castShadow = true;
  group.add(body);

  const head = new Mesh(new SphereGeometry(0.33, 10, 8), toon(C.snailBody));
  head.position.set(0.62, 0.42, 0);
  head.castShadow = true;
  group.add(head);

  for (const side of [-1, 1]) {
    const stalk = new Mesh(new CapsuleGeometry(0.045, 0.26, 3, 5), toon(C.snailBody));
    stalk.position.set(0.68, 0.72, 0.14 * side);
    stalk.rotation.z = -0.25;
    const eye = new Mesh(new SphereGeometry(0.1, 8, 6), toon(C.spot));
    eye.position.set(0.73, 0.9, 0.14 * side);
    const pupil = new Mesh(new SphereGeometry(0.05, 6, 5), toon(C.ink));
    pupil.position.set(0.81, 0.9, 0.15 * side);
    group.add(stalk, eye, pupil);
  }

  for (let i = 0; i < 5; i += 1) {
    const ring = new Mesh(
      new TorusGeometry(0.52 - i * 0.09, 0.17 - i * 0.022, 6, 14),
      toon(i % 2 ? C.shellRed : 0xc4523c, { flat: true }),
    );
    ring.position.set(-0.18, 0.6, i * 0.055);
    ring.castShadow = true;
    group.add(ring);
  }
  const core = new Mesh(new SphereGeometry(0.22, 10, 8), toon(0xc4523c, { flat: true }));
  core.position.set(-0.18, 0.6, 0.28);
  group.add(core);
  return group;
}
