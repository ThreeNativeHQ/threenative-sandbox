// Cockpit look: the glass and the surface finish, as call arguments (nothing in @threenative reads
// this). `applyCockpitLook` adds a canopy-glass shell around the pilot's eye and a glossy cover
// over each display, and finishes the metal and rubber. Both glasses are black, low-roughness
// standard materials blended additively (the engine's portable blend modes are None, Normal and Additive): the only light they add is the
// sky and sun that `scene.environment` and the sun already provide (Fresnel makes it strong at
// grazing angles and faint head-on), so there is no second environment and the view stays clear.
import {
  BackSide,
  type BufferGeometry,
  Float32BufferAttribute,
  AdditiveBlending,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  RepeatWrapping,
  type Scene,
  SphereGeometry,
} from "three";

/** One display: centre and size of its glass in model space; covers sit `lift` toward the pilot. */
export interface ICockpitScreen {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** In-plane tilt of the glass, radians (the model's side screens lean toward the pilot). */
  roll?: number;
}

export interface ICockpitLook {
  /** Pilot eye in model space; the canopy is a bubble around it. */
  eye: readonly [number, number, number];
  screens: readonly ICockpitScreen[];
  canopy?: {
    /** Bubble radius in model units: it must lie beyond the window frame so the frame hides its rim. */
    radius?: number;
    /** Degrees either side of dead ahead, and elevation range in degrees. */
    azimuth?: number;
    elevation?: readonly [number, number];
    /** Perceived glass roughness: low is a clean sheen, smudges raise it locally. */
    roughness?: number;
    /** Reflection strength, 0..1: the sky and sun the glass adds to the view. */
    reflect?: number;
  };
  /** Display cover roughness (clear-coat style gloss). */
  screenRoughness?: number;
  screenReflect?: number;
  screenLift?: number;
}

export interface ICockpitLookHandle {
  /** Call each frame the cockpit shows: finds the scene's environment once and shades the interior. */
  update(): void;
  dispose(): void;
}

// Surface finish by material name. `rough` multiplies the roughness the glb's map carries (so 2 lifts
// a polished 0.25 to 0.5), `color` is the linear albedo tint over its maps, `normal` the bump strength.
// Nothing is a mirror: the cockpit is worn gunmetal, matte rubber and enamel, never chrome.
interface IFinish {
  color?: readonly [number, number, number];
  rough?: number;
  metal?: number;
  normal?: number;
  /** Paint-chip brightening at convex edges (the mask in uv1.x), as a gain on the albedo. */
  chip?: number;
  /** Share of the sky's light the surface receives (the interior is shaded from most of it). */
  env?: number;
}
// Hard surfaces are metalness 1 with a dark albedo: a dielectric reflects 4% of the sun whatever its
// colour, and at the metered exposure that reads as cream, while a metal's reflectance is its albedo.
// The sun is so strong here that a 0.035 albedo already clips to white on a sun-facing facet.
const FINISH: Record<string, IFinish> = {
  "Edge steel": { color: [0.0024, 0.0028, 0.0035], rough: 3.4, metal: 1, env: 0.4 },
  "Cockpit headliner": { color: [0.0021, 0.0024, 0.0031], rough: 1.2, metal: 1, env: 0.3 },
  "Soft black rubber": { color: [0.0014, 0.0016, 0.0021], rough: 1.3, metal: 1, env: 0.3 },
  "Worn blue graphite | microtexture": {
    color: [0.0042, 0.0052, 0.0084],
    rough: 2.4,
    metal: 1,
    normal: 0.9,
    env: 0.3,
  },
  "Cobalt painted armor": {
    color: [0.04, 0.13, 0.62],
    chip: 0.9,
    rough: 0.85,
    metal: 0.1,
    normal: 0.6,
    env: 0.75,
  },
  "Frame | scratched gunmetal PBR": {
    color: [0.0035, 0.0038, 0.0049],
    rough: 2.4,
    metal: 1,
    normal: 1,
    env: 0.3,
  },
  // The side console shells and the screen step rings: dark gunmetal, same finish as the frame.
  "Side armor silver": {
    color: [0.0035, 0.0038, 0.0049],
    rough: 2.4,
    metal: 1,
    normal: 1,
    env: 0.3,
  },
  "Bezel edge gunmetal": { color: [0.011, 0.0115, 0.0125], rough: 1.6, metal: 1, env: 0.4 },
  // The side consoles: bare worn steel, a step lighter than the gunmetal frame.
  "Console worn steel": {
    color: [0.011, 0.0115, 0.0125],
    rough: 1.6,
    metal: 1,
    normal: 1,
    env: 0.4,
  },
  "Controls | black worn leather PBR": {
    color: [0.0017, 0.0017, 0.0021],
    rough: 2.4,
    metal: 1,
    normal: 1.6,
    env: 0.3,
  },
};

// Cheap deterministic hash noise, value-interpolated: the glass's smudges.
function hash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function smooth(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * u;
  const b = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * u;
  return a + (b - a) * v;
}

/**
 * Smudge and scratch roughness, in the green channel (three's roughness channel): clean glass
 * reads 0.2 of the material roughness, fingerprints and wiper haze up to 1, hairline scratches 1.
 * Bytes, not a canvas, so it runs on every target.
 */
function smudgeTexture(size = 256): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * 6;
      const v = (y / size) * 6;
      const blot = smooth(u, v) * 0.6 + smooth(u * 2.3, v * 2.3) * 0.3 + smooth(u * 5, v * 5) * 0.1;
      const haze = Math.max(0, blot - 0.52) * 2.4; // sparse patches, mostly clean
      const i = (y * size + x) * 4;
      const level = Math.min(1, 0.2 + haze);
      data[i] = 255;
      data[i + 1] = Math.round(level * 255);
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  // Hairline scratches: a few long, near-straight strokes.
  let seed = 11;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let s = 0; s < 14; s += 1) {
    let px = rand() * size;
    let py = rand() * size;
    const a = rand() * Math.PI;
    const length = size * (0.15 + rand() * 0.35);
    for (let t = 0; t < length; t += 0.5) {
      px += Math.cos(a) * 0.5;
      py += Math.sin(a) * 0.5;
      const i = ((Math.floor(py + size) % size) * size + (Math.floor(px + size) % size)) * 4;
      data[i + 1] = Math.max(data[i + 1] as number, 205);
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A black glass: additive, so its only light is the reflection, scaled by `strength` (0..1). */
function glassMaterial(
  roughness: number,
  strength: number,
  map?: DataTexture,
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x000000,
    metalness: 0,
    roughness,
    roughnessMap: map ?? null,
    transparent: true,
    opacity: strength,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

// ponytail: test-only URL seam, `?look=off` skips the glass and the combiner HUD for before/after captures.
export const LOOK_OFF = /[?&]look=off\b/.test(String(globalThis.location?.search ?? ""));

export function applyCockpitLook(model: Object3D, look: ICockpitLook): ICockpitLookHandle {
  if (LOOK_OFF) return { update() {}, dispose() {} };
  const own: Array<{ dispose(): void }> = [];
  /** Writes a material's finish; safe to repeat, since roughness and bump scale from a stored base. */
  const finish = (material: MeshStandardMaterial, f: IFinish): void => {
    const base = (material.userData.lookBase ??= {
      roughness: material.roughness,
      normal: material.normalScale.x,
    }) as { roughness: number; normal: number };
    material.userData.ownFinish = true;
    if ("specularIntensity" in material)
      (material as unknown as { specularIntensity: number }).specularIntensity = 0;
    if (f.color !== undefined) material.color.setRGB(...f.color);
    material.roughness = base.roughness * (f.rough ?? 1);
    if (f.metal !== undefined) {
      material.metalness = f.metal;
      // A metalness map lets texels fall toward a dielectric, whose 4% sun reflection reads cream.
      if (f.metal >= 1) material.metalnessMap = null;
    }
    if (f.normal !== undefined) material.normalScale.setScalar(base.normal * f.normal);
  };
  const interior = (visit: (material: MeshStandardMaterial, f: IFinish) => void): void =>
    model.traverse((object) => {
      const material = (object as Mesh).material as MeshStandardMaterial | undefined;
      const f = material === undefined ? undefined : FINISH[material.name];
      if (material !== undefined && f !== undefined) visit(material, f);
    });
  interior(finish);
  // Edge wear from the glb's second UV set (uv1.x convexity: outer edges chip, uv1.y concavity: seams
  // collect grime), folded into the vertex colour that already carries the baked AO. A vertex colour
  // is portable where a shader node is not (a second colour attribute crashes the web engine).
  model.traverse((object) => {
    const mesh = object as Mesh;
    const geometry = mesh.geometry as BufferGeometry | undefined;
    const f = FINISH[(mesh.material as MeshStandardMaterial | undefined)?.name ?? ""];
    const uv1 = geometry?.getAttribute("uv1");
    const color = geometry?.getAttribute("color");
    if (geometry === undefined || f === undefined || !uv1 || !color || geometry.userData.worn)
      return;
    geometry.userData.worn = true;
    const n = color.itemSize;
    const out = new Float32Array(color.count * n);
    for (let i = 0; i < color.count; i += 1) {
      const k = Math.max(0.2, 1 + (f.chip ?? 2.5) * uv1.getX(i) - 0.45 * uv1.getY(i));
      for (let c = 0; c < n; c += 1) out[i * n + c] = color.getComponent(i, c) * (c < 3 ? k : 1);
    }
    geometry.setAttribute("color", new Float32BufferAttribute(out, n));
  });

  const [ex, ey, ez] = look.eye;
  const canopy = look.canopy ?? {};
  // Default extent is the window opening seen from the eye (about +-25 deg across, -3 to +17 deg up),
  // so the glass never overdraws the headliner round the arch.
  const radius = canopy.radius ?? 8;
  const azimuth = ((canopy.azimuth ?? 25) * Math.PI) / 180;
  const [lo, hi] = canopy.elevation ?? [-4, 16.5];
  // Sphere azimuth 0 is +X and -Z sits at 3/2 pi; theta counts from the zenith.
  const shellGeometry = new SphereGeometry(
    radius,
    48,
    24,
    Math.PI * 1.5 - azimuth,
    azimuth * 2,
    ((90 - hi) * Math.PI) / 180,
    ((hi - lo) * Math.PI) / 180,
  );
  const smudge = smudgeTexture();
  smudge.repeat.set(2, 1);
  // The map multiplies the roughness: a base of 0.45 makes clean glass 0.09 and smudges 0.45.
  const shellMaterial = glassMaterial(canopy.roughness ?? 0.45, canopy.reflect ?? 0.12, smudge);
  shellMaterial.side = BackSide;
  const shell = new Mesh(shellGeometry, shellMaterial);
  shell.name = "canopy-glass";
  shell.position.set(ex, ey, ez);
  shell.renderOrder = 6;
  shell.frustumCulled = false;
  shell.castShadow = false;
  shell.receiveShadow = false;
  model.add(shell);
  own.push(shellGeometry, shellMaterial, smudge);

  const coverMaterial = glassMaterial(look.screenRoughness ?? 0.08, look.screenReflect ?? 0.3);
  own.push(coverMaterial);
  const covers = look.screens.map((screen) => {
    const geometry = new PlaneGeometry(screen.w, screen.h);
    const cover = new Mesh(geometry, coverMaterial);
    cover.name = "display-cover";
    cover.position.set(screen.x, screen.y, screen.z + (look.screenLift ?? 0.02));
    cover.rotation.z = screen.roll ?? 0;
    cover.renderOrder = 5;
    cover.frustumCulled = false;
    cover.castShadow = false;
    cover.receiveShadow = false;
    model.add(cover);
    own.push(geometry);
    return cover;
  });

  let tuned = false;
  return {
    update() {
      if (tuned) return;
      let top: Object3D = model;
      while (top.parent !== null) top = top.parent;
      const environment = (top as Scene).environment;
      if (environment === null || environment === undefined) return;
      tuned = true;
      // Own the environment on the interior materials so `envMapIntensity` can dim it: the cockpit
      // sits under a canopy and a dash, and lit like open ground it would be pale at grazing angles.
      interior((material, f) => {
        if (f.env === undefined) return;
        material.envMap = environment;
        material.envMapIntensity = f.env;
        material.needsUpdate = true;
        finish(material, f); // the swap can rebuild the material from its file values
      });
    },
    dispose() {
      shell.removeFromParent();
      for (const cover of covers) cover.removeFromParent();
      for (const item of own) item.dispose();
    },
  };
}
