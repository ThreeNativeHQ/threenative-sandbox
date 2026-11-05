export type Phase = "flying" | "arena" | "clear" | "down";

export type GameState = {
  phase: Phase;
  shield: number;
  shieldMax: number;
  boost: number;
  hits: number;
  distance: number;
  bombs: number;
  laserLevel: number;
  charge: number;
  locked: boolean;
  /** Test-only: a scenario sets this through `setup.resources` to fly the full-run autopilot. */
  autopilot: boolean;
  /** Test-only: a scenario sets metres along the course to jump to (e.g. past the rail end for the arena). */
  skipTo: number;
};
