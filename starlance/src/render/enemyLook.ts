// Meshes for everything the enemies and weapons lanes spawn. One look: the player's hard-surface
// language in the opposite hue (gunmetal #2a2328, crimson #7a1626, amber emissive #ff7a1a).
// Every geometry and material is built once and shared; each factory only wraps them in new
// Groups/Meshes, so spawning costs no allocation of GPU resources.
//
// Orientation convention (read by the enemies lane): a fighter's or turret's nose and a boss's prow
// point local -Z, like `Ship.mesh`. Bolt streaks are symmetric along Z.
import { type IMergePart, mergeParts } from "@threenative/core";
import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  OctahedronGeometry,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";

export type BoltKind = "laser" | "twin" | "hyper" | "homing" | "bomb" | "enemy";
export type ItemKind = "laser" | "bomb" | "wing" | "silverRing" | "goldRing";

// ---- palette (the style guide's colours) ------------------------------------------------------
const GUNMETAL = 0x2a2328;
const GRAPHITE = 0x141214;
const CRIMSON = 0x6c0f20;
const CRIMSON_DARK = 0x4a0e18;
const AMBER = 0xff7a1a;
const VIOLET = 0x5a44b0;
const CYAN = 0x1fd9ff;

// ---- tiny geometry kit ------------------------------------------------------------------------
const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const at = (
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = 1,
  sz = 1,
): Matrix4 =>
  _m
    .compose(new Vector3(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), new Vector3(sx, sy, sz))
    .clone();

type Poly = readonly (readonly [number, number])[];

/** A convex (x,z) outline extruded between y0 and y1: faceted slab for wings, plates, prows. */
function prism(poly: Poly, y0: number, y1: number): BufferGeometry {
  const pos: number[] = [];
  const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const centre = new Vector3(cx, (y0 + y1) / 2, cz);
  const tri = (a: Vector3, b: Vector3, c: Vector3): void => {
    const n = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    const mid = new Vector3().add(a).add(b).add(c).divideScalar(3).sub(centre);
    const [p, q] = n.dot(mid) < 0 ? [c, b] : [b, c];
    pos.push(a.x, a.y, a.z, p.x, p.y, p.z, q.x, q.y, q.z);
  };
  const v = (p: readonly [number, number], y: number): Vector3 => new Vector3(p[0], y, p[1]);
  for (let i = 1; i < poly.length - 1; i += 1) {
    tri(
      v(poly[0] as [number, number], y1),
      v(poly[i] as [number, number], y1),
      v(poly[i + 1] as [number, number], y1),
    );
    tri(
      v(poly[0] as [number, number], y0),
      v(poly[i] as [number, number], y0),
      v(poly[i + 1] as [number, number], y0),
    );
  }
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i] as [number, number];
    const b = poly[(i + 1) % poly.length] as [number, number];
    tri(v(a, y0), v(b, y0), v(b, y1));
    tri(v(a, y0), v(b, y1), v(a, y1));
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  return g;
}

const mirrorX = (poly: Poly): Poly => poly.map(([x, z]) => [-x, z] as const).reverse();

/** Merges coloured parts into one flat-shaded buffer (one draw call). */
function build(label: string, parts: IMergePart[]): BufferGeometry {
  const merged = mergeParts(parts, { label });
  const flat = merged.index !== null ? merged.toNonIndexed() : merged;
  flat.computeVertexNormals();
  flat.computeBoundingSphere();
  return flat;
}

const part = (
  geometry: BufferGeometry,
  color: number | undefined,
  matrix: Matrix4 = new Matrix4(),
): IMergePart => (color === undefined ? { geometry, matrix } : { geometry, matrix, color });

// ---- shared materials -------------------------------------------------------------------------
let materials: { hull: MeshStandardMaterial; glow: MeshStandardMaterial } | undefined;
function mats() {
  materials ??= {
    hull: new MeshStandardMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.52 }),
    glow: new MeshStandardMaterial({
      color: 0x180a04,
      emissive: AMBER,
      emissiveIntensity: 1.8,
      metalness: 0,
      roughness: 0.5,
    }),
  };
  return materials;
}

const cache = new Map<string, BufferGeometry>();
function cached(key: string, make: () => BufferGeometry): BufferGeometry {
  let g = cache.get(key);
  if (g === undefined) {
    g = make();
    cache.set(key, g);
  }
  return g;
}

/** A hull mesh and a glow mesh sharing one pair of cached geometries. */
function pair(key: string, hull: () => BufferGeometry, glow: () => BufferGeometry): Group {
  const m = mats();
  const g = new Group();
  g.add(
    new Mesh(cached(`${key}:hull`, hull), m.hull),
    new Mesh(cached(`${key}:glow`, glow), m.glow),
  );
  return g;
}

// ---- fighter ----------------------------------------------------------------------------------
const WING: Poly = [
  [0.35, -0.7],
  [2.7, 1.2],
  [2.6, 1.9],
  [0.35, 1.7],
];
const EDGE: Poly = [
  [0.35, -0.7],
  [2.7, 1.2],
  [2.55, 1.32],
  [0.3, -0.52],
];

export function fighterMesh(): Object3D {
  const out = pair(
    "fighter",
    () =>
      build("fighter hull", [
        part(
          new ConeGeometry(0.58, 3.4, 4),
          GUNMETAL,
          at(0, 0, -0.5, -Math.PI / 2, Math.PI / 4, 0, 1, 1, 0.7),
        ),
        part(new BoxGeometry(1.0, 0.62, 1.5), GRAPHITE, at(0, 0, 1.25)),
        part(new BoxGeometry(0.26, 0.1, 2.0), CRIMSON, at(0, 0.3, 0.1)),
        part(prism(WING, -0.06, 0.1), CRIMSON),
        part(prism(mirrorX(WING), -0.06, 0.1), CRIMSON),
        part(prism(EDGE, -0.1, 0.16), GRAPHITE),
        part(prism(mirrorX(EDGE), -0.1, 0.16), GRAPHITE),
        part(new BoxGeometry(0.3, 0.3, 1.5), GUNMETAL, at(1.55, 0, -0.15)),
        part(new BoxGeometry(0.3, 0.3, 1.5), GUNMETAL, at(-1.55, 0, -0.15)),
        part(new BoxGeometry(0.1, 0.95, 1.1), CRIMSON_DARK, at(0.42, 0.5, 1.3, 0, 0, -0.45)),
        part(new BoxGeometry(0.1, 0.95, 1.1), CRIMSON_DARK, at(-0.42, 0.5, 1.3, 0, 0, 0.45)),
      ]),
    () =>
      build("fighter glow", [
        part(new OctahedronGeometry(0.3), undefined, at(0, 0.3, -0.75, 0, 0, 0, 0.9, 0.6, 1.8)),
        part(new BoxGeometry(0.22, 0.22, 0.14), undefined, at(1.55, 0, -0.95)),
        part(new BoxGeometry(0.22, 0.22, 0.14), undefined, at(-1.55, 0, -0.95)),
        part(new BoxGeometry(0.7, 0.28, 0.16), undefined, at(0, 0, 2.05)),
      ]),
  );
  out.name = "fighter";
  return out;
}

// ---- turret -----------------------------------------------------------------------------------
function turretGeometry(): [BufferGeometry, BufferGeometry] {
  return [
    build("turret hull", [
      part(new CylinderGeometry(1.25, 1.45, 0.9, 6), GUNMETAL, at(0, 0.45, 0)),
      part(new IcosahedronGeometry(1, 0), CRIMSON, at(0, 1.15, 0, 0, 0, 0, 1, 0.72, 1.05)),
      part(new BoxGeometry(0.24, 0.24, 2.0), GRAPHITE, at(0.5, 1.2, -1.4)),
      part(new BoxGeometry(0.24, 0.24, 2.0), GRAPHITE, at(-0.5, 1.2, -1.4)),
      part(new BoxGeometry(2.4, 0.2, 0.5), CRIMSON_DARK, at(0, 0.95, 0.4)),
    ]),
    build("turret glow", [
      part(new BoxGeometry(0.34, 0.34, 0.14), undefined, at(0.5, 1.2, -2.45)),
      part(new BoxGeometry(0.34, 0.34, 0.14), undefined, at(-0.5, 1.2, -2.45)),
      part(new BoxGeometry(0.8, 0.14, 0.12), undefined, at(0, 1.3, -0.8)),
    ]),
  ];
}

let turretGeo: [BufferGeometry, BufferGeometry] | undefined;

export function turretMesh(): Object3D {
  const geo = (): [BufferGeometry, BufferGeometry] => (turretGeo ??= turretGeometry());
  const out = pair(
    "turret",
    () => geo()[0],
    () => geo()[1],
  );
  out.name = "turret";
  return out;
}

// ---- items and rings --------------------------------------------------------------------------
let itemMats:
  | {
      crystal: MeshStandardMaterial;
      frame: MeshStandardMaterial;
      silver: MeshStandardMaterial;
      gold: MeshStandardMaterial;
    }
  | undefined;
function items() {
  itemMats ??= {
    crystal: new MeshStandardMaterial({
      color: 0x08262e,
      emissive: CYAN,
      emissiveIntensity: 2.0,
      metalness: 0.1,
      roughness: 0.15,
    }),
    frame: new MeshStandardMaterial({
      color: VIOLET,
      emissive: 0x2a1a6a,
      emissiveIntensity: 0.8,
      metalness: 0.7,
      roughness: 0.3,
    }),
    silver: new MeshStandardMaterial({
      color: 0xdfe6f0,
      emissive: 0x8aa0c0,
      emissiveIntensity: 0.7,
      metalness: 0.85,
      roughness: 0.25,
    }),
    gold: new MeshStandardMaterial({
      color: 0xffc65a,
      emissive: 0xffa21f,
      emissiveIntensity: 1.1,
      metalness: 0.85,
      roughness: 0.25,
    }),
  };
  return itemMats;
}

function ringGeometry(): BufferGeometry {
  const parts: IMergePart[] = [part(new TorusGeometry(3, 0.3, 5, 24), undefined)];
  for (let k = 0; k < 4; k += 1) {
    const a = (k * Math.PI) / 2;
    parts.push(
      part(
        new BoxGeometry(0.5, 1.1, 0.5),
        undefined,
        at(Math.cos(a) * 3.35, Math.sin(a) * 3.35, 0, 0, 0, a),
      ),
    );
  }
  return build("ring", parts);
}

export function itemMesh(kind: ItemKind): Object3D {
  const m = items();
  const g = new Group();
  g.name = kind;
  if (kind === "silverRing" || kind === "goldRing") {
    g.add(new Mesh(cached("ring", ringGeometry), kind === "goldRing" ? m.gold : m.silver));
    return g;
  }
  // Cyan crystal inside a violet frame. The shape tells the pickup: needle = laser, orb = bomb,
  // plus = wing repair.
  const frame = (key: string, make: () => IMergePart[]): Mesh =>
    new Mesh(
      cached(`item:${key}:frame`, () => build(`${key} frame`, make())),
      m.frame,
    );
  const crystal = (key: string, make: () => IMergePart[]): Mesh =>
    new Mesh(
      cached(`item:${key}:crystal`, () => build(`${key} crystal`, make())),
      m.crystal,
    );
  const ring = (r: number, rx: number, ry: number): IMergePart =>
    part(new TorusGeometry(r, 0.07, 4, 6), undefined, at(0, 0, 0, rx, ry, 0));
  if (kind === "laser") {
    g.add(
      frame("laser", () => [
        ring(1.0, 0, 0),
        ring(1.0, Math.PI / 2, 0),
        part(new ConeGeometry(0.14, 0.5, 4), undefined, at(0, 1.25, 0)),
      ]),
      crystal("laser", () => [
        part(new OctahedronGeometry(0.42), undefined, at(0, 0, 0, 0, 0, 0, 0.5, 1.9, 0.5)),
      ]),
    );
  } else if (kind === "bomb") {
    g.add(
      frame("bomb", () => [
        ring(1.05, 0, 0),
        ring(1.05, Math.PI / 2, 0),
        ring(1.05, 0, Math.PI / 2),
      ]),
      crystal("bomb", () => [part(new IcosahedronGeometry(0.58, 0), undefined)]),
    );
  } else {
    g.add(
      frame("wing", () => [
        part(new CylinderGeometry(1.1, 1.1, 0.16, 6), undefined, at(0, 0, 0, Math.PI / 2, 0, 0)),
        part(new TorusGeometry(1.15, 0.07, 4, 6), undefined),
      ]),
      crystal("wing", () => [
        part(new BoxGeometry(1.2, 0.36, 0.36), undefined),
        part(new BoxGeometry(0.36, 1.2, 0.36), undefined),
        part(new OctahedronGeometry(0.3), undefined),
      ]),
    );
  }
  return g;
}

// ---- bolts ------------------------------------------------------------------------------------
let boltMaterial: MeshBasicMaterial | undefined;
function boltMat(): MeshBasicMaterial {
  boltMaterial ??= new MeshBasicMaterial({
    vertexColors: true,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
  });
  return boltMaterial;
}

const scaleColor = (hex: number, k: number): number => {
  const r = Math.round(((hex >> 16) & 255) * k);
  const g = Math.round(((hex >> 8) & 255) * k);
  const b = Math.round((hex & 255) * k);
  return (r << 16) | (g << 8) | b;
};

/** A glowing streak: white-hot core inside a wider, dimmer sleeve, symmetric along Z. */
function streak(len: number, core: number, glow: number, r: number, fins = false): BufferGeometry {
  const parts: IMergePart[] = [
    part(new OctahedronGeometry(1), core, at(0, 0, 0, 0, 0, 0, r, r, len / 2)),
    part(
      new OctahedronGeometry(1),
      scaleColor(glow, 0.34),
      at(0, 0, 0, 0, 0, 0, r * 3.2, r * 3.2, len * 0.46),
    ),
  ];
  if (fins) {
    for (const rz of [0, Math.PI / 2]) {
      parts.push(
        part(
          new OctahedronGeometry(1),
          scaleColor(glow, 0.22),
          at(0, 0, 0, 0, 0, rz, r * 0.4, r * 6, len * 0.5),
        ),
      );
    }
  }
  const g = mergeParts(parts, { label: "bolt" });
  g.computeBoundingSphere();
  return g;
}

function orb(rCore: number, rHalo: number, core: number, glow: number, tail = 0): BufferGeometry {
  const parts: IMergePart[] = [
    part(new IcosahedronGeometry(rCore, 1), core),
    part(new IcosahedronGeometry(rHalo, 1), scaleColor(glow, 0.3)),
  ];
  if (tail > 0)
    parts.push(
      part(
        new OctahedronGeometry(1),
        scaleColor(glow, 0.4),
        at(0, 0, 0, 0, 0, 0, rCore * 1.3, rCore * 1.3, tail),
      ),
    );
  const g = mergeParts(parts, { label: "orb" });
  g.computeBoundingSphere();
  return g;
}

const PLAYER_CORE = 0x9ff6ff;
const PLAYER_GLOW = 0x1fd9ff;
const ENEMY_CORE = 0xff9a3a;
const ENEMY_GLOW = 0xff5a10;

export function boltMesh(kind: BoltKind): Object3D {
  const geometry = cached(`bolt:${kind}`, () => {
    switch (kind) {
      case "laser":
        return streak(3.4, PLAYER_CORE, PLAYER_GLOW, 0.07);
      case "twin":
        return streak(3.8, PLAYER_CORE, PLAYER_GLOW, 0.09);
      case "hyper":
        return streak(4.6, 0xeaffff, PLAYER_GLOW, 0.12, true);
      case "homing":
        return orb(0.32, 0.75, 0xeaffff, PLAYER_GLOW, 2.4);
      case "bomb":
        return orb(0.5, 1.4, 0xffffff, PLAYER_GLOW, 1.8);
      case "enemy":
        return orb(0.24, 0.62, ENEMY_CORE, ENEMY_GLOW, 1.5);
    }
  });
  const mesh = new Mesh(geometry, boltMat());
  mesh.name = `bolt:${kind}`;
  return mesh;
}

// ---- boss carrier -----------------------------------------------------------------------------
export interface IBossLook {
  readonly root: Object3D;
  /** Three weak-point turrets, children of `root`. */
  readonly weakPoints: readonly Object3D[];
  readonly core: Object3D;
  /** The two clamshell plates over the core bay; named `coreHatch` under `root`. */
  readonly coreHatch: Object3D;
  /** 0 closed .. 1 fully open. The game drives it from `core.scale` (0.3 closed, 1 open). */
  setOpen(amount: number): void;
}

const BODY: Poly = [
  [0, -14],
  [6.5, -14],
  [7.5, 10],
  [5.5, 22],
  [-5.5, 22],
  [-7.5, 10],
  [-6.5, -14],
];
const PROW: Poly = [
  [0, -26],
  [6.5, -14],
  [-6.5, -14],
];
const BOSS_WING: Poly = [
  [6, -9],
  [30, -2],
  [31, 8],
  [27, 14],
  [6, 16],
];
const BOSS_EDGE: Poly = [
  [6, -9],
  [30, -2],
  [29.4, 0.8],
  [6, -6],
];
/** (height, z) outline of a tail fin, extruded across x and stood up by a quarter turn. */
const FIN: Poly = [
  [0, 6],
  [13, 16],
  [16, 22],
  [0, 22],
];
const RIDGE: Poly = [
  [-2.2, -12],
  [2.2, -12],
  [3, 16],
  [-3, 16],
];

let hatchMaterial: MeshStandardMaterial | undefined;

export function bossMesh(): IBossLook {
  const m = mats();
  const root = new Group();
  root.name = "boss";
  root.add(
    new Mesh(
      cached("boss:hull", () =>
        build("boss hull", [
          part(prism(BODY, -5, 5), GUNMETAL),
          part(prism(PROW, -4, 4.4), CRIMSON),
          part(prism(RIDGE, 5, 6.8), CRIMSON_DARK),
          part(prism(BOSS_WING, 0, 4.6), CRIMSON),
          part(prism(mirrorX(BOSS_WING), 0, 4.6), CRIMSON),
          part(prism(BOSS_EDGE, -0.8, 5.4), GRAPHITE),
          part(prism(mirrorX(BOSS_EDGE), -0.8, 5.4), GRAPHITE),
          part(new BoxGeometry(5, 3.2, 6), GUNMETAL, at(0, 7.4, 11)),
          // Vertical fins: the side-on silhouette that says "carrier" in the all-range arena.
          ...[-10, 10].map((x) =>
            part(prism(FIN, -0.9, 0.9), CRIMSON, at(x, 5, 0, 0, 0, Math.PI / 2)),
          ),
          part(prism(FIN, -0.7, 0.7), CRIMSON_DARK, at(0, 5, 2, 0, 0, Math.PI / 2)),
          ...[-3.6, 0, 3.6].map((x) =>
            part(
              new CylinderGeometry(2.3, 2.7, 3.6, 8),
              GRAPHITE,
              at(x, 0, 23.8, Math.PI / 2, 0, 0),
            ),
          ),
          ...[-12, 12].map((x) => part(new BoxGeometry(4, 1.6, 12), GRAPHITE, at(x, -0.6, 4))),
        ]),
      ),
      m.hull,
    ),
    new Mesh(
      cached("boss:glow", () =>
        build("boss glow", [
          ...[-3.6, 0, 3.6].map((x) =>
            part(
              new CylinderGeometry(1.9, 1.9, 0.5, 8),
              undefined,
              at(x, 0, 25.7, Math.PI / 2, 0, 0),
            ),
          ),
          part(new BoxGeometry(4, 0.5, 0.3), undefined, at(0, 7.9, 7.9)),
          part(
            prism(
              [
                [6.8, -7.6],
                [29.6, -1.2],
                [29.2, 0],
                [6.8, -6.2],
              ],
              4.7,
              5.0,
            ),
            undefined,
          ),
          part(
            prism(
              mirrorX([
                [6.8, -7.6],
                [29.6, -1.2],
                [29.2, 0],
                [6.8, -6.2],
              ]),
              4.7,
              5.0,
            ),
            undefined,
          ),
          part(new BoxGeometry(1.2, 0.5, 6), undefined, at(0, 6.9, -6)),
        ]),
      ),
      m.glow,
    ),
  );

  // Weak points: the enemies lane reads their world positions, so each group sits at (x, 7, 0)
  // and its turret hangs 1.8 m below that, standing on the hull.
  const weakPoints = [-20, 0, 20].map((x) => {
    const g = new Group();
    g.name = "weakPoint";
    g.position.set(x, 7, 0);
    const t = turretMesh();
    t.scale.setScalar(1.7);
    t.position.y = -1.8;
    g.add(t);
    root.add(g);
    return g;
  });

  // Core bay under the belly: an amber-white core inside two clamshell plates that swing apart.
  hatchMaterial ??= new MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.62,
    roughness: 0.38,
    side: DoubleSide,
  });
  const coreMaterial = new MeshStandardMaterial({
    color: 0x1a0a04,
    emissive: 0xffa040,
    emissiveIntensity: 3,
    metalness: 0,
    roughness: 0.4,
  });
  const core = new Mesh(
    cached("boss:core", () => new IcosahedronGeometry(3.4, 1)),
    coreMaterial,
  );
  core.name = "core";
  core.position.set(0, -6, 0);
  root.add(core);

  const hatch = new Group();
  hatch.name = "coreHatch";
  hatch.position.copy(core.position);
  const shellGeometry = cached("boss:shell", () => {
    const g = new SphereGeometry(5.3, 8, 6, 0, Math.PI).toNonIndexed();
    const colors: number[] = [];
    const base = [0x7a1626, 0x2a2328];
    for (let i = 0; i < g.attributes.position!.count; i += 1) {
      const c = base[Math.floor(i / 3) % 2] as number;
      colors.push(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
    }
    g.setAttribute("color", new Float32BufferAttribute(colors, 3));
    g.computeVertexNormals();
    return g;
  });
  const front = new Mesh(shellGeometry, hatchMaterial);
  const back = new Mesh(shellGeometry, hatchMaterial);
  back.rotation.y = Math.PI;
  front.name = "hatchFront";
  back.name = "hatchBack";
  hatch.add(front, back);
  root.add(hatch);

  const setOpen = (amount: number): void => {
    const t = Math.min(1, Math.max(0, amount));
    front.position.z = t * 4.6;
    back.position.z = -t * 4.6;
    front.rotation.x = t * 0.7;
    back.rotation.x = -t * 0.7;
    coreMaterial.emissiveIntensity = 1.5 + 4 * t;
  };
  setOpen(0);

  return { root, weakPoints, core, coreHatch: hatch, setOpen };
}

// ---- wingman ----------------------------------------------------------------------------------
const ALLY_GOLD = 0xffc65a;
const HULL_BY_NAME: [RegExp, number][] = [
  [/^Hull trim/, 0xb0a0a4],
  [/^Hull/, 0x9c8c91],
  [/^Wing \|/, 0x8a8088],
  [/^Armor \|/, 0x3d2f8a],
];

/**
 * An allied fighter: the player's model, in the model's own frame (nose +Z, native size), so
 * the squadron reads as one. Its 30 materials would cost 30 draws each, so the pieces are
 * baked into two meshes: armour in the guide's colours, and the cyan ion glow swapped to pale gold
 * (`#ffc65a`) on its own cloned material. The player's materials are never touched.
 */
export function wingmanMesh(playerModel: Object3D): Object3D {
  const root = playerModel.clone(true);
  root.updateMatrixWorld(true);
  const inverse = new Matrix4().copy(root.matrixWorld).invert();
  const body: IMergePart[] = [];
  const ion: IMergePart[] = [];
  const meshes: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh === true) meshes.push(o as Mesh);
  });
  for (const mesh of meshes) {
    const mat = (
      Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    ) as MeshStandardMaterial;
    const matrix = new Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const glows = Math.max(mat.emissive?.r ?? 0, mat.emissive?.g ?? 0, mat.emissive?.b ?? 0) >= 0.5;
    if (glows) {
      ion.push({ geometry: mesh.geometry, matrix });
    } else {
      const named = HULL_BY_NAME.find(([re]) => re.test(mat.name));
      body.push({
        geometry: mesh.geometry,
        matrix,
        color: named !== undefined ? named[1] : mat.color,
      });
    }
  }
  if (body.length === 0) return root;
  const out = new Group();
  out.name = "wingman";
  const bodyMat = new MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.4 });
  out.add(new Mesh(mergeParts(body, { label: "wingman body" }), bodyMat));
  if (ion.length > 0) {
    const glow = new MeshStandardMaterial({
      color: 0x1a1204,
      emissive: ALLY_GOLD,
      emissiveIntensity: 2.2,
      metalness: 0,
      roughness: 0.3,
    });
    out.add(new Mesh(mergeParts(ion, { label: "wingman ion" }), glow));
  }
  return out;
}
