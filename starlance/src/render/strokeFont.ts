// A thin single-stroke sans for the cockpit screens and the combiner HUD. Every glyph is a few line
// segments, and every segment is one quad through the shared painter, so text stays crisp at any
// size (unlike the 3x5 pixel font), needs no canvas, DOM or font file, and runs on every target.
// Glyphs live on a 6 x 10 grid (y up); the advance is 8, so the gap is 2.
import type { IPainter } from "./hud.js";

const GLYPHS: Record<string, string> = {
  A: "0,0 3,10 6,0|1.2,4 4.8,4",
  B: "0,0 0,10 4,10 5.5,9 5.5,6.5 4,5 0,5|4,5 6,4 6,1 4.5,0 0,0",
  C: "6,8.5 5,10 1,10 0,8.5 0,1.5 1,0 5,0 6,1.5",
  D: "0,0 0,10 3.5,10 6,7.5 6,2.5 3.5,0 0,0",
  E: "6,10 0,10 0,0 6,0|0,5 4.5,5",
  F: "6,10 0,10 0,0|0,5 4.5,5",
  G: "6,8.5 5,10 1,10 0,8.5 0,1.5 1,0 5,0 6,1.5 6,4.5 3.5,4.5",
  H: "0,0 0,10|6,0 6,10|0,5 6,5",
  I: "3,0 3,10",
  J: "6,10 6,1.5 5,0 1,0 0,1.5",
  K: "0,0 0,10|6,10 0,4.5|2,6.5 6,0",
  L: "0,10 0,0 6,0",
  M: "0,0 0,10 3,4 6,10 6,0",
  N: "0,0 0,10 6,0 6,10",
  O: "1,0 0,1.5 0,8.5 1,10 5,10 6,8.5 6,1.5 5,0 1,0",
  P: "0,0 0,10 4.5,10 6,8.5 6,6.5 4.5,5 0,5",
  Q: "1,0 0,1.5 0,8.5 1,10 5,10 6,8.5 6,1.5 5,0 1,0|4,2.5 6,0",
  R: "0,0 0,10 4.5,10 6,8.5 6,6.5 4.5,5 0,5|3,5 6,0",
  S: "6,8.5 5,10 1,10 0,8.5 0,6.5 1,5 5,5 6,3.5 6,1.5 5,0 1,0 0,1.5",
  T: "0,10 6,10|3,10 3,0",
  U: "0,10 0,1.5 1,0 5,0 6,1.5 6,10",
  V: "0,10 3,0 6,10",
  W: "0,10 1.5,0 3,6 4.5,0 6,10",
  X: "0,0 6,10|0,10 6,0",
  Y: "0,10 3,5 6,10|3,5 3,0",
  Z: "0,10 6,10 0,0 6,0",
  "0": "1,0 0,1.5 0,8.5 1,10 5,10 6,8.5 6,1.5 5,0 1,0|1.5,2 4.5,8",
  "1": "1,8 3,10 3,0|1,0 5,0",
  "2": "0,8.5 1,10 5,10 6,8.5 6,6.5 0,0 6,0",
  "3": "0,9 1,10 5,10 6,8.5 6,6.5 5,5 2.5,5|5,5 6,3.5 6,1.5 5,0 1,0 0,1",
  "4": "5,0 5,10 0,3 6,3",
  "5": "6,10 0,10 0,5.5 4.5,5.5 6,4 6,1.5 4.5,0 1,0 0,1",
  "6": "5,10 1,10 0,8.5 0,1.5 1,0 5,0 6,1.5 6,4 5,5.5 0,5.5",
  "7": "0,10 6,10 2,0",
  "8": "1,5 0,6.5 0,8.5 1,10 5,10 6,8.5 6,6.5 5,5 1,5 0,3.5 0,1.5 1,0 5,0 6,1.5 6,3.5 5,5",
  "9": "1,0 5,0 6,1.5 6,8.5 5,10 1,10 0,8.5 0,6 1,4.5 6,4.5",
  ".": "3,0 3,0.9",
  ":": "3,1.5 3,2.4|3,6.5 3,7.4",
  "-": "1,5 5,5",
  "+": "1,5 5,5|3,2 3,8",
  "/": "0,0 6,10",
  "%": "0,0 6,10|0.5,9 1.5,9|4.5,1 5.5,1",
  ">": "1,9 5,5 1,1",
  "<": "5,9 1,5 5,1",
  _: "0,0 6,0",
};

type Stroke = readonly (readonly [number, number])[];
const STROKES: Record<string, readonly Stroke[]> = {};
for (const [ch, def] of Object.entries(GLYPHS))
  STROKES[ch] = def.split("|").map((stroke) =>
    stroke.split(" ").map((pair) => {
      const [x, y] = pair.split(",");
      return [Number(x), Number(y)] as const;
    }),
  );

/** Width of `s` at glyph height `size`. */
export function strokeWidth(s: string, size: number): number {
  return Math.max(0, s.length * 8 - 2) * (size / 10);
}

type Anchor = "left" | "center" | "right";

/**
 * One line of text. `y` is the vertical centre, `size` the glyph height in painter units, `weight` the
 * stroke width as a fraction of the height (0.11 reads as a thin sans).
 */
export function strokeText(
  p: IPainter,
  s: string,
  x: number,
  y: number,
  size: number,
  color: number,
  anchor: Anchor = "left",
  weight = 0.11,
): void {
  const k = size / 10;
  const t = size * weight;
  const x0 =
    anchor === "left"
      ? x
      : anchor === "center"
        ? x - strokeWidth(s, size) / 2
        : x - strokeWidth(s, size);
  let cx = x0;
  for (const ch of s.toUpperCase()) {
    const strokes = STROKES[ch];
    if (strokes !== undefined)
      for (const stroke of strokes)
        for (let i = 1; i < stroke.length; i += 1) {
          const a = stroke[i - 1] as readonly [number, number];
          const b = stroke[i] as readonly [number, number];
          segment(
            p,
            cx + a[0] * k,
            y + (a[1] - 5) * k,
            cx + b[0] * k,
            y + (b[1] - 5) * k,
            t,
            color,
          );
        }
    cx += 8 * k;
  }
}

/** A line segment as one quad, overlapped by half a stroke at each end so corners close. */
export function segment(
  p: IPainter,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t: number,
  color: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  p.quad((x0 + x1) / 2, (y0 + y1) / 2, Math.hypot(dx, dy) + t * 0.9, t, color, Math.atan2(dy, dx));
}
