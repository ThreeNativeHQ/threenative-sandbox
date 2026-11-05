// Cockpit look: the glass and the surface finish, as call arguments (nothing in @threenative reads
// this). `applyCockpitLook` adds a canopy-glass shell around the pilot's eye and a glossy cover
// over each display, and finishes the metal and rubber. Both glasses are black, low-roughness
// standard materials blended as `reflection + view * (1 - tint)`: the only light they add is the
// sky and sun that `scene.environment` and the sun already provide (Fresnel makes it strong at
// grazing angles and faint head-on), so there is no second environment and the view stays clear.
import {
  BackSide,
  CustomBlending,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  RepeatWrapping,
  SphereGeometry,
} from "three";

/** One display: centre and size of its glass in model space; covers sit `lift` toward the pilot. */
export interface ICockpitScreen {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
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
    /** Share of the view absorbed by the (very faint) tint, 0..1. */
    tint?: number;
  };
  /** Display cover roughness (clear-coat style gloss). */
  screenRoughness?: number;
  screenLift?: number;
}

export interface ICockpitLookHandle {
  dispose(): void;
}

// Surface finish by material name: roughness and metalness multiply the glb's own maps.
const FINISH: Record<string, { roughness?: number; metalness?: number }> = {
  "Edge steel": { roughness: 0.34, metalness: 1 },
  "Soft black rubber": { roughness: 0.86, metalness: 0 },
  "Worn blue graphite | microtexture": { roughness: 1.15 },
  "Cobalt painted armor": { roughness: 0.8 },
  "Frame | scratched gunmetal PBR": { roughness: 1 },
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

/** A black glass: its only colour is what it reflects; `tint` (0..1) darkens what is behind it. */
function glassMaterial(roughness: number, tint: number, map?: DataTexture): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: 0x000000,
    metalness: 0,
    roughness,
    roughnessMap: map ?? null,
    transparent: true,
    opacity: tint,
    depthWrite: false,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
}

export function applyCockpitLook(model: Object3D, look: ICockpitLook): ICockpitLookHandle {
  const own: Array<{ dispose(): void }> = [];
  model.traverse((object) => {
    const material = (object as Mesh).material as MeshStandardMaterial | undefined;
    const finish = material === undefined ? undefined : FINISH[material.name];
    if (material === undefined || finish === undefined) return;
    // Applied once per material: clones share it, so scale from a stored base.
    const base = (material.userData.lookBase ??= {
      roughness: material.roughness,
      metalness: material.metalness,
    }) as { roughness: number; metalness: number };
    material.roughness = Math.min(1, base.roughness * (finish.roughness ?? 1));
    material.metalness = finish.metalness ?? base.metalness;
  });

  const [ex, ey, ez] = look.eye;
  const canopy = look.canopy ?? {};
  const radius = canopy.radius ?? 8;
  const azimuth = ((canopy.azimuth ?? 55) * Math.PI) / 180;
  const [lo, hi] = canopy.elevation ?? [-20, 60];
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
  const shellMaterial = glassMaterial(canopy.roughness ?? 0.45, canopy.tint ?? 0.05, smudge);
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

  const coverMaterial = glassMaterial(look.screenRoughness ?? 0.08, 0.02);
  own.push(coverMaterial);
  const covers = look.screens.map((screen) => {
    const geometry = new PlaneGeometry(screen.w, screen.h);
    const cover = new Mesh(geometry, coverMaterial);
    cover.name = "display-cover";
    cover.position.set(screen.x, screen.y, screen.z + (look.screenLift ?? 0.02));
    cover.renderOrder = 5;
    cover.frustumCulled = false;
    cover.castShadow = false;
    cover.receiveShadow = false;
    model.add(cover);
    own.push(geometry);
    return cover;
  });

  return {
    dispose() {
      shell.removeFromParent();
      for (const cover of covers) cover.removeFromParent();
      for (const item of own) item.dispose();
    },
  };
}
