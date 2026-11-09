/** Photographic dawn: one panorama supplies the visible sky and the aircraft/water reflections. */
import type { ICtx } from "@threenative/core";
import { Color, EquirectangularReflectionMapping, Euler, RepeatWrapping, Vector3, type Texture } from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { float, pmremTexture, texture, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

export const SUN_DIRECTION = new Vector3(-.62, .13, -.75).normalize();
export const SKY_ROTATION = new Euler(0, 2.76, 0);
export const SUN_COLOR = new Color(0xffc78a);
let sky: Texture;
let ripples: Texture;

export async function loadEnvironment(ctx: Pick<ICtx, "assets">): Promise<void> {
  const [url] = await ctx.assets.resolve("dawn-sky.hdr");
  [sky, ripples] = await Promise.all([
    new HDRLoader().loadAsync(url),
    ctx.assets.texture("ocean-normal.png"),
  ]);
  sky.mapping = EquirectangularReflectionMapping;
  ripples.wrapS = ripples.wrapT = RepeatWrapping;
  ripples.anisotropy = 4;
}

export function dawnEnvironment(): Texture {
  if (!sky) throw new Error("Dawn environment must load before the world.");
  return sky;
}

export function reflectedSky(direction: Node<"vec3">, roughness: Node<"float"> = float(.3)): Node<"vec3"> {
  // Prefiltered reflections preserve unresolved wave roughness at altitude. PMREM applies
  // scene.environmentRotation itself, keeping the water aligned with the visible panorama.
  return pmremTexture(dawnEnvironment(), direction, roughness).mul(.65);
}

/** Two moving, differently scaled normal octaves, filtered out below their pixel footprint. */
export function oceanRipples(point: Node<"vec2">, time: Node<"float">): Node<"vec3"> {
  const first = texture(ripples, point.mul(.075).add(time.mul(.011))).xyz.mul(2).sub(1);
  const second = texture(ripples, point.mul(.137).sub(time.mul(.009))).xyz.mul(2).sub(1);
  return vec3(first.x.add(second.y), 0, first.y.add(second.x)).mul(.11);
}
