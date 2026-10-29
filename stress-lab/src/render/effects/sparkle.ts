// Generated for you: ordinary Three.js TSL; edit or delete it freely.
// Algorithm translated from 0beqz/realism-effects/src/sparkle/SparkleEffect.js.
// Source project: MIT.
import { Fn, float, sin, smoothstep, uv, vec3, vec4 } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

// Appearance choices belong to this generated game source.
export const SPARKLE_THRESHOLD = 0.55;
export const SPARKLE_COUNT = 38;
export const SPARKLE_LENGTH = 0.48;
export const SPARKLE_COLOUR = [1, 0.82, 0.42] as const;

export interface ISparkleOptions {
  readonly colour?: readonly [number, number, number];
  readonly count?: number;
  readonly length?: number;
  readonly threshold?: number;
}

/**
 * Add deterministic highlight glints without a texture or a framework-owned material.
 *
 * `inputNode` is a **texture** node, not any vec4 node: this effect calls `.sample()` on it,
 * and only a materialised texture answers that. Pass `convertToTexture(previousStage)`.
 */
export function sparkle(inputNode: TextureNode, options: ISparkleOptions = {}): Node<"vec4"> {
  const threshold = options.threshold ?? SPARKLE_THRESHOLD;
  const count = options.count ?? SPARKLE_COUNT;
  const length = options.length ?? SPARKLE_LENGTH;
  const sparkleColour = options.colour ?? SPARKLE_COLOUR;
  return Fn(() => {
    const colour = inputNode.sample(uv());
    const cell = uv().mul(count).fract().sub(0.5);
    const diagonal = cell.x.add(cell.y).abs();
    const cross = cell.x.sub(cell.y).abs();
    const streak = float(1)
      .sub(smoothstep(0, length, diagonal))
      .mul(float(1).sub(smoothstep(0, length, cross)));
    const brightness = colour.rgb
      .add(0.0001)
      .length()
      .sub(threshold)
      .div(float(1).sub(threshold))
      .clamp(0, 1);
    const phase = sin(uv().x.mul(91.7).add(uv().y.mul(173.1))).abs();
    const glint = streak.mul(brightness).mul(phase);
    return vec4(colour.rgb.add(vec3(...sparkleColour).mul(glint)), colour.a);
  })();
}
