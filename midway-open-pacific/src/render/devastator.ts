/**
 * The Douglas TBD-1 Devastator, extracted from the standalone `Douglas-TBD-1.html` airframe study.
 *
 * Nose -X and metres in its own frame; `makeDevastator` wraps it nose -Z on the wheel datum the rest
 * of the game expects, and publishes the same handles the imported airframes did (`propeller`,
 * `propBlur`, `torpedoLoad`, `arrestingHook`, `cockpit`) so one dispatch can drive every type. The
 * SBD is untouched: `createDouglas` still owns it.
 */
import * as T from "three";
import { mergeByMaterial, softCircleDataTexture } from "@threenative/core";
import { emblem } from "./assets.js";
import { createSeatedStation, SEATED_PELVIS, type ISeatedStation } from "./aircrew.js";
import { createCockpitInterior, getCockpitMaterials, type CockpitInterior } from "./cockpit-detail.js";

const PI = Math.PI;
const TAU = PI * 2;
const V = (x = 0, y = 0, z = 0): T.Vector3 => new T.Vector3(x, y, z);

type Station = number[];
type Surface = { name: string; group: T.Group; axis: T.Vector3 };
type MaterialMap = Record<string, T.Material>;

interface DevastatorModel {
  root: T.Group;
  parts: Record<string, T.Object3D>;
  materials: MaterialMap;
  setControl(name: string, value: number): void;
  update(dt: number): void;
  reset(): void;
  releaseTorpedo(): boolean;
  getState(): { targets: Record<string, number>; current: Record<string, number>; released: boolean };
  dispose(): void;
}

/**
 * One material set for every Devastator in the scene. Materials are shared rather than rebuilt per
 * instance: each unique material is its own WebGPU pipeline, and a carrier's deck park would
 * otherwise multiply the pipeline count by the number of parked airframes.
 */
let shared: MaterialMap | undefined;
function materials(): MaterialMap {
  if (shared) return shared;
  const standard = (color: number, metalness = 0.1, roughness = 0.65): T.MeshStandardMaterial =>
    new T.MeshStandardMaterial({
      color: new T.Color(color).convertSRGBToLinear(),
      metalness,
      roughness,
      envMapIntensity: 0.72,
    });
  shared = {
    skin: standard(0x617a86),
    wing: standard(0x69828c),
    under: standard(0xabb3af),
    tail: standard(0x617b87),
    frame: standard(0x627c87, 0.3, 0.45),
    stabilizer: standard(0x69838e, 0.1, 0.72),
    edge: standard(0x89999b, 0.65, 0.39),
    dark: standard(0x202b2e, 0.6, 0.65),
    steel: standard(0x859292, 0.85, 0.31),
    rubber: standard(0x151b1c, 0, 0.94),
    cockpit: standard(0x414c37, 0.07, 0.79),
    seat: standard(0x605b3d, 0, 0.92),
    black: standard(0x161e22, 0.25, 0.43),
    yellow: standard(0xd7b863, 0.06, 0.5),
    torpedo: standard(0x5e6561, 0.8, 0.37),
    brass: standard(0x9f8754, 0.8, 0.34),
    instrument: standard(0x141d1c, 0.05, 0.8),
    glass: new T.MeshPhysicalMaterial({
      color: new T.Color(0xc0dce1).convertSRGBToLinear(),
      metalness: 0.02,
      roughness: 0.045,
      transparent: true,
      opacity: 0.33,
      envMapIntensity: 1.15,
      depthWrite: false,
      side: T.DoubleSide,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    }),
    red: new T.MeshStandardMaterial({ color: 0x701a15, emissive: 0xf92912, emissiveIntensity: 0.7, roughness: 0.18 }),
    green: new T.MeshStandardMaterial({ color: 0x164a3e, emissive: 0x23d3a1, emissiveIntensity: 0.65, roughness: 0.18 }),
    blade: new T.MeshStandardMaterial({ vertexColors: true, metalness: 0.47, roughness: 0.39, side: T.DoubleSide }),
    // Shared national-insignia decal: Midway-era US star-in-circle, no bars. Kept in the
    // shared map so instance disposal never releases it out from under the other airframes.
    insignia: emblem("us"),
  };
  return shared;
}

/** The model itself, ported nearly verbatim: metres, nose -X, up +Y. */
function buildModel(detail: "hero" | "ai"): DevastatorModel {
  const ai = detail === "ai";
  const root = new T.Group();
  root.name = "Douglas_TBD_1_Devastator";
  const parts: Record<string, T.Object3D> = {};
  const surfaces: Surface[] = [];
  const M: MaterialMap = materials();
  /** A piece gets its name, its parent and the shadow flags every part of this airframe has. */
  const adopt = (o: T.Mesh, mat: T.Material, parent: T.Object3D, name: string): T.Mesh => {
    o.name = name;
    o.castShadow = mat !== M.glass;
    o.receiveShadow = true;
    parent.add(o);
    return o;
  };
  const mesh = (geo: T.BufferGeometry, mat: T.Material, parent: T.Object3D = root, name = ""): T.Mesh =>
    adopt(new T.Mesh(geo, mat), mat, parent, name);
  const box = (
    size: [number, number, number],
    pos: [number, number, number],
    mat: T.Material,
    parent: T.Object3D = root,
  ): T.Mesh => {
    const o = mesh(new T.BoxGeometry(...size), mat, parent);
    o.position.set(...pos);
    return o;
  };
  const ball = (
    r: number,
    pos: [number, number, number],
    mat: T.Material,
    parent: T.Object3D = root,
    scale?: [number, number, number],
  ): T.Mesh => {
    const o = mesh(new T.SphereGeometry(r, 16, 10), mat, parent);
    o.position.set(...pos);
    if (scale) o.scale.set(...scale);
    return o;
  };
  const rod = (
    a: [number, number, number],
    b: [number, number, number],
    r: number,
    mat: T.Material,
    parent: T.Object3D = root,
    r2 = r,
    seg = 10,
  ): T.Mesh => {
    const av = V(...a);
    const bv = V(...b);
    const d = bv.clone().sub(av);
    const o = mesh(new T.CylinderGeometry(r2, r, d.length(), seg), mat, parent);
    o.position.copy(av.add(bv).multiplyScalar(0.5));
    o.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
    return o;
  };
  const tube = (
    points: number[][],
    r: number,
    mat: T.Material,
    parent: T.Object3D = root,
    segments = 30,
  ): T.Mesh =>
    mesh(
      new T.TubeGeometry(
        new T.CatmullRomCurve3(points.map((p) => V(...(p as [number, number, number])))),
        segments,
        r,
        6,
        false,
      ),
      mat,
      parent,
    );
  // Every procedural geometry here carries normal and uv already: Box, Sphere, Cylinder, Tube,
  // Torus and Extrude geometries generate both, and `geometry()` computes normals and writes uv.
  // So the engine's merge needs no game-side fallback for the authored channels, and it refuses
  // loudly if a future part ever arrives without one instead of inventing a default.
  const batch = (group: T.Object3D): void => {
    // The engine walks the whole subtree and groups by material; `skip` keeps this to the direct
    // children it always merged, and leaves a material with fewer than three of them alone —
    // merging a pair or a lone piece saves no draw call, costs a geometry copy, and renames the
    // pieces a script finds by name (`airframebody` and the fuselage insignia, both read by
    // scripts/check-aircraft.mjs and tools/capture-airframes.mjs).
    const counts = new Map<T.Material, number>();
    for (const c of group.children as T.Mesh[])
      if (c.isMesh && !Array.isArray(c.material)) counts.set(c.material, (counts.get(c.material) ?? 0) + 1);
    const skip = (m: T.Mesh) => m.parent !== group || (counts.get(m.material as T.Material) ?? 0) < 3;
    const merged = mergeByMaterial(group, { label: group.name || "devastator", skip });
    // It does not touch the root, so the sources are dropped here or the airframe draws twice.
    for (const c of [...group.children] as T.Mesh[])
      if (c.isMesh && !skip(c)) {
        group.remove(c);
        c.geometry.dispose();
      }
    for (const m of merged) adopt(m, m.material as T.Material, group, group.name + "_details");
  };
  const geometry = (p: number[], uv: number[], index: number[]): T.BufferGeometry => {
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(p, 3));
    g.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeVertexNormals();
    return g;
  };
  const interp = (stations: Station[], x: number): number[] => {
    let i = 0;
    while (i < stations.length - 2 && x > stations[i + 1]![0]!) i++;
    const a = stations[i]!;
    const b = stations[i + 1]!;
    const f = T.MathUtils.clamp((x - a[0]!) / (b[0]! - a[0]!), 0, 1);
    return a.slice(1).map((v, k) => v + (b[k + 1]! - v) * f);
  };
  const latheX = (
    stations: Station[],
    radial = 80,
    steps = 130,
    cut = false,
    uvGlobal = true,
  ): T.BufferGeometry => {
    const p: number[] = [];
    const uv: number[] = [];
    const ix: number[] = [];
    const a = stations[0]![0]!;
    const b = stations[stations.length - 1]![0]!;
    for (let i = 0; i <= steps; i++) {
      const x = a + ((b - a) * i) / steps;
      const [ry, rz, cy = 0] = interp(stations, x);
      for (let j = 0; j <= radial; j++) {
        const theta = (j / radial) * TAU - PI / 2;
        p.push(x, cy + Math.sin(theta) * ry!, Math.cos(theta) * rz!);
        uv.push(uvGlobal ? (x + 5.25) / 10.85 : i / steps, 1 - j / radial);
      }
    }
    for (let i = 0; i < steps; i++)
      for (let j = 0; j < radial; j++) {
        const aa = i * (radial + 1) + j;
        const bb = aa + radial + 1;
        const midX = a + ((b - a) * (i + 0.5)) / steps;
        const theta = ((j + 0.5) / radial) * TAU - PI / 2;
        const [ry, , cy = 0] = interp(stations, midX);
        if (cut && midX > -3.33 && midX < 1.36 && cy + Math.sin(theta) * ry! > 0.53) continue;
        ix.push(aa, bb, bb + 1, aa, bb + 1, aa + 1);
      }
    return geometry(p, uv, ix);
  };
  const fuselageProfile: Station[] = [
    [-4.2, 0.84, 0.78, 0], [-3.8, 0.87, 0.79, 0], [-3.25, 0.86, 0.77, -0.02], [-2.6, 0.88, 0.75, -0.025],
    [-1.5, 0.9, 0.72, -0.045], [-0.3, 0.85, 0.65, -0.03], [0.8, 0.76, 0.58, -0.01], [1.8, 0.65, 0.5, 0.015],
    [2.8, 0.54, 0.405, 0.05], [3.7, 0.41, 0.29, 0.09], [4.6, 0.29, 0.175, 0.14], [5.18, 0.23, 0.09, 0.19],
    [5.53, 0.16, 0.012, 0.24],
  ];
  const fuselage = mesh(latheX(fuselageProfile, ai ? 36 : 72, ai ? 64 : 120, true), M.skin, root, "airframebody");
  parts.fuselage = fuselage;
  for (const side of [-1, 1]) {
    const fair = new T.Group();
    fair.name = "wing_root_fairing";
    root.add(fair);
    tube(
      [[-2.5, -0.34, side * 0.52], [-1.5, -0.12, side * 0.81], [-0.2, -0.22, side * 0.77], [1.1, -0.49, side * 0.5]],
      0.037,
      M.frame,
      fair,
      38,
    );
    batch(fair);
  }

  const cowling = new T.Group();
  cowling.name = "radial_cowling";
  root.add(cowling);
  parts.cowling = cowling;
  mesh(
    latheX([
      [-5.07, 0.7, 0.7, 0], [-5.02, 0.83, 0.82, 0], [-4.85, 0.91, 0.89, 0], [-4.48, 0.92, 0.89, 0],
      [-4.02, 0.88, 0.83, 0], [-3.87, 0.84, 0.8, 0],
    ], ai ? 32 : 64, ai ? 20 : 36),
    M.skin,
    cowling,
  );
  mesh(latheX([[-5.075, 0.69, 0.69, 0], [-5.04, 0.68, 0.68, 0], [-4.88, 0.69, 0.69, 0]], ai ? 20 : 48, ai ? 6 : 8), M.dark, cowling);
  const lip = mesh(new T.TorusGeometry(0.743, 0.047, 10, ai ? 32 : 64), M.edge, cowling);
  lip.rotation.y = PI / 2;
  lip.position.x = -5.062;
  for (let i = 0; i < (ai ? 8 : 16); i++) {
    const a = (i / 16) * TAU;
    const flap = box([0.25, 0.3, 0.025], [-3.91, Math.sin(a) * 0.858, Math.cos(a) * 0.817], M.frame, cowling);
    flap.rotation.x = -a;
  }
  const engine = new T.Group();
  engine.name = "R1830_radial_engine";
  root.add(engine);
  parts.engine = engine;
  // The radial engine is only read through the cowl's open front, so the parked build omits it
  // whole rather than paying for a second row of cylinders no one can resolve on a deck.
  if (!ai) {
    rod([-5.03, 0, 0], [-4.47, 0, 0], 0.28, M.steel, engine, 0.32, 16);
    for (let row = 0; row < 2; row++)
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU + (row * PI) / 7;
        const x = -4.82 + row * 0.25;
        rod([x, Math.sin(a) * 0.28, Math.cos(a) * 0.28], [x, Math.sin(a) * 0.72, Math.cos(a) * 0.72], 0.145, M.dark, engine, 0.145, 10);
        for (let k = 0; k < 5; k++) {
          const r = 0.37 + k * 0.043;
          rod(
            [x, Math.sin(a) * (r - 0.01), Math.cos(a) * (r - 0.01)],
            [x, Math.sin(a) * (r + 0.01), Math.cos(a) * (r + 0.01)],
            0.165,
            M.steel,
            engine,
            0.165,
            10,
          );
        }
        rod([x - 0.1, Math.sin(a) * 0.22, Math.cos(a) * 0.22], [x - 0.1, Math.sin(a) * 0.67, Math.cos(a) * 0.67], 0.015, M.black, engine, undefined, 6);
      }
  }
  for (const side of [-1, 1])
    tube([[-4.05, -0.4, side * 0.64], [-3.9, -0.58, side * 0.66], [-3.58, -0.61, side * 0.65]], 0.1, M.dark, cowling, 14);
  batch(engine);
  batch(cowling);

  const prop = new T.Group();
  prop.name = "propeller";
  prop.position.x = -5.22;
  root.add(prop);
  parts.propeller = prop;
  // Tip radius by construction: the blades below extend to r, so the blur disc and any
  // clearance check can use the swept disc rather than a bounding box of three static blades
  // parked 120° apart, which understates the diameter by nearly a fifth.
  let tipRadius = 0.5;
  for (let blade = 0; blade < 3; blade++) {
    const p: number[] = [];
    const uv: number[] = [];
    const ix: number[] = [];
    const cols: number[] = [];
    const n = ai ? 14 : 28;
    const k = ai ? 6 : 8;
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const r = 0.2 + f * 1.49;
      tipRadius = Math.max(tipRadius, r);
      const width = (0.09 + 0.105 * Math.sin(PI * f) ** 0.8) * Math.min(1, (1.04 - f) * 15);
      const twist = 0.47 - f * 0.4;
      for (let j = 0; j <= k; j++) {
        const a = (j / k) * TAU;
        const xx = Math.cos(a) * 0.023;
        const zz = Math.sin(a) * width;
        const sw = 0.08 * Math.sin(PI * f);
        p.push(xx * Math.cos(twist) + zz * Math.sin(twist), r, zz * Math.cos(twist) - xx * Math.sin(twist) + sw);
        uv.push(f, j / k);
        const c = new T.Color(f > 0.885 ? 0xdac16a : 0x1b2227).convertSRGBToLinear();
        cols.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < n; i++)
      for (let j = 0; j < k; j++) {
        const a = i * (k + 1) + j;
        const b = a + k + 1;
        ix.push(a, b, b + 1, a, b + 1, a + 1);
      }
    const g = geometry(p, uv, ix);
    g.setAttribute("color", new T.Float32BufferAttribute(cols, 3));
    const bladeMesh = mesh(g, M.blade!, prop, "propeller_blade_" + blade);
    bladeMesh.rotation.x = (blade / 3) * TAU;
  }
  ball(0.22, [0, 0, 0], M.steel, prop, [1.1, 1, 1]);
  rod([-0.3, 0, 0], [0.1, 0, 0], 0.105, M.steel, prop, 0.17, 24);
  prop.userData.tipRadius = tipRadius;

  const wingStations: Station[] = [
    [0, -2.6, 3.9], [0.8, -2.55, 3.86], [2.35, -2.32, 3.52], [5.9, -1.5, 2.42], [6.9, -1.08, 1.93],
    [7.35, -0.75, 1.25], [7.6, -0.35, 0.36], [7.62, -0.18, 0.025],
  ];
  const tailStations: Station[] = [
    [0, 3.4, 2.12], [0.6, 3.49, 2.0], [1.8, 4.0, 1.33], [2.35, 4.43, 0.64], [2.52, 4.72, 0.025],
  ];
  const wingY = (s: number): number => -0.41 + Math.max(0, s - 0.8) * 0.065;
  const wingPoint = (s: number, t: number, side: number, upper: boolean, tail = false): T.Vector3 => {
    const [le, c] = interp(tail ? tailStations : wingStations, s);
    const th = tail ? 0.1 : 0.155 - s * 0.007;
    const yt = 5 * th! * c! * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t * t * t - 0.1036 * t * t * t * t);
    return V(
      le! + c! * t,
      (tail ? 0.205 : wingY(s)) + (tail ? 0.003 : 0.017) * c! * Math.sin(PI * t) + (upper ? yt : -yt),
      side * s,
    );
  };
  const wingPatch = (
    parent: T.Object3D,
    sa: number,
    sb: number,
    ta: number,
    tb: number,
    side: number,
    offset = V(),
    tail = false,
    name = "wing_skin",
  ): void => {
    const ns = Math.max(6, Math.ceil((sb - sa) * (ai ? 4 : 8)));
    const nc = ai ? 8 : 16;
    for (const upper of [true, false]) {
      const p: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= ns; i++)
        for (let j = 0; j <= nc; j++) {
          const s = sa + ((sb - sa) * i) / ns;
          const t = ta + (tb - ta) * (0.5 - 0.5 * Math.cos((j / nc) * PI));
          const v = wingPoint(s, t, side, upper, tail).sub(offset);
          p.push(v.x, v.y, v.z);
          uv.push(s / (tail ? 2.52 : 7.62), 1 - t);
        }
      for (let i = 0; i < ns; i++)
        for (let j = 0; j < nc; j++) {
          const a = i * (nc + 1) + j;
          const b = a + nc + 1;
          if ((side > 0) === upper) idx.push(a, b, b + 1, a, b + 1, a + 1);
          else idx.push(a, b + 1, b, a, a + 1, b + 1);
        }
      mesh(geometry(p, uv, idx), tail ? M.stabilizer! : upper ? M.wing! : M.under!, parent, name + (upper ? "_top" : "_bottom"));
    }
    for (const chord of [ta, tb]) {
      const p: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= ns; i++) {
        const s = sa + ((sb - sa) * i) / ns;
        for (const upper of [true, false]) {
          const v = wingPoint(s, chord, side, upper, tail).sub(offset);
          p.push(v.x, v.y, v.z);
          uv.push(s / (tail ? 2.52 : 7.62), 1 - chord);
        }
      }
      for (let i = 0; i < ns; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      mesh(geometry(p, uv, idx), M.frame!, parent);
    }
  };
  const hinged = (
    parent: T.Object3D,
    name: string,
    sa: number,
    sb: number,
    ta: number,
    tb: number,
    side: number,
    offset: T.Vector3,
    tail = false,
  ): T.Group => {
    const h = wingPoint(sa, ta, side, true, tail);
    const end = wingPoint(sb, ta, side, true, tail);
    const g = new T.Group();
    g.name = name;
    g.position.copy(h.clone().sub(offset));
    parent.add(g);
    parts[name] = g;
    wingPatch(g, sa, sb, ta, tb, side, h, tail, name);
    const axis = end.sub(h).normalize();
    surfaces.push({ name, group: g, axis });
    return g;
  };
  // US national insignia as shared-material decals: the ported TBD carries no textures,
  // so the marks it never had go on as quads. They never cast or receive shadows.
  const star = (parent: T.Object3D, name: string, size: number): T.Mesh => {
    const mark = new T.Mesh(new T.PlaneGeometry(size, size), M.insignia!);
    mark.name = name;
    mark.castShadow = false;
    mark.receiveShadow = false;
    parent.add(mark);
    return mark;
  };
  for (const side of [-1, 1]) {
    const suffix = side < 0 ? "Port" : "Starboard";
    wingPatch(root, 0, 0.86, 0, 1, side);
    wingPatch(root, 0.86, 2.34, 0, 0.735, side);
    hinged(root, "flap" + suffix, 0.87, 2.33, 0.748, 1, side, V());
    const fold = new T.Group();
    fold.name = "wing" + suffix;
    fold.position.set(0, wingY(2.35), side * 2.35);
    root.add(fold);
    parts[fold.name] = fold;
    const off = fold.position.clone();
    wingPatch(fold, 2.36, 3.2, 0, 1, side, off);
    wingPatch(fold, 3.2, 7.07, 0, 0.765, side, off);
    hinged(fold, "aileron" + suffix, 3.21, 7.06, 0.779, 1, side, off);
    wingPatch(fold, 7.07, 7.62, 0, 1, side, off);
    for (const x of [-2.06, -0.14, 0.75])
      rod([x, wingY(2.35) - 0.03, side * 2.33], [x + 0.18, wingY(2.35) - 0.03, side * 2.33], 0.047, M.steel!);
    const nav = ball(0.06, [-0.62, 0.095, side * 7.37], side < 0 ? M.red! : M.green!, fold, [1.25, 0.7, 1]);
    nav.position.sub(off);
    if (side < 0)
      tube(
        [[-1.12, wingY(5.95), side * 5.95], [-1.65, wingY(5.95), side * 5.95], [-2.03, wingY(5.95), side * 5.95]].map((a) =>
          V(...(a as [number, number, number])).sub(off).toArray(),
        ),
        0.016,
        M.steel!,
        fold,
        12,
      );
    batch(fold);
    // Upper-wing star on the folding outer panel, in fold-local coordinates so it folds
    // with the wing: mid-chord clear of the flap, aileron and pitot, tilted to the dihedral.
    const spot = wingPoint(4.8, 0.42, side, true);
    const wingMark = star(fold, `us-insignia-wing-${suffix}`, 1.3);
    wingMark.position.set(spot.x - off.x, spot.y - off.y + 0.035, spot.z - off.z);
    wingMark.rotation.x = -PI / 2;
    wingMark.rotateX(-side * 0.065);
    wingPatch(root, 0, 2.52, 0, 0.7, side, V(), true, "horizontal_stabilizer");
    hinged(root, "elevator" + suffix, 0.03, 2.49, 0.713, 1, side, V(), true);
  }
  for (const side of [-1, 1]) {
    // Fuselage star on bare skin aft of the greenhouse: profile rz ≈ 0.56 at x = 1.0.
    const hullMark = star(root, `us-insignia-fuselage-${side < 0 ? "Port" : "Starboard"}`, 0.5);
    hullMark.position.set(1.0, -0.005, side * 0.599);
    if (side < 0) hullMark.rotation.y = PI;
  }

  const finGeo = (points: number[][], offset = V(), depth = 0.12): T.BufferGeometry => {
    const shape = new T.Shape();
    points.forEach((p, i) => (i ? shape.lineTo(p[0]!, p[1]!) : shape.moveTo(p[0]!, p[1]!)));
    shape.closePath();
    const g = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2, curveSegments: ai ? 8 : 16, steps: 1 });
    g.translate(-offset.x, -offset.y, -depth / 2 - offset.z);
    const p = g.attributes.position!;
    const u: number[] = [];
    for (let i = 0; i < p.count; i++) u.push((p.getX(i) + offset.x - 3.25) / 2.45, (p.getY(i) + offset.y) / 2.7);
    g.setAttribute("uv", new T.Float32BufferAttribute(u, 2));
    return g;
  };
  const finPts = [[3.36, 0.13], [3.65, 0.54], [3.97, 1.26], [4.31, 1.96], [4.6, 2.4], [4.78, 2.57], [4.97, 2.63], [5.025, 2.55], [5.02, 0.17]];
  mesh(finGeo(finPts), M.tail!, root, "vertical_stabilizer");
  const rudder = new T.Group();
  rudder.name = "rudder";
  rudder.position.set(5.055, 0.18, 0);
  root.add(rudder);
  parts.rudder = rudder;
  mesh(finGeo([[5.065, 0.18], [5.065, 2.55], [5.21, 2.42], [5.4, 2.1], [5.52, 1.59], [5.55, 0.98], [5.5, 0.27], [5.35, 0.17]], rudder.position, 0.1), M.tail!, rudder);

  const cockpit = new T.Group();
  cockpit.name = "cockpit_interior";
  root.add(cockpit);
  parts.cockpit = cockpit;
  const tub = [[-3.2, 0.4], [-2.64, 0.53], [-1.17, 0.51], [0.27, 0.41], [0.93, 0.28], [1.28, 0.13]];
  for (let i = 0; i < tub.length - 1; i++) {
    const [a, wa] = tub[i]!;
    const [b, wb] = tub[i + 1]!;
    mesh(geometry([a!, 0.22, -wa!, a!, 0.22, wa!, b!, 0.22, wb!, b!, 0.22, -wb!], [0, 0, 0, 1, 1, 1, 1, 0], [0, 1, 2, 0, 2, 3]), M.cockpit!, cockpit);
    for (const side of [-1, 1])
      mesh(geometry([a!, 0.22, side * wa!, b!, 0.22, side * wb!, b!, 0.47, side * wb!, a!, 0.47, side * wa!], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3]), M.cockpit!, cockpit);
  }
  for (const x of [-2.46, -0.98, 0.55]) {
    // The rearmost station's gunner faces aft, so his backrest sits forward of his pelvis; the
    // forward-facing seats' backrest, aft of the pelvis, had his legs through it.
    const aft = x === 0.55;
    const seat = box([0.4, 0.48, 0.45], [aft ? x - 0.3 : x, 0.55, 0], M.cockpit!, cockpit);
    seat.rotation.z = aft ? 0.12 : -0.12;
    box([0.44, 0.1, 0.43], [x - 0.15, 0.31, 0], M.seat!, cockpit);
    if (!ai)
      for (const side of [-1, 1]) {
        const strap = box([0.038, 0.38, 0.012], [x - 0.224, 0.58, side * 0.14], M.yellow!, cockpit);
        strap.rotation.z = -0.18;
      }
    rod([x - 0.48, 0.3, 0], [x - 0.52, 0.62, 0], 0.018, M.black!, cockpit);
    ball(0.035, [x - 0.52, 0.62, 0], M.black!, cockpit);
  }
  box([0.1, 0.48, 0.98], [-3.05, 0.64, 0], M.black!, cockpit);
  const instrument = mesh(new T.PlaneGeometry(0.94, 0.43), M.instrument!, cockpit, "instrument_panel");
  instrument.rotation.y = PI / 2;
  instrument.position.set(-2.994, 0.64, 0);
  for (const side of [-1, 1]) {
    box([0.7, 0.13, 0.14], [-2.7, 0.49, side * 0.43], M.black!, cockpit);
    if (!ai) for (let i = 0; i < 5; i++) rod([-2.93 + i * 0.1, 0.55, side * 0.43], [-2.93 + i * 0.1, 0.61, side * 0.43], 0.01, M.steel!, cockpit);
  }
  box([0.3, 0.3, 0.48], [0.17, 0.48, 0], M.black!, cockpit);
  // No legacy rear gun is drawn here: the approved twin-mount asset (`createSeatedStation`'s
  // `gun: true`) is the one rear weapon on the airframe. The old rod pedestal, barrel and magazine
  // that used to sit under it are removed so two guns never overlap in the rear station.
  batch(cockpit);

  const canopyStations: Station[] = [
    [-3.35, 0.68, 0.47], [-2.64, 1.4, 0.585], [-1.91, 1.44, 0.605], [-1.17, 1.41, 0.592],
    [-0.43, 1.32, 0.56], [0.27, 1.15, 0.49], [0.93, 0.94, 0.36], [1.42, 0.63, 0.13],
  ];
  const railY = 0.545;
  const section = (st: Station): number[][] => {
    const [x, top, w] = st as [number, number, number];
    const dh = top - railY;
    return [[x, railY, -w], [x, railY + dh * 0.65, -w * 0.88], [x, top, -w * 0.4], [x, top, w * 0.4], [x, railY + dh * 0.65, w * 0.88], [x, railY, w]];
  };
  const canopyStatic = new T.Group();
  canopyStatic.name = "canopy_fixed";
  root.add(canopyStatic);
  const sliding = new T.Group();
  sliding.name = "canopy";
  root.add(sliding);
  parts.canopy = sliding;
  // The gunner's station is open. The supplied greenhouse closes over the rearmost seat whose crown
  // the aft glazing overlapped by ~4 cm, so the panes and their arches stop at station 4 and the
  // station-5 arch closes the opening; the pilot keeps the whole forward greenhouse. Nothing aft of
  // the lip is drawn, so no floating arches are left behind the gun.
  const REAR_OPEN_STATION = 5;
  for (let i = 0; i < REAR_OPEN_STATION; i++) {
    const parent = i === 1 ? sliding : canopyStatic;
    const a = section(canopyStations[i]!);
    const b = section(canopyStations[i + 1]!);
    for (let j = 0; j < a.length - 1; j++) {
      const p = [...a[j]!, ...b[j]!, ...b[j + 1]!, ...a[j + 1]!];
      const pane = mesh(geometry(p, [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3]), M.glass!, parent, "glass_pane");
      pane.renderOrder = 3;
      rod(a[j] as [number, number, number], b[j] as [number, number, number], j === 0 || j === 4 ? 0.023 : 0.016, M.frame!, parent);
      rod(a[j] as [number, number, number], a[j + 1] as [number, number, number], 0.023, M.frame!, parent);
      if (i === REAR_OPEN_STATION - 1 || i === 1) rod(b[j] as [number, number, number], b[j + 1] as [number, number, number], 0.023, M.frame!, parent);
    }
  }
  for (const side of [-1, 1]) {
    tube([[-3.4, 0.55, side * 0.48], [-2.6, 0.54, side * 0.6], [-1.0, 0.54, side * 0.6], [0.35, 0.54, side * 0.5], [1.4, 0.56, side * 0.15]], 0.025, M.frame!, canopyStatic, 32);
    rod([-2.6, 0.585, side * 0.607], [-0.86, 0.585, side * 0.607], 0.012, M.steel!, canopyStatic);
    rod([-3.29, 0.61, side * 0.474], [-2.65, 1.12, side * 0.517], 0.017, M.frame!, canopyStatic);
  }
  batch(canopyStatic);
  batch(sliding);
  rod([-3.5, 0.7, 0], [-3.5, 1.13, 0], 0.014, M.black!);
  rod([-3.72, 1.08, 0], [-3.12, 1.08, 0], 0.019, M.dark!);
  rod([-3.82, 0.8, 0], [-3.82, 1.94, 0], 0.022, M.frame!, root, 0.013, 8);
  tube([[-3.82, 1.94, 0], [0.5, 2.23, 0], [4.84, 2.65, 0]], 0.006, M.dark!, root, 24);
  tube([[-0.72, 2.16, 0], [-0.59, 1.4, 0]], 0.005, M.dark!, root, 8);

  for (const side of [-1, 1]) {
    const suffix = side < 0 ? "Port" : "Starboard";
    const well = ball(0.57, [-0.36, -0.4, side * 1.64], M.dark!, root, [1.02, 0.11, 0.73]);
    well.name = "wheel_well_" + suffix;
    const gear = new T.Group();
    gear.name = "gear" + suffix;
    gear.position.set(-1.48, -0.38, side * 1.64);
    root.add(gear);
    parts[gear.name] = gear;
    rod([0, 0, 0], [0.04, -0.79, side * 0.055], 0.067, M.frame!, gear, 0.075, 14);
    rod([0.04, -0.7, side * 0.055], [0.045, -1.15, side * 0.055], 0.045, M.steel!, gear, 0.045, 14);
    rod([0.49, -0.015, -side * 0.11], [0.04, -0.88, 0], 0.033, M.steel!, gear, 0.033, 12);
    rod([0.12, -0.67, side * 0.01], [0.21, -0.91, side * 0.01], 0.023, M.dark!, gear);
    rod([0.21, -0.91, side * 0.01], [0.045, -1.06, side * 0.01], 0.023, M.dark!, gear);
    rod([0.045, -1.13, -side * 0.16], [0.045, -1.13, side * 0.26], 0.064, M.steel!, gear, 0.064, 16);
    const tire = mesh(new T.TorusGeometry(0.385, 0.135, ai ? 10 : 14, ai ? 20 : 36), M.rubber!, gear, "main_tire");
    tire.position.set(0.045, -1.13, side * 0.12);
    rod([0.045, -1.13, side * 0.015], [0.045, -1.13, side * 0.24], 0.264, M.steel!, gear, 0.264, 32);
    for (const z of [-0.01, 0.25]) {
      const hub = mesh(new T.TorusGeometry(0.199, 0.022, 8, ai ? 12 : 24), M.dark!, gear);
      hub.position.set(0.045, -1.13, side * z);
    }
    for (let j = 0; j < 8; j++) {
      const a = (j / 8) * TAU;
      ball(0.028, [0.045 + Math.sin(a) * 0.163, -1.13 + Math.cos(a) * 0.163, side * 0.263], M.dark!, gear, [1, 1, 0.35]);
    }
    const door = box([0.33, 0.74, 0.036], [0.015, -0.47, -side * 0.12], M.under!, gear);
    door.rotation.z = -0.04;
    batch(gear);
  }
  const tailGear = new T.Group();
  tailGear.name = "tail_wheel";
  root.add(tailGear);
  parts.tailGear = tailGear;
  rod([4.7, -0.045, 0], [4.91, -0.49, 0], 0.034, M.steel!, tailGear);
  const tw = mesh(new T.TorusGeometry(0.145, 0.062, 10, ai ? 16 : 24), M.rubber!, tailGear);
  tw.position.set(4.91, -0.55, 0);
  rod([4.91, -0.55, -0.075], [4.91, -0.55, 0.075], 0.102, M.steel!, tailGear, 0.102, 20);
  batch(tailGear);
  const hook = new T.Group();
  hook.name = "arrestingHook";
  hook.position.set(3.4, -0.28, 0);
  root.add(hook);
  parts.hook = hook;
  tube([[0, 0, 0], [0.82, -0.08, 0], [1.28, -0.05, 0], [1.38, 0.03, 0]], 0.025, M.dark!, hook, 20);

  const torpedo = new T.Group();
  torpedo.name = "torpedo";
  torpedo.position.set(0, -1.13, 0);
  root.add(torpedo);
  parts.torpedo = torpedo;
  const tp: Station[] = [
    [-3.48, 0.015, 0.015, 0], [-3.43, 0.13, 0.13, 0], [-3.3, 0.225, 0.225, 0], [-3.12, 0.26, 0.26, 0],
    [-2.88, 0.267, 0.267, 0], [-0.15, 0.267, 0.267, 0], [0.48, 0.245, 0.245, 0], [0.86, 0.16, 0.16, 0],
    [1.08, 0.065, 0.065, 0],
  ];
  mesh(latheX(tp, ai ? 28 : 48, ai ? 36 : 64, false, false), M.torpedo!, torpedo, "torpedo_body");
  for (const x of [-2.94, -1.25, 0.26]) {
    const band = mesh(new T.TorusGeometry(0.267, 0.012, 8, 48), M.dark!, torpedo);
    band.rotation.y = PI / 2;
    band.position.x = x;
  }
  for (let i = 0; i < 4; i++) {
    const fin = box([0.62, 0.028, 0.32], [0.75, 0, 0.19], M.dark!, torpedo);
    const holder = new T.Group();
    torpedo.remove(fin);
    holder.add(fin);
    holder.rotation.x = (i / 4) * TAU;
    torpedo.add(holder);
  }
  rod([0.94, 0, 0], [1.23, 0, 0], 0.033, M.steel!, torpedo, 0.033, 12);
  for (const x of [1.1, 1.21])
    for (let j = 0; j < 4; j++) {
      const b = box([0.019, 0.19, 0.045], [x, 0.09, 0], M.brass!, torpedo);
      b.rotation.x = (j / 4) * TAU;
      b.position.y = Math.cos((j / 4) * TAU) * 0.08;
      b.position.z = Math.sin((j / 4) * TAU) * 0.08;
    }
  for (const x of [-2.34, -0.63]) {
    rod([x, -0.68, -0.11], [x, -0.9, -0.13], 0.025, M.dark!);
    rod([x, -0.68, 0.11], [x, -0.9, 0.13], 0.025, M.dark!);
    const strap = mesh(new T.TorusGeometry(0.282, 0.019, 8, 36, PI), M.steel!);
    strap.rotation.y = PI / 2;
    strap.rotation.z = PI;
    strap.position.set(x, -1.13, 0);
  }
  batch(torpedo);

  const defaults: Record<string, number> = { rpm: 0, fold: 0, gear: 0, canopy: 0, flaps: 0, aileron: 0, elevator: 0, rudder: 0, hook: 0 };
  const targets = { ...defaults };
  const state = { ...defaults };
  let released = false;
  let fallVelocity = 0;
  let elapsed = 0;
  const setControl = (name: string, value: number): void => {
    if (!(name in targets)) throw new RangeError("Unknown control: " + name);
    if (!Number.isFinite(value)) throw new TypeError("Control value must be finite.");
    targets[name] = T.MathUtils.clamp(
      value,
      ["aileron", "elevator", "rudder"].includes(name) ? -1 : 0,
      name === "rpm" ? 2400 : 1,
    );
  };
  const update = (dt: number): void => {
    if (!Number.isFinite(dt) || dt < 0) return;
    dt = Math.min(dt, 0.1);
    elapsed += dt;
    for (const k in state) {
      const rate = k === "rpm" ? 1.8 : k === "fold" ? 2 : 4;
      state[k]! += (targets[k]! - state[k]!) * (1 - Math.exp(-rate * dt));
    }
    prop.rotation.x = (prop.rotation.x + ((state.rpm! * TAU) / 60) * dt) % TAU;
    parts.wingPort!.rotation.x = state.fold! * 1.51;
    parts.wingStarboard!.rotation.x = -state.fold! * 1.51;
    parts.gearPort!.rotation.z = state.gear! * 1.48;
    parts.gearStarboard!.rotation.z = state.gear! * 1.48;
    sliding.position.x = state.canopy! * 0.86;
    sliding.position.y = state.canopy! * 0.035;
    rudder.rotation.y = state.rudder! * 0.4;
    hook.rotation.z = state.hook! * 0.78;
    for (const s of surfaces) {
      let angle = 0;
      if (s.name.startsWith("flap")) angle = (s.name.endsWith("Port") ? -1 : 1) * state.flaps! * 0.7;
      if (s.name.startsWith("aileron")) angle = state.aileron! * 0.36;
      if (s.name.startsWith("elevator")) angle = (s.name.endsWith("Port") ? -1 : 1) * state.elevator! * 0.31;
      s.group.quaternion.setFromAxisAngle(s.axis, angle);
    }
    if (released) {
      fallVelocity += 9.81 * dt;
      torpedo.position.y -= fallVelocity * dt;
      torpedo.position.x -= 0.5 * dt;
      torpedo.rotation.z -= 0.04 * dt;
      if (torpedo.position.y < -30) torpedo.visible = false;
    }
  };
  const releaseTorpedo = (): boolean => {
    if (released) return false;
    released = true;
    fallVelocity = 0;
    root.updateWorldMatrix(true, true);
    if (root.parent) root.parent.attach(torpedo);
    return true;
  };
  const rearmTorpedo = (): void => {
    released = false;
    fallVelocity = 0;
    root.add(torpedo);
    torpedo.position.set(0, -1.13, 0);
    torpedo.rotation.set(0, 0, 0);
    torpedo.visible = true;
  };
  const reset = (): void => {
    Object.assign(targets, defaults);
    Object.assign(state, defaults);
    released = false;
    fallVelocity = 0;
    elapsed = 0;
    root.add(torpedo);
    torpedo.position.set(0, -1.13, 0);
    torpedo.rotation.set(0, 0, 0);
    torpedo.visible = true;
    prop.rotation.x = 0;
    update(0);
  };
  const getState = () => ({ targets: { ...targets }, current: { ...state }, released, elapsed });
  const dispose = (): void => {
    const gs = new Set<T.BufferGeometry>();
    const ms = new Set<T.Material>();
    root.traverse((o) => {
      const m = o as T.Mesh;
      if (m.isMesh) {
        gs.add(m.geometry);
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) ms.add(mat);
      }
    });
    for (const g of gs) g.dispose();
    for (const m of ms) if (!Object.values(shared!).includes(m)) m.dispose();
  };
  batch(root);
  reset();
  return { root, parts, materials: M, setControl, update, reset, releaseTorpedo, getState, dispose };
}

const instances = new WeakMap<
  T.Group,
  {
    model: DevastatorModel;
    propeller: T.Group;
    blades: T.Object3D;
    blur: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
    torpedo: T.Object3D;
    interior?: CockpitInterior;
    /** The two-men crew, each with its own skeleton and mixer. */
    crew: ISeatedStation[];
  }
>();

/**
 * The Devastator as the game draws it: nose -Z, its wheels on the same datum every other airframe
 * uses, and the published handles the scene's own animator and capture gates already address.
 *
 * `WHEEL_DROP` is `gearClearance` rest value: `@threenative/core`'s flight model puts the simulated
 * root 1.82 m above the wheel contact, and every other drawn airframe (the SBD, the Zero, the
 * procedural hull) hangs its gear that far below its origin. The standalone model grounds its own
 * wheels on y = 0, so it is dropped to match rather than floating a gear-height above the deck.
 */
const WHEEL_DROP = 1.82;

/**
 * The detailed interior is a real-metre cockpit shrunk into a canopy opening; the SBD and the
 * imported TBD both mount it at this scale, so the Devastator does too rather than growing a
 * second set of gauges. Its position is derived, not tuned: the rig's own eye is put exactly on
 * the seat datum the chase/cockpit camera already flies to, so the panel can never sit off-axis
 * from the view that looks at it.
 */
const COCKPIT_SCALE = 0.52;

export function makeDevastator(detail: "hero" | "ai" = "hero", withCockpit = false): T.Group {
  const model = buildModel(detail);
  const root = new T.Group();
  root.name = "Douglas TBD-1 Devastator";
  model.root.rotation.y = -PI / 2;
  root.add(model.root);
  root.updateMatrixWorld(true);
  const bounds = new T.Box3().setFromObject(model.root);
  model.root.position.y = -bounds.min.y - WHEEL_DROP;

  model.parts.aileronPort!.name = "aileronleft";
  model.parts.aileronStarboard!.name = "aileronright";
  model.parts.flapPort!.name = "flapleft";
  model.parts.flapStarboard!.name = "flapright";
  model.parts.gearPort!.name = "gearleft";
  model.parts.gearStarboard!.name = "gearright";
  model.parts.elevatorPort!.name = "elevator";

  root.updateMatrixWorld(true);
  const shaft = model.parts.propeller!.getWorldPosition(new T.Vector3());
  const blades = model.parts.propeller!;
  model.root.remove(blades);
  blades.position.set(0, 0, 0);
  blades.rotation.set(0, 0, 0);
  blades.name = "propeller_blades";
  const propeller = new T.Group();
  propeller.name = "propeller";
  propeller.position.copy(shaft);
  const mount = new T.Group();
  mount.rotation.y = -PI / 2;
  mount.add(blades);
  propeller.add(mount);
  root.add(propeller);

  // Sized from the swept disc the blades actually cover: the tip radius recorded at build,
  // plus a margin for blade twist and thickness. A bounding box of the three static blades
  // parked 120° apart understates the diameter by nearly a fifth and leaves the tips out.
  const tipRadius = (blades.userData.tipRadius as number | undefined) ?? 1.7;
  const radius = tipRadius + 0.06;
  const blur = new T.Mesh(
    new T.PlaneGeometry(radius * 2, radius * 2),
    new T.MeshBasicMaterial({
      map: softCircleDataTexture(64, 0.8),
      color: 0xa3aaa3,
      transparent: true,
      // The Douglas's value, and it is the whole trick: a faint sheen reads as a turning disc,
      // while an opaque one reads as a grey plate bolted to the nose.
      opacity: 0.045,
      side: T.DoubleSide,
      depthWrite: false,
      forceSinglePass: true,
      toneMapped: false,
    }),
  );
  blur.name = "Propeller motion blur";
  // Ride the propeller group at the shaft, the way the Douglas blur rides its pivot: the disc
  // stays centred and square to the blades in their own frame, so position and facing can never
  // drift apart. It spins with the blades, which a radially symmetric texture hides.
  propeller.add(blur);
  blur.position.set(0, 0, 0);
  blur.visible = false;

  root.userData.devastator = true;
  root.userData.propeller = propeller;
  root.userData.propBlur = blur;
  root.userData.torpedoLoad = model.parts.torpedo;
  root.userData.arrestingHook = model.parts.hook;
  const eye = new T.Vector3(0, model.root.position.y + 1.02, -2.42);
  root.userData.cockpit = eye;

  const materials = withCockpit ? getCockpitMaterials() : undefined;
  const interior = materials ? createCockpitInterior(materials) : undefined;
  if (interior) {
    const instrumentRoot = new T.Group();
    instrumentRoot.name = "Devastator live cockpit instruments";
    interior.root.scale.setScalar(COCKPIT_SCALE);
    interior.root.position.set(
      eye.x - interior.eye[0] * COCKPIT_SCALE,
      eye.y - interior.eye[1] * COCKPIT_SCALE,
      eye.z - interior.eye[2] * COCKPIT_SCALE,
    );
    instrumentRoot.add(interior.root);
    root.add(instrumentRoot);
    root.userData.cockpitInterior = instrumentRoot;
    root.userData.cockpitRig = interior;
    // The rig brings its own tub, framing and glazing. The airframe's own blocked-out cockpit and
    // greenhouse share that space, so they stand down while the player is sitting in it — the same
    // swap `createDouglas` makes with the SBD's fuselage shells.
    root.userData.cockpitShell = [model.parts.cockpit!, model.parts.canopy!, model.root.getObjectByName("canopy_fixed")].filter(
      (node): node is T.Object3D => Boolean(node),
    );
  }
  // The two manned crew on the ported cockpit's own three seats: the forward pilot and the rearmost
  // radioman/gunner. The rig's measured pelvis is put on that seat's own cushion centre, so the man
  // sits where the airframe was drawn rather than at an SBD-derived offset. The middle seat is the
  // bombardier/torpedo officer, not the gunner. The forward pilot's published eye is authoritative —
  // the cockpit camera flies to it — so his station is shifted until the measured eye lands there.
  // `furniture: false` because the TBD already models its seats; the station still owns the gun pivot.
  // The cushion top: buildModel's pan centre 0.31 plus its 0.05 half-height, on the gear datum.
  const seatTop = 0.36 + model.root.position.y;
  // Cushion centre in the final (nose -Z) frame is the seat's model x minus its 0.15 m forward
  // cushion offset; the model's own +X maps to +Z. Seats are at x = -2.46, -0.98, +0.55.
  const seatAt = (pelvisZ: number, yaw: number): [number, number, number] => {
    const [px, py, pz] = SEATED_PELVIS;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return [-px * c - pz * s, seatTop - py, pelvisZ + px * s - pz * c];
  };
  const pilot = createSeatedStation("TBD front pilot", seatAt(-2.61, PI), PI, { furniture: false });
  const shift = eye.clone().sub(pilot.eye);
  pilot.root.position.add(shift);
  pilot.eye.add(shift);
  root.add(pilot.root);
  root.userData.crew = [pilot.root];
  root.userData.pilotRig = pilot.player;
  root.userData.pilotEye = pilot.eye;
  // The gunner's own rig root is published — not the station — so a first-person station can hide
  // the man without taking his seat or the gun with him; `rearGun` is the pivot the controls turn.
  const gunner = createSeatedStation("TBD rear gunner", seatAt(0.4, 0), 0, {
    gun: true,
    furniture: false,
  });
  root.add(gunner.root);
  root.userData.gunner = gunner.player.root;
  root.userData.gunnerRig = gunner.player;
  root.userData.gunnerEye = gunner.eye;
  root.userData.rearGun = gunner.gun;
  root.userData.owned = [
    ...((root.userData.owned as T.Object3D[] | undefined) ?? []),
    pilot.furniture,
    gunner.furniture,
  ];
  instances.set(root, { model, propeller, blades, blur, torpedo: model.parts.torpedo!, interior, crew: [pilot, gunner] });
  return root;
}

export function animateDevastator(
  root: T.Group,
  p: {
    rpm?: number;
    throttle?: number;
    elevator?: number;
    controlAileron?: number;
    aileron?: number;
    rudder?: number;
    flapPos?: number;
    gearPos?: number;
    torpedo?: number;
  },
  dt: number,
): void {
  const inst = instances.get(root);
  if (!inst) throw new Error(`${root.name || "This object"} is not a Devastator.`);
  const { model, propeller, blur, blades, interior } = inst;
  const rpm = T.MathUtils.clamp(p.rpm ?? p.throttle ?? 0, 0, 1);
  model.setControl("rpm", rpm * 2400);
  model.setControl("gear", 1 - T.MathUtils.clamp(p.gearPos ?? 1, 0, 1));
  model.setControl("flaps", T.MathUtils.clamp(p.flapPos ?? 0, 0, 1));
  model.setControl("aileron", T.MathUtils.clamp(p.controlAileron ?? p.aileron ?? 0, -1, 1));
  model.setControl("elevator", T.MathUtils.clamp(p.elevator ?? 0, -1, 1));
  model.setControl("rudder", T.MathUtils.clamp(p.rudder ?? 0, -1, 1));
  model.setControl("hook", T.MathUtils.clamp(p.gearPos ?? 1, 0, 1));
  model.update(dt);
  // The visible blades live under the mount's -90° yaw (nose -Z frame), while the model's own
  // prop group stayed behind in the nose -X build frame — spin what is actually drawn, at the
  // model's own eased rpm so blades and blur agree.
  const easedRpm = inst.model.getState().current.rpm ?? 0;
  propeller.rotation.z += ((easedRpm * TAU) / 60) * dt;
  interior?.update(p);
  inst.torpedo.visible = (p.torpedo ?? 0) > 0;
  // Hide the blades, never the group: the blur rides the same pivot and would go with it.
  // Same swap point and same fixed opacity as the Douglas, so the two aircraft's propellers match.
  blades.visible = rpm < 0.24;
  blur.visible = rpm >= 0.24;
  // Each seated man holds the sit idle at the frame's own dt, so a paused (dt = 0) frame freezes
  // him exactly like the propeller.
  for (const station of inst.crew) station.player.update(dt);
}
/** Rewind one pooled Devastator's crew animation to rest time. */
export function resetDevastatorAnimation(root: T.Group): void {
  const inst = instances.get(root);
  if (inst) for (const station of inst.crew) station.player.mixer.setTime(0);
}

export function disposeDevastator(root: T.Group): void {
  const inst = instances.get(root);
  if (!inst) return;
  // The crew's skinned geometry is the shared pilot GLTF's; only their mixer bindings are ours.
  for (const station of inst.crew) station.player.dispose();
  inst.interior?.dispose();
  inst.model.dispose();
  inst.blur.geometry.dispose();
  inst.blur.material.map?.dispose();
  inst.blur.material.dispose();
  instances.delete(root);
}
