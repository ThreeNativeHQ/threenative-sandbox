/**
 * Detailed, physically-driven cockpit interior, ported from the standalone `cockpit.html`
 * material study. Native space is metres, forward -Z, Y up, and the pilot eye sits at
 * `EYE`. Static geometry is batched by material; flight controls and gauge needles are kept
 * out of the batch so live flight state can drive them.
 */
import * as T from "three";
import { Fn, cos, mix, sin, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import type { IAssetLoader } from "@threenative/core";

const PBR = [
  "olive-frame",
  "olive-body",
  "black-panel",
  "black-metal",
  "leather",
  "rubber",
  "steel",
  "red-paint",
  "seat-leather",
] as const;
const DIALS = ["airspeed", "altimeter", "rpm", "fuel", "climb", "oil", "attitude", "compass", "manifold"] as const;
const LABELS = [
  "instruments",
  "serial",
  "dive",
  "engine",
  "trim",
  "electric",
  "gear",
  "fuel",
  "warning",
  "oxygen",
] as const;

/** Pilot eye in the interior's native space. */
export const EYE: [number, number, number] = [0, 1.42, 1.6];

export type CockpitMaterials = Record<string, any> & { textures: Record<string, T.Texture> };

export async function loadCockpitMaterials(
  assets: Pick<IAssetLoader, "texture">,
  base = "/assets/cockpit/",
  anisotropy = 8,
): Promise<CockpitMaterials> {
  // Load by CAPABILITY, never by browser sniff, and through the engine's own loader, which decodes
  // by capability: `fetch` + `createImageBitmap` with the orientation the platform needs. The native
  // runtime has `window` and `document` but no `Image`/`HTMLImageElement`, so a `TextureLoader`
  // (which builds an <img>) cannot run there — and because `pbr()` takes its colour from the
  // basecolor map alone, every cockpit texture silently missing on native rendered the whole
  // interior white and fully metallic. Colour space, wrap and anisotropy ride along in the one
  // call: an albedo is sRGB and a normal/orm is data, which is the trap the options close.
  const textures: Record<string, T.Texture> = {};
  const load = async (name: string, file: string, srgb: boolean, wrap: T.Wrapping = T.RepeatWrapping) => {
    const t = await assets.texture(base + file, { data: !srgb, wrap, anisotropy });
    t.name = name;
    textures[name] = t;
  };
  // Headless CPU checks import this module with no image decoder at all; those build the same
  // materials map-lessly. Any target that can decode an image loads the real ones.
  if (typeof createImageBitmap === "function" || typeof Image !== "undefined") {
    await Promise.all([
      ...PBR.flatMap((id) => [
        load(`${id}-basecolor`, `${id}-basecolor.jpg`, true),
        load(`${id}-normal`, `${id}-normal.png`, false),
        load(`${id}-orm`, `${id}-orm.png`, false),
      ]),
      load("glass-normal", "glass-normal.png", false),
      // The artificial horizon's two baked faces. See tools/bake-attitude.mjs.
      load("attitude-moving", "attitude-moving.png", true),
      load("attitude-overlay", "attitude-overlay.png", true),
      ...DIALS.map((d) => load(`dial-${d}`, `dial-${d}.png`, true)),
      ...LABELS.map((l) => load(`label-${l}`, `label-${l}.png`, true, T.ClampToEdgeWrapping)),
    ]);
  }

  const m: CockpitMaterials = { textures } as CockpitMaterials;
  const pbr = (id: string, name: string, normal = 0.28) => {
    const mat = new T.MeshStandardMaterial({
      map: textures[`${id}-basecolor`],
      normalMap: textures[`${id}-normal`],
      normalScale: new T.Vector2(normal, normal),
      roughnessMap: textures[`${id}-orm`],
      metalnessMap: textures[`${id}-orm`],
      aoMap: textures[`${id}-orm`],
      aoMapIntensity: 0.6,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 0.64,
    });
    mat.name = name;
    return mat;
  };
  m.frame = pbr("olive-frame", "Worn olive canopy paint", 0.32);
  m.olive = pbr("olive-body", "Interior green primer", 0.25);
  m.panel = pbr("black-panel", "Aged instrument panel enamel", 0.22);
  m.black = pbr("black-metal", "Blackened machined metal", 0.22);
  m.leather = pbr("leather", "Coaming leather", 0.45);
  m.rubber = pbr("rubber", "Bakelite and rubber", 0.4);
  m.steel = pbr("steel", "Brushed steel", 0.17);
  m.red = pbr("red-paint", "Worn oxide red enamel", 0.28);
  m.seat = pbr("seat-leather", "Aged seat cushion leather", 0.45);
  const solid = (name: string, color: number, roughness: number, metalness: number) => {
    const a = new T.MeshStandardMaterial({ color: new T.Color(color), roughness, metalness });
    a.name = name;
    return a;
  };
  m.edge = solid("Exposed aluminium edges", 0x7d8179, 0.43, 0.85);
  m.darkEdge = solid("Oxidized aluminium", 0x353a35, 0.5, 0.72);
  m.bolt = solid("Steel screw heads", 0x777b72, 0.37, 0.85);
  m.washer = solid("Darkened fastener washers", 0x303630, 0.46, 0.8);
  m.slot = solid("Recessed screw slots", 0x101510, 0.91, 0.0);
  m.brass = solid("Aged brass fittings", 0x998259, 0.44, 0.78);
  m.needle = solid("Warm ivory dial hands", 0xd5c598, 0.59, 0.1);
  m.canvas = solid("Khaki woven restraint webbing", 0x8b876b, 0.99, 0.0);
  m.darkRed = solid("Red Bakelite grip", 0x742820, 0.37, 0.1);
  m.yellow = solid("Yellow identification collar", 0xa79039, 0.56, 0.1);
  m.glass = new T.MeshPhysicalMaterial({
    name: "Thin canopy glass",
    color: 0xb1c4c4,
    roughness: 0.11,
    metalness: 0.02,
    transparent: true,
    opacity: 0.045,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    envMapIntensity: 0.6,
    side: T.DoubleSide,
    depthWrite: false,
    normalMap: textures["glass-normal"],
    normalScale: new T.Vector2(0.065, 0.065),
  });
  m.lens = m.glass.clone();
  m.lens.name = "Instrument cover glass";
  m.lens.opacity = 0.075;
  m.lens.envMapIntensity = 0.7;
  m.lens.normalScale.set(0.028, 0.028);
  m.sightGlass = m.glass.clone();
  m.sightGlass.name = "Reflector sight glass";
  m.sightGlass.opacity = 0.095;
  m.sightGlass.envMapIntensity = 0.8;
  m.reticle = new T.MeshBasicMaterial({ color: 0xf7d277, transparent: true, opacity: 0.88, toneMapped: false });
  m.reticle.name = "Collimated amber reticle";
  m.reticleGlow = new T.MeshBasicMaterial({ color: 0xe8b646, transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false });
  m.reticleGlow.name = "Reticle soft halo";
  m.dials = {};
  m.labels = {};
  for (const d of DIALS) {
    const t = textures[`dial-${d}`];
    if (t) t.wrapS = t.wrapT = T.ClampToEdgeWrapping;
    const a = new T.MeshStandardMaterial({ map: t, roughness: 0.91, metalness: 0.015, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.085 });
    a.name = `Printed dial-${d}`;
    m.dials[d] = a;
  }
  for (const l of LABELS) {
    const t = textures[`label-${l}`];
    const a = new T.MeshStandardMaterial({ map: t, roughness: 0.75, metalness: 0.12 });
    a.name = `Placard label-${l}`;
    m.labels[l] = a;
  }
  return m;
}

export interface CockpitInterior {
  root: T.Group;
  eye: [number, number, number];
  update(p: any): void;
  dispose(): void;
}

let cachedMaterials: CockpitMaterials | undefined;
let loadingMaterials: Promise<CockpitMaterials> | undefined;

/** Cockpit textures are loaded once per session and shared by every aircraft that mounts the rig. */
export function ensureCockpitMaterials(
  assets: Pick<IAssetLoader, "texture">,
  anisotropy = 8,
): Promise<CockpitMaterials> {
  loadingMaterials ??= loadCockpitMaterials(assets, "/assets/cockpit/", anisotropy).then((loaded) => (cachedMaterials = loaded));
  return loadingMaterials;
}

export function getCockpitMaterials(): CockpitMaterials | undefined {
  return cachedMaterials;
}

interface AttitudeFace {
  material: T.Material;
  update(pitch: number, roll: number): void;
}

/**
 * Live artificial horizon: sky/ground and pitch ladder move, the aircraft symbol stays fixed.
 *
 * It used to redraw a 256² canvas and re-upload its `CanvasTexture` on every update — an external
 * image upload per frame for a picture that only rotates and slides. The two faces are baked once
 * by tools/bake-attitude.mjs and the motion is two scalars: the fragment maps its own dial pixel
 * back through the old canvas transform and reads the static backing there.
 *
 * `SOURCE` and `BACKING` are the old dial's pixel scale and the baked backing's size; `LADDER` is
 * its 112 px per radian of pitch. Changing any of them means rebaking.
 */
const SOURCE = 256;
const BACKING = 1024;
const LADDER = 112;

function createAttitudeFace(moving: T.Texture | undefined, overlay: T.Texture | undefined): AttitudeFace | undefined {
  if (!moving || !overlay) return undefined;
  const pitchUniform = uniform(0);
  const rollUniform = uniform(0);
  const face = Fn(() => {
    const dial = uv();
    // The old canvas drew in pixels with y downward and a texture is flipped on upload, so this
    // fragment's drawn-pixel position is (u·256, (1−v)·256), and `p` is that relative to the dial
    // centre — the same `p` the canvas transform acted on.
    const p = vec2(dial.x.mul(SOURCE).sub(SOURCE / 2), dial.y.oneMinus().mul(SOURCE).sub(SOURCE / 2));
    // Inverse of `translate(centre); rotate(−roll)` followed by the pitch shift inside that frame.
    const c = cos(rollUniform);
    const s = sin(rollUniform);
    const back = vec2(
      p.x.mul(c).sub(p.y.mul(s)),
      p.x.mul(s).add(p.y.mul(c)).sub(pitchUniform.mul(LADDER)),
    ).add(BACKING / 2);
    const sky = texture(moving, vec2(back.x.div(BACKING), back.y.div(BACKING).oneMinus()));
    const symbol = texture(overlay, dial);
    // The fixed aircraft symbol and top index sit over the transformed face, exactly as the second
    // `ctx.save()` block used to composite them.
    return vec3(mix(sky.rgb, symbol.rgb, symbol.a));
  })();
  const material = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.02 });
  material.name = "Live artificial horizon";
  material.colorNode = face;
  // The old material lit the dial with `emissive: 0xffffff, emissiveIntensity: 0.16` through the
  // same image as `emissiveMap`; that product is this node, and dropping it would put the
  // instrument into shadow the moment the canopy did.
  material.emissiveNode = face.mul(0.16);
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  return {
    material,
    update(pitch: number, roll: number) {
      // The same clamps the canvas applied, so the dial still stops rather than wrapping.
      pitchUniform.value = clamp(pitch, -1.2, 1.2);
      rollUniform.value = clamp(roll, -Math.PI, Math.PI);
    },
  };
}

export function createCockpitInterior(m: CockpitMaterials): CockpitInterior {
  const root = new T.Group();
  root.name = "Cockpit interior";
  const staticRoot = new T.Group();
  staticRoot.name = "Cockpit static";
  const animatedRoot = new T.Group();
  animatedRoot.name = "Cockpit controls";
  root.add(staticRoot, animatedRoot);
  const g = createGeometryTools(T, m, staticRoot);
  const { part, add, box, plate, cylinder, sphere, torus, curve, tube, rod, beam, glassPolygon, lens, lathe, bolt, boltLine, decal, roundedShape, extruded } = g;
  const PI = Math.PI;
  m.olive.side = T.DoubleSide;
  m.frame.side = T.DoubleSide;

  const mk = (geometry: T.BufferGeometry, material: T.Material, p?: number[], rotation?: number[], parent = animatedRoot) => {
    const o = new T.Mesh(geometry, material);
    if (p) o.position.set(p[0], p[1], p[2]);
    if (rotation) o.rotation.set(rotation[0], rotation[1], rotation[2]);
    o.castShadow = !material.transparent;
    o.receiveShadow = !material.transparent;
    if (material.transparent) o.renderOrder = 10;
    parent.add(o);
    return o;
  };
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const tubeGeo = (pts: number[][], r: number, segments = 48, radial = 10, closed = false) =>
    new T.TubeGeometry(curve(pts as any, closed), segments, r, radial, closed);
  const boxGeo = (w: number, h: number, d: number, r = 0.008) => extruded(roundedShape(w, h, r), d, Math.min(0.003, r * 0.35, d * 0.15));

  // ----- Cockpit tub, side sheet metal, floor and rear bulkhead -----
  part("Airframe");
  const tubPos: number[] = [];
  const tubUV: number[] = [];
  const tubIdx: number[] = [];
  const rows = 30;
  const cols = 12;
  for (let j = 0; j <= cols; j += 1)
    for (let i = 0; i <= rows; i += 1) {
      const a = -PI / 2 + (i / rows) * PI;
      const z = -0.57 + (j / cols) * 2.67;
      tubPos.push(0.91 * Math.sin(a), 0.955 - 0.88 * Math.cos(a), z);
      tubUV.push((i / rows) * 2, (j / cols) * 3);
    }
  for (let j = 0; j < cols; j += 1)
    for (let i = 0; i < rows; i += 1) {
      const a = j * (rows + 1) + i;
      const b = a + rows + 1;
      tubIdx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const tub = new T.BufferGeometry();
  tub.setAttribute("position", new T.Float32BufferAttribute(tubPos, 3));
  tub.setAttribute("uv", new T.Float32BufferAttribute(tubUV, 2));
  tub.setIndex(tubIdx);
  tub.computeVertexNormals();
  add(tub, m.olive);
  box(1.16, 2.23, 0.035, [0, 0.17, 0.69], m.olive, 0.025, [-PI / 2, 0, 0]);
  for (const side of [-1, 1]) {
    beam([[side * 0.52, 0.205, -0.45], [side * 0.52, 0.205, 1.79]], 0.065, 0.038, m.frame, 12);
    box(0.31, 0.86, 0.023, [side * 0.31, 0.205, -0.12], m.darkEdge, 0.018, [-PI / 2, 0, 0]);
    for (let j = 0; j < 12; j += 1) box(0.22, 0.012, 0.007, [side * 0.31, 0.221, -0.47 + j * 0.06], m.rubber, 0.003, [-PI / 2, 0, 0]);
    for (let j = 0; j < 15; j += 1) bolt([side * 0.54, 0.235, -0.42 + j * 0.145], [0, 1, 0], 0.006, j * 0.37);
    beam([[side * 0.892, 0.944, -0.56], [side * 0.887, 0.941, 0.3], [side * 0.875, 0.93, 1.9]], 0.055, 0.055, m.frame, 38);
    tube([[side * 0.913, 0.927, -0.5], [side * 0.917, 0.927, 0.5], [side * 0.9, 0.92, 1.95]], 0.012, m.darkEdge, 48);
    for (let j = 0; j < 16; j += 1) bolt([side * 0.856, 0.947, -0.46 + j * 0.148], [0, 1, 0], 0.0065, j);
    for (const z of [-0.35, 0.22, 0.82, 1.48, 1.93]) {
      const pts: number[][] = [];
      for (let j = 0; j <= 12; j += 1) {
        const a = side * (0.7 + (j / 12) * (PI / 2 - 0.7));
        pts.push([0.889 * Math.sin(a), 0.955 - 0.856 * Math.cos(a), z]);
      }
      beam(pts, 0.035, 0.026, m.frame, 24);
      for (const a of [0.9, 1.22, 1.48]) bolt([side * 0.873 * Math.sin(a), 0.955 - 0.84 * Math.cos(a), z + 0.018], [0, 0, 1], 0.006);
    }
    box(0.025, 0.29, 0.61, [side * 0.865, 0.695, 0.57], m.panel, 0.012, [0, (side * PI) / 2, 0]);
    for (let i = 0; i < 5; i += 1) bolt([side * 0.839, 0.805, 0.33 + i * 0.117], [-side, 0, 0], 0.0057, i);
    for (let i = 0; i < 5; i += 1) bolt([side * 0.839, 0.585, 0.33 + i * 0.117], [-side, 0, 0], 0.0057, i + 0.6);
  }
  plate([[-0.7, 0.18], [0.7, 0.18], [0.81, 0.69], [0.73, 1.25], [0.49, 1.35], [-0.49, 1.35], [-0.73, 1.25], [-0.81, 0.69]], 0.029, [0, 0, 1.98], m.olive, 0.008);
  for (let i = 0; i < 14; i += 1) bolt([-0.67 + i * 0.103, 1.235, 2.006], [0, 0, 1], 0.006, i);
  beam([[-0.88, 0.55, 1.91], [-0.79, 1.16, 1.91], [-0.58, 1.75, 1.91], [0, 2.08, 1.91], [0.58, 1.75, 1.91], [0.79, 1.16, 1.91], [0.88, 0.55, 1.91]], 0.047, 0.041, m.frame, 90);
  box(0.66, 0.67, 0.07, [0, 0.4, 1.36], m.olive, 0.075, [-PI / 2, 0, 0]);
  box(0.58, 0.59, 0.06, [0, 0.452, 1.34], m.seat, 0.06, [-PI / 2, 0, 0]);
  box(0.65, 0.75, 0.055, [0, 0.785, 1.72], m.olive, 0.083, [-0.13, 0, 0]);
  box(0.53, 0.57, 0.048, [0, 0.835, 1.675], m.seat, 0.073, [-0.13, 0, 0]);
  for (const side of [-1, 1]) {
    beam([[side * 0.17, 1.19, 1.65], [side * 0.12, 0.9, 1.6], [side * 0.11, 0.64, 1.59]], 0.072, 0.007, m.canvas, 28);
    beam([[side * 0.3, 0.49, 1.42], [side * 0.21, 0.51, 1.26], [side * 0.065, 0.52, 1.22]], 0.083, 0.008, m.canvas, 24);
    box(0.085, 0.11, 0.014, [side * 0.11, 0.67, 1.61], m.steel, 0.006);
    box(0.053, 0.075, 0.018, [side * 0.11, 0.67, 1.622], m.slot, 0.004);
    rod([side * 0.29, 0.21, 1.12], [side * 0.29, 0.43, 1.38], 0.018, m.edge);
  }
  box(0.1, 0.062, 0.019, [0, 0.536, 1.225], m.steel, 0.008, [-PI / 2, 0, 0]);

  // ----- Bevelled, riveted canopy framing -----
  part("Canopy");
  const mainPoints: number[][] = [[-1.015, 0.28, 0.3], [-0.957, 0.66, 0.235], [-0.8, 1.1, 0.13], [-0.652, 1.56, 0.018], [-0.461, 1.894, -0.076], [-0.233, 2.067, -0.117], [0, 2.113, -0.13], [0.233, 2.067, -0.117], [0.461, 1.894, -0.076], [0.652, 1.56, 0.018], [0.8, 1.1, 0.13], [0.957, 0.66, 0.235], [1.015, 0.28, 0.3]];
  mainPoints.forEach((p) => {
    p[0] *= 1.125;
    if (p[1] > 1.5) p[1] -= 0.024;
  });
  const main = beam(mainPoints, 0.082, 0.058, m.frame, 160).curve;
  boltLine(main, 43, 0.038, 0.009);
  const edgeOuter: T.Vector3[] = [];
  const edgeInner: T.Vector3[] = [];
  const rubberSeal: T.Vector3[] = [];
  for (let i = 0; i <= 160; i += 1) {
    const t = i / 160;
    const p = main.getPoint(t);
    const v = main.getTangent(t);
    const n = new T.Vector3(v.y, -v.x, 0).normalize();
    edgeOuter.push(p.clone().addScaledVector(n, -0.042).add(new T.Vector3(0, 0, 0.008)));
    edgeInner.push(p.clone().addScaledVector(n, 0.0395).add(new T.Vector3(0, 0, 0.027)));
    rubberSeal.push(p.clone().addScaledVector(n, -0.052).add(new T.Vector3(0, 0, -0.012)));
  }
  tube(edgeOuter, 0.0033, m.darkEdge, 160, 8);
  tube(edgeInner, 0.00145, m.edge, 160, 6);
  tube(rubberSeal, 0.007, m.rubber, 160, 8);
  for (let i = 4; i < 152; i += 11) tube(edgeOuter.slice(i, i + 4).map((p) => p.clone().add(new T.Vector3(0, 0, 0.005))), 0.00125, m.edge, 6, 5);
  const frontTop: number[][] = [[-0.524, 1.882, -1.084], [-0.395, 1.934, -1.11], [-0.207, 1.982, -1.136], [0, 1.998, -1.148], [0.207, 1.982, -1.136], [0.395, 1.934, -1.11], [0.524, 1.882, -1.084]];
  const top = beam(frontTop, 0.048, 0.04, m.frame, 85).curve;
  boltLine(top, 14, 0.026, 0.0065);
  for (const side of [-1, 1]) {
    const frontLeg = [[side * 0.712, 1.081, -0.602], [side * 0.625, 1.42, -0.803], [side * 0.524, 1.882, -1.084]];
    const strut = beam(frontLeg, 0.051, 0.042, m.frame, 40).curve;
    boltLine(strut, 8, 0.028, 0.0073);
    const trim = frontLeg.map((p) => [p[0] + side * 0.028, p[1], p[2] + 0.021]);
    tube(trim, 0.002, m.edge, 34, 6);
    beam([[side * 0.648, 1.735, -0.04], [side * 0.546, 1.82, -0.56], [side * 0.524, 1.882, -1.084]], 0.036, 0.034, m.frame, 35);
    bolt([side * 0.648, 1.735, -0.015], [0, 0, 1], 0.008);
    bolt([side * 0.525, 1.873, -1.054], [0, 0, 1], 0.007);
    const sill = [[side * 0.997, 0.422, 0.323], [side * 0.939, 0.626, 0.202], [side * 0.835, 0.826, -0.103], [side * 0.717, 1.075, -0.575]];
    beam(sill, 0.065, 0.05, m.frame, 64);
    boltLine(sill, 12, 0.027, 0.0078);
    tube(sill.map((p) => [p[0] - side * 0.032, p[1] + 0.022, p[2] + 0.008]), 0.0065, m.darkEdge, 58);
    tube(sill.map((p) => [p[0] - side * 0.04, p[1] + 0.029, p[2] + 0.019]), 0.002, m.edge, 58, 6);
    beam([[side * 0.959, 0.738, 0.214], [side * 0.982, 0.748, 0.74], [side * 0.998, 0.76, 1.91]], 0.047, 0.043, m.frame, 55);
    tube([[side * 0.946, 0.754, 0.21], [side * 0.969, 0.764, 0.74], [side * 0.985, 0.776, 1.91]], 0.0034, m.steel, 55, 7);
    for (const z of [0.44, 0.95, 1.5]) bolt([side * 0.957, 0.775, z], [0, 1, 0], 0.007, z);
    glassPolygon([[side * 0.941, 0.669, 0.226], [side * 0.796, 1.101, 0.124], [side * 0.647, 1.73, -0.043], [side * 0.52, 1.865, -1.07], [side * 0.702, 1.09, -0.608], [side * 0.832, 0.837, -0.108]], m.glass);
    plate([[-0.047, -0.035], [0.051, -0.029], [0.037, 0.041], [-0.032, 0.052]], 0.017, [side * 0.712, 1.073, -0.553], m.darkEdge, 0.003);
    cylinder(0.026, 0.021, [side * 0.711, 1.091, -0.532], m.bolt);
    cylinder(0.015, 0.025, [side * 0.711, 1.091, -0.516], m.black);
    bolt([side * 0.711, 1.09, -0.499], [0, 0, 1], 0.009);
  }
  glassPolygon([[-0.696, 1.094, -0.618], [0.696, 1.094, -0.618], [0.511, 1.87, -1.088], [0.392, 1.921, -1.115], [0.203, 1.97, -1.14], [0, 1.985, -1.15], [-0.203, 1.97, -1.14], [-0.392, 1.921, -1.115], [-0.511, 1.87, -1.088]], m.glass);
  for (const side of [-1, 1]) {
    beam([[side * 0.845, 1.28, 0.085], [side * 0.994, 1.28, 0.85], [side * 1.055, 1.28, 1.9]], 0.044, 0.038, m.frame, 55);
    tube([[side * 0.848, 1.292, 0.09], [side * 0.997, 1.292, 0.85], [side * 1.058, 1.292, 1.9]], 0.002, m.edge, 55, 6);
    for (const z of [0.12, 0.34, 0.68, 1.14, 1.64]) bolt([side * (0.845 + (z - 0.085) * 0.11), 1.292, z], [0, 1, 0], 0.0065, z);
  }

  // ----- Stacked instrument panel and padded coaming -----
  part("Instruments");
  const panelOutline: number[][] = [[-0.824, 0.23], [0.8, 0.23], [0.797, 0.816], [0.75, 1.05], [0.666, 1.085], [-0.681, 1.085], [-0.786, 1.04], [-0.824, 0.851]];
  plate(panelOutline, 0.05, [0, 0, -0.455], m.darkEdge, 0.008);
  const innerOutline = panelOutline.map(([x, y]) => [x * 0.979, (y - 0.64) * 0.979 + 0.64]);
  plate(innerOutline, 0.018, [0, 0, -0.419], m.panel, 0.004);
  for (let i = 0; i < 14; i += 1) bolt([-0.716 + i * 0.108, 1.053, -0.399], [0, 0, 1], 0.0075, i * 0.64);
  for (let i = 0; i < 14; i += 1) bolt([-0.757 + i * 0.112, 0.258, -0.399], [0, 0, 1], 0.0072, i * 0.74);
  for (let i = 0; i < 5; i += 1)
    for (const s of [-1, 1]) bolt([s * 0.778, 0.35 + i * 0.138, -0.393], [0, 0, 1], 0.0069, i);
  box(1.43, 0.365, 0.04, [0, 1.086, -0.663], m.black, 0.044, [-PI / 2, 0, 0]);
  const coaming: number[][] = [[-0.811, 0.977, -0.382], [-0.744, 1.079, -0.389], [-0.49, 1.099, -0.393], [0, 1.108, -0.393], [0.49, 1.099, -0.393], [0.744, 1.079, -0.389], [0.805, 0.977, -0.382]];
  const coam = tube(coaming, 0.021, m.leather, 90, 12);
  coam.scale.z = 1.13;
  tube(coaming.map((p) => [p[0], p[1] + 0.007, p[2] + 0.015]), 0.0012, m.darkEdge, 90, 6);
  decal("instruments", 0.49, 0.026, [-0.08, 1.039, -0.395]);

  // ----- Live gauges: static bezels and lens, needles driven by flight state -----
  const needles: Array<{ set: (theta: number) => void }> = [];
  const makeNeedle = (x: number, y: number, z: number, r: number, length = 1, width = 1, material = m.needle) => {
    const points: number[][] = [[-0.0034 * width, -r * 0.175], [0.0034 * width, -r * 0.175], [0.0028 * width, r * 0.56 * length], [0.0007, r * 0.82 * length], [0, r * 0.865 * length], [-0.0009, r * 0.79 * length], [-0.0027 * width, r * 0.56 * length]];
    const shape = new T.Shape(points.map((p) => new T.Vector2(p[0], p[1])));
    const geometry = extruded(shape, 0.0018, 0.0004);
    const pivot = new T.Group();
    pivot.name = "Gauge needle";
    pivot.position.set(x, y, z);
    mk(geometry, material, [0, 0, 0], undefined, pivot);
    const hub = new T.Mesh(new T.CylinderGeometry(0.0067, 0.0067, 0.004, 32), m.brass);
    hub.rotation.x = PI / 2;
    hub.position.z = 0.0038;
    pivot.add(hub);
    const cap = new T.Mesh(new T.CylinderGeometry(0.0041, 0.0041, 0.005, 32), m.black);
    cap.rotation.x = PI / 2;
    cap.position.z = 0.0063;
    pivot.add(cap);
    animatedRoot.add(pivot);
    const ref = { set: (theta: number) => (pivot.rotation.z = (-theta * PI) / 180) };
    needles.push(ref);
    return ref;
  };
  const attitudeFace = createAttitudeFace(m.textures["attitude-moving"], m.textures["attitude-overlay"]);
  const gauge = (type: string, x: number, y: number, r: number) => {
    const z = -0.387;
    box((r + 0.019) * 2, (r + 0.019) * 2, 0.017, [x, y, z - 0.01], m.black, 0.02);
    cylinder(r + 0.004, 0.125, [x, y, z - 0.061], m.black, "z", 48);
    torus(r + 0.006, 0.0068, [x, y, z + 0.004], m.rubber);
    const profile = [[r - 0.01, 0], [r + 0.006, 0], [r + 0.013, 0.008], [r + 0.015, 0.017], [r + 0.01, 0.027], [r + 0.003, 0.032], [r - 0.008, 0.028], [r - 0.01, 0.01], [r - 0.01, 0]];
    lathe(profile, [x, y, z], m.black, 72);
    torus(r + 0.004, 0.0016, [x, y, z + 0.03], m.darkEdge);
    torus(r - 0.007, 0.001, [x, y, z + 0.0285], m.edge);
    if (type === "attitude") {
      add(new T.CircleGeometry(r - 0.009, 72), attitudeFace?.material ?? m.dials.attitude, [x, y, z + 0.013]);
    } else {
      add(new T.CircleGeometry(r - 0.009, 72), m.dials[type], [x, y, z + 0.013]);
    }
    lens(r - 0.007, [x, y, z + 0.0295], m.lens, 0.004);
    const c = r + 0.0015;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) bolt([x + sx * c, y + sy * c, z + 0.004], [0, 0, 1], 0.0053, (x + y) * 5 + sx - sy * 0.4);
    if (type === "altimeter" || type === "attitude") {
      const nx = x + r * 0.77;
      const ny = y - r * 0.83;
      cylinder(0.012, 0.024, [nx, ny, z + 0.027], m.black, "z", 24);
      torus(0.01, 0.0013, [nx, ny, z + 0.041], m.edge);
    }
  };
  gauge("airspeed", -0.481, 0.851, 0.146);
  gauge("altimeter", -0.113, 0.851, 0.148);
  gauge("rpm", 0.259, 0.851, 0.146);
  gauge("fuel", -0.482, 0.478, 0.141);
  gauge("climb", -0.113, 0.478, 0.142);
  gauge("oil", 0.259, 0.478, 0.142);
  gauge("attitude", 0.58, 0.815, 0.105);
  box(0.21, 0.167, 0.013, [0.58, 0.589, -0.392], m.black, 0.009);
  decal("serial", 0.171, 0.114, [0.58, 0.591, -0.382]);
  for (const x of [0.486, 0.672])
    for (const y of [0.513, 0.665]) bolt([x, y, -0.376], [0, 0, 1], 0.0049, x + y);
  gauge("compass", 0.574, 0.36, 0.08);
  for (const [x, y] of [[0.765, 0.86], [0.765, 0.756], [0.766, 0.663], [-0.745, 0.733]]) {
    cylinder(0.023, 0.033, [x, y, -0.373], m.black, "z", 28);
    torus(0.023, 0.003, [x, y, -0.35], m.darkEdge);
    cylinder(0.015, 0.036, [x, y, -0.345], m.rubber, "z", 24);
  }
  for (const x of [-0.624, -0.406, -0.2, 0.008, 0.218, 0.409]) {
    cylinder(0.014, 0.02, [x, 0.204, -0.393], m.brass, "z", 20);
    cylinder(0.009, 0.03, [x, 0.204, -0.381], m.rubber, "z", 20);
  }
  const needleAirspeed = makeNeedle(-0.481, 0.851, -0.367, 0.146);
  const needleAltThousands = makeNeedle(-0.113, 0.851, -0.367, 0.148);
  const needleAltTenThousands = makeNeedle(-0.113, 0.851, -0.363, 0.148, 0.61, 1.5);
  const needleAltHundreds = makeNeedle(-0.113, 0.851, -0.359, 0.148, 0.37, 1.0, m.darkEdge);
  const needleRpm = makeNeedle(0.259, 0.851, -0.367, 0.146);
  const needleFuel = makeNeedle(-0.482, 0.478, -0.367, 0.141);
  const needleClimb = makeNeedle(-0.113, 0.478, -0.367, 0.142);
  const needleOil = makeNeedle(0.259, 0.478, -0.367, 0.142);
  const needleCompass = makeNeedle(0.574, 0.36, -0.367, 0.08);

  // ----- Reflector gunsight -----
  part("Gunsight");
  box(0.533, 0.078, 0.29, [0, 1.13, -0.64], m.black, 0.016);
  box(0.588, 0.022, 0.328, [0, 1.087, -0.64], m.darkEdge, 0.012);
  box(0.458, 0.019, 0.249, [0, 1.178, -0.64], m.panel, 0.012);
  for (const x of [-0.237, 0.237])
    for (const z of [-0.53, -0.744]) bolt([x, 1.179, z], [0, 1, 0], 0.007, x + z);
  cylinder(0.123, 0.083, [0, 1.187, -0.747], m.black, "y", 64);
  torus(0.107, 0.007, [0, 1.231, -0.747], m.darkEdge, [PI / 2, 0, 0]);
  const optic = add(new T.CircleGeometry(0.101, 64), m.lens, [0, 1.232, -0.747], [-PI / 2, 0, 0]);
  optic.renderOrder = 11;
  for (const side of [-1, 1]) {
    box(0.032, 0.175, 0.055, [side * 0.205, 1.258, -0.667], m.black, 0.006);
    box(0.052, 0.022, 0.094, [side * 0.205, 1.183, -0.661], m.darkEdge, 0.003);
    cylinder(0.022, 0.067, [side * 0.212, 1.311, -0.657], m.black, "x", 32);
    cylinder(0.017, 0.074, [side * 0.215, 1.311, -0.657], m.brass, "x", 24);
    bolt([side * 0.249, 1.311, -0.657], [side, 0, 0], 0.0095, 0.8);
    cylinder(0.027, 0.03, [side * 0.278, 1.128, -0.512], m.black, "z", 40);
    torus(0.024, 0.003, [side * 0.278, 1.128, -0.493], m.darkEdge);
    bolt([side * 0.278, 1.128, -0.491], [0, 0, 1], 0.009, side);
  }
  const sightShape = roundedShape(0.408, 0.342, 0.046);
  add(new T.ShapeGeometry(sightShape, 16), m.sightGlass, [0, 1.427, -0.661]);
  const contour = sightShape.getPoints(15).map((p) => [p.x, p.y + 1.427, -0.662]);
  tube(contour, 0.005, m.black, 128, 8, true);
  tube(contour.map((p) => [p[0], p[1], p[2] + 0.002]), 0.0011, m.darkEdge, 128, 6, true);
  const center: number[] = [0, 1.469, -0.65];
  const rr = 0.041;
  torus(rr, 0.00095, center, m.reticle);
  torus(rr, 0.0022, [0, 1.469, -0.6503], m.reticleGlow);
  for (const a of [0, PI / 2, PI, PI * 1.5])
    rod([Math.cos(a) * rr * 1.3, 1.469 + Math.sin(a) * rr * 1.3, -0.65], [Math.cos(a) * rr * 1.83, 1.469 + Math.sin(a) * rr * 1.83, -0.65], 0.0008, m.reticle, 6);
  sphere(0.0016, center, m.reticle, [1, 1, 0.3], 12);
  rod([0, 1.369, -0.65], [0, 1.413, -0.65], 0.0006, m.reticle, 6);
  box(0.104, 0.024, 0.003, [0, 1.119, -0.49], m.darkEdge, 0.002);
  for (const x of [-0.045, 0.045]) bolt([x, 1.119, -0.486], [0, 0, 1], 0.0028);

  // ----- Side controls, switchgear, hydraulic plumbing; static parts -----
  part("Controls");
  cylinder(0.045, 0.028, [-0.798, 0.754, 0.07], m.black, "x", 40);
  torus(0.039, 0.004, [-0.817, 0.754, 0.07], m.edge, [0, PI / 2, 0]);
  tube([[-0.35, 0.235, 0.72], [-0.31, 0.53, 0.64], [-0.235, 0.776, 0.55], [-0.185, 0.929, 0.55]], 0.016, m.black, 48, 12);
  sphere(0.049, [-0.185, 0.95, 0.55], m.leather, [1, 1.1, 0.94], 28);
  torus(0.034, 0.004, [-0.185, 0.98, 0.55], m.darkEdge, [PI / 2, 0, 0]);
  box(0.197, 0.238, 0.041, [0.722, 0.73, 0.294], m.black, 0.016, [0, -0.16, 0]);
  decal("electric", 0.178, 0.048, [0.722, 0.825, 0.325], [0, -0.16, 0]);
  for (let row = 0; row < 2; row += 1)
    for (let col = 0; col < 4; col += 1) {
      const x = 0.659 + col * 0.044;
      const y = 0.765 - row * 0.075;
      const z = 0.323 - (x - 0.722) * 0.16;
      cylinder(0.013, 0.009, [x, y, z], m.brass, "z", 12);
      const base = [x, y, z + 0.012];
      const end = [x, y + 0.023 * (row === 0 ? 1 : -1), z + 0.036];
      rod(base, end, 0.0038, m.steel, 10);
      sphere(0.0055, end, m.steel, [1, 1, 1], 12);
      bolt([x, y - 0.027, z], [0, 0, 1], 0.0028, col);
    }
  for (const x of [0.638, 0.809])
    for (const y of [0.623, 0.837]) bolt([x, y, 0.329 - (x - 0.722) * 0.16], [0, 0, 1], 0.0062, x + y);
  box(0.136, 0.16, 0.06, [0.736, 0.496, 0.319], m.olive, 0.014);
  decal("gear", 0.121, 0.046, [0.736, 0.548, 0.354]);
  rod([0.736, 0.485, 0.358], [0.736, 0.503, 0.429], 0.008, m.steel);
  sphere(0.022, [0.736, 0.503, 0.439], m.rubber, [1, 1, 1], 22);
  cylinder(0.052, 0.022, [-0.747, 0.443, 0.158], m.darkEdge);
  cylinder(0.03, 0.03, [-0.747, 0.443, 0.176], m.brass, "z", 32);
  box(0.018, 0.077, 0.032, [-0.747, 0.443, 0.197], m.rubber, 0.006, [0, 0, -0.8]);
  decal("fuel", 0.19, 0.039, [-0.747, 0.36, 0.172]);
  for (const side of [-1, 1]) {
    for (let j = 0; j < 3; j += 1) {
      const x = side * (0.79 + j * 0.025);
      const points = [[x, 0.38, 1.09], [x, 0.48, 0.71], [x, 0.62, 0.39], [x, 0.737, 0.16], [side * (0.778 + j * 0.025), 0.855, -0.047], [side * (0.753 + j * 0.025), 0.916, -0.204]];
      tube(points, j === 2 ? 0.0065 : 0.0082, j === 1 ? m.brass : m.darkEdge, 65, 10);
      if (j === 0) tube(points.map((p) => [p[0] - side * 0.004, p[1] + 0.004, p[2] + 0.004]), 0.0012, m.edge, 60, 5);
      for (const a of [0.19, 0.48, 0.74]) {
        const c = curve(points as any);
        const p = c.getPoint(a);
        const t = c.getTangent(a);
        const collar = cylinder(0.012, 0.022, [p.x, p.y, p.z], m.steel, "y", 12);
        collar.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), t.normalize());
      }
    }
    for (const [y, z] of [[0.57, 0.51], [0.74, 0.16], [0.9, -0.18]]) {
      box(0.112, 0.021, 0.024, [side * 0.813, y, z], m.darkEdge, 0.004);
      bolt([side * 0.813, y, z + 0.016], [0, 0, 1], 0.006, side * y);
    }
    const hose = curve([[side * 0.83, 0.414, 1.14], [side * 0.769, 0.44, 0.87], [side * 0.738, 0.598, 0.55], [side * 0.758, 0.671, 0.322], [side * 0.743, 0.75, 0.17]] as any);
    tube(hose, 0.016, m.rubber, 72, 12);
    for (let j = 0; j < 51; j += 1) {
      const t = j / 50;
      const p = hose.getPointAt(t);
      const tangent = hose.getTangentAt(t);
      const ring = torus(0.016, 0.0021, [p.x, p.y, p.z], m.rubber, null);
      ring.quaternion.setFromUnitVectors(new T.Vector3(0, 0, 1), tangent.normalize());
    }
  }
  decal("warning", 0.226, 0.037, [0.857, 0.933, 0.87], [0, -PI / 2, 0]);

  // ----- Animated flight controls: stick, throttle, pedals, trim, dive brakes -----
  const stickPivot: number[] = [0.075, 0.325, 0.73];
  const stick = new T.Group();
  stick.name = "Control stick";
  stick.position.set(stickPivot[0], stickPivot[1], stickPivot[2]);
  animatedRoot.add(stick);
  mk(tubeGeo([[0.075, 0.325, 0.73], [0.077, 0.548, 0.651], [0.075, 0.761, 0.589], [0.072, 0.884, 0.552]].map((p) => sub(p, stickPivot)), 0.021, 55, 16), m.black, undefined, undefined, stick);
  mk(new T.CylinderGeometry(0.026, 0.026, 0.072, 32), m.darkEdge, sub([0.072, 0.864, 0.552], stickPivot), undefined, stick);
  mk(boxGeo(0.088, 0.166, 0.088, 0.036), m.leather, sub([0.072, 0.937, 0.552], stickPivot), [-0.18, 0, -0.03], stick);
  const knuckle = mk(new T.SphereGeometry(0.044, 28, 18), m.leather, sub([0.071, 1.021, 0.535], stickPivot), undefined, stick);
  knuckle.scale.set(1, 0.58, 1);
  for (let i = 0; i < 8; i += 1) {
    const y = 0.876 + i * 0.017;
    mk(tubeGeo([[0.034, y, 0.59], [0.071, y + 0.003, 0.6], [0.108, y, 0.585]].map((p) => sub(p, stickPivot)), 0.00125, 12, 5), m.darkEdge, undefined, undefined, stick);
  }
  mk(new T.CylinderGeometry(0.012, 0.012, 0.006, 24), m.darkRed, sub([0.066, 1.043, 0.527], stickPivot), [PI / 2, 0, 0], stick);
  mk(boxGeo(0.016, 0.032, 0.027, 0.006), m.brass, sub([0.072, 0.998, 0.488], stickPivot), [-0.2, 0, 0], stick);

  const levers: T.Group[] = [];
  box(0.191, 0.16, 0.315, [-0.687, 0.809, 0.045], m.black, 0.028, [0.12, 0, -0.1]);
  box(0.218, 0.034, 0.337, [-0.688, 0.886, 0.045], m.darkEdge, 0.021, [0.12, 0, -0.1]);
  for (let i = 0; i < 3; i += 1) {
    const x = -0.756 + i * 0.064;
    const points = [[x, 0.814, 0.118], [x, 0.908, 0.075], [x, 0.967 - 0.024 * i, -0.03 - 0.036 * i], [x, 0.996 - 0.028 * i, -0.112 - 0.02 * i]];
    const base = points[0];
    const lever = new T.Group();
    lever.name = "Throttle lever " + i;
    lever.position.set(base[0], base[1], base[2]);
    animatedRoot.add(lever);
    mk(tubeGeo(points.map((p) => sub(p, base)), 0.0077, 26, 10), m.steel, undefined, undefined, lever);
    const end = points[3];
    if (i === 0) {
      mk(new T.CylinderGeometry(0.036, 0.036, 0.078, 32), m.rubber, sub([end[0], end[1] + 0.012, end[2]], base), [0, 0, PI / 2], lever);
      for (let k = 0; k < 8; k += 1) {
        const ring = new T.Mesh(new T.TorusGeometry(0.035, 0.001, 6, 20), m.darkEdge);
        ring.position.copy(new T.Vector3(...(sub([end[0] - 0.032 + k * 0.009, end[1] + 0.012, end[2]], base) as [number, number, number])));
        ring.rotation.set(0, PI / 2, 0);
        lever.add(ring);
      }
    } else {
      const knob = mk(new T.SphereGeometry(0.027, 20, 14), i === 2 ? m.darkRed : m.rubber, sub(end, base), undefined, lever);
      knob.scale.set(0.88, 1.1, 1);
    }
    levers.push(lever);
    rod([x, 0.899, 0.13], [x, 0.899, -0.13], 0.006, m.slot, 6);
    bolt([x, 0.881, 0.213], [0, 0, 1], 0.006, i);
  }
  decal("engine", 0.174, 0.041, [-0.685, 0.804, 0.212]);

  const trimWheelPivot: number[] = [-0.697, 0.545, 0.415];
  const trimWheel = new T.Group();
  trimWheel.name = "Trim wheel";
  trimWheel.position.set(trimWheelPivot[0], trimWheelPivot[1], trimWheelPivot[2]);
  animatedRoot.add(trimWheel);
  {
    const ring = new T.Mesh(new T.TorusGeometry(0.115, 0.013, 8, 64), m.rubber);
    ring.rotation.y = PI / 2;
    trimWheel.add(ring);
    for (let k = 0; k < 5; k += 1) {
      const a = (k / 5) * PI * 2;
      const spoke = new T.Mesh(new T.CylinderGeometry(0.008, 0.008, 0.1, 8), m.black);
      spoke.position.set(0, Math.cos(a) * 0.05, Math.sin(a) * 0.05);
      spoke.rotation.x = -a + PI / 2;
      trimWheel.add(spoke);
    }
    const hub = new T.Mesh(new T.CylinderGeometry(0.031, 0.031, 0.063, 32), m.black);
    hub.rotation.y = PI / 2;
    trimWheel.add(hub);
  }
  rod([-0.715, 0.635, 0.488], [-0.756, 0.635, 0.488], 0.01, m.steel);
  cylinder(0.016, 0.052, [-0.776, 0.635, 0.488], m.rubber, "x", 20);
  decal("trim", 0.216, 0.044, [-0.82, 0.464, 0.415], [0, PI / 2, 0]);

  const pedals: Array<{ mesh: T.Object3D; base: number; sign: number }> = [];
  rod([-0.48, 0.292, -0.16], [0.48, 0.292, -0.16], 0.017, m.steel, 20);
  for (const s of [-1, 1]) {
    const group = new T.Group();
    group.name = s < 0 ? "Left rudder pedal" : "Right rudder pedal";
    group.position.set(s * 0.3, 0.365, -0.143);
    animatedRoot.add(group);
    mk(boxGeo(0.233, 0.14, 0.027, 0.016), m.black, [0, 0, 0], [0.46, 0, 0], group);
    for (let i = 0; i < 5; i += 1) mk(boxGeo(0.014, 0.11, 0.006, 0.003), m.darkEdge, [-0.085 + i * 0.042, 0.004, 0.026], [0.46, 0, 0], group);
    rod([s * 0.3, 0.295, -0.16], [s * 0.3, 0.366, -0.15], 0.025, m.olive, 16);
    pedals.push({ mesh: group, base: -0.143, sign: s });
  }

  const brakeHandleParts: T.Object3D[] = [];
  cylinder(0.027, 0.025, [-0.745, 1.02, -0.276], m.darkEdge);
  const brakeGroup = new T.Group();
  brakeGroup.position.set(-0.745, 1.02, -0.276);
  animatedRoot.add(brakeGroup);
  {
    const stem = new T.Mesh(new T.CylinderGeometry(0.021, 0.021, 0.031, 24), m.red);
    stem.rotation.x = PI / 2;
    brakeGroup.add(stem);
    const ring = new T.Mesh(new T.TorusGeometry(0.017, 0.0022, 6, 24), m.edge);
    ring.position.z = 0.036;
    brakeGroup.add(ring);
    const pull = new T.Group();
    pull.position.set(0, -0.17, -0.011);
    brakeGroup.add(pull);
    mk(new T.CylinderGeometry(0.01, 0.01, 0.164, 12), m.red, [0, 0.082, 0], undefined, pull);
    mk(boxGeo(0.106, 0.162, 0.011, 0.006), m.red, [0, 0, 0.03], [0, 0, -0.027], pull);
    const label = new T.Mesh(new T.PlaneGeometry(0.092, 0.145), m.labels.dive);
    label.position.set(0, 0, 0.039);
    label.rotation.set(0, 0, -0.027);
    pull.add(label);
    brakeHandleParts.push(pull as T.Object3D);
  }

  const boltCount = g.buildHardware();
  g.optimize();
  root.userData.boltCount = boltCount;

  function update(p: any): void {
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const sweep = (v: number, max: number, lo = 190, span = 290) => lo + clamp(v / max, 0, 1) * span;
    const ias = p.ias ?? p.speed ?? 0;
    needleAirspeed.set(sweep(ias * 2.23694, 450));
    const feet = (p.y ?? 0) * 3.28084;
    needleAltThousands.set((((feet / 1000) % 10) + 10) % 10 * 36);
    needleAltTenThousands.set((((feet / 10000) % 10) + 10) % 10 * 36);
    needleAltHundreds.set((((feet / 100) % 10) + 10) % 10 * 36);
    const rpm = Math.max(0, (p.rpm ?? 0) * (p.airframe === "tbd" ? 2800 : 3000));
    needleRpm.set(sweep(rpm / 100, 35));
    needleFuel.set(sweep(p.fuel ?? 0, 100));
    const climb = clamp((p.vy ?? 0) * 196.85, -2000, 6000);
    needleClimb.set(200 + (climb / 1000) * 49.5);
    needleOil.set(sweep(Math.max(0, (p.rpm ?? 0) * 90 * (p.damage?.engine?.integrity ?? 1)), 100));
    needleCompass.set((((p.heading ?? 0) * 180) / PI) % 360);
    const elevator = clamp(p.elevator ?? 0, -1, 1);
    const aileron = clamp(p.aileron ?? 0, -1, 1);
    stick.rotation.x = elevator * 0.34;
    stick.rotation.z = -aileron * 0.24;
    const throttle = clamp(p.throttle ?? p.rpm ?? 0, 0, 1);
    for (let i = 0; i < levers.length; i += 1) levers[i].rotation.x = -(throttle * 0.55 + i * 0.05);
    const rudder = clamp(p.rudder ?? 0, -1, 1);
    for (const pedal of pedals) pedal.mesh.position.z = pedal.base - pedal.sign * rudder * 0.035;
    const trim = p.trim ?? 0.04;
    trimWheel.rotation.x = (trim - 0.04) * 22;
    const brake = clamp(p.brakePos ?? 0, 0, 1);
    for (const part of brakeHandleParts) part.position.y = -0.17 - brake * 0.03;
    attitudeFace?.update(p.pitch ?? 0, p.roll ?? 0);
  }

  function dispose(): void {
    // Materials and textures are shared through the session cache; only per-instance geometry and
    // the live attitude face (created per interior) are owned here.
    const geos = new Set<T.BufferGeometry>();
    root.traverse((o) => {
      const mesh = o as T.Mesh;
      if (mesh.isMesh) geos.add(mesh.geometry);
    });
    for (const geo of geos) geo.dispose();
    // The two baked horizon faces are session-cached textures like every other image here, shared
    // by every cockpit ever built; only this interior's own material is owned. Disposing the image
    // with it left the next aircraft's dial black.
    attitudeFace?.material.dispose();
  }

  return { root, eye: EYE, update, dispose };
}

/* ------------------------------------------------------------------ */
/* Geometry toolkit ported from the standalone material study.        */
/* ------------------------------------------------------------------ */
function createGeometryTools(Tg: typeof T, materials: CockpitMaterials, root: T.Group) {
  const parts: Record<string, T.Group> = {};
  const bolts: Array<{ p: T.Vector3; n: T.Vector3; size: number; angle: number }> = [];
  let current: T.Group | null = null;
  const V = (p: any) => (p?.isVector3 ? p.clone() : new Tg.Vector3(p[0], p[1], p[2]));
  function part(name: string) {
    if (!parts[name]) {
      parts[name] = new Tg.Group();
      parts[name].name = name;
      root.add(parts[name]);
    }
    current = parts[name];
    return current;
  }
  function add(geometry: T.BufferGeometry, material: any, p: any = [0, 0, 0], rotation: number[] | null = null, name = "") {
    const o = new Tg.Mesh(geometry, material);
    o.position.copy(V(p));
    if (rotation) o.rotation.set(rotation[0], rotation[1], rotation[2]);
    o.name = name || material.name;
    o.castShadow = !material.transparent;
    o.receiveShadow = !material.transparent;
    if (material.transparent) o.renderOrder = 10;
    (current || root).add(o);
    return o;
  }
  function roundedShape(w: number, h: number, r: number) {
    r = Math.min(r, w * 0.49, h * 0.49);
    const x = -w / 2;
    const y = -h / 2;
    const s = new Tg.Shape();
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    s.closePath();
    return s;
  }
  function planarUV(geo: T.BufferGeometry, scale = 1) {
    geo.computeBoundingBox();
    const b = geo.boundingBox!;
    const p = geo.attributes.position as T.BufferAttribute;
    const uv = geo.attributes.uv as T.BufferAttribute;
    const n = geo.attributes.normal as T.BufferAttribute;
    const w = b.max.x - b.min.x || 1;
    const h = b.max.y - b.min.y || 1;
    const d = b.max.z - b.min.z || 1;
    for (let i = 0; i < p.count; i += 1) {
      const nx = Math.abs(n.getX(i));
      const ny = Math.abs(n.getY(i));
      const nz = Math.abs(n.getZ(i));
      if (nz >= nx && nz >= ny) uv.setXY(i, ((p.getX(i) - b.min.x) / w) * scale, ((p.getY(i) - b.min.y) / h) * scale);
      else if (ny >= nx) uv.setXY(i, ((p.getX(i) - b.min.x) / w) * scale, ((p.getZ(i) - b.min.z) / d) * scale);
      else uv.setXY(i, ((p.getZ(i) - b.min.z) / d) * scale, ((p.getY(i) - b.min.y) / h) * scale);
    }
    return geo;
  }
  function extruded(shape: T.Shape, depth: number, bevel = 0.003) {
    const g = new Tg.ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 8 });
    g.translate(0, 0, -depth / 2);
    planarUV(g);
    return g;
  }
  function boxGeo(w: number, h: number, d: number, r = 0.008) {
    return extruded(roundedShape(w, h, r), d, Math.min(0.003, r * 0.35, d * 0.15));
  }
  function box(w: number, h: number, d: number, p: number[], mat: any, r = 0.008, rotation: number[] | null = null) {
    return add(boxGeo(w, h, d, r), mat, p, rotation);
  }
  function plate(points: number[][], d: number, p: number[], mat: any, bevel = 0.004) {
    const s = new Tg.Shape(points.map((a) => new Tg.Vector2(a[0], a[1])));
    return add(extruded(s, d, bevel), mat, p);
  }
  function cylinder(r: number, h: number, p: number[], mat: any, axis = "z", segments = 48, r2 = r) {
    const g = new Tg.CylinderGeometry(r, r2, h, segments, 1, false);
    if (axis === "z") g.rotateX(Math.PI / 2);
    if (axis === "x") g.rotateZ(Math.PI / 2);
    return add(g, mat, p);
  }
  function sphere(r: number, p: number[], mat: any, scale: number[] = [1, 1, 1], segments = 24) {
    const o = add(new Tg.SphereGeometry(r, segments, 16), mat, p);
    o.scale.set(scale[0], scale[1], scale[2]);
    return o;
  }
  function torus(r: number, t: number, p: number[], mat: any, rotation: number[] | null = null, arc = Math.PI * 2) {
    return add(new Tg.TorusGeometry(r, t, 8, 64, arc), mat, p, rotation);
  }
  function curve(points: any, closed = false) {
    return new Tg.CatmullRomCurve3(points.map(V), closed, "centripetal", 0.5);
  }
  function tube(points: any, r: number, mat: any, segments = 48, radial = 10, closed = false) {
    const c = typeof points.getPoint === "function" ? points : curve(points, closed);
    return add(new Tg.TubeGeometry(c, segments, r, radial, closed), mat);
  }
  function rod(a: number[], b: number[], r: number, mat: any, n = 12) {
    const av = V(a);
    const bv = V(b);
    const delta = bv.clone().sub(av);
    const o = add(new Tg.CylinderGeometry(r, r, delta.length(), n), mat, av.add(bv).multiplyScalar(0.5));
    o.quaternion.setFromUnitVectors(new Tg.Vector3(0, 1, 0), delta.normalize());
    return o;
  }
  function beam(points: any, w: number, d: number, mat: any, segments = 80) {
    const c = typeof points.getPoint === "function" ? points : curve(points);
    const b = Math.min(w, d) * 0.16;
    const profile = [[-w / 2 + b, d / 2], [w / 2 - b, d / 2], [w / 2, d / 2 - b], [w / 2, -d / 2 + b], [w / 2 - b, -d / 2], [-w / 2 + b, -d / 2], [-w / 2, -d / 2 + b], [-w / 2, d / 2 - b]];
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let length = 0;
    let prev: T.Vector3 | null = null;
    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const p = c.getPoint(t);
      const tangent = c.getTangent(t).normalize();
      if (prev) length += p.distanceTo(prev);
      prev = p;
      const n = new Tg.Vector3(tangent.y, -tangent.x, 0);
      if (n.lengthSq() < 0.0001) n.set(1, 0, 0);
      n.normalize();
      const front = new Tg.Vector3().crossVectors(n, tangent).normalize();
      if (front.z < 0) {
        front.negate();
        n.negate();
      }
      for (let j = 0; j < 8; j += 1)
        for (let k = 0; k < 2; k += 1) {
          const co = profile[(j + k) % 8];
          const v = p.clone().addScaledVector(n, co[0]).addScaledVector(front, co[1]);
          pos.push(v.x, v.y, v.z);
          uv.push(length / 0.85, j === 0 ? k : (j + k) / 8);
        }
    }
    for (let i = 0; i < segments; i += 1)
      for (let j = 0; j < 8; j += 1) {
        const a = i * 16 + j * 2;
        const b2 = a + 1;
        const cc = a + 16;
        const dd = cc + 1;
        idx.push(a, b2, cc, b2, dd, cc);
      }
    const g = new Tg.BufferGeometry();
    g.setAttribute("position", new Tg.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new Tg.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return { mesh: add(g, mat), curve: c };
  }
  function glassPolygon(points: number[][], mat: any) {
    const verts = points.map(V);
    const pos: number[] = [];
    const uv: number[] = [];
    for (const v of verts) {
      pos.push(v.x, v.y, v.z);
      uv.push(v.x + 0.5, v.y * 0.8);
    }
    const idx: number[] = [];
    for (let i = 1; i < verts.length - 1; i += 1) idx.push(0, i, i + 1);
    const g = new Tg.BufferGeometry();
    g.setAttribute("position", new Tg.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new Tg.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return add(g, mat);
  }
  function lens(r: number, p: number[], mat: any, bulge = 0.006) {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const rings = 10;
    const segs = 64;
    for (let j = 0; j <= rings; j += 1)
      for (let i = 0; i <= segs; i += 1) {
        const rho = (r * j) / rings;
        const a = (i / segs) * Math.PI * 2;
        pos.push(rho * Math.cos(a), rho * Math.sin(a), bulge * (1 - (rho / r) ** 2));
        uv.push(0.5 + (0.5 * rho * Math.cos(a)) / r, 0.5 + (0.5 * rho * Math.sin(a)) / r);
      }
    for (let j = 0; j < rings; j += 1)
      for (let i = 0; i < segs; i += 1) {
        const a = j * (segs + 1) + i;
        const b = a + segs + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    const g = new Tg.BufferGeometry();
    g.setAttribute("position", new Tg.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new Tg.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return add(g, mat, p);
  }
  function lathe(profile: number[][], p: number[], mat: any, segments = 64) {
    const g = new Tg.LatheGeometry(profile.map((a) => new Tg.Vector2(a[0], a[1])), segments);
    g.rotateX(Math.PI / 2);
    return add(g, mat, p);
  }
  function bolt(p: any, normal: number[] = [0, 0, 1], size = 0.007, angle = 0) {
    bolts.push({ p: V(p), n: V(normal).normalize(), size, angle });
  }
  function boltLine(points: any, count: number, offset = 0.033, size = 0.007) {
    const c = typeof points.getPoint === "function" ? points : curve(points);
    for (let i = 0; i < count; i += 1) {
      const p = c.getPointAt((i + 0.4) / (count - 0.2));
      p.z += offset;
      bolt(p, [0, 0, 1], size, (i * 2.39) % Math.PI);
    }
  }
  function decal(name: string, w: number, h: number, p: number[], rotation: number[] | null = null) {
    box(w + 0.01, h + 0.008, 0.003, [p[0], p[1], p[2] - 0.003], materials.darkEdge, 0.003, rotation);
    const o = add(new Tg.PlaneGeometry(w, h), materials.labels[name], p, rotation);
    o.castShadow = false;
    return o;
  }
  function buildHardware() {
    part("Fasteners");
    const cap = new Tg.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.rotateX(Math.PI / 2);
    cap.scale(1, 1, 0.43);
    const washer = new Tg.TorusGeometry(1.12, 0.145, 5, 16);
    washer.translate(0, 0, -0.07);
    const slot = new Tg.BoxGeometry(1.18, 0.145, 0.02);
    slot.translate(0, 0, 0.425);
    const items: Array<[T.BufferGeometry, any, string]> = [
      [cap, materials.bolt, "Domed slotted screw heads"],
      [washer, materials.washer, "Fastener washers"],
      [slot, materials.slot, "Screw slots"],
    ];
    for (const [geo, mat, name] of items) {
      const im = new Tg.InstancedMesh(geo, mat, bolts.length);
      im.name = name;
      const matrix = new Tg.Matrix4();
      const q = new Tg.Quaternion();
      const twist = new Tg.Quaternion();
      const scale = new Tg.Vector3();
      for (let i = 0; i < bolts.length; i += 1) {
        const b = bolts[i];
        q.setFromUnitVectors(new Tg.Vector3(0, 0, 1), b.n);
        twist.setFromAxisAngle(new Tg.Vector3(0, 0, 1), b.angle);
        q.multiply(twist);
        scale.setScalar(b.size);
        matrix.compose(b.p, q, scale);
        im.setMatrixAt(i, matrix);
      }
      im.castShadow = true;
      im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      current!.add(im);
      // Same again: every screw's placement is in the instance matrices, and the instanced mesh's
      // own transform is final from here. Its world matrix still follows its parent.
      im.updateMatrix();
      im.matrixAutoUpdate = false;
    }
    return bolts.length;
  }
  function pushArray(dst: number[], src: ArrayLike<number>) {
    for (let i = 0; i < src.length; i += 1) dst.push(src[i]);
  }
  function optimize() {
    // The toolkit's `root` is the static shell group; the live controls hang off its sibling
    // `animatedRoot`, which this never visits, so a gauge needle or a lever can never be dragged
    // into a batch. Batch the shell by material across every part rather than within one part: the
    // same surface used by two parts becomes one draw while two surfaces never do. Every triangle,
    // normal and UV is unchanged; only the draw count falls.
    root.updateMatrixWorld(true);
    const batches = new Map<string, T.Mesh[]>();
    root.traverse((o) => {
      const mesh = o as T.Mesh;
      if (!mesh.isMesh || (mesh as any).isInstancedMesh) return;
      const key = (mesh.material as T.Material).uuid;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key)!.push(mesh);
    });
    for (const list of batches.values()) {
      const material = list[0].material as T.Material;
      const positions: number[] = [];
      const normals: number[] = [];
      const uvs: number[] = [];
      const indices: number[] = [];
      let offset = 0;
      for (const o of list) {
        const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
        const p = g.attributes.position as T.BufferAttribute;
        const n = g.attributes.normal as T.BufferAttribute;
        const uv = g.attributes.uv as T.BufferAttribute | undefined;
        pushArray(positions, p.array as ArrayLike<number>);
        pushArray(normals, n.array as ArrayLike<number>);
        if (uv) pushArray(uvs, uv.array as ArrayLike<number>);
        else for (let i = 0; i < p.count; i += 1) uvs.push(0, 0);
        if (g.index) {
          const source = g.index.array as ArrayLike<number>;
          for (let i = 0; i < source.length; i += 1) indices.push(source[i] + offset);
        } else for (let i = 0; i < p.count; i += 1) indices.push(i + offset);
        offset += p.count;
        g.dispose();
        o.parent!.remove(o);
        o.geometry.dispose();
      }
      const g = new Tg.BufferGeometry();
      g.setAttribute("position", new Tg.Float32BufferAttribute(positions, 3));
      g.setAttribute("normal", new Tg.Float32BufferAttribute(normals, 3));
      g.setAttribute("uv", new Tg.Float32BufferAttribute(uvs, 2));
      g.setAttribute("uv1", new Tg.Float32BufferAttribute(uvs, 2));
      g.setIndex(indices);
      g.computeBoundingSphere();
      const o = new Tg.Mesh(g, material);
      o.name = root.name + " · " + material.name;
      o.castShadow = !material.transparent;
      o.receiveShadow = !material.transparent;
      if (material.transparent) o.renderOrder = 10;
      root.add(o);
      // Every vertex here was already baked through its source `matrixWorld` into the shell, so
      // this merged mesh's local transform is identity and can never change again. Compose it once and stop
      // recomposing it every frame. `matrixWorldAutoUpdate` stays on, so the aircraft, the carrier
      // under it and the camera still carry the whole cockpit exactly as before — only the local
      // recomposition of a constant stops.
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    }
  }
  return {
    part,
    add,
    box,
    plate,
    cylinder,
    sphere,
    torus,
    curve,
    tube,
    rod,
    beam,
    glassPolygon,
    lens,
    lathe,
    bolt,
    boltLine,
    decal,
    roundedShape,
    extruded,
    planarUV,
    buildHardware,
    optimize,
    parts,
    V,
  };
}
