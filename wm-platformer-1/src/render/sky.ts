// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A vertical blue gradient supplies the background; a measured environment supplies the light.
// The background's lower hemisphere matches skyFloor around the floating route.
import {
  BackSide,
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  FogExp2,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  SRGBColorSpace,
  type Scene,
  SphereGeometry,
  type Texture,
  UnsignedByteType,
  Vector3,
} from "three";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

/** Unit vector toward the authored sun, 47.9° above the horizon. */
export const SUN_DIRECTION = new Vector3(0.48, 0.72, 0.6).normalize();

/** The look this fog replaced: FogExp2 at 0.003, measured at 150 m from 2 m up. */
const EYE_LEVEL = { density: 0.0055, distance: 150, cameraHeight: 2 };

/**
 * The distance term's density that, with the height term, keeps the old eye-level haze: at
 * `EYE_LEVEL.distance` along the horizon from `EYE_LEVEL.cameraHeight` the two together transmit what
 * FogExp2 at `EYE_LEVEL.density` did. The distance term is lowered, never removed, so the ground
 * still ends in fog at a kilometre.
 */
function distanceDensity(p: HeightFogParams = HEIGHT_FOG): number {
  const { distance, density, cameraHeight } = EYE_LEVEL;
  const old = (density * distance) ** 2;
  const height = heightFogDepth(p, cameraHeight, cameraHeight, distance) * Math.LN2;
  return Math.sqrt(Math.max(0, old - height)) / distance;
}

export function gradientColor(row: number, height: number): Color {
  const high = new Color(palette.skyHigh);
  const mid = new Color(palette.skyLow);
  const horizon = new Color(palette.horizon);
  const deep = high.clone().lerp(horizon, 0.45);
  // DataTexture rows start at v=0 (nadir); equirectangular v=0.5 is the horizon.
  const elevation = Math.sin((row / (height - 1) - 0.5) * Math.PI);
  // The blue has to arrive within the first twenty degrees above the horizon: a third-person
  // camera frames the horizon and a little sky above it, so a gradient that only deepens at the
  // zenith reads as one pale sheet all game long.
  return elevation < 0
    ? horizon.clone().lerp(deep, Math.min(1, -elevation / 0.6))
    : elevation < 0.2
      ? horizon.clone().lerp(mid, (elevation / 0.2) ** 0.7)
      : mid.clone().lerp(high, Math.min(1, (elevation - 0.2) / 0.45));
}

/** sRGB equirectangular radiance, from the lower haze through the horizon to the zenith. */
export function skyTexture(): DataTexture {
  // three's PMREM sizes its cube from width / 4, needing at least 16: keep width >= 64.
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const encoded = gradientColor(row, height).convertLinearToSRGB();
    for (let column = 0; column < width; column += 1) {
      data.set(
        [...encoded.toArray().map((value) => Math.round(value * 255)), 255],
        (row * width + column) * 4,
      );
    }
  }
  const sky = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  sky.magFilter = LinearFilter;
  sky.minFilter = LinearFilter;
  sky.needsUpdate = true;
  return sky;
}

/**
 * The visible sky, as a dome that skips the tone curve.
 *
 * `scene.background` is drawn through the renderer's tone mapping, which is right for geometry and
 * wrong for a sky that has to read as the reference's flat vivid blue: the filmic curve pulls
 * `#1e7ce6` out to a grey-blue. This carries the same equirectangular gradient as an untonemapped
 * texture on an inside-out sphere, so the sky is the palette's colour on every tier.
 */
export function skyDome(sky: Texture): Mesh {
  const dome = new Mesh(
    // Inside the camera's 900 m far plane by the box diagonal a mesh is measured by (500 x 1.73):
    // a bigger dome is clipped by the far plane, and the playtest that guards the far plane says so.
    new SphereGeometry(500, 48, 24),
    new MeshBasicMaterial({
      map: sky,
      side: BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
  );
  dome.name = "sky-dome";
  dome.renderOrder = -2;
  dome.frustumCulled = false;
  return dome;
}

export function setupSky(scene: Scene, sky: Texture, environment: Texture = sky): void {
  sky.mapping = EquirectangularReflectionMapping;
  scene.background = sky;
  scene.backgroundIntensity = 1;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  // The measured fill lights faces the sun misses and supplies reflections as roughness drops.
  scene.environment = environment;
  scene.environmentIntensity = 1.12;
  // The route runs to x=97 with the backdrop cliffs another 60 m behind them, so this is thin on
  // purpose: at this density it is under 2% inside the playfield and only reads past the castle.
  // `scene.fog` stays the distance term; `scene.fogNode` is what three applies and adds the height term.
  const distanceFog = new FogExp2(palette.horizon, distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG, SUN_DIRECTION);
}

/**
 * Inside the camera's far plane by a bounding box's diagonal: the playtest's `cameraClearsScene`
 * measures a mesh by its box, and a box of half-width R reaches 1.73 R.
 */
const FLOOR_RADIUS = 480;

/** Radians the floor climbs above the horizon before it has faded out. */
const RISE = 0.055;

/**
 * What the world floats in. The route has no ground; this is the lower
 * hemisphere, from the fog colour at the horizon to a deeper sky blue straight down, so distant
 * rock fades into it exactly as it fades into the fog. It climbs 20 degrees past the horizon and
 * fades out there, so the gradient melts into the haze instead of meeting it at a hard line.
 * It is not fogged and never writes depth.
 */
export function skyFloor(): Mesh {
  const geometry = new SphereGeometry(
    FLOOR_RADIUS,
    32,
    16,
    0,
    Math.PI * 2,
    Math.PI / 2 - RISE,
    Math.PI / 2 + RISE,
  );
  const horizon = new Color(palette.horizon);
  const deep = new Color(palette.skyHigh).lerp(horizon, 0.45);
  const position = geometry.getAttribute("position");
  const colors: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    const elevation = position.getY(i) / FLOOR_RADIUS;
    const c = horizon.clone().lerp(deep, Math.min(1, Math.max(0, -elevation) / 0.6));
    colors.push(c.r, c.g, c.b, elevation <= 0 ? 1 : Math.max(0, 1 - elevation / Math.sin(RISE)));
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 4));
  const floor = new Mesh(
    geometry,
    new MeshBasicMaterial({
      depthWrite: false,
      fog: false,
      side: BackSide,
      transparent: true,
      vertexColors: true,
    }),
  );
  floor.name = "sky-floor";
  floor.renderOrder = -1;
  floor.frustumCulled = false;
  return floor;
}

/**
 * The cloud bank, as a list of lobes to instance.
 *
 * Eighteen clouds of five to nine squashed lobes is 130-odd separate spheres, and the gradient sky
 * is static — so the scene builds one `InstancedBatch` of a unit sphere from this and never
 * touches it again. The motion in the sky is the airship in `scenery.ts`, which crosses the frame
 * in twenty seconds, and the parallax of a fox covering ninety-seven metres.
 *
 * This is data, not objects, so the batching stays the scene's decision: `src/render/` is ordinary
 * Three.js and never reaches back into the framework.
 */
export function cloudLobes(
  rng: () => number,
): { position: [number, number, number]; scale: [number, number, number] }[] {
  const lobes: { position: [number, number, number]; scale: [number, number, number] }[] = [];
  for (let cloud = 0; cloud < 22; cloud += 1) {
    const scale = 7 + rng() * 9;
    const count = 5 + Math.floor(rng() * 4);
    const cx = -140 + rng() * 420;
    const cy = 14 + rng() * 42;
    const cz = -60 - rng() * 190;
    for (let lobe = 0; lobe < count; lobe += 1) {
      const r = (0.6 + rng() * 0.7) * scale;
      lobes.push({
        position: [
          cx + (lobe - count / 2) * scale * 0.75 + (rng() - 0.5) * scale * 0.4,
          cy + (rng() - 0.4) * scale * 0.35,
          cz + (rng() - 0.5) * scale * 0.5,
        ],
        scale: [r, r * 0.72, r],
      });
    }
  }
  return lobes;
}
