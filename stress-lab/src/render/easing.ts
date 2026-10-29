// Generated for you. This is ordinary game-owned source — edit or delete it freely.
// Curves decide the feel of a motion, so they live beside the rest of the starter's look.

/** Raise the pickup quickly, then settle it gently onto its hover height. */
export const pickupRiseEase = (t: number): number => 1 - (1 - t) ** 3;
