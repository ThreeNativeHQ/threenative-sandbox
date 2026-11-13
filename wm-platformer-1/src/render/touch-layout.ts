import { MathUtils, Vector2 } from "three";

/**
 * Where the on-screen controls sit and how far the stick has been pushed. Pure geometry: no
 * Three.js objects, no scene, so a test can check the maths without a renderer.
 */

export const MOVE_RADIUS = 72;
export const BUTTON_RADIUS = 64;
const EDGE = 36;

export interface ITouchPointer {
  readonly position: Vector2;
}

export interface ITouchViewport {
  readonly height: number;
  readonly width: number;
}

type TouchControlName = "dash" | "jump" | "move";

export function touchControlPoint(size: ITouchViewport, name: TouchControlName): Vector2 {
  if (name === "move") return new Vector2(MOVE_RADIUS + EDGE, size.height - MOVE_RADIUS - EDGE);

  if (size.height > size.width) {
    const yOffset = name === "jump" ? BUTTON_RADIUS * 2 + EDGE : 0;
    return new Vector2(
      size.width - BUTTON_RADIUS - EDGE,
      size.height - BUTTON_RADIUS - EDGE - yOffset,
    );
  }

  const x =
    name === "jump" ? size.width - BUTTON_RADIUS - EDGE : size.width - BUTTON_RADIUS * 3 - EDGE;
  return new Vector2(x, size.height - BUTTON_RADIUS - EDGE);
}

export interface ITouchInput {
  readonly dashPressed: boolean;
  readonly jumpPressed: boolean;
  readonly move: Vector2;
}

/**
 * Deflection of a thumb from where that thumb landed, not from where the ring is drawn.
 *
 * A thumb does not arrive on the circle. It lands wherever the player's hand already was, and
 * measuring from a fixed centre turns that landing spot into an instant full-strength direction
 * the player never asked for — press the middle of the pad and the character bolts diagonally
 * before you have moved at all. Anchoring on touch is what every thumbstick that feels right
 * does, and it is the difference between a control that works and one that fights you.
 *
 * Exported so it can be tested without a renderer: it is pure arithmetic on two points.
 */
export function stickDeflection(anchor: Vector2, current: Vector2, radius: number): Vector2 {
  return new Vector2(
    MathUtils.clamp((current.x - anchor.x) / radius, -1, 1),
    // Screen y grows downward and the game's move.y is +up, so this axis inverts here rather
    // than in the character, which reads `move` from keyboard and touch alike.
    MathUtils.clamp((anchor.y - current.y) / radius, -1, 1),
  );
}
