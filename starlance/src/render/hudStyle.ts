// Chase-view status panels: shield, boost, hit counter, bombs, laser and wings, drawn through the
// shared `IPainter` (one draw call). Original look in the spirit of the reference card
// (`docs/reference-Nzh211-UIGM.md`): mint outlines, slanted bar wedges, hex pips, a damage ghost that
// drains after a hit, a flash on the shield frame, a pulse on the hit counter.
//
// Every control says which way to move it. `hud.ts` owns the layout rectangle and the clock; this
// file owns colours, geometry and the easing state.
import type { IPainter } from "./hud.js";

/** The palette of the whole HUD (sRGB). The cockpit combiner HUD should read these too. */
export const STYLE = {
  mint: 0x45f2b4,
  ice: 0xe6fff8,
  teal: 0x06262b,
  dim: 0x1b4a47,
  boost: 0x4aa8ff,
  amber: 0xffb03a,
  red: 0xff5a3a,
  /** Skew of every bar wedge, as the fraction of its height the top edge leans right. Up: more slant. */
  slant: 0.9,
  /** Seconds the shield ghost waits after a hit before draining. */
  ghostHold: 0.35,
  /** Ghost drain, in fractions of the bar per second. */
  ghostDrain: 0.5,
  /** Seconds the shield frame flashes after a hit. */
  flash: 0.3,
  /** How fast the shown value chases the real one (1/s). Up: snappier bars. */
  ease: 9,
} as const;

export interface IStatus {
  shield: number;
  shieldMax: number;
  boost: number;
  boostLatched: boolean;
  hits: number;
  bombs: number;
  laserLevel: number;
  /** Left and right wing health, 0..60. */
  wings: readonly [number, number];
}

/** Where the panels sit, in screen heights, and the glyph size `hud.ts` uses. */
export interface IStatusLayout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  px: number;
}

export interface IStatusStyle {
  draw(p: IPainter, s: IStatus, layout: IStatusLayout, dt: number, clock: number): void;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const shade = (color: number, k: number): number =>
  (Math.round(((color >> 16) & 255) * k) << 16) |
  (Math.round(((color >> 8) & 255) * k) << 8) |
  Math.round((color & 255) * k);

/** A parallelogram of `rows` stacked strips; the top edge leans right by `skew`. */
function wedge(
  p: IPainter,
  x: number,
  y: number,
  w: number,
  h: number,
  skew: number,
  color: number,
  rows = 5,
): void {
  for (let r = 0; r < rows; r += 1) {
    const shift = skew * (1 - (r + 0.5) / rows);
    p.rect(x + shift, y - (h * r) / rows, x + shift + w, y - (h * (r + 1)) / rows, color);
  }
}

/** A slanted gauge: dark well, mint outline, `value` fill, an optional trailing ghost. */
function gauge(
  p: IPainter,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: number,
  value: number,
  frame: number,
  ghost = 0,
  segments = 0,
): void {
  const skew = h * STYLE.slant;
  const t = h * 0.14;
  wedge(p, x - t, y + t, w + 2 * t, h + 2 * t, skew, frame);
  wedge(p, x, y, w, h, skew, STYLE.teal);
  if (ghost > value) wedge(p, x, y, w * ghost, h, skew, STYLE.ice, 3);
  if (value > 0.002) {
    wedge(p, x, y, w * value, h, skew, fill);
    // The lower 45% a shade darker gives the bar body.
    wedge(p, x, y - h * 0.55, w * value, h * 0.45, skew * 0.45, shade(fill, 0.62), 2);
  }
  for (let k = 1; k < segments; k += 1)
    p.quad(
      x + (w * k) / segments + skew * 0.5,
      y - h / 2,
      h * 0.1,
      h * 1.05,
      STYLE.teal,
      -Math.atan2(skew, h),
    );
  // A bright cap on the fill's leading edge reads as a charged level.
  if (value > 0.01)
    p.rect(
      x + skew * 0.5 + w * value - h * 0.12,
      y - h * 0.15,
      x + skew * 0.5 + w * value,
      y - h * 0.85,
      STYLE.ice,
    );
}

/** A flat-topped hexagon pip: three bars turned 60 degrees apart. */
function hex(p: IPainter, x: number, y: number, r: number, color: number): void {
  for (const a of [0, Math.PI / 3, -Math.PI / 3]) p.quad(x, y, r * 2, r * 1.15, color, a);
}

export function createStatusStyle(): IStatusStyle {
  let shield = Number.NaN;
  let ghost = 0;
  let hold = 0;
  let flash = 0;
  let boost = 0;
  let hits = 0;
  let pulse = 0;
  return {
    draw(p, s, { left, right, top, bottom, px }, dt, clock) {
      const ratioTo = (v: number): number => clamp01(v / s.shieldMax);
      const target = ratioTo(s.shield);
      if (Number.isNaN(shield)) {
        shield = target;
        ghost = target;
        boost = s.boost;
        hits = s.hits;
      }
      // A hit: the bar drops at once, a pale ghost holds where it was, then drains.
      if (target < shield - 0.004) {
        ghost = Math.max(ghost, shield);
        hold = STYLE.ghostHold;
        flash = STYLE.flash;
      }
      const k = 1 - Math.exp(-STYLE.ease * dt);
      shield = target < shield ? target : shield + (target - shield) * k;
      hold = Math.max(0, hold - dt);
      if (hold === 0) ghost = Math.max(shield, ghost - STYLE.ghostDrain * dt);
      flash = Math.max(0, flash - dt);
      boost += (clamp01(s.boost) - boost) * k;
      if (s.hits !== hits) {
        pulse = 1;
        hits = s.hits;
      }
      pulse = Math.max(0, pulse - dt * 4);

      const low = s.shield <= 100;
      const crit = s.shield <= 50;
      const blink = (hz: number): boolean => Math.sin(clock * hz * Math.PI * 2) > 0;
      const level = crit ? (blink(4) ? STYLE.red : STYLE.amber) : low ? STYLE.amber : STYLE.mint;
      const frame = flash > 0 ? STYLE.red : STYLE.mint;

      // ---- shield and boost (top left) ---------------------------------------------------------
      const unit = 0.28 / 255;
      const barW = s.shieldMax * unit;
      const by = top - 0.036;
      p.text("SHIELD", left, top, px, STYLE.mint);
      p.text(String(Math.ceil(s.shield)), left + barW, top, px, STYLE.ice, "right");
      gauge(p, left, by, barW, 0.02, level, shield, frame, ghost, 5);
      if (s.shieldMax > 255) {
        const nx = left + 255 * unit;
        p.rect(nx - 0.0012, by + 0.008, nx + 0.0012, by - 0.028, STYLE.ice);
        p.text(`MAX ${Math.round(s.shieldMax)}`, left, by - 0.026, px * 0.85, STYLE.amber);
      }
      const gy = by - (s.shieldMax > 255 ? 0.082 : 0.054);
      const boostColor = s.boostLatched ? STYLE.amber : STYLE.boost;
      p.text(s.boostLatched ? "BOOST WAIT" : "BOOST", left, gy + 0.016, px * 0.85, boostColor);
      gauge(p, left, gy - 0.008, 0.2, 0.011, boostColor, boost, STYLE.dim);

      // ---- hit counter (top right): the numerals swell for a moment on every hit --------------
      p.text("HITS", right, top, px, STYLE.mint, "right");
      p.text(
        String(s.hits).padStart(3, "0"),
        right,
        top - 6.5 * px,
        px * (1.9 + 0.5 * pulse),
        STYLE.ice,
        "right",
      );
      const rw = 0.17;
      wedge(p, right - rw, top - 0.09, rw, 0.0035, 0.0035 * STYLE.slant, STYLE.mint, 1);

      // ---- bombs, laser level, wings (bottom left) ---------------------------------------------
      const lab = 0.092;
      let ly = bottom + 0.105;
      p.text("BOMB", left, ly, px, STYLE.mint);
      for (let i = 0; i < 9; i += 1)
        hex(p, left + lab + i * 0.0165, ly - 0.0085, 0.0062, i < s.bombs ? STYLE.mint : STYLE.dim);
      ly -= 0.038;
      p.text("LASER", left, ly, px, STYLE.mint);
      for (let i = 0; i < 3; i += 1) {
        const c = i <= s.laserLevel ? STYLE.mint : STYLE.dim;
        const x = left + lab + 0.006 + i * 0.02;
        p.quad(x, ly - 0.011, 0.014, 0.0035, c, 0.6);
        p.quad(x, ly - 0.005, 0.014, 0.0035, c, -0.6);
      }
      ly -= 0.038;
      p.text("WING", left, ly, px, STYLE.mint);
      s.wings.forEach((hp, i) => {
        const x = left + lab + i * 0.04;
        const frac = clamp01(hp / 60);
        const c = hp <= 0 ? STYLE.red : frac < 0.5 ? STYLE.amber : STYLE.mint;
        gauge(p, x, ly - 0.004, 0.028, 0.014, c, frac, hp <= 0 && blink(2) ? STYLE.red : STYLE.dim);
      });
    },
  };
}
