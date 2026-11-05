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
};
