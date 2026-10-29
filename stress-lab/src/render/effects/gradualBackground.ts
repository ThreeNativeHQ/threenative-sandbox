// Generated for you: ordinary Three.js TSL; edit or delete it freely.
// Algorithm translated from 0beqz/realism-effects/src/gradual-background/GradualBackgroundEffect.js.
// Source project: MIT.
import { Fn, linearDepth, mix, smoothstep, uv, vec3, vec4, viewportLinearDepth } from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

// Appearance choices belong to this generated game source.
export const GRADUAL_BACKGROUND_START = 0.18;
export const GRADUAL_BACKGROUND_END = 0.86;
export const GRADUAL_BACKGROUND_STRENGTH = 0.65;
export const GRADUAL_BACKGROUND_BOTTOM = [0.015, 0.025, 0.06] as const;
export const GRADUAL_BACKGROUND_TOP = [0.24, 0.12, 0.32] as const;

export interface IGradualBackgroundOptions {
  readonly bottom?: readonly [number, number, number];
  /** Scene depth from the pass that produced `inputNode`; omit to use the viewport depth texture. */
  readonly depth?: Node<"float">;
  readonly end?: number;
  readonly start?: number;
  readonly strength?: number;
  readonly top?: readonly [number, number, number];
}

/**
 * Grade a background by screen height and scene distance toward the upper sky.
 *
 * `inputNode` is a **texture** node, not any vec4 node: this effect calls `.sample()` on it,
 * and only a materialised texture answers that. Pass `convertToTexture(previousStage)`.
 */
export function gradualBackground(
  inputNode: TextureNode,
  options: IGradualBackgroundOptions = {},
): Node<"vec4"> {
  const start = options.start ?? GRADUAL_BACKGROUND_START;
  const end = options.end ?? GRADUAL_BACKGROUND_END;
  const strength = options.strength ?? GRADUAL_BACKGROUND_STRENGTH;
  const bottom = options.bottom ?? GRADUAL_BACKGROUND_BOTTOM;
  const top = options.top ?? GRADUAL_BACKGROUND_TOP;
  const distance = options.depth === undefined ? viewportLinearDepth : linearDepth(options.depth);
  return Fn(() => {
    const colour = inputNode.sample(uv());
    const verticalGradient = smoothstep(start, end, uv().y);
    const distanceGradient = smoothstep(start, end, distance);
    const gradient = mix(verticalGradient, distanceGradient, 0.7);
    const background = mix(vec3(...bottom), vec3(...top), gradient);
    return vec4(mix(colour.rgb, background, strength), colour.a);
  })();
}
