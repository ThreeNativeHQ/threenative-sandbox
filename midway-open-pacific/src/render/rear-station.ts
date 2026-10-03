/**
 * First-person rear-gunner station: the surrounding cockpit shell and the visible twin gun.
 *
 * Ported from two user-supplied references, kept unchanged in `~/Downloads`:
 * - `cockpit(1).html` ("Rear Cockpit · Three.js Structure Study"): airframe skin, canopy frame,
 *   glazing, seat and radio equipment. Its own procedural gun, demo renderer, camera/input loop,
 *   background and DOM/UI are not ported.
 * - `douglas-gunner.html` ("Procedural twin aircraft guns"): the twin-gun geometry and materials.
 *   Its demo renderer, effects, camera and input are not ported. Rights are user-supplied and
 *   unverified; no licence is claimed.
 *
 * Player-only and self-contained: `world.ts` builds one for the player's own mesh, so no AI
 * aircraft allocates a hidden first-person interior. The exterior `weapon.rear-gun.glb` and the
 * pilot cockpit are untouched. Pure render code: no sim, input or camera state is read here.
 */
import * as T from "three";
import { createRandom, mergeByMaterial } from "@threenative/core";
import { canvasTexture } from "./assets.js";
import { REAR_GUN_MOUNTS, type RearGunMount } from "../sim/gun-mount.js";

const TAU = Math.PI * 2;
const UP = new T.Vector3(0, 1, 0);
const FWD = new T.Vector3(0, 0, 1);

/** The supplied study's declared gunner eye and its flexible-mount track centre, in metres. */
const SHELL_EYE: readonly [number, number, number] = [0, 1.6, 1.48];
const SHELL_MOUNT: readonly [number, number, number] = [0, 1.035, -0.03];
/** The live gunner camera anchor, in aircraft-root coordinates (world.ts's authored framing). */
const CAMERA_OFFSET: readonly [number, number, number] = [0, 0.03, -0.32];

let canvasCapable: boolean | undefined;
/**
 * True only when a real 2D canvas is available. The CPU checks install a stub `document` whose
 * context answers every method with `undefined`, so the capability is probed by an actual gradient
 * rather than by `typeof document`.
 */
function canCanvas(): boolean {
  if (canvasCapable !== undefined) return canvasCapable;
  canvasCapable = false;
  try {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return canvasCapable;
    const c = document.createElement("canvas") as HTMLCanvasElement;
    const ctx = c.getContext("2d") as CanvasRenderingContext2D | null;
    const g = ctx?.createRadialGradient?.(0, 0, 0, 1, 1, 1);
    canvasCapable = !!g && typeof g.addColorStop === "function";
  } catch {
    canvasCapable = false;
  }
  return canvasCapable;
}

/** The repo's existing canvas path, with the wrap/colour-space the supplied study expects. */
function tex(
  w: number,
  h: number,
  draw: (c: CanvasRenderingContext2D, w: number, h: number) => void,
  srgb = true,
  repeat = 1,
): T.Texture | null {
  if (!canCanvas()) return null;
  const t = canvasTexture(w, h, draw);
  t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------------------------------------
// Modelling primitives (ported from the supplied study's `src/primitives.js`).
// ---------------------------------------------------------------------------------------------

function group(parent: T.Object3D | null, name: string): T.Group {
  const g = new T.Group();
  g.name = name;
  if (parent) parent.add(g);
  return g;
}

function mesh(
  parent: T.Object3D,
  geometry: T.BufferGeometry,
  material: T.Material,
  pos: readonly number[] = [0, 0, 0],
  name = "",
): T.Mesh {
  const m = new T.Mesh(geometry, material);
  m.position.set(pos[0]!, pos[1]!, pos[2]!);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

const roundCache = new Map<string, T.BufferGeometry>();
function roundBoxGeometry(w: number, h: number, d: number, r = 0.006): T.BufferGeometry {
  const rr = Math.max(0.0001, Math.min(r, w / 2 - 1e-5, h / 2 - 1e-5, d / 2 - 1e-5));
  const key = [w, h, d, rr].join(",");
  const cached = roundCache.get(key);
  if (cached) return cached;
  const g = new T.BoxGeometry(w, h, d, 4, 4, 4);
  const p = g.attributes.position!;
  const n = g.attributes.normal!;
  const half = new T.Vector3(w / 2 - rr, h / 2 - rr, d / 2 - rr);
  const v = new T.Vector3();
  const core = new T.Vector3();
  const delta = new T.Vector3();
  for (let i = 0; i < p.count; i += 1) {
    v.fromBufferAttribute(p as T.BufferAttribute, i);
    core.copy(v).clamp(half.clone().negate(), half);
    delta.subVectors(v, core).normalize();
    v.copy(core).addScaledVector(delta, rr);
    p.setXYZ(i, v.x, v.y, v.z);
    n.setXYZ(i, delta.x, delta.y, delta.z);
  }
  g.computeBoundingSphere();
  roundCache.set(key, g);
  return g;
}

function box(
  parent: T.Object3D,
  mat: T.Material,
  w: number,
  h: number,
  d: number,
  pos: readonly number[] = [0, 0, 0],
  r = 0.004,
  name = "Panel",
): T.Mesh {
  return mesh(parent, roundBoxGeometry(w, h, d, r), mat, pos, name);
}

const cylCache = new Map<string, T.BufferGeometry>();
function cyl(
  parent: T.Object3D,
  mat: T.Material,
  r1: number,
  r2: number,
  h: number,
  pos: readonly number[] = [0, 0, 0],
  axis: "x" | "y" | "z" = "y",
  segments = 24,
  name = "Cylinder",
): T.Mesh {
  const key = ["c", r1, r2, h, segments].join(",");
  if (!cylCache.has(key)) cylCache.set(key, new T.CylinderGeometry(r1, r2, h, segments, 1));
  const m = mesh(parent, cylCache.get(key)!, mat, pos, name);
  if (axis === "z") m.rotation.x = Math.PI / 2;
  else if (axis === "x") m.rotation.z = Math.PI / 2;
  return m;
}

function ball(
  parent: T.Object3D,
  mat: T.Material,
  r: number,
  pos: readonly number[] = [0, 0, 0],
  scale: readonly number[] = [1, 1, 1],
  name = "Dome",
): T.Mesh {
  const key = `s${r}`;
  if (!cylCache.has(key)) cylCache.set(key, new T.SphereGeometry(r, 12, 8));
  const m = mesh(parent, cylCache.get(key)!, mat, pos, name);
  m.scale.set(scale[0]!, scale[1]!, scale[2]!);
  return m;
}

function rod(
  parent: T.Object3D,
  mat: T.Material,
  a: readonly number[],
  b: readonly number[],
  r = 0.008,
  segments = 12,
  name = "Tube",
): T.Mesh {
  const A = new T.Vector3(a[0], a[1], a[2]);
  const B = new T.Vector3(b[0], b[1], b[2]);
  const delta = B.clone().sub(A);
  const len = delta.length();
  if (len < 1e-7) throw new Error("Zero-length rod");
  const m = cyl(parent, mat, r, r, len, A.clone().add(B).multiplyScalar(0.5).toArray(), "y", segments, name);
  m.quaternion.setFromUnitVectors(UP, delta.normalize());
  return m;
}

function beam(
  parent: T.Object3D,
  mat: T.Material,
  a: readonly number[],
  b: readonly number[],
  width = 0.055,
  depth = 0.025,
  name = "Frame rail",
): T.Mesh {
  const A = new T.Vector3(a[0], a[1], a[2]);
  const B = new T.Vector3(b[0], b[1], b[2]);
  const delta = B.clone().sub(A);
  const m = box(parent, mat, width, delta.length(), depth, A.clone().add(B).multiplyScalar(0.5).toArray(), Math.min(0.004, depth * 0.2), name);
  m.quaternion.setFromUnitVectors(UP, delta.normalize());
  return m;
}

function tube(
  parent: T.Object3D,
  mat: T.Material,
  points: readonly (readonly number[])[],
  r = 0.012,
  segments = 64,
  radial = 10,
  closed = false,
  name = "Bent tubing",
): T.Mesh {
  const curve = new T.CatmullRomCurve3(points.map((p) => new T.Vector3(p[0], p[1], p[2])), closed, "centripetal");
  return mesh(parent, new T.TubeGeometry(curve, segments, r, radial, closed), mat, [0, 0, 0], name);
}

function torus(
  parent: T.Object3D,
  mat: T.Material,
  r: number,
  t: number,
  pos: readonly number[] = [0, 0, 0],
  rot: readonly number[] = [0, 0, 0],
  arc = Math.PI * 2,
  name = "Ring",
): T.Mesh {
  const m = mesh(parent, new T.TorusGeometry(r, t, 8, Math.max(24, Math.ceil((72 * arc) / TAU)), arc), mat, pos, name);
  m.rotation.set(rot[0]!, rot[1]!, rot[2]!);
  return m;
}

function strip(
  parent: T.Object3D,
  mat: T.Material,
  points: readonly (readonly number[])[],
  width = 0.07,
  depth = 0.022,
  name = "Curved sheet frame",
): T.Mesh {
  const curve = new T.CatmullRomCurve3(points.map((p) => new T.Vector3(p[0], p[1], p[2])), false, "centripetal");
  const ps = curve.getPoints(64);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < ps.length; k += 1) {
    const tangent = curve.getTangent(k / (ps.length - 1)).normalize();
    const normal = new T.Vector3(-tangent.y, tangent.x, 0).normalize();
    if (normal.lengthSq() < 0.1) normal.set(1, 0, 0);
    for (let j = 0; j < 4; j += 1) {
      const side = j < 2 ? -1 : 1;
      const zsign = j % 2 === 0 ? -1 : 1;
      const p = ps[k]!.clone().addScaledVector(normal, width * 0.5 * side);
      p.z += depth * 0.5 * zsign;
      positions.push(p.x, p.y, p.z);
      uvs.push(j < 2 ? 0 : 1, k / (ps.length - 1));
    }
  }
  for (let k = 0; k < ps.length - 1; k += 1) {
    const a = k * 4;
    const b = (k + 1) * 4;
    for (const [u, v] of [[0, 2], [2, 3], [3, 1], [1, 0]] as const) indices.push(a + u, b + u, a + v, b + u, b + v, a + v);
  }
  indices.push(0, 1, 2, 1, 3, 2);
  const e = (ps.length - 1) * 4;
  indices.push(e, e + 2, e + 1, e + 1, e + 2, e + 3);
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return mesh(parent, g, mat, [0, 0, 0], name);
}

function plate(
  parent: T.Object3D,
  mat: T.Material,
  points: readonly (readonly number[])[],
  depth = 0.02,
  name = "Shaped panel",
): T.Mesh {
  const s = new T.Shape();
  s.moveTo(points[0]![0]!, points[0]![1]!);
  for (let i = 1; i < points.length; i += 1) s.lineTo(points[i]![0]!, points[i]![1]!);
  s.closePath();
  const g = new T.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, -depth * 0.5);
  return mesh(parent, g, mat, [0, 0, 0], name);
}

interface FastenerPoint {
  p: T.Vector3;
  q: T.Quaternion;
  s: [number, number, number];
}

/** Rivets, washers and screw slots, batched into three instanced meshes. */
function fasteners(parent: T.Object3D, mats: ShellMaterials) {
  const heads: FastenerPoint[] = [];
  const washers: FastenerPoint[] = [];
  const slots: FastenerPoint[] = [];
  const add = (p: readonly number[], normal: readonly number[] = [0, 0, 1], r = 0.008, slotted = false): void => {
    const pos = new T.Vector3(p[0], p[1], p[2]);
    const n = new T.Vector3(normal[0], normal[1], normal[2]);
    const q = new T.Quaternion().setFromUnitVectors(FWD, n.clone().normalize());
    heads.push({ p: pos.clone(), q, s: [r, r, r * 0.56] });
    washers.push({ p: pos.clone().addScaledVector(n, -0.0015), q, s: [r * 1.35, r * 1.35, r * 0.2] });
    if (slotted) slots.push({ p: pos.clone().addScaledVector(n, r * 0.53), q, s: [r * 1.15, r * 0.2, 0.001] });
  };
  const line = (a: readonly number[], b: readonly number[], spacing = 0.095, r = 0.008, normal: readonly number[] = [0, 0, 1]): void => {
    const A = new T.Vector3(a[0], a[1], a[2]);
    const B = new T.Vector3(b[0], b[1], b[2]);
    const count = Math.max(1, Math.round(A.distanceTo(B) / spacing));
    for (let i = 0; i <= count; i += 1) add(A.clone().lerp(B, i / count).toArray(), normal, r, i % 3 === 0);
  };
  const batch = (items: FastenerPoint[], geo: T.BufferGeometry, mat: T.Material, name: string): void => {
    if (!items.length) return;
    const m = new T.InstancedMesh(geo, mat, items.length);
    m.name = name;
    const matrix = new T.Matrix4();
    items.forEach((o, i) => {
      matrix.compose(o.p, o.q, new T.Vector3(o.s[0], o.s[1], o.s[2]));
      m.setMatrixAt(i, matrix);
    });
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
  };
  const finish = (): void => {
    batch(washers, new T.SphereGeometry(1, 8, 6), mats.recess!, "Fastener washers");
    batch(heads, new T.SphereGeometry(1, 10, 6), mats.rivet!, "Rivet heads");
    batch(slots, new T.BoxGeometry(1, 1, 1), mats.recess!, "Screw slots");
  };
  return { add, line, finish };
}

/** Collapse ordinary opaque meshes sharing a material, leaving the component hierarchy. */
function mergeStatic(root: T.Group): void {
  root.updateMatrixWorld(true);
  const batches = new Map<string, { material: T.Material; meshes: T.Mesh[] }>();
  const inverse = new T.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh || (m as unknown as T.InstancedMesh).isInstancedMesh) return;
    if (!m.visible || Array.isArray(m.material) || (m.material as T.Material).transparent || m.userData.keepSeparate) return;
    const key = (m.material as T.Material).uuid;
    let b = batches.get(key);
    if (!b) {
      b = { material: m.material as T.Material, meshes: [] };
      batches.set(key, b);
    }
    b.meshes.push(m);
  });
  for (const { material, meshes } of batches.values()) {
    if (meshes.length < 3) continue;
    let size = 0;
    const gs = meshes.map((m) => {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(new T.Matrix4().multiplyMatrices(inverse, m.matrixWorld));
      size += g.attributes.position!.count;
      return g;
    });
    const pos = new Float32Array(size * 3);
    const norm = new Float32Array(size * 3);
    const uv = new Float32Array(size * 2);
    let offset = 0;
    for (const g of gs) {
      pos.set(g.attributes.position!.array as Float32Array, offset * 3);
      if (g.attributes.normal) norm.set(g.attributes.normal.array as Float32Array, offset * 3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array as Float32Array, offset * 2);
      offset += g.attributes.position!.count;
      g.dispose();
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new T.BufferAttribute(norm, 3));
    geo.setAttribute("uv", new T.BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const merged = mesh(root, geo, material, [0, 0, 0], `${material.name} details`);
    merged.userData.parts = meshes.map((m) => m.name);
    meshes.forEach((m) => m.removeFromParent());
  }
}

// ---------------------------------------------------------------------------------------------
// Materials (ported from the supplied study's `src/materials.js`).
// ---------------------------------------------------------------------------------------------

type ShellMaterials = Record<string, T.Material> & { glass: T.Material };

function normalFromHeight(c: HTMLCanvasElement, strength = 1.8): T.Texture | null {
  const s = c.width;
  const h = c.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, s, h).data;
  const value = (x: number, y: number): number => d[(((y + h) % h) * s + ((x + s) % s)) * 4]! / 255;
  return tex(s, h, (out) => {
    const img = out.createImageData(s, h);
    for (let y = 0; y < h; y += 1)
      for (let x = 0; x < s; x += 1) {
        const dx = (value(x - 1, y) - value(x + 1, y)) * strength;
        const dy = (value(x, y - 1) - value(x, y + 1)) * strength;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const i = (y * s + x) * 4;
        img.data[i] = (dx * inv * 0.5 + 0.5) * 255;
        img.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
        img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    out.putImageData(img, 0, 0);
  }, false);
}

function metalSurface(base: string, seed: number, wear = 0.45): Partial<T.MeshStandardMaterialParameters> {
  if (!canCanvas()) return { color: base };
  const rand = createRandom(seed);
  const s = 1024;
  const height = document.createElement("canvas");
  height.width = 512;
  height.height = 512;
  const hc = height.getContext("2d")!;
  hc.fillStyle = "#808080";
  hc.fillRect(0, 0, 512, 512);
  const map = tex(s, s, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 25000; i += 1) {
      const x = rand() * s;
      const y = rand() * s;
      const a = rand() * 0.12;
      ctx.fillStyle = rand() > 0.48 ? `rgba(206,203,164,${a})` : `rgba(2,8,6,${a})`;
      ctx.fillRect(x, y, rand() * 2.4 + 0.5, rand() * 2.4 + 0.5);
    }
    for (let i = 0; i < 130; i += 1) {
      const x = rand() * s;
      const y = rand() * s;
      const r = rand() * 85 + 14;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(4,8,4,${0.03 + rand() * 0.07})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 3400 * wear; i += 1) {
      let x = rand() * s;
      let y = rand() * s;
      if (rand() < 0.82) {
        if (rand() < 0.5) x = rand() < 0.5 ? Math.pow(rand(), 2) * 50 : s - Math.pow(rand(), 2) * 50;
        else y = rand() < 0.5 ? Math.pow(rand(), 2) * 50 : s - Math.pow(rand(), 2) * 50;
      }
      const len = rand() * 14 + 1;
      const w = rand() * 2.2 + 0.4;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rand() * 6.28);
      ctx.fillStyle = rand() < 0.66 ? "rgba(151,145,120,.70)" : "rgba(19,18,13,.75)";
      ctx.fillRect(-len / 2, -w / 2, len, w);
      ctx.restore();
      hc.fillStyle = "#676767";
      hc.fillRect(x / 2, y / 2, len / 2, 1);
    }
    for (let i = 0; i < 90 * wear; i += 1) {
      const x = rand() * s;
      const y = rand() * s;
      ctx.strokeStyle = "rgba(175,177,164,.18)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rand() * 45, y + rand() * 8);
      ctx.stroke();
    }
  });
  const rough = tex(512, 512, (ctx) => {
    ctx.fillStyle = "#b7b7b7";
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 3000; i += 1) {
      ctx.fillStyle = rand() > 0.5 ? "rgba(0,0,0,.09)" : "rgba(255,255,255,.1)";
      ctx.fillRect(rand() * 512, rand() * 512, rand() * 6 + 1, rand() * 5 + 1);
    }
  }, false);
  const normalMap = normalFromHeight(height, 1.1);
  return {
    ...(map ? { map } : {}),
    ...(normalMap ? { normalMap } : {}),
    ...(rough ? { roughnessMap: rough } : {}),
    color: 0xffffff,
  };
}

function clothSurface(base: string, seed: number, straps = false): Partial<T.MeshStandardMaterialParameters> {
  if (!canCanvas()) return { color: base };
  const rand = createRandom(seed);
  const h = document.createElement("canvas");
  h.width = 512;
  h.height = 512;
  const hc = h.getContext("2d")!;
  hc.fillStyle = "#808080";
  hc.fillRect(0, 0, 512, 512);
  const map = tex(512, 512, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 512, 512);
    for (let y = 0; y < 512; y += 3)
      for (let x = 0; x < 512; x += 3) {
        const check = ((x + y) / 3) | 0;
        const a = 0.025 + rand() * 0.045;
        ctx.fillStyle = check % 2 ? `rgba(197,177,127,${a})` : `rgba(5,9,4,${a + 0.02})`;
        ctx.fillRect(x, y, 2.1, 1.3);
        hc.fillStyle = check % 2 ? "#858585" : "#7a7a7a";
        hc.fillRect(x, y, 2, 1);
      }
    for (let i = 0; i < 90; i += 1) {
      const x = rand() * 512;
      const y = rand() * 512;
      const r = rand() * 90 + 18;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(12,10,4,.11)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    if (straps)
      for (let x = 5; x < 512; x += 18) {
        ctx.strokeStyle = "rgba(207,178,123,.13)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 512);
        ctx.stroke();
      }
  });
  const normalMap = normalFromHeight(h, 0.65);
  return { ...(map ? { map } : {}), ...(normalMap ? { normalMap } : {}), color: 0xffffff };
}

/** The study's material set. Maps fall back to flat base colours where no canvas exists. */
function makeShellMaterials(): ShellMaterials {
  const result: Record<string, T.Material> = {};
  const p = (name: string, props: T.MeshStandardMaterialParameters): T.MeshStandardMaterial => {
    const m = new T.MeshStandardMaterial(props);
    m.name = name;
    result[name] = m;
    return m;
  };
  p("olive", { ...metalSurface("#363c2c", 14, 0.74), metalness: 0.58, roughness: 0.67, normalScale: new T.Vector2(0.25, 0.25), envMapIntensity: 0.8 });
  p("oliveDark", { ...metalSurface("#252a21", 28, 0.62), metalness: 0.53, roughness: 0.78, normalScale: new T.Vector2(0.24, 0.24), envMapIntensity: 0.65 });
  p("oliveLight", { ...metalSurface("#494d34", 27, 0.68), metalness: 0.52, roughness: 0.74, normalScale: new T.Vector2(0.24, 0.24), envMapIntensity: 0.7 });
  p("gunmetal", { ...metalSurface("#252a2a", 71, 0.72), metalness: 0.84, roughness: 0.51, normalScale: new T.Vector2(0.25, 0.25), envMapIntensity: 0.9 });
  p("steel", { ...metalSurface("#59615d", 55, 0.36), metalness: 0.88, roughness: 0.4, normalScale: new T.Vector2(0.18, 0.18), envMapIntensity: 0.85 });
  p("brass", { ...metalSurface("#aa884c", 8, 0.23), metalness: 0.84, roughness: 0.4, normalScale: new T.Vector2(0.15, 0.15), envMapIntensity: 0.75 });
  p("copper", { color: 0x9d6341, metalness: 0.83, roughness: 0.47, envMapIntensity: 0.75 });
  p("rivet", { color: 0x414536, metalness: 0.52, roughness: 0.74, envMapIntensity: 0.5 });
  p("recess", { color: 0x111713, metalness: 0.25, roughness: 0.91 });
  p("rubber", { ...clothSurface("#202520", 91), metalness: 0, roughness: 0.94, normalScale: new T.Vector2(0.3, 0.3) });
  p("canvas", { ...clothSurface("#3c392b", 177), metalness: 0, roughness: 1, normalScale: new T.Vector2(0.3, 0.3) });
  p("webbing", { ...clothSurface("#4a4230", 183, true), metalness: 0, roughness: 1, normalScale: new T.Vector2(0.3, 0.3) });
  p("seam", { color: 0x6e624a, metalness: 0, roughness: 1 });
  p("ivory", { color: 0xb0afa1, metalness: 0.15, roughness: 0.88 });
  result.glass = new T.MeshPhysicalMaterial({
    name: "Canopy glazing",
    color: 0xa9bec0,
    metalness: 0.02,
    roughness: 0.06,
    transparent: true,
    opacity: 0.075,
    depthWrite: false,
    side: T.DoubleSide,
    envMapIntensity: 0.5,
    clearcoat: 1,
  });
  return result as ShellMaterials;
}

interface LabelOptions {
  background?: string | null;
  color?: string;
  font?: string;
  size?: number;
  border?: boolean;
  align?: CanvasTextAlign;
  wear?: number;
  bold?: boolean;
}

/** A painted placard, drawn on a canvas like the study's `label`. Skipped without a canvas. */
function label(
  parent: T.Object3D,
  lines: string[],
  w: number,
  h: number,
  pos: readonly number[],
  options: LabelOptions = {},
): T.Object3D {
  if (!canCanvas()) return group(parent, `${lines[0]} label (skipped)`);
  const { background = null, color = "#cecbb4", font = "monospace", size = 42, border = false, align = "center", wear = 0.25 } = options;
  const rand = createRandom(591 + lines.join("").length);
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = Math.max(128, Math.round((1024 * h) / w));
  const ctx = c.getContext("2d")!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  const pad = border ? 42 : 12;
  if (border) {
    ctx.strokeStyle = "#383b31";
    ctx.lineWidth = 4;
    ctx.strokeRect(18, 18, c.width - 36, c.height - 36);
  }
  ctx.fillStyle = color;
  ctx.font = `${options.bold ? "bold " : ""}${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  const lineH = (c.height - 2 * pad) / lines.length;
  lines.forEach((line, i) => ctx.fillText(line, align === "center" ? c.width / 2 : pad, pad + lineH * (i + 0.5), c.width - pad * 2));
  ctx.globalCompositeOperation = background ? "source-over" : "destination-out";
  for (let i = 0; i < 3000 * wear; i += 1) {
    ctx.fillStyle = background ? "rgba(23,22,13,.14)" : `rgba(0,0,0,${rand() * 0.55})`;
    ctx.fillRect(rand() * c.width, rand() * c.height, rand() * 3.7 + 0.2, rand() * 3 + 0.4);
  }
  ctx.globalCompositeOperation = "source-over";
  const map = tex(c.width, c.height, (out) => out.drawImage(c, 0, 0));
  const mat = new T.MeshStandardMaterial({
    name: `${lines[0]} decal`,
    ...(map ? { map } : {}),
    transparent: true,
    depthWrite: false,
    roughness: 0.97,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  if (map) map.wrapS = map.wrapT = T.ClampToEdgeWrapping;
  const m = mesh(parent, new T.PlaneGeometry(w, h), mat, pos, `${lines[0]} label`);
  m.castShadow = false;
  return m;
}

// ---------------------------------------------------------------------------------------------
// Structure (ported from the supplied study's `src/airframe.js`, `equipment.js`, `gun.js` omitted).
// ---------------------------------------------------------------------------------------------

function buildAirframe(root: T.Object3D, M: ShellMaterials): void {
  const g = group(root, "Airframe");
  const f = fasteners(g, M);
  const sample = (theta: number, z: number): T.Vector3 => {
    const u = (z + 1.3) / 2.6;
    const rx = 0.76 + 0.29 * u;
    const ry = 0.84 + 0.12 * u;
    const top = 1.13 + 0.23 * u;
    return new T.Vector3(Math.cos(theta) * rx, top - Math.sin(theta) * ry, z);
  };
  const inside = (theta: number): T.Vector3 => new T.Vector3(-Math.cos(theta), Math.sin(theta), 0);
  const skin = (a: number, b: number, z0: number, z1: number, mat: T.Material, name: string): void => {
    const positions: number[] = [];
    const uv: number[] = [];
    const ind: number[] = [];
    const nx = 12;
    const nz = 4;
    for (let j = 0; j <= nz; j += 1)
      for (let i = 0; i <= nx; i += 1) {
        const p = sample(a + ((b - a) * i) / nx, z0 + ((z1 - z0) * j) / nz);
        positions.push(p.x, p.y, p.z);
        uv.push(i / nx, j / nz);
      }
    for (let j = 0; j < nz; j += 1)
      for (let i = 0; i < nx; i += 1) {
        const k = j * (nx + 1) + i;
        ind.push(k, k + nx + 1, k + 1, k + 1, k + nx + 1, k + nx + 2);
      }
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    geo.setIndex(ind);
    geo.computeVertexNormals();
    mesh(g, geo, mat, [0, 0, 0], name);
  };
  const skinMats = [M.olive!, M.oliveDark!, M.oliveLight!];
  skinMats.forEach((m) => (m.side = T.DoubleSide));
  const zs = [-1.3, -0.78, -0.2, 0.37, 0.9, 1.3];
  const thetas = [0, 0.3, 0.68, 1.1, 1.54, 1.99, 2.44, 2.84, Math.PI];
  for (let j = 0; j < zs.length - 1; j += 1)
    for (let i = 0; i < thetas.length - 1; i += 1) skin(thetas[i]!, thetas[i + 1]!, zs[j]!, zs[j + 1]!, skinMats[(i + j * 2) % 3]!, `Skin panel ${j + 1}.${i + 1}`);
  for (let j = 0; j < zs.length; j += 1) {
    const z = zs[j]! + 0.003;
    const points: number[][] = [];
    for (let i = 0; i <= 40; i += 1) {
      const theta = 0.02 + ((Math.PI - 0.04) * i) / 40;
      const p = sample(theta, z).addScaledVector(inside(theta), 0.011);
      points.push(p.toArray());
    }
    strip(g, M.oliveDark!, points, 0.052, 0.028, "Formed fuselage rib");
    for (let k = 0; k <= 32; k += 1) {
      const theta = 0.035 + ((Math.PI - 0.07) * k) / 32;
      const p = sample(theta, z).addScaledVector(inside(theta), 0.03);
      f.add(p.toArray(), inside(theta).toArray(), 0.0073);
    }
    tube(g, M.steel!, points.map((p) => [p[0]!, p[1]!, p[2]! + 0.015]), 0.0031, 70, 6, false, "Worn rib edge");
  }
  for (const theta of [0.31, 0.69, 1.12, 2.02, 2.46, 2.83]) {
    const p: number[][] = [];
    for (let j = 0; j <= 16; j += 1) p.push(sample(theta, -1.3 + (j * 2.6) / 16).addScaledVector(inside(theta), 0.02).toArray());
    tube(g, M.oliveLight!, p, 0.014, 48, 8, false, "Longitudinal stiffener");
    for (let z = -1.25; z < 1.28; z += 0.13) f.add(sample(theta, z).addScaledVector(inside(theta), 0.03).toArray(), inside(theta).toArray(), 0.006);
  }
  for (const s of [-1, 1]) {
    const p: number[][] = [];
    for (let i = 0; i <= 12; i += 1) {
      const z = -1.3 + (i * 2.6) / 12;
      p.push(sample(s === 1 ? 0 : Math.PI, z).toArray());
    }
    tube(g, M.oliveDark!, p, 0.036, 48, 12, false, "Cockpit coaming");
    tube(g, M.steel!, p.map((v) => [v[0]! - s * 0.027, v[1]! + 0.016, v[2]!]), 0.006, 48, 8, false, "Exposed coaming edge");
    tube(g, M.rubber!, p.map((v) => [v[0]! + s * 0.013, v[1]! + 0.03, v[2]!]), 0.012, 48, 10, false, "Coaming seal");
    for (let z = -1.19; z < 1.3; z += 0.1) {
      const pos = sample(s === 1 ? 0 : Math.PI, z);
      f.add(pos.add(new T.Vector3(-s * 0.024, 0.02, 0)).toArray(), [0, 1, 0], 0.007);
    }
  }
  const sh = new T.Shape();
  sh.moveTo(-0.73, 1.12);
  sh.lineTo(-0.72, 0.73);
  sh.quadraticCurveTo(-0.49, 0.3, 0, 0.28);
  sh.quadraticCurveTo(0.49, 0.3, 0.72, 0.73);
  sh.lineTo(0.73, 1.12);
  sh.closePath();
  for (const x of [-0.51, -0.31, 0.31, 0.51]) {
    const hole = new T.Path();
    hole.absellipse(x, 0.82, 0.065, 0.12, 0, TAU, true);
    sh.holes.push(hole);
  }
  const bh = new T.ExtrudeGeometry(sh, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1, steps: 1, curveSegments: 24 });
  mesh(g, bh, M.oliveLight!, [0, 0, -1.29], "Perforated forward bulkhead");
  for (const z of [-0.86, -0.23, 0.4, 1.03]) {
    box(g, M.oliveDark!, 0.76, 0.034, 0.47, [0, 0.31, z], 0.004, "Floor panel");
    for (let x = -0.31; x <= 0.32; x += 0.09) box(g, M.recess!, 0.018, 0.003, 0.37, [x, 0.329, z], 0.001, "Non-slip floor groove");
  }
  box(g, M.gunmetal!, 0.44, 0.025, 0.24, [-0.24, 0.4, 0.05], 0.003, "Left heel support");
  box(g, M.gunmetal!, 0.44, 0.025, 0.24, [0.24, 0.4, 0.05], 0.003, "Right heel support");
  for (const s of [-1, 1])
    for (let i = 0; i < 7; i += 1) box(g, M.steel!, 0.027, 0.01, 0.2, [s * 0.24 + (i - 3) * 0.048, 0.418, 0.05], 0.002, "Footrest rib");
  torus(g, M.oliveDark!, 0.77, 0.039, [0, 1.035, -0.03], [Math.PI / 2, 0, 0], TAU, "Flexible-mount track");
  torus(g, M.steel!, 0.793, 0.01, [0, 1.056, -0.03], [Math.PI / 2, 0, 0], TAU, "Outer bearing rail");
  torus(g, M.steel!, 0.742, 0.008, [0, 1.058, -0.03], [Math.PI / 2, 0, 0], TAU, "Inner bearing rail");
  torus(g, M.recess!, 0.77, 0.032, [0, 0.993, -0.03], [Math.PI / 2, 0, 0], TAU, "Track shadow channel");
  for (let i = 0; i < 32; i += 1) {
    const a = (i / 32) * TAU;
    f.add([Math.cos(a) * 0.77, 1.073, Math.sin(a) * 0.77 - 0.03], [0, 1, 0], 0.0065);
  }
  for (const s of [-1, 1]) {
    beam(g, M.oliveDark!, [s * 0.63, 0.68, -0.73], [s * 0.6, 1.015, -0.49], 0.053, 0.041, "Mount support bracket");
    beam(g, M.oliveDark!, [s * 0.73, 0.64, 0.49], [s * 0.63, 1.015, 0.4], 0.054, 0.042, "Aft support bracket");
    box(g, M.oliveLight!, 0.14, 0.095, 0.035, [s * 0.64, 0.79, -0.58], 0.004, "Rib joining plate");
    f.add([s * 0.66, 0.807, -0.555], [0, 0, 1], 0.01, true);
    f.add([s * 0.61, 0.762, -0.555], [0, 0, 1], 0.01, true);
  }
  f.finish();
  mergeStatic(g);
}

function buildCanopy(root: T.Object3D, M: ShellMaterials): void {
  const g = group(root, "Canopy");
  const glass = group(root, "Glazing");
  const f = fasteners(g, M);
  for (const s of [-1, 1]) {
    const a = [s * 0.635, 1.235, -0.845];
    const b = [s * 0.778, 2.665, -0.94];
    beam(g, M.oliveDark!, a, b, 0.067, 0.047, "Main canopy mullion");
    beam(g, M.rubber!, [a[0]! - s * 0.035, a[1]!, a[2]! - 0.018], [b[0]! - s * 0.035, b[1]!, b[2]! - 0.018], 0.014, 0.025, "Mullion glass seal");
    beam(g, M.steel!, [a[0]! + s * 0.03, a[1]!, a[2]! + 0.019], [b[0]! + s * 0.03, b[1]!, b[2]! + 0.019], 0.0035, 0.004, "Mullion worn edge");
    f.line([a[0]!, a[1]! + 0.02, a[2]! + 0.028], [b[0]!, b[1]! - 0.025, b[2]! + 0.028], 0.105, 0.009, [0, 0, 1]);
    const shoe = plate(g, M.oliveLight!, [[-0.07, -0.065], [0.07, -0.065], [0.044, 0.12], [-0.042, 0.12]], 0.015, "Mullion mounting shoe");
    shoe.position.set(a[0]!, a[1]!, a[2]! + 0.036);
    for (const dy of [-0.035, 0.055]) f.add([a[0]!, a[1]! + dy, a[2]! + 0.05], [0, 0, 1], 0.011, true);
    beam(g, M.oliveDark!, [s * 0.65, 1.24, -0.85], [s * 1.02, 1.34, 0.58], 0.059, 0.038, "Side window sill");
    rod(g, M.steel!, [s * 0.674, 1.26, -0.85], [s * 1.032, 1.36, 0.58], 0.004, 8, "Sill edge wear");
    for (let t = 0; t <= 1; t += 0.095) {
      const p = new T.Vector3(s * 0.65, 1.26, -0.85).lerp(new T.Vector3(s * 1.02, 1.36, 0.58), t);
      f.add(p.toArray(), [0, 1, 0], 0.007);
    }
    beam(g, M.oliveDark!, [s * 0.776, 2.62, -0.94], [s * 0.83, 2.48, 0.22], 0.074, 0.052, "Roof longitudinal");
    rod(g, M.rubber!, [s * 0.8, 2.64, -0.94], [s * 0.85, 2.5, 0.22], 0.008, 10, "Roof seal");
    for (const z of [-0.93, 0.2]) {
      cyl(g, M.oliveLight!, 0.035, 0.035, 0.14, [s * 0.77, z === -0.93 ? 2.57 : 2.47, z + 0.019], "x", 20, "Canopy hinge");
      cyl(g, M.steel!, 0.014, 0.014, 0.163, [s * 0.77, z === -0.93 ? 2.57 : 2.47, z + 0.019], "x", 16, "Hinge pin");
    }
  }
  beam(g, M.oliveDark!, [-0.81, 2.605, -0.935], [0.81, 2.605, -0.935], 0.107, 0.065, "Overhead cross-member");
  beam(g, M.steel!, [-0.78, 2.554, -0.898], [0.78, 2.554, -0.898], 0.005, 0.004, "Cross-member wear lip");
  f.line([-0.76, 2.608, -0.897], [0.76, 2.608, -0.897], 0.135, 0.014, [0, 0, 1]);
  for (const x of [-0.61, 0.61]) {
    box(g, M.oliveLight!, 0.064, 0.176, 0.039, [x, 2.614, -0.873], 0.006, "Sliding hood latch");
    cyl(g, M.gunmetal!, 0.027, 0.027, 0.044, [x, 2.555, -0.842], "z", 20, "Latch pivot");
    f.add([x, 2.66, -0.846], [0, 0, 1], 0.011, true);
  }
  const arch: number[][] = [
    [-1.12, 1.32, 0.24], [-1.15, 1.85, 0.24], [-1.09, 2.21, 0.24], [-0.84, 2.47, 0.24], [-0.43, 2.58, 0.24],
    [0, 2.62, 0.24], [0.43, 2.58, 0.24], [0.84, 2.47, 0.24], [1.09, 2.21, 0.24], [1.15, 1.85, 0.24], [1.12, 1.32, 0.24],
  ];
  strip(g, M.oliveDark!, arch, 0.07, 0.047, "Outer arched canopy frame");
  const ac = new T.CatmullRomCurve3(arch.map((p) => new T.Vector3(p[0], p[1], p[2])));
  for (let i = 0; i <= 40; i += 1) {
    const p = ac.getPoint(i / 40);
    p.z += 0.028;
    f.add(p.toArray(), [0, 0, 1], 0.0087, i % 3 === 0);
  }
  tube(g, M.rubber!, arch.map((v) => [v[0]! * 1.018, v[1]! + 0.012, v[2]! - 0.011]), 0.01, 100, 10, false, "Outer canopy gasket");
  const pane = (points: number[][], name: string): void => {
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(points.flat(), 3));
    geo.setAttribute("uv", new T.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.computeVertexNormals();
    const m = mesh(glass, geo, M.glass!, [0, 0, 0], name);
    m.castShadow = false;
  };
  for (const s of [-1, 1]) pane([[s * 0.65, 1.27, -0.85], [s * 1.13, 1.34, 0.24], [s * 1.07, 2.19, 0.24], [s * 0.8, 2.6, -0.94]], "Side glazing");
  pane([[-0.77, 2.61, -0.94], [0.77, 2.61, -0.94], [0.83, 2.48, 0.24], [-0.83, 2.48, 0.24]], "Overhead glazing");
  glass.visible = false;
  f.finish();
  mergeStatic(g);
}

function buildSeat(root: T.Object3D, M: ShellMaterials): void {
  const g = group(root, "Seat");
  const f = fasteners(g, M);
  tube(g, M.gunmetal!, [
    [-0.45, 0.48, 0.72], [-0.455, 0.93, 0.68], [-0.436, 1.2, 0.665], [-0.35, 1.286, 0.68], [0, 1.308, 0.69],
    [0.35, 1.286, 0.68], [0.436, 1.2, 0.665], [0.455, 0.93, 0.68], [0.45, 0.48, 0.72],
  ], 0.02, 100, 14, false, "Tubular backrest frame");
  box(g, M.canvas!, 0.795, 0.586, 0.063, [0, 0.994, 0.708], 0.027, "Padded radio backrest");
  const geo = new T.PlaneGeometry(0.77, 0.56, 38, 30);
  const p = geo.attributes.position!;
  for (let i = 0; i < p.count; i += 1) {
    const x = p.getX(i);
    const y = p.getY(i);
    const edge = Math.min(1, (0.385 - Math.abs(x)) * 13);
    const bulge = 0.018 * (1 - Math.pow(x / 0.39, 2)) * (1 - 0.35 * Math.pow(y / 0.29, 2));
    p.setZ(i, bulge + (0.0017 * Math.sin(x * 53 + y * 9) + 0.001 * Math.sin(y * 82)) * Math.max(0, edge));
  }
  geo.computeVertexNormals();
  mesh(g, geo, M.canvas!, [0, 0.994, 0.744], "Woven canvas face");
  cyl(g, M.canvas!, 0.023, 0.023, 0.762, [0, 1.279, 0.727], "x", 24, "Canvas top roll");
  const frameFrontZ = 0.782;
  for (const s of [-1, 1]) {
    box(g, M.webbing!, 0.054, 0.585, 0.009, [s * 0.319, 0.994, frameFrontZ], 0.004, "Vertical webbing strap");
    box(g, M.webbing!, 0.061, 0.03, 0.1, [s * 0.319, 1.279, 0.735], 0.009, "Webbing folded over backrest");
    for (const dx of [-0.02, 0.02])
      for (let y = 0.728; y < 1.268; y += 0.013) rod(g, M.seam!, [s * 0.319 + dx, y, 0.788], [s * 0.319 + dx, y + 0.0055, 0.788], 0.00065, 5, "Webbing stitch");
    box(g, M.oliveDark!, 0.052, 0.082, 0.029, [s * 0.407, 1.216, 0.721], 0.008, "Backrest clamp");
    cyl(g, M.steel!, 0.021, 0.021, 0.025, [s * 0.407, 1.237, 0.745], "z", 20, "Clamp washer");
    f.add([s * 0.407, 1.237, 0.763], [0, 0, 1], 0.011, true);
    beam(g, M.gunmetal!, [s * 0.446, 0.62, 0.71], [s * 0.64, 0.87, 0.44], 0.037, 0.04, "Seat support stay");
  }
  box(g, M.webbing!, 0.711, 0.033, 0.009, [0, 1.255, 0.771], 0.005, "Upper sewn binding");
  box(g, M.webbing!, 0.711, 0.03, 0.009, [0, 0.728, 0.766], 0.005, "Lower sewn binding");
  for (let x = -0.355; x < 0.354; x += 0.014) rod(g, M.seam!, [x, 1.25, 0.777], [x + 0.006, 1.25, 0.777], 0.00065, 5, "Horizontal seam");
  label(g, ["NO STEP", "RADIO", "KEEP CLEAR"], 0.456, 0.138, [0, 1.188, 0.785], { size: 60, color: "#a6a18c", wear: 0.85, font: "monospace" });
  box(g, M.canvas!, 0.68, 0.079, 0.46, [0, 0.585, 0.85], 0.029, "Seat cushion");
  box(g, M.webbing!, 0.047, 0.014, 0.49, [-0.18, 0.636, 0.85], 0.006, "Lap strap left");
  box(g, M.webbing!, 0.047, 0.014, 0.49, [0.17, 0.636, 0.85], 0.006, "Lap strap right");
  box(g, M.steel!, 0.07, 0.025, 0.052, [0.17, 0.648, 0.995], 0.005, "Harness buckle");
  f.finish();
  mergeStatic(g);
  g.scale.x = 0.78;
}

/** The starboard-radio placard airframe line. Both names are five characters, so the label's
 * wear seed and layout are unchanged between airframes. */
export function placardAirframeLine(airframe: string): string {
  return airframe === "tbd" ? "TBD-1" : "SBD-3";
}

function buildEquipment(root: T.Object3D, M: ShellMaterials, airframe: string): void {
  const g = group(root, "Equipment");
  const f = fasteners(g, M);
  const radio = (pos: number[], w: number, h: number, d: number, name: string): T.Group => {
    const r = group(g, name);
    r.position.set(pos[0]!, pos[1]!, pos[2]!);
    box(r, M.oliveDark!, w, h, d, [0, 0, 0], 0.013, "Equipment enclosure");
    box(r, M.recess!, w + 0.006, 0.011, d + 0.009, [0, h / 2 - 0.038, 0], 0.002, "Lid seam");
    box(r, M.olive!, w + 0.012, 0.04, d + 0.016, [0, h / 2 - 0.01, 0], 0.009, "Equipment lid");
    box(r, M.oliveDark!, w - 0.025, h - 0.058, 0.014, [0, -0.007, d / 2 + 0.008], 0.005, "Front cover");
    for (const s of [-1, 1]) {
      box(r, M.steel!, 0.022, h - 0.015, 0.016, [s * (w / 2 - 0.008), -0.002, d / 2 + 0.011], 0.003, "Case corner edging");
      box(r, M.oliveLight!, 0.05, 0.102, 0.022, [s * (w / 2 - 0.06), h * 0.12, d / 2 + 0.024], 0.005, "Case fastening strap");
      box(r, M.gunmetal!, 0.03, 0.039, 0.029, [s * (w / 2 - 0.06), h * 0.12 - 0.012, d / 2 + 0.035], 0.004, "Toggle latch");
      box(r, M.oliveLight!, 0.065, 0.032, d + 0.027, [s * (w / 2 - 0.032), -h / 2 - 0.014, 0], 0.004, "Rubber-mounted case foot");
    }
    for (let i = 0; i < 8; i += 1) box(r, M.recess!, w * 0.48, 0.01, 0.004, [0, -h * 0.32 + i * 0.017, -d / 2 - 0.002], 0.002, "Rear ventilation slot");
    tube(r, M.gunmetal!, [
      [-w * 0.23, h / 2 + 0.009, -0.02], [-w * 0.22, h / 2 + 0.057, -0.02], [-w * 0.15, h / 2 + 0.069, -0.02],
      [w * 0.15, h / 2 + 0.069, -0.02], [w * 0.22, h / 2 + 0.057, -0.02], [w * 0.23, h / 2 + 0.009, -0.02],
    ], 0.013, 36, 12, false, "Folding carrying handle");
    for (const s of [-1, 1]) box(r, M.oliveLight!, 0.057, 0.016, 0.052, [s * w * 0.26, h / 2 + 0.009, -0.02], 0.004, "Handle hinge plate");
    const rf = fasteners(r, M);
    for (const s of [-1, 1]) for (let y = -h / 2 + 0.032; y < h / 2; y += 0.078) rf.add([s * (w / 2 - 0.014), y, d / 2 + 0.023], [0, 0, 1], 0.0074, true);
    for (let x = -w / 2 + 0.04; x < w / 2 - 0.025; x += 0.095) {
      rf.add([x, -h / 2 + 0.029, d / 2 + 0.02], [0, 0, 1], 0.0068);
      rf.add([x, h / 2 - 0.025, d / 2 + 0.02], [0, 0, 1], 0.0068);
    }
    rf.finish();
    return r;
  };
  const right = radio([0.795, 1.014, 0.245], 0.53, 0.375, 0.59, "Starboard radio case");
  right.rotation.y = -0.035;
  label(right, ["U.S. NAVY", placardAirframeLine(airframe)], 0.361, 0.213, [0.011, -0.012, 0.311], { size: 92, color: "#c2c1b4", wear: 0.8 });
  const aft = radio([0.766, 1.025, -0.585], 0.27, 0.273, 0.298, "Starboard auxiliary equipment");
  label(aft, ["RADIO", "CONTROL"], 0.165, 0.108, [0, 0.012, 0.157], { size: 86, color: "#bfc1ac", wear: 0.65 });
  cyl(aft, M.gunmetal!, 0.032, 0.032, 0.025, [-0.13, 0.005, 0.008], "x", 20, "Electrical connector");
  cyl(aft, M.steel!, 0.02, 0.02, 0.028, [-0.145, 0.005, 0.008], "x", 20, "Connector collar");
  tube(aft, M.rubber!, [[-0.147, 0.005, 0.008], [-0.24, -0.015, 0.001], [-0.27, -0.13, 0.04], [-0.2, -0.24, 0.12]], 0.009, 44, 8, false, "Auxiliary radio cable");
  const plaque = group(g, "Bombing signals placard");
  plaque.position.set(-0.847, 1.075, 0.285);
  plaque.rotation.y = 0.22;
  box(plaque, M.oliveDark!, 0.322, 0.412, 0.024, [0, 0, 0], 0.004, "Placard backing");
  label(plaque, ["BOMBING SIGNALS", "1.  ATTACK", "2.  GOOD HITS", "3.  CEASE ATTACK", "4.  RETURN TO BASE"], 0.288, 0.371, [0, 0, 0.014], { background: "#858472", color: "#262c27", size: 67, border: true, align: "left", wear: 0.45, font: "Arial" });
  const pf = fasteners(plaque, M);
  for (const x of [-0.143, 0.143]) for (const y of [-0.185, 0.185]) pf.add([x, y, 0.018], [0, 0, 1], 0.007, true);
  pf.finish();
  box(g, M.oliveDark!, 0.205, 0.474, 0.231, [-0.984, 1.12, 0.638], 0.013, "Port communications box");
  box(g, M.gunmetal!, 0.153, 0.316, 0.036, [-0.962, 1.118, 0.772], 0.013, "Communications panel");
  for (let i = 0; i < 8; i += 1) box(g, M.recess!, 0.116, 0.007, 0.004, [-0.962, 1.13 + i * 0.022, 0.793], 0.002, "Communications cooling slot");
  cyl(g, M.steel!, 0.03, 0.03, 0.025, [-0.96, 1.036, 0.801], "z", 24, "Communications control collar");
  cyl(g, M.rubber!, 0.027, 0.027, 0.036, [-0.96, 1.036, 0.817], "z", 24, "Communications control knob");
  for (const s of [-1, 1]) {
    const x = s * 1.075;
    const points: number[][] = [
      [x, 0.72, 0.91], [x - s * 0.014, 1.03, 0.765], [x - s * 0.008, 1.43, 0.66], [x - s * 0.044, 1.49, 0.6],
      [x - s * 0.074, 1.445, 0.53], [x - s * 0.086, 1.1, 0.38], [x - s * 0.088, 0.76, 0.1],
    ];
    if (s === -1) {
      tube(g, M.rubber!, points, 0.018, 80, 12, false, "Protective cable loom");
      const curve = new T.CatmullRomCurve3(points.map((p) => new T.Vector3(p[0], p[1], p[2])));
      for (let i = 0; i < 94; i += 1) {
        const u = i / 93;
        const p = curve.getPoint(u);
        const t = curve.getTangent(u);
        const ring = torus(g, M.recess!, 0.018, 0.0027, p.toArray(), [0, 0, 0], TAU, "Loom corrugation");
        ring.quaternion.setFromUnitVectors(FWD, t);
      }
    }
  }
  tube(g, M.rubber!, [[0.74, 0.83, 0.1], [0.68, 0.73, -0.1], [0.71, 0.61, -0.4], [0.85, 0.53, -0.69]], 0.011, 48, 10, false, "Radio cable harness");
  tube(g, M.rubber!, [[0.79, 0.79, 0.2], [0.69, 0.67, 0.26], [0.61, 0.58, 0.38], [0.75, 0.5, 0.48]], 0.007, 48, 10, false, "Secondary electrical lead");
  for (const s of [-1, 1]) {
    box(g, M.oliveLight!, 0.092, 0.155, 0.034, [s * 0.742, 0.95, -0.4], 0.006, "Junction plate");
    f.add([s * 0.742, 1.006, -0.377], [0, 0, 1], 0.008, true);
    f.add([s * 0.742, 0.892, -0.377], [0, 0, 1], 0.008, true);
    rod(g, M.steel!, [s * 0.83, 1.35, -0.24], [s * 0.94, 1.38, 0.67], 0.021, 18, "Upper side reinforcement");
    rod(g, M.recess!, [s * 0.8, 0.76, -0.61], [s * 0.91, 0.81, 0.64], 0.016, 12, "Side control conduit");
    for (const z of [-0.5, -0.05, 0.4]) box(g, M.oliveLight!, 0.034, 0.058, 0.064, [s * 0.85, 0.82, z], 0.004, "Conduit retaining clamp");
  }
  label(g, ["CHECK HARNESS", "BEFORE FLIGHT"], 0.22, 0.08, [0.4, 0.774, -1.236], { background: "#747767", size: 100, color: "#262e27", border: true, wear: 0.4 });
  box(g, M.oliveDark!, 0.29, 0.11, 0.22, [-0.55, 0.728, 0.07], 0.008, "Feed-belt collection case");
  f.finish();
  mergeStatic(g);
}

// ---------------------------------------------------------------------------------------------
// Twin gun (ported from the supplied `douglas-gunner.html`).
// ---------------------------------------------------------------------------------------------

interface GunMaterials {
  steel: T.MeshStandardMaterial;
  paint: T.MeshStandardMaterial;
  edge: T.MeshStandardMaterial;
  dark: T.MeshStandardMaterial;
  black: T.MeshStandardMaterial;
  parkerized: T.MeshStandardMaterial;
  brass: T.MeshStandardMaterial;
  copper: T.MeshStandardMaterial;
  grip: T.MeshStandardMaterial;
  label: T.MeshStandardMaterial;
  textures: T.Texture[];
}

function srgb(t: T.Texture): T.Texture {
  t.colorSpace = T.SRGBColorSpace;
  return t;
}

function surfaceMap(kind: "paint" | "steel" | "brass", seed: number): T.Texture | null {
  if (!canCanvas()) return null;
  const rand = createRandom(seed);
  const base = kind === "paint" ? [91, 96, 66] : kind === "brass" ? [148, 116, 64] : [67, 72, 77];
  return tex(512, 512, (ctx) => {
    const image = ctx.createImageData(512, 512);
    const field = Array.from({ length: 33 * 33 }, () => rand());
    for (let y = 0; y < 512; y += 1)
      for (let x = 0; x < 512; x += 1) {
        const fx = x / 16;
        const fy = y / 16;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const u = fx - ix;
        const v = fy - iy;
        const n =
          (field[iy * 33 + ix]! * (1 - u) + field[iy * 33 + ix + 1]! * u) * (1 - v) +
          (field[(iy + 1) * 33 + ix]! * (1 - u) + field[(iy + 1) * 33 + ix + 1]! * u) * v;
        const grain = (rand() - 0.5) * 20 + (n - 0.5) * 30;
        const k = (y * 512 + x) * 4;
        for (let i = 0; i < 3; i += 1) image.data[k + i] = base[i]! + grain;
        image.data[k + 3] = 255;
      }
    ctx.putImageData(image, 0, 0);
    for (let i = 0; i < 1600; i += 1) {
      const x = rand() * 512;
      const y = rand() * 512;
      const length = 2 + rand() * 40;
      ctx.strokeStyle = rand() > 0.4 ? `rgba(215,218,209,${0.025 + rand() * 0.1})` : `rgba(4,9,12,${rand() * 0.18})`;
      ctx.lineWidth = rand() < 0.96 ? 0.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + length, y + (rand() - 0.5) * 3);
      ctx.stroke();
    }
    if (kind === "paint")
      for (let i = 0; i < 140; i += 1) {
        const x = rand() * 512;
        const y = rand() < 0.65 ? (rand() < 0.5 ? rand() * 12 : 500 + rand() * 12) : rand() * 512;
        ctx.fillStyle = `rgba(188,183,147,${0.12 + rand() * 0.25})`;
        ctx.fillRect(x, y, 2 + rand() * 13, 0.5 + rand() * 2.3);
      }
  });
}

function makeGunMaterials(): GunMaterials {
  const steelMap = surfaceMap("steel", 19);
  const paintMap = surfaceMap("paint", 81);
  const brassMap = surfaceMap("brass", 37);
  const standard = (props: T.MeshStandardMaterialParameters): T.MeshStandardMaterial => new T.MeshStandardMaterial(props);
  const mk = (map: T.Texture | null, props: T.MeshStandardMaterialParameters): T.MeshStandardMaterial => {
    if (!map) return standard(props);
    return standard({ ...props, map, bumpMap: map });
  };
  // Dark blued steel, lifted off near-black so the receiver holds a mid-tone under the sky instead
  // of reading as flat plastic. `edge` is deliberately a muted worn steel — a bright chamfer along a
  // full receiver length reads as a cartoon outline — so it stays sparing and broken into segments.
  const steel = mk(steelMap, { metalness: 0.84, roughness: 0.38, bumpScale: 0.0035, envMapIntensity: 1.25, color: 0xd0dae4 });
  const paint = mk(paintMap, { metalness: 0.58, roughness: 0.6, bumpScale: 0.002, envMapIntensity: 0.75, color: 0xffffff });
  const brass = mk(brassMap, { metalness: 0.72, roughness: 0.52, envMapIntensity: 0.8, color: 0xc9b98f });
  const textures = [steelMap, paintMap, brassMap].filter((t): t is T.Texture => t !== null).map(srgb);
  return {
    steel,
    paint,
    edge: standard({ color: 0x7d837b, metalness: 0.9, roughness: 0.33 }),
    dark: standard({ color: 0x121719, metalness: 0.6, roughness: 0.45 }),
    black: standard({ color: 0x090c0d, roughness: 0.8 }),
    parkerized: mk(steelMap, { color: 0x292e2c, metalness: 0.76, roughness: 0.5 }),
    brass,
    copper: standard({ color: 0x76502f, metalness: 0.72, roughness: 0.5 }),
    grip: standard({ color: 0x1d1c19, roughness: 0.72, metalness: 0.08 }),
    label: standard({ color: 0xbab392, roughness: 0.65, metalness: 0.05 }),
    textures,
  };
}

function gunLabel(text: string, width = 512, height = 128, color = "#c0baa1"): T.MeshBasicMaterial {
  const map = tex(width, height, (c) => {
    c.clearRect(0, 0, width, height);
    c.fillStyle = color;
    c.font = `600 ${Math.floor(height * 0.36)}px monospace`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, width / 2, height / 2);
  });
  if (map) {
    // The label planes are the only transparent surfaces; clamp them like the study.
    map.wrapS = map.wrapT = T.ClampToEdgeWrapping;
  }
  return new T.MeshBasicMaterial({ ...(map ? { map } : {}), transparent: true, opacity: map ? 0.72 : 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
}

function roundedShape(w: number, h: number, r: number): T.Shape {
  const s = new T.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function roundedBox(w: number, h: number, d: number, radius = 0.015): T.BufferGeometry {
  const r = Math.min(radius, w / 4, h / 4, d / 4);
  const g = new T.ExtrudeGeometry(roundedShape(w - 2 * r, h - 2 * r, r), { depth: d - 2 * r, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: r, bevelThickness: r, curveSegments: 3 });
  g.translate(0, 0, -d / 2 + r);
  return g;
}

function gmesh(parent: T.Object3D, geo: T.BufferGeometry, mat: T.Material, x = 0, y = 0, z = 0, name = ""): T.Mesh {
  const m = new T.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function gbox(parent: T.Object3D, w: number, h: number, d: number, mat: T.Material, x: number, y: number, z: number, r = 0.012): T.Mesh {
  return gmesh(parent, roundedBox(w, h, d, r), mat, x, y, z);
}

function gcyl(parent: T.Object3D, radius: number, length: number, mat: T.Material, x: number, y: number, z: number, axis: "x" | "y" | "z" = "y", segments = 24, radius2 = radius): T.Mesh {
  const m = gmesh(parent, new T.CylinderGeometry(radius, radius2, length, segments), mat, x, y, z);
  if (axis === "z") m.rotation.x = Math.PI / 2;
  if (axis === "x") m.rotation.z = Math.PI / 2;
  return m;
}

function gtorus(parent: T.Object3D, radius: number, thickness: number, mat: T.Material, x: number, y: number, z: number, axis: "x" | "y" | "z" = "z", arc = TAU): T.Mesh {
  const m = gmesh(parent, new T.TorusGeometry(radius, thickness, 6, Math.max(12, Math.ceil((20 * arc) / TAU)), arc), mat, x, y, z);
  if (axis === "y") m.rotation.x = Math.PI / 2;
  if (axis === "x") m.rotation.y = Math.PI / 2;
  return m;
}

function grod(parent: T.Object3D, a: number[], b: number[], radius: number, mat: T.Material): T.Mesh {
  const av = new T.Vector3(a[0]!, a[1]!, a[2]!);
  const bv = new T.Vector3(b[0]!, b[1]!, b[2]!);
  const dir = bv.clone().sub(av);
  const m = gmesh(parent, new T.CylinderGeometry(radius, radius, dir.length(), 12), mat);
  m.position.copy(av.add(bv).multiplyScalar(0.5));
  m.quaternion.setFromUnitVectors(UP, dir.normalize());
  return m;
}

function gbolt(parent: T.Object3D, x: number, y: number, z: number, axis: "x" | "y" | "z", M: GunMaterials, radius = 0.035): void {
  gcyl(parent, radius * 1.28, 0.013, M.dark!, x, y, z, axis, 10);
  gcyl(parent, radius, 0.025, M.edge!, x, y, z, axis, 6);
  const notch = gbox(parent, radius * 1.25, 0.004, 0.007, M.dark!, x, y + 0.014, z, 0.001);
  if (axis === "x") {
    notch.rotation.z = Math.PI / 2;
    notch.position.set(x + 0.014, y, z);
  }
  if (axis === "z") {
    notch.rotation.x = Math.PI / 2;
    notch.position.set(x, y, z + 0.014);
  }
}

function gxyPlate(parent: T.Object3D, pts: number[][], holes: number[][], depth: number, mat: T.Material, x = 0, y = 0, z = 0): T.Mesh {
  const shape = new T.Shape();
  pts.forEach((p, i) => (i ? shape.lineTo(p[0]!, p[1]!) : shape.moveTo(p[0]!, p[1]!)));
  shape.closePath();
  for (const h of holes) {
    const p = new T.Path();
    p.absellipse(h[0]!, h[1]!, h[2]!, h[3] ?? h[2]!, 0, TAU, true);
    shape.holes.push(p);
  }
  const g = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1, curveSegments: 10 });
  g.translate(0, 0, -depth / 2);
  return gmesh(parent, g, mat, x, y, z);
}

function gsidePlate(parent: T.Object3D, ptsZY: number[][], holesZY: number[][], depth: number, mat: T.Material, x: number): T.Mesh {
  const m = gxyPlate(parent, ptsZY.map((p) => [-p[0]!, p[1]!]), holesZY.map((h) => [-h[0]!, h[1]!, h[2]!, h[3]!]), depth, mat, x, 0, 0);
  m.rotation.y = Math.PI / 2;
  return m;
}

function geye(parent: T.Object3D, x: number, y: number, z: number, M: GunMaterials, w = 0.14, h = 0.27): T.Mesh {
  const s = roundedShape(w, h, w * 0.4);
  const hole = new T.Path();
  hole.absellipse(0, h * 0.17, w * 0.3, h * 0.2, 0, TAU, true);
  s.holes.push(hole);
  const g = new T.ExtrudeGeometry(s, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1, curveSegments: 10 });
  return gmesh(parent, g, M.steel!, x, y, z);
}

/**
 * The ring-and-cross sight: a thin wire ring on a foot bracketed to the jacket, deliberately
 * **larger than the barrel jacket** so the hoop silhouettes against the sky instead of reading as a
 * bead on the muzzle. `radius` is in gun-local units (the weapon is normalised by ~0.22, so 0.18
 * reads as an ~8 cm hoop in the world). 36 tube segments: at 20 the hoop was visibly polygonal.
 */
function gringSight(parent: T.Object3D, x: number, y: number, z: number, M: GunMaterials, radius = 0.18): void {
  const jacketTop = 0.223;
  // Foot bracket + clamp bolt on the jacket crown, then the post up to the ring's lower arc.
  gbox(parent, 0.11, 0.05, 0.12, M.steel!, x, jacketTop - 0.012, z, 0.012);
  gbolt(parent, x + 0.062, jacketTop - 0.012, z, "x", M, 0.016);
  grod(parent, [x, jacketTop + 0.005, z], [x, y - radius + 0.012, z], 0.013, M.steel!);
  gmesh(parent, new T.TorusGeometry(radius, 0.0085, 6, 36), M.steel!, x, y, z, "ring-sight-hoop");
  gbox(parent, 0.009, radius * 2, 0.0085, M.steel!, x, y, z, 0.002);
  gbox(parent, radius * 2, 0.009, 0.0085, M.steel!, x, y, z, 0.002);
}

function gperforatedJacket(radius = 0.144, length = 2.34): T.BufferGeometry {
  const pos: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const columns = 8;
  const rows = 10;
  const cellW = (TAU * radius) / columns;
  const cellH = length / rows;
  const rx = 0.042;
  const ry = 0.048;
  const thickness = 0.014;
  const ringSteps = 2;
  const angles: number[] = [];
  for (let i = 0; i < 32; i += 1) angles.push((i * TAU) / 32);
  const corner = Math.atan2(cellH * 0.5, cellW * 0.5);
  for (const a of [corner, Math.PI - corner, Math.PI + corner, TAU - corner]) angles.push(a);
  angles.sort((a, b) => a - b);
  const n = angles.length;
  const vertex = (u: number, v: number, r: number, nu: number, nv: number, nr: number): number => {
    const phi = u / radius;
    const ss = Math.sin(phi);
    const cc = Math.cos(phi);
    const index = pos.length / 3;
    pos.push(r * ss, r * cc, -v);
    const normal = new T.Vector3(nu * cc + nr * ss, -nu * ss + nr * cc, -nv).normalize();
    normals.push(normal.x, normal.y, normal.z);
    uvs.push((u / (TAU * radius)) * 2, (v / length) * 3);
    return index;
  };
  for (let row = 0; row < rows; row += 1)
    for (let col = 0; col < columns; col += 1) {
      const uc = (col + 0.5) * cellW;
      const vc = (row + 0.5) * cellH;
      for (let face = 0; face < 2; face += 1) {
        const offset = pos.length / 3;
        const r = radius + (face ? 0 : thickness);
        const normal = face ? -1 : 1;
        for (let k = 0; k <= ringSteps; k += 1)
          for (const a of angles) {
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const outer = Math.min((cellW * 0.5) / Math.max(Math.abs(ca), 1e-8), (cellH * 0.5) / Math.max(Math.abs(sa), 1e-8));
            const t = k / ringSteps;
            const u = uc + ca * (rx + (outer - rx) * t);
            const v = vc + sa * (ry + (outer - ry) * t);
            vertex(u, v, r, 0, 0, normal);
          }
        for (let k = 0; k < ringSteps; k += 1)
          for (let j = 0; j < n; j += 1) {
            const a = offset + k * n + j;
            const b = offset + (k + 1) * n + j;
            const c = offset + (k + 1) * n + ((j + 1) % n);
            const d = offset + k * n + ((j + 1) % n);
            if (face) indices.push(a, c, b, a, d, c);
            else indices.push(a, b, c, a, c, d);
          }
      }
      const holeStart = pos.length / 3;
      for (const a of angles) for (const r of [radius + thickness, radius]) vertex(uc + Math.cos(a) * rx, vc + Math.sin(a) * ry, r, -Math.cos(a) / rx, -Math.sin(a) / ry, 0);
      for (let j = 0; j < n; j += 1) {
        const a = holeStart + j * 2;
        const b = a + 1;
        const d = holeStart + ((j + 1) % n) * 2;
        const c = d + 1;
        indices.push(a, d, c, a, c, b);
      }
    }
  for (const v of [0, length]) {
    const start = pos.length / 3;
    for (let i = 0; i <= 128; i += 1) for (const r of [radius, radius + thickness]) vertex((i / 128) * TAU * radius, v, r, 0, v === 0 ? -1 : 1, 0);
    for (let i = 0; i < 128; i += 1) {
      const a = start + 2 * i;
      if (v === 0) indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
      else indices.push(a, a + 3, a + 2, a, a + 1, a + 3);
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
  g.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeBoundingSphere();
  return g;
}

/**
 * Merge a gun subassembly's static meshes per material, keeping named moving groups.
 *
 * The walk, the grouping by material, the baked transforms and the one buffer per material are the
 * engine's `mergeByMaterial`. What stays here is the two appearance decisions this airframe owns:
 * every merged surface takes the subassembly's `-surface` name and the cast/receive flags `gmesh`
 * gives every other part. It does not touch the root, so the pieces it took are dropped here —
 * leaving them would draw the subassembly twice.
 */
function gbake(root: T.Object3D): void {
  const merged = mergeByMaterial(root, { label: root.name || "gun" });
  const materials = new Set(merged.map((m) => m.material));
  const sources: T.Mesh[] = [];
  root.traverse((o) => {
    const m = o as T.Mesh;
    if (m.isMesh && !(m as unknown as T.InstancedMesh).isInstancedMesh && materials.has(m.material as T.Material))
      sources.push(m);
  });
  for (const m of sources) {
    m.removeFromParent();
    m.geometry.dispose();
  }
  for (const m of merged) {
    m.name = `${root.name}-surface`;
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
  }
}

function cartridgeGeometries(): { brass: T.BufferGeometry; tip: T.BufferGeometry; links: T.BufferGeometry } {
  // A .30 case, the same profile at 0.62 scale: the full-width case telescopes into its fore-and-aft
  // neighbour in the belt.
  const profile = [[0.022, 0], [0.024, 0.012], [0.021, 0.025], [0.021, 0.17], [0.017, 0.202], [0.014, 0.208], [0.014, 0.244]];
  const brass = new T.LatheGeometry(profile.map((p) => new T.Vector2(p[0]!, p[1]!)), 12);
  brass.rotateX(-Math.PI / 2);
  brass.translate(0, 0, 0.13);
  const tip = new T.LatheGeometry([[0.014, 0], [0.0135, 0.027], [0.012, 0.055], [0.008, 0.078], [0.001, 0.11]].map((p) => new T.Vector2(p[0]!, p[1]!)), 12);
  tip.rotateX(-Math.PI / 2);
  tip.translate(0, 0, -0.114);
  const links = new T.TorusGeometry(0.028, 0.009, 6, 14, Math.PI * 1.72);
  links.translate(0, 0, 0.015);
  return { brass, tip, links };
}

/** The supplied twin gun. Static geometry is baked per material; the moving groups stay separate. */
function buildTwinGun(): {
  group: T.Group;
  muzzles: T.Object3D[];
  barrels: T.Object3D[];
  covers: T.Object3D[];
  handles: T.Object3D[];
  lids: T.Object3D[];
  belts: T.Object3D[];
} {
  const M = makeGunMaterials();
  const group = new T.Group();
  group.name = "ProceduralTwinAircraftGun";
  const base = new T.Group();
  base.name = "SwivelFoot";
  group.add(base);
  gcyl(base, 0.34, 0.11, M.paint!, 0.91, 0.095, 0.59);
  gcyl(base, 0.28, 0.04, M.edge!, 0.91, 0.16, 0.59);
  gcyl(base, 0.205, 0.22, M.dark!, 0.91, 0.24, 0.59);
  for (let i = 0; i < 6; i += 1) gbolt(base, 0.91 + Math.cos((i * TAU) / 6) * 0.265, 0.166, 0.59 + Math.sin((i * TAU) / 6) * 0.265, "y", M, 0.028);
  gbake(base);
  const swivel = new T.Group();
  swivel.name = "TraversePivot";
  swivel.position.set(0.91, 0.2, 0.59);
  group.add(swivel);
  const assembly = new T.Group();
  assembly.position.set(-0.91, -0.2, -0.59);
  swivel.add(assembly);
  const frame = new T.Group();
  frame.name = "OliveCradleSupport";
  assembly.add(frame);
  gsidePlate(frame, [[0.34, 0.27], [0.83, 0.27], [0.94, 0.44], [0.86, 0.74], [0.62, 1.13], [0.51, 1.46], [0.69, 1.93], [0.58, 2.13], [0.36, 2.23], [0.16, 2.1], [0.05, 1.85], [-0.12, 1.55], [-0.3, 1.33], [-0.18, 1.2], [0.02, 1.1], [0.22, 0.67]],
    [[0.5, 0.51, 0.105, 0.115], [0.39, 0.87, 0.11, 0.15], [0.18, 1.27, 0.095, 0.15]], 0.095, M.paint!, 0.94);
  grod(frame, [0.999, 0.38, 0.37], [0.999, 1.2, 0.1], 0.025, M.edge!);
  grod(frame, [0.999, 0.4, 0.8], [0.999, 1.7, 0.47], 0.027, M.paint!);
  gbox(frame, 0.2, 0.16, 0.54, M.paint!, 0.94, 0.3, 0.59, 0.028);
  gbolt(frame, 1.01, 0.42, 0.43, "x", M, 0.058);
  gbolt(frame, 1.01, 1.24, 0.02, "x", M, 0.066);
  gcyl(frame, 0.17, 0.16, M.paint!, 0.94, 2.08, 0.35, "x");
  gcyl(frame, 0.115, 0.19, M.edge!, 0.94, 2.08, 0.35, "x");
  gbolt(frame, 1.07, 2.08, 0.35, "x", M, 0.085);
  gcyl(frame, 0.053, 0.26, M.steel!, 1.08, 1.53, 0.39, "x");
  gcyl(frame, 0.104, 0.055, M.dark!, 1.23, 1.53, 0.39, "x", 10);
  gbolt(frame, 1.27, 1.53, 0.39, "x", M, 0.049);
  const bow = new T.CatmullRomCurve3([[-0.95, 2.08, 0.35], [-1.06, 1.72, -0.16], [-0.65, 1.51, -0.75], [0.39, 1.48, -0.78], [0.96, 1.65, -0.26], [0.95, 2.08, 0.35]].map((v) => new T.Vector3(v[0]!, v[1]!, v[2]!)));
  gmesh(frame, new T.TubeGeometry(bow, 48, 0.063, 10, false), M.paint!);
  gcyl(frame, 0.112, 0.13, M.paint!, -0.96, 2.08, 0.35, "x");
  gbolt(frame, -1.04, 2.08, 0.35, "x", M, 0.068);
  gbake(frame);
  const elevation = new T.Group();
  elevation.name = "ElevationPivot";
  elevation.position.set(0, 2.08, 0.35);
  assembly.add(elevation);
  const cradle = new T.Group();
  cradle.name = "TwinGunCradle";
  elevation.add(cradle);
  grod(cradle, [-0.99, 0, 0], [0.99, 0, 0], 0.075, M.steel!);
  // Trunnion bearings either side of the yoke.
  for (const x of [-0.34, 0.34]) gtorus(cradle, 0.115, 0.022, M.steel!, x, 0, 0, "x");
  for (const x of [-0.72, 0.72]) {
    gbox(cradle, 0.09, 0.14, 1.72, M.paint!, x, -0.24, 0.15);
    gsidePlate(cradle, [[-0.75, -0.29], [-0.75, 0.29], [-0.57, 0.33], [-0.43, 0.1], [0.54, -0.11], [1.02, -0.1], [1.03, -0.29]], [[-0.64, 0.18, 0.045, 0.053]], 0.07, M.paint!, x);
    gbolt(cradle, x, -0.2, -0.61, "x", M, 0.052);
    gbolt(cradle, x, -0.2, 0.81, "x", M, 0.045);
    grod(cradle, [x, -0.2, -0.5], [x, 0.19, -0.71], 0.025, M.edge!);
  }
  gbox(cradle, 1.5, 0.11, 0.1, M.paint!, 0, -0.24, -0.63);
  gbox(cradle, 1.55, 0.1, 0.13, M.paint!, 0, -0.26, 0.94);
  gbake(cradle);

  const muzzles: T.Object3D[] = [];
  // The authored vented barrels, kept so a live shot can kick them back along the bore.
  const barrels: T.Object3D[] = [];
  // The authored feed cycle parts, kept so a belt change can open the cover, pulse the charging
  // handle, lift the box lid and draw the belt through, exactly as the supplied controller did.
  const covers: T.Object3D[] = [];
  const handles: T.Object3D[] = [];
  const lids: T.Object3D[] = [];
  const belts: T.Object3D[] = [];
  const bulletGeo = cartridgeGeometries();
  for (let side = 0; side < 2; side += 1) {
    const sign = side ? 1 : -1;
    const x = sign * 0.405;
    const gun = new T.Group();
    gun.name = side ? "RightGun" : "LeftGun";
    gun.position.x = x;
    elevation.add(gun);
    const shell = new T.Group();
    shell.name = `${gun.name}-Receiver`;
    gun.add(shell);
    // Stepped breech, not one flat slab: a slim body carrying a proud machined band, a raised rear
    // block that meets the cover, a tapered forward shoulder, and an exposed feed tray between the
    // cover rails. The chamfers are broken into short segments instead of one full-length strip: a
    // continuous bright line down the whole receiver read as a cartoon outline.
    gbox(shell, 0.43, 0.34, 1.69, M.steel!, 0, 0.01, 0.14, 0.016);
    gbox(shell, 0.452, 0.1, 0.5, M.steel!, 0, -0.02, 0.36, 0.014);
    gbox(shell, 0.12, 0.145, 0.92, M.steel!, 0.14, 0.235, 0.59, 0.012);
    gbox(shell, 0.12, 0.145, 0.92, M.steel!, -0.14, 0.235, 0.59, 0.012);
    gbox(shell, 0.17, 0.05, 0.9, M.dark!, 0, 0.243, 0.59, 0.006);
    gbox(shell, 0.03, 0.022, 0.88, M.steel!, 0.082, 0.262, 0.59, 0.004);
    gbox(shell, 0.03, 0.022, 0.88, M.steel!, -0.082, 0.262, 0.59, 0.004);
    gbox(shell, 0.14, 0.05, 0.34, M.edge!, 0, 0.272, 0.74, 0.01);
    gbox(shell, 0.41, 0.10, 0.62, M.steel!, 0, 0.20, -0.32, 0.012);
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 3; k += 1) gbox(shell, 0.012, 0.016, 0.26, M.edge!, sx * 0.207, 0.135, -0.46 + k * 0.5, 0.003);
      for (let k = 0; k < 3; k += 1) gbox(shell, 0.009, 0.018, 0.28, M.edge!, sx * 0.244, -0.075, -0.42 + k * 0.56, 0.002);
      gbox(shell, 0.01, 0.014, 0.4, M.edge!, sx * 0.192, 0.30, 0.42, 0.003);
      gbox(shell, 0.01, 0.014, 0.34, M.edge!, sx * 0.192, 0.30, 0.86, 0.003);
    }
    gbox(shell, 0.39, 0.075, 1.64, M.dark!, 0, -0.19, 0.14);
    gbox(shell, 0.044, 0.36, 1.47, M.steel!, 0.218, 0.05, 0.12, 0.011);
    gbox(shell, 0.044, 0.36, 1.47, M.steel!, -0.218, 0.05, 0.12, 0.011);
    gbox(shell, 0.45, 0.075, 0.13, M.edge!, 0, 0.228, -0.59, 0.013);
    for (const lz of [0.16, 0.72]) {
      gbox(shell, 0.03, 0.055, 0.10, M.edge!, 0.222, 0.10, lz, 0.006);
      gbox(shell, 0.03, 0.055, 0.10, M.edge!, -0.222, 0.10, lz, 0.006);
      gbolt(shell, 0.228, 0.10, lz, "x", M, 0.017);
      gbolt(shell, -0.228, 0.10, lz, "x", M, 0.017);
    }
    for (const sx of [-1, 1]) {
      // Ejection port: a raised steel surround with the dark opening recessed inside it.
      gbox(shell, 0.024, 0.2, 0.46, M.steel!, sx * 0.232, 0.025, -0.24, 0.006);
      gbox(shell, 0.014, 0.14, 0.38, M.dark!, sx * 0.246, 0.025, -0.24, 0.003);
      gbox(shell, 0.018, 0.04, 0.51, M.steel!, sx * 0.255, -0.15, -0.2, 0.004);
      for (const z of [-0.55, -0.32, 0.28, 0.58, 0.82]) {
        gbolt(shell, sx * 0.251, 0.179, z, "x", M, 0.021);
        gbolt(shell, sx * 0.251, -0.107, z, "x", M, 0.019);
      }
    }
    gcyl(shell, 0.17, 0.14, M.dark!, 0, 0.065, -0.73, "z");
    gcyl(shell, 0.164, 0.07, M.edge!, 0, 0.065, -0.8, "z");
    // Rear buffer: a distinct stepped backplate, its buffer disc, and a latch lever on the outside.
    gbox(shell, 0.32, 0.33, 0.075, M.steel!, 0, 0.03, 1.07, 0.016);
    gbox(shell, 0.26, 0.28, 0.06, M.dark!, 0, 0.03, 1.13, 0.012);
    gcyl(shell, 0.105, 0.1, M.steel!, 0, 0.04, 1.02, "z");
    gcyl(shell, 0.068, 0.06, M.edge!, 0, 0.04, 1.17, "z", 20);
    grod(shell, [0.14, 0.12, 1.11], [0.25, 0.2, 1.15], 0.02, M.edge!);
    gbox(shell, 0.075, 0.05, 0.05, M.steel!, 0.26, 0.21, 1.15, 0.008);
    // Spade grip: a smooth black casting that sweeps down and outboard, with a flattened end plate.
    const gripCurve = new T.CatmullRomCurve3([[0, -0.11, 1.21], [sign * 0.02, -0.24, 1.26], [sign * 0.06, -0.35, 1.32], [sign * 0.085, -0.42, 1.37]].map((v) => new T.Vector3(v[0]!, v[1]!, v[2]!)));
    gmesh(shell, new T.TubeGeometry(gripCurve, 12, 0.05, 10, false), M.grip!);
    gbox(shell, 0.115, 0.05, 0.09, M.grip!, sign * 0.09, -0.435, 1.38, 0.024);
    gbox(shell, 0.07, 0.036, 0.07, M.edge!, sign * 0.09, -0.462, 1.38, 0.014);
    gcyl(shell, 0.07, 0.035, M.steel!, 0, 0.026, 1.24);
    gcyl(shell, 0.062, 0.032, M.steel!, sign * 0.02, -0.20, 1.245);
    grod(shell, [0, 0.04, 1.025], [0, 0.04, 1.245], 0.034, M.steel!);
    grod(shell, [0, -0.34, 1.025], [0, -0.34, 1.285], 0.028, M.steel!);
    gbox(shell, 0.035, 0.075, 0.05, M.dark!, 0, -0.045, 1.35, 0.01);
    gbox(shell, 0.11, 0.12, 0.39, M.dark!, sign * 0.285, 0.08, -0.12);
    gbox(shell, 0.17, 0.028, 0.44, M.edge!, sign * 0.31, -0.006, -0.09, 0.004);
    const idMat = gunLabel(side ? "AIRCRAFT / R" : "AIRCRAFT / L");
    const idPlate = gmesh(shell, new T.PlaneGeometry(0.69, 0.17), idMat, sign * 0.253, 0.005, 0.47);
    idPlate.rotation.y = (sign * Math.PI) / 2;
    gbake(shell);

    const cover = new T.Group();
    cover.name = `${gun.name}-FeedCover`;
    cover.position.set(0, 0.302, -0.66);
    gun.add(cover);
    covers.push(cover);
    gbox(cover, 0.431, 0.058, 1.65, M.steel!, 0, 0, 0.825, 0.014);
    gbox(cover, 0.245, 0.023, 1.15, M.dark!, 0, 0.039, 0.89, 0.009);
    gbox(cover, 0.235, 0.018, 0.33, M.steel!, 0, 0.051, 0.42, 0.008);
    // The cover is the receiver's top surface, so it carries the long ridge, edge seams and latch
    // blocks instead of reading as one blank lid.
    gbox(cover, 0.10, 0.02, 1.44, M.steel!, 0, 0.036, 0.86, 0.006);
    // Broken chamfers, plus the raised machined spines and the two cover hinge lugs on the top
    // surfaces. The rear aperture is a slim open loop, not a wide holed plate.
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 3; k += 1) gbox(cover, 0.014, 0.014, 0.28, M.edge!, sx * 0.205, 0.03, 0.2 + k * 0.46, 0.003);
      gbox(cover, 0.016, 0.02, 0.62, M.steel!, sx * 0.13, 0.041, 0.72, 0.005);
      gbox(cover, 0.022, 0.05, 0.06, M.steel!, sx * 0.2, -0.03, 0.02, 0.006);
      gbolt(cover, sx * 0.2, -0.03, 0.02, "x", M, 0.013);
    }
    for (const lz of [0.18, 0.66, 1.14]) {
      gbox(cover, 0.05, 0.032, 0.10, M.steel!, 0, 0.045, lz, 0.008);
      gbolt(cover, 0, 0.061, lz, "y", M, 0.015);
    }
    gcyl(cover, 0.038, 0.46, M.edge!, 0, 0.014, 0.07, "x", 18);
    gbox(cover, 0.16, 0.043, 0.12, M.steel!, 0, 0.026, 1.51, 0.008);
    geye(cover, 0.1, 0.185, 1.42, M, 0.055, 0.12);
    gbox(cover, 0.24, 0.045, 0.09, M.steel!, 0.05, 0.049, 1.37, 0.007);
    gbolt(cover, -0.135, 0.038, 1.33, "y", M, 0.023);
    gbolt(cover, 0.13, 0.038, 0.27, "y", M, 0.022);
    gbake(cover);

    const handle = new T.Group();
    handle.name = `${gun.name}-ChargingHandle`;
    handle.position.set(sign * 0.29, 0.1, 0.13);
    gun.add(handle);
    handles.push(handle);
    grod(handle, [0, 0, 0], [sign * 0.13, 0, 0], 0.024, M.edge!);
    gcyl(handle, 0.046, 0.105, M.dark!, sign * 0.13, 0, 0, "y", 12);
    gbake(handle);

    const barrel = new T.Group();
    barrel.name = `${gun.name}-VentedBarrel`;
    gun.add(barrel);
    barrels.push(barrel);
    gcyl(barrel, 0.056, 2.92, M.dark!, 0, 0.065, -2.22, "z");
    // A dark sleeve inside the jacket: without it the holes showed the lit inner wall and read as
    // almost no perforation at all.
    gcyl(barrel, 0.10, 2.1, M.black!, 0, 0.065, -1.42, "z", 16);
    gmesh(barrel, gperforatedJacket(), M.steel!, 0, 0.065, -0.84, "perforated-jacket");
    for (const z of [-0.9, -3.12, -3.19]) gcyl(barrel, 0.159, z === -3.12 ? 0.025 : 0.073, M.steel!, 0, 0.065, z, "z");
    for (const z of [-0.89, -3.195]) gtorus(barrel, 0.154, 0.006, M.edge!, 0, 0.065, z);
    gcyl(barrel, 0.122, 0.27, M.steel!, 0, 0.065, -3.32, "z");
    gtorus(barrel, 0.116, 0.007, M.edge!, 0, 0.065, -3.44);
    gcyl(barrel, 0.094, 0.3, M.steel!, 0, 0.065, -3.56, "z");
    const muzzleTube = new T.LatheGeometry([[0.055, 0], [0.098, 0], [0.103, 0.025], [0.091, 0.18], [0.055, 0.18]].map((v) => new T.Vector2(v[0]!, v[1]!)), 24);
    muzzleTube.rotateX(Math.PI / 2);
    gmesh(barrel, muzzleTube, M.steel!, 0, 0.065, -3.78);
    const bore = gmesh(barrel, new T.CircleGeometry(0.055, 24), M.black!, 0, 0.065, -3.735);
    bore.rotation.y = Math.PI;
    gtorus(barrel, 0.078, 0.006, M.edge!, 0, 0.065, -3.778);
    // Ring-and-cross sight on a post over the jacket, sized wider than the jacket so the hoop
    // silhouettes against the sky.
    gringSight(barrel, 0, 0.58, -1.95, M);
    gbox(barrel, 0.05, 0.10, 0.05, M.steel!, 0, 0.165, -3.19, 0.008);
    for (const sx of [-1, 1]) gbox(barrel, 0.025, 0.026, 0.137, M.dark!, sx * 0.087, 0.065, -3.55, 0.009);
    gbake(barrel);
    const muzzle = new T.Object3D();
    muzzle.name = `${gun.name}-Muzzle`;
    muzzle.position.set(0, 0.065, -3.8);
    gun.add(muzzle);
    muzzles.push(muzzle);

    const bin = new T.Group();
    bin.name = `${gun.name}-AmmoBox`;
    bin.position.set(sign * 0.83, -0.5, 0.11);
    gun.add(bin);
    const binBody = new T.Group();
    binBody.name = `${gun.name}-AmmoBoxBody`;
    bin.add(binBody);
    gbox(binBody, 0.47, 0.62, 0.6, M.paint!, 0, -0.055, 0.06, 0.033);
    gbox(binBody, 0.489, 0.065, 0.62, M.paint!, 0, 0.283, 0.06, 0.02);
    for (const z of [-0.2, 0.3]) gbox(binBody, 0.025, 0.51, 0.031, M.paint!, sign * 0.247, -0.05, z, 0.009);
    gbox(binBody, 0.49, 0.031, 0.62, M.edge!, 0, -0.315, 0.06, 0.004);
    gbox(binBody, 0.027, 0.2, 0.13, M.dark!, sign * 0.25, 0.1, 0.07, 0.006);
    gbolt(binBody, sign * 0.271, 0.162, 0.07, "x", M, 0.025);
    const stencil = gmesh(binBody, new T.PlaneGeometry(0.45, 0.13), gunLabel("BELT / 120"), 0, -0.035, -0.246);
    stencil.rotation.y = Math.PI;
    gbake(binBody);
    const binLid = new T.Group();
    binLid.name = `${gun.name}-AmmoBoxLid`;
    binLid.position.set(0, 0.31, 0.34);
    bin.add(binLid);
    lids.push(binLid);
    gbox(binLid, 0.475, 0.034, 0.59, M.paint!, 0, 0, -0.29, 0.012);
    gbake(binLid);

    // A linked ladder: the feed runs across the gun, so every round's long axis lies fore-and-aft
    // along the bore (-Z) and only the route bends in X/Y, from the receiver's feed out and down
    // into the box. Rounds are placed by the route's own arclength, spaced at a pitch just above the
    // 0.048 case width so the cartridges abut and read as one belt rather than loose rounds.
    const curve = new T.CatmullRomCurve3(
      [
        [sign * 0.24, 0.1, -0.06],
        [sign * 0.5, 0.185, -0.06],
        [sign * 0.76, 0.135, -0.06],
        [sign * 0.94, -0.09, -0.05],
        [sign * 0.88, -0.3, -0.04],
        [sign * 0.8, -0.46, -0.03],
      ].map((v) => new T.Vector3(v[0]!, v[1]!, v[2]!)),
    );
    const count = Math.max(2, Math.round(curve.getLength() / 0.054));
    const inst: T.InstancedMesh[] = [];
    for (const [geo, mat, n] of [
      [bulletGeo.brass, M.brass!, count],
      [bulletGeo.tip, M.copper!, count],
      [bulletGeo.links, M.dark!, count - 1],
    ] as const) {
      const m = new T.InstancedMesh(geo, mat, n);
      m.name = `${gun.name}-Belt`;
      m.instanceMatrix.setUsage(T.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      gun.add(m);
      inst.push(m);
      belts.push(m);
    }
    // Resting feed route; setReload moves the belt meshes together during a belt change.
    const matrix = new T.Matrix4();
    const q = new T.Quaternion();
    const one = new T.Vector3(1, 1, 1);
    const axis = new T.Vector3();
    const chord = new T.Vector3();
    const prev = new T.Vector3();
    for (let i = 0; i < count; i += 1) {
      const t = (i + 1) / (count + 1);
      const cp = curve.getPointAt(t);
      const tangent = curve.getTangentAt(t);
      axis.set(tangent.x * 0.16, tangent.y * 0.16, -1).normalize();
      q.setFromUnitVectors(FWD.clone().negate(), axis);
      matrix.compose(cp, q, one);
      inst[0]!.setMatrixAt(i, matrix);
      inst[1]!.setMatrixAt(i, matrix);
      // One dark link ring per gap, its axis on the chord between the two rounds, so the rounds are
      // visibly joined along the route instead of floating apart.
      if (i > 0) {
        chord.subVectors(cp, prev).normalize();
        q.setFromUnitVectors(FWD, chord);
        matrix.compose(cp.clone().add(prev).multiplyScalar(0.5), q, one);
        inst[2]!.setMatrixAt(i - 1, matrix);
      }
      prev.copy(cp);
    }
  }
  const bridge = new T.Group();
  bridge.name = "RearTriggerBridge";
  elevation.add(bridge);
  grod(bridge, [-0.4, -0.16, 1.27], [0.4, -0.16, 1.27], 0.021, M.steel!);
  gbox(bridge, 0.17, 0.08, 0.095, M.dark!, 0, -0.14, 1.31, 0.01);
  gbake(bridge);
  // The supplied gun aims on its own hinges; the station drives it rigidly about the measured hinge
  // instead (see `createRearStation`), so the articulated sub-groups are left at rest for the look.
  elevation.rotation.x = 0;
  return { group, muzzles, barrels, covers, handles, lids, belts };
}

// ---------------------------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------------------------

export interface RearStation {
  /** The whole station, in aircraft-root coordinates; add it to the player's mesh. */
  group: T.Group;
  /** The first-person cockpit shell (structure, glazing, seat, equipment). Visible only in the rear FPP. */
  shell: T.Group;
  /** The visible gun pivot, exactly on the sim's hinge; the renderer writes its `YXZ` euler. */
  pivot: T.Group;
  /** The gun's muzzle nodes, in the airframe frame once the pivot is at rest. */
  muzzles: T.Object3D[];
  /** Measured residual between the visible muzzles and the fired mouths, in metres. */
  muzzleError: number;
  /** Uniform scale the supplied weapon was normalised by. */
  weaponScale: number;
  /**
   * Kick the two authored barrels back along the bore, in metres (0 = battery). Render-only: the
   * sim's byte-ballistics are untouched, and a refused or empty trigger never produces a kick.
   */
  setRecoil(metres: number): void;
  /**
   * Drive the authored belt-change cycle, `open` 0..1. Render-only: cover, lid, charging handle and
   * belt move; the sim's ammunition and the round ballistics are untouched.
   */
  setReload(open: number): void;
  /** Release every geometry, material and texture this station built. */
  dispose(): void;
}

/**
 * Build the player's first-person rear station for one airframe: the supplied shell fitted to the
 * live camera anchor, and the supplied twin gun normalised onto the sim's measured mouths.
 *
 * The shell is yawed π (barrels and the study's forward both face aft), scaled uniformly so its
 * declared eye lands on `gunnerEye + [0,0.03,-0.32]`, and translated there. The gun keeps its own
 * hinge geometry but is driven rigidly by the pivot at `REAR_GUN_MOUNTS[airframe].pivot`, so its
 * two visible muzzles coincide with `rearGunMuzzle` within `muzzleError` at every aim.
 */
export function createRearStation(airframe: string, gunnerEye: readonly [number, number, number]): RearStation | null {
  const mount: RearGunMount | undefined = REAR_GUN_MOUNTS[airframe];
  if (!mount) return null;
  const group = new T.Group();
  group.name = "Rear station";

  // Shell: one authored build, per-airframe placement.
  const shell = new T.Group();
  shell.name = "Rear station shell";
  shell.visible = false;
  group.add(shell);
  const materials = makeShellMaterials();
  const native = new T.Group();
  native.name = "Rear cockpit";
  buildAirframe(native, materials);
  buildCanopy(native, materials);
  buildSeat(native, materials);
  buildEquipment(native, materials, airframe);
  shell.add(native);

  // The live camera anchor, `gunnerEye + [0,0.03,-0.32]`, matching world.ts's authored framing.
  const anchor = new T.Vector3(gunnerEye[0] + CAMERA_OFFSET[0], gunnerEye[1] + CAMERA_OFFSET[1], gunnerEye[2] + CAMERA_OFFSET[2]);
  const hinge = new T.Vector3(mount.pivot[0], mount.pivot[1], mount.pivot[2]);
  const eyeToMount = new T.Vector3(SHELL_EYE[0] - SHELL_MOUNT[0], SHELL_EYE[1] - SHELL_MOUNT[1], SHELL_EYE[2] - SHELL_MOUNT[2]).length();
  const shellScale = anchor.distanceTo(hinge) / eyeToMount;
  // world = P + Ry(π)·(S·p). Place the study's eye on the anchor.
  const shellP = anchor.clone().sub(new T.Vector3(-SHELL_EYE[0], SHELL_EYE[1], -SHELL_EYE[2]).multiplyScalar(shellScale));
  shell.position.copy(shellP);
  shell.rotation.y = Math.PI;
  shell.scale.setScalar(shellScale);

  // Gun: normalise the supplied weapon onto the measured mouths, then hinge it on the sim pivot.
  const twin = buildTwinGun();
  twin.group.updateMatrixWorld(true);
  const q = twin.muzzles.map((m) => m.getWorldPosition(new T.Vector3()));
  const target = mount.mouths.map((m) => new T.Vector3(m[0], m[1], m[2]));
  const ry = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI);
  const rotate = (v: T.Vector3): T.Vector3 => v.clone().applyQuaternion(ry);
  const weaponScale = target[1]!.clone().sub(target[0]!).length() / rotate(q[1]!).sub(rotate(q[0]!)).length();
  let best: { t: T.Vector3; err: number } | null = null;
  const pairings: Array<[[number, number], [number, number]]> = [
    [[0, 0], [1, 1]],
    [[0, 1], [1, 0]],
  ];
  for (const [[qa, ta], [qb, tb]] of pairings) {
    const t = target[ta]!.clone().sub(rotate(q[qa]!).multiplyScalar(weaponScale));
    const mapped = rotate(q[qb]!).multiplyScalar(weaponScale).add(t);
    const err = mapped.distanceTo(target[tb]!);
    if (!best || err < best.err) best = { t, err };
  }
  const weapon = new T.Group();
  weapon.name = "Rear gunner fpp weapon";
  weapon.quaternion.copy(ry);
  weapon.scale.setScalar(weaponScale);
  weapon.position.copy(best!.t);
  weapon.add(twin.group);
  const pivot = new T.Group();
  pivot.name = "Rear gunner fpp pivot";
  pivot.position.copy(hinge);
  pivot.add(weapon);
  pivot.visible = false;
  group.add(pivot);

  // The barrels live under the uniformly-scaled weapon group, so a world-space kick is divided by
  // that scale before it is written to the barrel's own local `+Z` (the bore's rearward axis).
  const setRecoil = (metres: number): void => {
    const local = weaponScale > 0 ? metres / weaponScale : metres;
    for (const barrel of twin.barrels) barrel.position.z = local;
  };

  // The authored belt-change cycle from the supplied controller: cover swings open 1.32 rad, the box
  // lid 1.15, the charging handle pulses out and back, and the belt draws through. `open` runs 0..1
  // across the change; this is purely visual and never touches the sim's ammunition.
  const setReload = (open: number): void => {
    const t = open < 0 ? 0 : open > 1 ? 1 : open;
    for (const cover of twin.covers) cover.rotation.x = -t * 1.32;
    for (const lid of twin.lids) lid.rotation.x = -t * 1.15;
    const pulse = 0.24 * Math.sin(t * Math.PI);
    for (const handle of twin.handles) handle.position.z = 0.13 + pulse;
    for (const belt of twin.belts) belt.position.z = -0.05 * t;
  };

  const dispose = (): void => {
    const geometries = new Set<T.BufferGeometry>();
    const mats = new Set<T.Material>();
    const texes = new Set<T.Texture>();
    group.traverse((o) => {
      const m = o as T.Mesh;
      if (m.geometry) geometries.add(m.geometry);
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => mats.add(mat));
    });
    geometries.forEach((g) => g.dispose());
    mats.forEach((m) => {
      const rec = m as unknown as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        const value = rec[key];
        if (value && (value as T.Texture).isTexture) texes.add(value as T.Texture);
      }
      m.dispose();
    });
    texes.forEach((t) => t.dispose());
    group.removeFromParent();
  };

  return { group, shell, pivot, muzzles: twin.muzzles, muzzleError: best!.err, weaponScale, setRecoil, setReload, dispose };
}
