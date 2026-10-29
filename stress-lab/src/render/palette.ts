// Generated for you. Keep these six palette roles coherent when you change the look.
// Neutral greys carry the light; one saturated blue marks what you can touch.
// `skyLow`/`skyHigh` are the sky photograph's own two tones, sampled from the HDR it was made
// from, so the horizon the fog fades into is the horizon the frame actually shows.
export const palette = {
  /** Light grid: platform tops and the ground the arena stands on. */
  floor: 0xb4b1ae,
  /** Dark grid: platform sides, walls, pillars — anything structural. */
  structure: 0x747578,
  /** The metre line both grids are drawn in. */
  gridLine: 0x3a3a3c,
  /** The one saturated colour: anything you can push, pick up or stand on. */
  accent: 0x2a6cf0,
  /** The sky photograph's horizon — the fog colour, and the loading screen behind the bar. */
  skyLow: 0xacb1c1,
  /** One stop brighter: the zenith, and the loading track. */
  skyHigh: 0xc3d2e4,
} as const;
