// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// `palette` is the six roles the render layer shares: the loading screen's two sky bands, the
// distance the horizon fades into, the two colours a walkable surface is made of, and one
// saturated `accent` that marks everything the player can touch. Rename a role and every user of
// it moves with it, which is the point — there is no second copy of "the green" anywhere.
//
// `C` is this game's own colour table for the procedural models below it. A fox with a jacket, a
// gold coin and a red mushroom cap needs more than six colours and pretending otherwise buys
// nothing: these are named per part, so swapping one creature's fur never touches a rock.

export const palette = {
  grass: 0x67c23c,
  /** Distance fades into this; also the loading screen's background. */
  horizon: 0xbfe4fb,
  rock: 0xa1907c,
  /** The loading screen's progress track. */
  skyHigh: 0x1368f2,
  skyLow: 0x3f9bf4,
  /** The one saturated role: coins, gems, stars, the goal. */
  accent: 0xffd23f,
} as const;

/** Colours sampled from the reference frame, by part. */
export const C = {
  skyTop: 0x1368f2,
  skyBottom: 0xbfe4fb,
  fog: 0xa9d8f5,
  sun: 0xfff4d6,

  grass: 0x67c23c,
  grassDark: 0x3f8f28,
  grassLight: 0x9ade5a,
  dirt: 0x9a7548,

  rock: 0x8f7f6d,
  rockDark: 0x61564a,
  rockLight: 0xb2a28c,
  moss: 0x6a9b3f,

  wood: 0xdb9448,
  woodDark: 0xa8632f,
  woodPost: 0xc4813c,
  rope: 0xe6cd96,

  fur: 0xf2952f,
  furDark: 0xd4761b,
  cream: 0xfbe7c9,
  jacket: 0x2f7fd6,
  jacketDark: 0x2263ab,
  pack: 0x5c7ea3,
  ink: 0x2b1a10,

  gold: 0xffd23f,
  goldDark: 0xd79a17,
  gem: 0x3fa9f5,
  gemLight: 0x9fe0ff,

  capRed: 0xdf4a3d,
  capDark: 0xa82f26,
  shellRed: 0x9e3527,
  snailBody: 0xa8c47a,
  spot: 0xfff3e2,

  water: 0x9fe3fb,
  cloud: 0xffffff,
  brick: 0xb08d72,
  brickDark: 0x8a6c55,
  roof: 0x3f7fbf,
  metal: 0x9aa7b4,
} as const;
