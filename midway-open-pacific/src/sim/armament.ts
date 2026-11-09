/** Sortie presets and a game-tuned 1942-style straight-running torpedo envelope. */
import { clamp, forward } from "./math.js";
import { FIRING_DEPTH_LIMIT, SUBMERGED_MAX } from "./submarine.js";

type Any = any;

export interface ILoadout {
  id: string;
  airframe: string;
  name: string;
  description: string;
  bombs: number;
  torpedo: number;
  kind: string;
}

export const LOADOUTS: Record<string, ILoadout> = Object.freeze({
  bomb: {
    id: "bomb",
    airframe: "sbd",
    name: "SBD Dauntless",
    description: "Dive strike · 1 heavy + 2 light bombs",
    bombs: 3,
    torpedo: 0,
    kind: "bomber",
  },
  torpedo: {
    id: "torpedo",
    airframe: "tbd",
    name: "TBD Devastator",
    description: "Torpedo strike · 1 Mark 13",
    bombs: 0,
    torpedo: 1,
    kind: "torpedo",
  },
});

export function applyLoadout(p: Any, id: string): boolean {
  const load = LOADOUTS[id];
  if (!load) return false;
  // A different airframe is a different aircraft and brings its own rear-gun capacity (the SBD's
  // 1200, the TBD's 600). Applying the same loadout — a deck rearm — leaves every ammunition
  // counter alone, so the carrier's finite stores stay the only refill and a rearm cannot top up
  // the rear gun for free.
  const airframeChanged = p.airframe !== load.airframe;
  Object.assign(p, {
    loadout: id,
    airframe: load.airframe,
    kind: id === "torpedo" ? "torpedo" : "bomber",
    bombs: load.bombs,
    torpedo: load.torpedo,
  });
  if (airframeChanged) {
    p.rearAmmo = rearRoundsFor(load.airframe);
    initRearState(p);
  }
  if (id === "torpedo") {
    p.brakes = false;
    p.brakePos = 0;
  }
  updateStores(p);
  return true;
}

/**
 * Payload mass and drag the flight model reads, derived from the stores actually left on the racks.
 * Call this after every successful release; calling `applyLoadout` instead would replenish them.
 */
export function updateStores(p: Any): void {
  p.payloadMass =
    ((p.bombs ?? 0) >= 3 ? 454 : 0) + Math.min(2, p.bombs ?? 0) * 45 + (p.torpedo ?? 0) * 1000;
  p.payloadDrag = ((p.bombs ?? 0) > 0 ? 0.003 : 0) + ((p.torpedo ?? 0) > 0 ? 0.014 : 0);
}

/**
 * The player-facing release gate. The altitude and speed limits are the carried variant's own
 * (`TORPEDO_VARIANTS[...].release`, m/s throughout), picked by AIRFRAME where the airframe is known;
 * the team is only the fallback for an aircraft with no airframe id, and it selects the same two
 * envelopes the game has always used (15.5 m / 57 m/s for the Mark 13, 45 m / 88 m/s for the Type 91).
 * Attitude limits stay here because they are the aircraft's, not the weapon's.
 */
export function torpedoEnvelope(p: Any): {
  safe: boolean;
  problems: string[];
  maxHeight: number;
  maxSpeed: number;
} {
  const variant =
    torpedoVariantForAirframe(p.airframe) ??
    torpedoVariant(p.team === "jp" ? "type91" : "mk13");
  const speed = p.speed ?? Math.hypot(p.vx || 0, p.vy || 0, p.vz || 0);
  const { maxAltitude: maxHeight, maxSpeed, minAltitude, minSpeed } = variant.release;
  const problems: string[] = [];
  if (p.y < minAltitude) problems.push("TOO LOW");
  if (p.y > maxHeight) problems.push("TOO HIGH");
  if (speed > maxSpeed) problems.push("TOO FAST");
  if (speed < minSpeed) problems.push("TOO SLOW");
  if (Math.abs(p.roll || 0) > 0.17) problems.push("WINGS NOT LEVEL");
  if (Math.abs(p.pitch || 0) > 0.14) problems.push("LEVEL THE NOSE");
  return { safe: problems.length === 0, problems, maxHeight, maxSpeed };
}

export function torpedoIntercept(
  a: Any,
  target: Any,
  speed = 17.25,
): { x: number; y: number; z: number; time: number } {
  const tf = forward(target.heading);
  const vx = tf.x * target.speed;
  const vz = tf.z * target.speed;
  const dx = target.x - a.x;
  const dz = target.z - a.z;
  const A = vx * vx + vz * vz - speed * speed;
  const B = 2 * (dx * vx + dz * vz);
  const C = dx * dx + dz * dz;
  const disc = B * B - 4 * A * C;
  let t = 0;
  if (disc >= 0 && Math.abs(A) > 1e-7) {
    const roots = [(-B + Math.sqrt(disc)) / (2 * A), (-B - Math.sqrt(disc)) / (2 * A)].filter(
      (v) => v > 0,
    );
    if (roots.length) t = Math.min(...roots);
  } else if (Math.abs(B) > 1e-7) t = -C / B;
  t = clamp(t, 0, 160);
  return { x: target.x + vx * t, y: 0, z: target.z + vz * t, time: t };
}

// ---------------------------------------------------------------------------------------------
// Torpedo variants
// ---------------------------------------------------------------------------------------------
//
// Every figure below is cited to a section of docs/reference-dimensions.md, which holds the source
// link and the arithmetic. All speeds are **m/s**; the cited knots value is shown beside each one so
// a unit regression is visible on the page. Nothing in `src/sim/` ever holds knots — the HUD converts
// at its own boundary.
//
// SHIPPED BODY. `assets/weapon.torpedo.glb` is 4.089 m long and 0.569 m in diameter
// (`WEAPON_BODIES.torpedo` in ./catalog.ts): that is a **Mark 13** and nothing else. The uniform
// scale each other variant would need from that body, and why the scale is not enough:
//
//   mk13    x1.000 length, x1.000 diameter — the body as shipped.
//   type91  x1.342 length (5.486/4.089) but x0.791 diameter (0.450/0.569). A uniform x1.342 gives a
//           0.763 m body: 70% too fat. A correct Type 91 is a SEPARATE mesh — longer, markedly
//           slimmer, and carrying the wooden anti-roll box tail the Mod 2 was fitted with in 1941,
//           which the Mark 13's plain ring tail does not have at any scale.
//   type95  x1.749 length (7.15/4.089), x0.937 diameter (0.533/0.569) — again non-uniform, and the
//           Type 95 is a wakeless oxygen weapon with its own tail and no air flask vents.
//   mk14    x1.565 length (6.40/4.089), x0.937 diameter (0.533/0.569) — non-uniform.
//
// So reusing one body for all four, which is what the PRD forbids, is not just a scale error: three
// of the four need their own geometry. Until those exist, a caller should draw only `mk13` from this
// body and accept that the other three have no correct model yet.

/** One speed setting and the range the weapon makes at it. */
export interface TorpedoSetting {
  /** m/s — never knots. */
  speed: number;
  /** m of run at that speed. */
  range: number;
  label: string;
}

/** Running depth as a settable band, plus the error the weapon actually ran with. */
export interface TorpedoDepth {
  /** m below the surface, shallowest setting. */
  min: number;
  /** m below the surface, deepest setting. */
  max: number;
  /** m the weapon ran DEEPER than set. 0 where no source records a bias. */
  bias: number;
  note: string;
}

/**
 * The share of legal releases that run true and detonate.
 *
 * This is a **seeded game approximation, not a historical measurement**: no cited source publishes a
 * per-weapon success rate for June 1942. `provenance` says what the number was reasoned from and what
 * it is not. Deliberately coarse — two significant figures would be a false precision.
 */
export interface TorpedoReliability {
  /** 0..1. GAME APPROXIMATION. */
  runs: number;
  provenance: string;
}

/**
 * Where a launch is legal. `altitude` is metres, positive up, so a submarine tube is a NEGATIVE
 * band: `maxAltitude: 0` means the weapon cannot leave the tube above the surface, and
 * `minAltitude: -FIRING_DEPTH_LIMIT` is the depth below which the boat must rise to shoot. Speeds
 * are the launch platform's, in m/s.
 */
export interface ReleaseEnvelope {
  minAltitude: number;
  maxAltitude: number;
  minSpeed: number;
  maxSpeed: number;
}

export interface TorpedoVariant {
  id: string;
  displayName: string;
  /** What carries it. Chosen by launcher and airframe, never by team. */
  launcher: "aircraft" | "submarine";
  /** m; overall body length. */
  length: number;
  /** m; body diameter. */
  bodyDiameter: number;
  /** kg of explosive charge (not the warhead assembly, and not the all-up weight). */
  warheadMass: number;
  /** Every setting the weapon actually had, with its own range. One entry means one setting. */
  settings: TorpedoSetting[];
  runDepth: TorpedoDepth;
  /** m of run before the exploder arms. A hit short of this is a bounce, not a detonation. */
  armingDistance: number;
  reliability: TorpedoReliability;
  release: ReleaseEnvelope;
  /** Source note: which section of docs/reference-dimensions.md every figure above came from. */
  source: string;
}

/** Tubes cannot be fired below this depth; from ./submarine.js so the two cannot drift apart. */
const TUBE_DEPTH_LIMIT = FIRING_DEPTH_LIMIT;

export const TORPEDO_VARIANTS: Readonly<Record<string, TorpedoVariant>> = Object.freeze({
  mk13: {
    id: "mk13",
    displayName: "Mark 13",
    launcher: "aircraft",
    length: 4.09, // m; docs/reference-dimensions.md §13 (OP 629(A), 161 in)
    bodyDiameter: 0.569, // m; §13 (22.4 in, USS Midway Museum); the shipped GLB measures 0.569 m
    warheadMass: 181, // kg TNT; §13, Mod 0 as carried in June 1942 (the 272 kg Torpex Mod 2 is 1943)
    settings: [
      { speed: 17.23, range: 5760, label: "33.5 kn" }, // m/s and m; §13, single setting, 6,300 yd
    ],
    runDepth: {
      min: 0, // m
      max: 3.5, // m
      bias: 0,
      note: "§13 finds NO numeric setting range: 1942 depth control was poor and the weapon often ran on the surface. The 0-3.5 m band is a GAME APPROXIMATION of that behaviour, not a published setting range.",
    },
    armingDistance: 230, // m; GAME APPROXIMATION, see ARMING_PROVENANCE
    reliability: {
      runs: 0.35,
      provenance:
        "GAME APPROXIMATION. §13 states only that reliability was poor and that drops outside 15 m / 110 kn broke up, ran on the surface or failed to run; no rate is published. 0.35 is a seeded setting chosen to make a legal release worth flying and an unlucky one unremarkable.",
    },
    release: {
      minAltitude: 5, // m; the game's own floor, unchanged
      maxAltitude: 15.5, // m; the game's existing figure, and §13's cited 50 ft ≈ 15 m limit
      minSpeed: 35, // m/s; the game's own floor, unchanged
      maxSpeed: 57, // m/s; the game's existing figure ≈ §13's 110 kn = 56.6 m/s
    },
    source: "docs/reference-dimensions.md §13 (US Mark 13 aerial torpedo, 1942 service state)",
  },
  type91: {
    id: "type91",
    displayName: "Type 91 Mod 2",
    launcher: "aircraft",
    length: 5.486, // m; docs/reference-dimensions.md §14 (OP 1507 / NavWeaps, 216 in)
    bodyDiameter: 0.45, // m; §14 (17.7 in)
    warheadMass: 205, // kg HE charge; §14 adopted value (OP 1507 gives 190 kg, navweaps 240 kg)
    settings: [
      { speed: 21.61, range: 2000, label: "42 kn" }, // m/s and m; §14 adopted (OP 1507 gives 3,018 m)
    ],
    runDepth: {
      min: 2.0, // m; §14 (6 ft 6 in)
      max: 16.0, // m; §14 (52 ft 8 in)
      bias: 0,
      note: "§14: a published 2.0-16.0 m setting range, the only one of the four with a cited band. The 1941 anti-rolling controller is what made the shallow end usable.",
    },
    armingDistance: 200, // m; GAME APPROXIMATION, see ARMING_PROVENANCE
    reliability: {
      runs: 0.8,
      provenance:
        "GAME APPROXIMATION. §14 records a weapon strengthened in 1938 and given the anti-rolling controller in 1941 for shallow-water drops, with no documented failure epidemic; no rate is published. 0.8 is a seeded setting reflecting that, not a measured figure.",
    },
    release: {
      minAltitude: 5, // m; the game's own floor, unchanged
      maxAltitude: 45, // m; the game's existing figure for the Japanese envelope
      minSpeed: 35, // m/s; the game's own floor, unchanged
      maxSpeed: 88, // m/s; the game's existing figure (≈171 kn), NOT a knots value
    },
    source: "docs/reference-dimensions.md §14 (Japanese Type 91 aerial torpedo, Kai/Mod 2, 1942)",
  },
  type95: {
    id: "type95",
    displayName: "Type 95 Mod 1",
    launcher: "submarine",
    length: 7.15, // m; docs/reference-dimensions.md §15 (23 ft 5 in)
    bodyDiameter: 0.533, // m; §15 (21.0 in) — equal to the Mark 14 because both are 21-inch weapons
    warheadMass: 405, // kg; §15 Mod 1 (the Model 2's 550 kg is a later mark)
    settings: [
      { speed: 25.21, range: 9000, label: "49 kn" }, // m/s and m; §15 Mod 1
      { speed: 23.15, range: 12000, label: "45 kn" }, // m/s and m; §15 Mod 1
    ],
    runDepth: {
      min: 1.0, // m
      max: 20.0, // m
      bias: 0,
      note: "§15 finds NO published numeric limiter: depth was set by the fire-control party. The 1-20 m band is a GAME APPROXIMATION of a settable weapon, not a cited setting range.",
    },
    armingDistance: 350, // m; GAME APPROXIMATION, see ARMING_PROVENANCE
    reliability: {
      runs: 0.85,
      provenance:
        "GAME APPROXIMATION. §15 records a kerosene-oxygen wet-heater derived from the Type 93, the weapon I-168 used successfully against Yorktown and Hammann, with no documented failure epidemic; no rate is published. 0.85 is a seeded setting, the highest of the four.",
    },
    release: {
      // A tube shot, not a drop: at or under the surface, and not below the depth the boat can shoot from.
      minAltitude: -TUBE_DEPTH_LIMIT, // m; ./submarine.js FIRING_DEPTH_LIMIT, as a negative altitude
      maxAltitude: 0, // m; the tube cannot be above the surface
      minSpeed: 0, // m/s; a boat can shoot from a standstill
      maxSpeed: SUBMERGED_MAX, // m/s; ./submarine.js — the fastest a submerged boat runs
    },
    source: "docs/reference-dimensions.md §15 (Japanese Type 95 submarine torpedo)",
  },
  mk14: {
    id: "mk14",
    displayName: "Mark 14",
    launcher: "submarine",
    length: 6.4, // m; docs/reference-dimensions.md §16 (21 ft 0 in)
    bodyDiameter: 0.533, // m; §16 (21 in) — equal to the Type 95 because both are 21-inch weapons
    warheadMass: 230, // kg TNT; §16, the initial charge (the 303 kg Torpex fill is later)
    settings: [
      { speed: 16.21, range: 8230, label: "31.5 kn long" }, // m/s and m; §16, 9,000 yd
      { speed: 23.66, range: 4115, label: "46 kn short" }, // m/s and m; §16, 4,500 yd
    ],
    runDepth: {
      min: 1.0, // m
      max: 20.0, // m
      bias: 3.2, // m DEEPER than set; §16 cites 3.0-3.4 m (10-11 ft) through mid-1942
      note: "§16: settable by pistol, but in 1942 the weapon ran 3.0-3.4 m deeper than set because the heavier warhead was never recalibrated into the depth mechanism. `bias` is that cited error; the 1-20 m band itself is a GAME APPROXIMATION.",
    },
    armingDistance: 400, // m; GAME APPROXIMATION, see ARMING_PROVENANCE
    reliability: {
      runs: 0.2,
      provenance:
        "GAME APPROXIMATION, but the best-evidenced of the four: §16 cites about 80% of the ~800 torpedoes fired by mid-1942 failing, from three compounding defects (deep running, premature magnetic exploder, sheared contact firing pin). 0.2 is that 80% read as a pass rate, not a per-shot probability any source publishes.",
    },
    release: {
      minAltitude: -TUBE_DEPTH_LIMIT, // m; ./submarine.js FIRING_DEPTH_LIMIT, as a negative altitude
      maxAltitude: 0, // m; the tube cannot be above the surface
      minSpeed: 0, // m/s
      maxSpeed: SUBMERGED_MAX, // m/s; ./submarine.js
    },
    source: "docs/reference-dimensions.md §16 (US Mark 14 submarine torpedo, 1942 service state)",
  },
});

/**
 * Why every `armingDistance` above is a game approximation: docs/reference-dimensions.md records an
 * arming figure only for the depth charge (§17, armed at 3.7-4.6 m depth) and finds no published
 * arming run for any of the four torpedoes. The four values are seeded so that a weapon cannot
 * detonate on the aircraft or boat that launched it, and so a submarine's minimum firing range is a
 * real tactical constraint rather than zero. They are not historical facts.
 */
export const ARMING_PROVENANCE =
  "GAME APPROXIMATION: no cited source gives a torpedo arming run; see docs/reference-dimensions.md §13-§16.";

/** Which torpedo an airframe actually carries. No team test: the airframe is the identity. */
export const TORPEDO_BY_AIRFRAME: Readonly<Record<string, string>> = Object.freeze({
  tbd: "mk13",
  kate: "type91",
});

export class UnknownTorpedoVariantError extends Error {
  constructor(id: string) {
    super(`unknown torpedo variant: ${id}`);
    this.name = "UnknownTorpedoVariantError";
  }
}

export function torpedoVariant(id: string): TorpedoVariant {
  const found = TORPEDO_VARIANTS[id];
  if (!found) throw new UnknownTorpedoVariantError(id);
  return found;
}

/** The variant an airframe drops, or null for an airframe that carries no torpedo. */
export function torpedoVariantForAirframe(airframeId: string | undefined): TorpedoVariant | null {
  const id = TORPEDO_BY_AIRFRAME[airframeId ?? ""];
  return id ? torpedoVariant(id) : null;
}

/**
 * Is this launch legal for this variant? One gate for a drop and a tube shot alike: altitude is
 * metres positive up, so a submarine passes with a negative altitude and an aircraft with a positive
 * one. Speed is the launch platform's, in m/s.
 */
export function releaseLegal(
  variantId: string,
  launch: { altitude: number; speed: number },
): { legal: boolean; problems: string[] } {
  const e = torpedoVariant(variantId).release;
  const problems: string[] = [];
  if (launch.altitude < e.minAltitude) problems.push("TOO LOW");
  if (launch.altitude > e.maxAltitude) problems.push("TOO HIGH");
  if (launch.speed < e.minSpeed) problems.push("TOO SLOW");
  if (launch.speed > e.maxSpeed) problems.push("TOO FAST");
  return { legal: problems.length === 0, problems };
}

/** A weapon that has not run its arming distance strikes without detonating. */
export function torpedoArmed(variantId: string, runDistance: number): boolean {
  return runDistance >= torpedoVariant(variantId).armingDistance;
}

/** The depth the weapon really runs at, which for the Mark 14 is not the depth that was set. */
export function actualRunDepth(variantId: string, setDepth: number): number {
  const d = torpedoVariant(variantId).runDepth;
  return clamp(setDepth, d.min, d.max) + d.bias;
}

// ---------------------------------------------------------------------------------------------
// Gun batteries, by airframe
// ---------------------------------------------------------------------------------------------
//
// Selected by AIRFRAME ID, never by team and never by "is Japanese". A team test is the bug this
// record removes: it gave the Kate a forward-firing gun it never had, and it would hand a player TBD
// the Dauntless battery. `family` is the existing cue key (src/audio.ts WEAPON_CUES) so a mount can
// be sounded without inventing an asset; `caliber` carries the truth about the gun.

export interface GunMount {
  /** A fixed offensive battery, or a flexible defensive position that fires aft. */
  facing: "forward" | "rear";
  /** mm */
  caliber: number;
  /** barrels on this mount */
  count: number;
  /** Cue family key, src/audio.ts: gun50 | gun30 | gun77 | cannon20. */
  family: string;
  /** rounds carried, all barrels on this mount together */
  rounds: number;
  name: string;
}

export interface GunBattery {
  airframe: string;
  displayName: string;
  /** Every mount the airframe has. An airframe with no forward entry has NO forward gun. */
  mounts: GunMount[];
  source: string;
}

export const GUN_BATTERIES: Readonly<Record<string, GunBattery>> = Object.freeze({
  sbd: {
    airframe: "sbd",
    displayName: "SBD-3 Dauntless",
    mounts: [
      { facing: "forward", caliber: 12.7, count: 2, family: "gun50", rounds: 720, name: "Browning M2 cowl pair" },
      { facing: "rear", caliber: 7.62, count: 2, family: "gun30", rounds: 1200, name: "flexible twin Browning" },
    ],
    source:
      "NOT YET IN docs/reference-dimensions.md — that document covers only the TBD (§11) and B5N2 (§12). These are the standard published SBD-3 mounts; the forward .50 pair is also what the game already sounds for the player (gunFamily returns gun50). Needs a cited §18 before it is treated as a measured figure.",
  },
  tbd: {
    airframe: "tbd",
    displayName: "TBD-1 Devastator",
    mounts: [
      // One rifle-calibre cowl gun, not the Dauntless's .50 pair. The 12.7 mm alternative fit is
      // recorded in §11 but the 7.62 mm gun is the June 1942 aircraft.
      { facing: "forward", caliber: 7.62, count: 1, family: "gun30", rounds: 500, name: "starboard cowl Browning" },
      { facing: "rear", caliber: 7.62, count: 1, family: "gun30", rounds: 600, name: "rear-cockpit Browning" },
    ],
    source: "docs/reference-dimensions.md §11 (Douglas TBD-1 Devastator, Armament row)",
  },
  kate: {
    airframe: "kate",
    displayName: "B5N2 Kate",
    mounts: [
      // The only gun on the aircraft. §12 states it explicitly: no forward-firing guns at all.
      { facing: "rear", caliber: 7.7, count: 1, family: "gun77", rounds: 582, name: "Type 92 flexible rear gun" },
    ],
    source:
      "docs/reference-dimensions.md §12 (Nakajima B5N2, Defensive armament): a single flexibly mounted rear-firing 7.7 mm Type 92 with six 97-round drums = 582 rounds, and no forward-firing guns.",
  },
  zero: {
    // The A6M3 Model 32. `zero` is the airframe id the rest of the sim uses (src/sim/battle.ts).
    airframe: "zero",
    displayName: "A6M3 Zero Model 32",
    mounts: [
      { facing: "forward", caliber: 20, count: 2, family: "cannon20", rounds: 200, name: "Type 99 wing cannon" },
      { facing: "forward", caliber: 7.7, count: 2, family: "gun77", rounds: 1160, name: "Type 97 cowl guns" },
    ],
    source:
      "NOT YET IN docs/reference-dimensions.md — see the SBD note. These are the standard published A6M3 Model 32 mounts, and the two families match the cannon20/gun77 alternation the game already emits. Needs a cited §19.",
  },
});

/**
 * Rounds carried by an airframe's rear (defensive) mounts, all mounts together. Zero when the
 * airframe has no rear mount, so a single-seat fighter keeps an empty rear station. Unknown
 * airframes return zero: only the table is a source of truth.
 */
export function rearRoundsFor(airframeId: string): number {
  const battery = GUN_BATTERIES[airframeId];
  if (!battery) return 0;
  let rounds = 0;
  for (const mount of battery.mounts) if (mount.facing === "rear") rounds += mount.rounds;
  return rounds;
}

/**
 * Rounds the gun can hold at once. The supplied rear-cockpit controller's two 120-round belts —
 * a gameplay approximation of the belt feed, not a verified historical capacity (see the PRD).
 */
export const REAR_BELT_LOADED = 240;
/** Seconds a belt change takes, from the same supplied controller; artistic, not a specification. */
export const REAR_RELOAD_SECONDS = 3.6;

/**
 * A fresh gun: the total pool in `rearAmmo`, one combined belt loaded, no belt change running.
 * `rearAmmo` is and stays the whole sortie's reserve; reloading only moves rounds from the reserve
 * into the gun, so the total never changes and no round is ever created.
 */
export function initRearState(a: Any): void {
  a.rearLoaded = Math.min(REAR_BELT_LOADED, a.rearAmmo ?? 0);
  a.rearReloadUntil = 0;
}

/** True while a belt change is in progress at the given shared sim time. */
export function rearReloading(a: Any, now: number): boolean {
  return (a.rearReloadUntil ?? 0) > now;
}

/** Spend one round from both the gun and the sortie total. */
export function spendRearRound(a: Any): void {
  a.rearAmmo = Math.max(0, (a.rearAmmo ?? 0) - 1);
  a.rearLoaded = Math.max(0, (a.rearLoaded ?? 0) - 1);
}

/**
 * Begin a belt change. A full belt is a no-op, and one with nothing in reserve is refused, so an
 * exhausted sortie total can never be reloaded back into existence. Returns whether one started.
 */
export function startRearReload(a: Any, now: number): boolean {
  if (rearReloading(a, now)) return false;
  if ((a.rearLoaded ?? 0) >= REAR_BELT_LOADED) return false;
  if ((a.rearAmmo ?? 0) - (a.rearLoaded ?? 0) <= 0) return false;
  a.rearReloadUntil = now + REAR_RELOAD_SECONDS;
  return true;
}

/** Complete a belt change whose time has come, filling from the same total. Returns whether it did. */
export function advanceRearReload(a: Any, now: number): boolean {
  const until = a.rearReloadUntil ?? 0;
  if (until <= 0 || now < until) return false;
  a.rearReloadUntil = 0;
  a.rearLoaded = Math.min(REAR_BELT_LOADED, a.rearAmmo ?? 0);
  return true;
}

/** Whether the gun can produce a round right now (belt loaded, reserve behind it, no belt change). */
export function rearCanFire(a: Any, now: number): boolean {
  return (a.rearLoaded ?? 0) > 0 && (a.rearAmmo ?? 0) > 0 && !rearReloading(a, now);
}

export class UnknownAirframeGunsError extends Error {
  constructor(id: string) {
    super(`no gun battery recorded for airframe: ${id}`);
    this.name = "UnknownAirframeGunsError";
  }
}

/**
 * The battery an airframe actually carries. Throws rather than defaulting: a silent fallback is how
 * the Kate ended up with a forward gun and how a TBD would inherit the SBD's.
 */
export function gunsFor(airframeId: string): GunBattery {
  const found = GUN_BATTERIES[airframeId];
  if (!found) throw new UnknownAirframeGunsError(airframeId);
  return found;
}
