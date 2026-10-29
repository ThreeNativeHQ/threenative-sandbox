// Generated for you: ordinary Three.js TSL; edit or delete it freely.
// Algorithm translated from 0beqz/realism-effects/src/lens-distortion/LensDistortionEffect.js.
// Source project: MIT. Radial model reference: https://marcodiiga.github.io/radial-lens-undistortion-filtering
import { Fn, float, uv, vec2, vec4 } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

// Appearance choices belong to this generated game source.
export const LENS_DISTORTION_K1 = -0.18;
export const LENS_DISTORTION_K2 = 0.04;
export const LENS_DISTORTION_CHROMATIC_ABERRATION = 0.0025;

export interface ILensDistortionOptions {
  readonly chromaticAberration?: number;
  readonly k1?: number;
  readonly k2?: number;
}

/**
 * Apply radial undistortion with a small per-channel chromatic offset.
 *
 * `inputNode` is a **texture** node, not any vec4 node: this effect calls `.sample()` on it,
 * and only a materialised texture answers that. Pass `convertToTexture(previousStage)`.
 */
export function lensDistortion(
  inputNode: TextureNode,
  options: ILensDistortionOptions = {},
): Node<"vec4"> {
  const k1 = options.k1 ?? LENS_DISTORTION_K1;
  const k2 = options.k2 ?? LENS_DISTORTION_K2;
  const chromaticAberration = options.chromaticAberration ?? LENS_DISTORTION_CHROMATIC_ABERRATION;
  return Fn(() => {
    const centered = uv().sub(0.5);
    const radiusSquared = centered.dot(centered);
    const radial = float(1)
      .add(radiusSquared.mul(k1))
      .add(radiusSquared.mul(radiusSquared).mul(k2));
    const distorted = centered.mul(radial).add(0.5).clamp(0, 1);
    const red = inputNode.sample(distorted.add(vec2(chromaticAberration, 0))).r;
    const green = inputNode.sample(distorted).g;
    const blue = inputNode.sample(distorted.sub(vec2(chromaticAberration, 0))).b;
    return vec4(red, green, blue, inputNode.sample(distorted).a);
  })();
}
