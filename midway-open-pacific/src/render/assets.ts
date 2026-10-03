/** Procedural geometry and textures. No copyrighted game assets or image downloads. */
import * as THREE from "three";
import { mergeByMaterial } from "@threenative/core";

const materialCache = new Map<string, THREE.MeshStandardMaterial>();

export function mat(color: number, opts: Record<string, unknown> = {}): THREE.MeshStandardMaterial {
  const key = String(color) + JSON.stringify(opts);
  let m = materialCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).convertLinearToSRGB(), roughness: 0.68, metalness: 0.18, ...opts });
    materialCache.set(key, m);
  }
  return m;
}

export function box(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material | number,
): THREE.Mesh {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof m === "number" ? mat(m) : m);
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

export function ellipsoid(
  parent: THREE.Object3D,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  m: THREE.Material,
  segments = 16,
): THREE.Mesh {
  const o = new THREE.Mesh(new THREE.SphereGeometry(1, segments, 10), m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  parent.add(o);
  return o;
}

export function cylinder(
  parent: THREE.Object3D,
  r1: number,
  r2: number,
  height: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
  segments = 12,
): THREE.Mesh {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, height, segments), m);
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

export function rod(
  parent: THREE.Object3D,
  a: number[],
  b: number[],
  r: number,
  m: THREE.Material,
): THREE.Mesh {
  const A = new THREE.Vector3(...(a as [number, number, number]));
  const B = new THREE.Vector3(...(b as [number, number, number]));
  const v = B.clone().sub(A);
  const o = cylinder(parent, r, r, v.length(), 0, 0, 0, m, 8);
  o.position.copy(A.add(B).multiplyScalar(0.5));
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize());
  return o;
}

export function canvasTexture(
  w: number,
  h: number,
  draw: (c: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.Texture {
  // A target with no 2D canvas gets a flat white pixel: the material keeps its own colour and the
  // model is untextured, rather than the whole build throwing while it draws a decal.
  if (typeof document === "undefined" || typeof document.createElement !== "function") return flatTexture();
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx === null) return flatTexture();
  // The native 2D shim implements the common path but not every method (createRadialGradient,
  // setLineDash); a draw that throws on a missing one falls back to the flat pixel instead of
  // taking the build down.
  try {
    draw(ctx, w, h);
  } catch {
    return flatTexture();
  }
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = 4;
  return tx;
}

/** The stand-in a target without a 2D canvas gets: one opaque white texel. */
function flatTexture(): THREE.Texture {
  const tx = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.needsUpdate = true;
  return tx;
}

/**
 * Merge static components by material to avoid a draw call for every bolt and window.
 *
 * The grouping, the baked transforms and the per-material mesh are the engine's `mergeByMaterial`;
 * the two appearance decisions are ours and stay here: every merged mesh casts and receives, and the
 * group is the group it was given, so the call sites that added a returned group keep working. The
 * sources are dropped afterwards — `mergeByMaterial` does not mutate the root, and leaving them would
 * draw the whole hierarchy twice.
 */
export function consolidate(group: THREE.Group): THREE.Group {
  const merged = mergeByMaterial(group, { label: "consolidate" });
  for (const child of [...group.children]) group.remove(child);
  for (const mesh of merged) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.geometry.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}

function roundel(team: string): THREE.Texture {
  return canvasTexture(128, 128, (c) => {
    c.fillStyle = team === "us" ? "#193446" : "#eee5cf";
    c.beginPath();
    c.arc(64, 64, 58, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = team === "us" ? "#f3eee0" : "#a73130";
    if (team === "jp") {
      c.beginPath();
      c.arc(64, 64, 45, 0, Math.PI * 2);
      c.fill();
    } else {
      c.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 21 : 51;
        c.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
      }
      c.closePath();
      c.fill();
    }
  });
}

const roundelM: Record<string, THREE.MeshBasicMaterial> = {};
/** Shared national-insignia decal material: Midway-era US star-in-circle, no bars. */
export function emblem(team: string): THREE.MeshBasicMaterial {
  if (!roundelM[team]) roundelM[team] = new THREE.MeshBasicMaterial({ map: roundel(team), transparent: true, depthWrite: false, side: THREE.DoubleSide });
  return roundelM[team];
}

/**
 * Turn a wheeled airframe into a catapult floatplane: wheels off, a central float on a pylon and a
 * small one under each wing.
 *
 * The cruisers' scouts are Aichi E13A-type floatplanes in everything the simulation does with them —
 * catapulted off the quarterdeck, recovered alongside by crane, lost if they run dry over water — and
 * drawing them on wheels contradicts every one of those. The offsets fit a wheeled airframe
 * whose wheels hang ~1.85 m below its origin with span on X: the hull sits where the gear was
 * and the wing floats stand under the outer panel. An airframe on another datum (wheels on y = 0
 * out of the import contract) needs its own offsets — the floats will hang below its belly.
 */
export function addFloats(plane: THREE.Group): THREE.Group {
  const gear = plane.userData.gear as THREE.Object3D | undefined;
  if (gear) gear.visible = false;
  const grey = mat(0x9aa3a0);
  const dark = mat(0x4a5558);
  const floats = new THREE.Group();
  // Main float: a long body under the fuselage on two struts, with a shallow bow rise.
  const hull = box(floats, 0.86, 0.62, 7.4, 0, -1.95, 0.1, grey);
  hull.rotation.x = 0.02;
  box(floats, 0.9, 0.22, 1.5, 0, -1.72, -3.3, grey).rotation.x = -0.22;
  box(floats, 0.66, 0.2, 1.1, 0, -2.2, 3.3, dark);
  for (const x of [-0.62, 0.62]) {
    rod(floats, [x, -0.35, -0.6], [x * 0.55, -1.66, -0.9], 0.09, dark);
    rod(floats, [x, -0.35, 1.5], [x * 0.55, -1.66, 1.2], 0.09, dark);
  }
  // Wing floats, one under each outer panel.
  for (const x of [-4.3, 4.3]) {
    box(floats, 0.46, 0.36, 2.5, x, -1.28, 0.2, grey);
    rod(floats, [x, -0.18, -0.5], [x, -1.12, -0.5], 0.07, dark);
    rod(floats, [x, -0.18, 0.9], [x, -1.12, 0.9], 0.07, dark);
  }
  plane.add(floats);
  plane.userData.floats = floats;
  return plane;
}

export function makeCrew(): THREE.Group {
  const group = new THREE.Group();
  const yellow = mat(0xc6a951);
  const pants = mat(0x3b5664);
  const skin = mat(0xb89576);
  for (let i = 0; i < 12; i += 1) {
    const man = new THREE.Group();
    const side = i % 2 ? 1 : -1;
    man.position.set(side * (7.5 + (i % 3) * 1.5), 20, 67 + Math.floor(i / 2) * 8);
    box(man, 0.55, 0.85, 0.38, 0, 0.95, 0, i % 3 ? yellow : mat(0xa38677));
    ellipsoid(man, 0, 1.62, 0, 0.21, 0.25, 0.21, skin, 8);
    for (const x of [-0.16, 0.16]) rod(man, [x, 0.6, 0], [x, 0.05, 0], 0.1, pants);
    rod(man, [-0.3, 1.23, 0], [-0.65, 1.1, -0.1], 0.075, yellow);
    rod(man, [0.3, 1.23, 0], [0.55, 1.65, -0.1], 0.075, yellow);
    man.userData.phase = i;
    group.add(consolidate(man));
  }
  return group;
}

export function smokeTexture(): THREE.Texture {
  return canvasTexture(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 62);
    g.addColorStop(0, "rgba(255,255,255,.9)");
    g.addColorStop(0.3, "rgba(245,245,245,.68)");
    g.addColorStop(0.7, "rgba(210,215,220,.25)");
    g.addColorStop(1, "rgba(210,215,220,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
  });
}

export function cloudTexture(): THREE.Texture {
  return canvasTexture(512, 256, (c) => {
    for (let i = 0; i < 33; i += 1) {
      const x = 80 + (Math.sin(i * 2.1) + 1) * 170;
      const y = 83 + Math.cos(i * 1.7) * 42;
      const r = 45 + (i % 4) * 15;
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(239,230,208,.25)");
      g.addColorStop(0.5, "rgba(233,229,218,.14)");
      g.addColorStop(1, "rgba(221,221,210,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 512, 256);
    }
  });
}

export function wakeTexture(): THREE.Texture {
  return canvasTexture(256, 512, (c) => {
    for (let i = 0; i < 110; i += 1) {
      const y = i * 4.5;
      const spread = 8 + y * 0.21;
      const alpha = (1 - i / 110) * 0.22;
      c.strokeStyle = `rgba(210,235,232,${alpha})`;
      c.lineWidth = 4 + (i % 5);
      c.beginPath();
      c.moveTo(128 - spread, y);
      c.lineTo(128 - spread + 14, y + 22);
      c.stroke();
      c.beginPath();
      c.moveTo(128 + spread, y);
      c.lineTo(128 + spread - 14, y + 22);
      c.stroke();
    }
    const g = c.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, "rgba(216,241,238,.45)");
    g.addColorStop(1, "rgba(216,241,238,0)");
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(122, 0);
    c.lineTo(96, 512);
    c.lineTo(160, 512);
    c.lineTo(134, 0);
    c.fill();
  });
}

export function makeIsland(): THREE.Group {
  const g = new THREE.Group();
  const sand = mat(0xb1b09a);
  const green = mat(0x5f7565);
  const runway = mat(0x6d7675);
  ellipsoid(g, 0, -18, 0, 1350, 30, 670, sand, 32);
  ellipsoid(g, 50, -10, 30, 1120, 27, 500, green, 32);
  box(g, 1120, 0.25, 63, 0, 12, 0, runway);
  box(g, 63, 0.25, 750, 160, 12, 0, runway);
  for (let i = 0; i < 15; i += 1) box(g, 35, 0.3, 2, -500 + i * 70, 12.4, 0, mat(0xc9cfb9));
  for (let i = 0; i < 8; i += 1) {
    box(g, 55, 24, 36, -380 + i * 100, 23, 120, mat(0x838578));
    box(g, 57, 4, 39, -380 + i * 100, 36, 120, mat(0x626d65));
  }
  for (let i = 0; i < 12; i += 1) cylinder(g, 12, 12, 16, -420 + (i % 6) * 36, 22, -140 - Math.floor(i / 6) * 42, mat(0x727c75));
  return consolidate(g);
}
