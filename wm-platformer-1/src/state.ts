export type GameState = {
  /** Which checkpoint the fox would respawn at, as an index into the route's points. */
  checkpoint: number;
  coins: number;
  coyoteJumps: number;
  dashes: number;
  defeated: number;
  /** True once the fox has touched the goal flag; the run's clock stops here. */
  finished: boolean;
  /** The same fact under the name the sealed proof reads it by. */
  goalReached: boolean;
  gemTotal: number;
  gems: number;
  hearts: number;
  jumps: number;
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** How high the fox has ever got, which is what proves a jump happened. */
  peakRise: number;
  playerX: number;
  grounded: boolean;
  respawns: number;
  stars: number;
  /** Seconds on the route, frozen when the run finishes. */
  time: number;
  /** A short line under the HUD — "GEM 2/5", "NICE!", "LEVEL CLEAR!". */
  toast: string;
  topSpeed: number;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
};
