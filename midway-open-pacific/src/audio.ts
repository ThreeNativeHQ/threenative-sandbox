/**
 * Midway's audio direction, on the engine's portable `AudioBus`.
 *
 * This file owns only the game's choices: which cue, how loud, which perspective and which state
 * triggers it. Voice recycling, the concurrency ceiling, positional panning, distance rolloff,
 * detune and tail cut-off belong to `AudioBus`, and every buffer arrives through `ctx.assets.audio`,
 * so the native build plays exactly what the web does. There is no `window.AudioContext` here.
 *
 * The engine bank is cross-faded between a dry exterior recording and a pilot-seat interior one so
 * switching the camera changes the balance rather than swapping one drone for another. Continuous
 * layers are held and their gains are driven every frame; one-shots go through the bus and are
 * capped by its voice ceiling.
 *
 * Asset provenance, exact generation prompts and hashes live in `content/audio/midway-audio.json`.
 * A cue whose file is missing stays silent, preserves its caption and reports once.
 *
 * `IAudioTarget` is the bus surface this file uses. It is declared structurally — rather than
 * imported — so the game logic is testable in Node under a fake bus and the real `AudioBus` is
 * supplied by the scene. Speech lives in `./speech.js`, which owns the finite script table and the
 * bounded queue; this file only routes `speech` events to it and ducks effects underneath.
 */
import { SpeechQueue, speechSlugList, type ISpeechBus, type ISpeechRequest } from "./speech.js";

type Buffers = ReadonlyMap<string, AudioBuffer>;
type Assets = { audio(path: string): Promise<AudioBuffer> };

interface IVoice {
  gain: { gain: AudioParam };
  source?: unknown;
}

/** The subset of `AudioBus` this game uses. `AudioBus` satisfies it structurally. */
export interface IAudioTarget {
  listener: { context: { currentTime: number } };
  setVolume(volume: number, fade?: number): void;
  play(buffer: AudioBuffer, options?: Record<string, unknown>): IVoice;
  playAt(buffer: AudioBuffer, source: unknown, options?: Record<string, unknown>): IVoice;
  music(buffer: AudioBuffer, options?: Record<string, unknown>): IVoice;
  stopVoice(voice: unknown): boolean;
  readonly voices?: number;
  readonly pooled?: number;
  unlock(): Promise<void>;
  dispose(): void;
}

/**
 * Semantic cue name to packaged file. Only cues with a code consumer are listed; the conditional
 * catalog rows are generated and connected when their trigger exists (PRD "conditional cues are
 * generated only when the game has their listed consumer").
 */
export const CUE_FILES: Record<string, string> = {
  engineExtIdle: "audio/sbd-engine-exterior-idle-01.ogg",
  engineExtCruise: "audio/sbd-engine-exterior-cruise-01.ogg",
  engineExtPower: "audio/sbd-engine-exterior-power-01.ogg",
  engineIntIdle: "audio/sbd-engine-interior-idle-01.ogg",
  engineIntCruise: "audio/sbd-engine-interior-cruise-01.ogg",
  engineIntPower: "audio/sbd-engine-interior-power-01.ogg",
  tbdEngineExtIdle: "audio/tbd-engine-exterior-idle-01.ogg",
  tbdEngineExtCruise: "audio/tbd-engine-exterior-cruise-01.ogg",
  tbdEngineExtPower: "audio/tbd-engine-exterior-power-01.ogg",
  tbdEngineIntIdle: "audio/tbd-engine-interior-idle-01.ogg",
  tbdEngineIntCruise: "audio/tbd-engine-interior-cruise-01.ogg",
  tbdEngineIntPower: "audio/tbd-engine-interior-power-01.ogg",
  wildcatEngineExtIdle: "audio/wildcat-engine-exterior-idle-01.ogg",
  wildcatEngineExtCruise: "audio/wildcat-engine-exterior-cruise-01.ogg",
  wildcatEngineExtPower: "audio/wildcat-engine-exterior-power-01.ogg",
  catalinaEngineExtIdle: "audio/catalina-engine-exterior-idle-01.ogg",
  catalinaEngineExtCruise: "audio/catalina-engine-exterior-cruise-01.ogg",
  catalinaEngineExtPower: "audio/catalina-engine-exterior-power-01.ogg",
  zeroEngineExtIdle: "audio/zero-engine-exterior-idle-01.ogg",
  zeroEngineExtCruise: "audio/zero-engine-exterior-cruise-01.ogg",
  zeroEngineExtPower: "audio/zero-engine-exterior-power-01.ogg",
  valEngineExtIdle: "audio/val-engine-exterior-idle-01.ogg",
  valEngineExtCruise: "audio/val-engine-exterior-cruise-01.ogg",
  valEngineExtPower: "audio/val-engine-exterior-power-01.ogg",
  kateEngineExtIdle: "audio/kate-engine-exterior-idle-01.ogg",
  kateEngineExtCruise: "audio/kate-engine-exterior-cruise-01.ogg",
  kateEngineExtPower: "audio/kate-engine-exterior-power-01.ogg",
  airflowExterior: "audio/airflow-exterior.ogg",
  airflowCockpit: "audio/airflow-cockpit.ogg",
  engineRough: "audio/engine-rough.ogg",
  engineSeize: "audio/engine-seize.ogg",
  propWindmill: "audio/prop-windmill.ogg",
  engineStart: "audio/sbd-engine-start.ogg",
  engineStop: "audio/sbd-engine-stop.ogg",
  tbdEngineStart: "audio/tbd-engine-start.ogg",
  tbdEngineStop: "audio/tbd-engine-stop.ogg",
  diveBrake: "audio/sbd-dive-brake.ogg",
  buffet: "audio/airframe-buffet.ogg",
  cockpitRattle: "audio/cockpit-rattle.ogg",
  gearTravel: "audio/gear-travel.ogg",
  flapTravel: "audio/flap-travel.ogg",
  airframeHit: "audio/airframe-hit.ogg",
  gun50: "audio/gun-50.ogg",
  gun30: "audio/gun-30.ogg",
  gun77: "audio/gun-77.ogg",
  cannon20: "audio/cannon-20.ogg",
  bulletNear: "audio/bullet-near.ogg",
  aaHeavy: "audio/aa-heavy.ogg",
  aa11: "audio/aa-11.ogg",
  aa20: "audio/aa-20.ogg",
  aa25: "audio/aa-25.ogg",
  flakAirburst: "audio/flak-airburst.ogg",
  bombShackle: "audio/bomb-shackle.ogg",
  torpedoRelease: "audio/torpedo-release.ogg",
  bombDeck: "audio/bomb-deck.ogg",
  bombWater: "audio/bomb-water.ogg",
  bombUnderwater: "audio/bomb-underwater.ogg",
  depthCharge: "audio/depth-charge.ogg",
  waterColumnFall: "audio/water-column-fall.ogg",
  torpedoHit: "audio/torpedo-hit.ogg",
  torpedoEntry: "audio/torpedo-entry.ogg",
  aircraftCrash: "audio/aircraft-crash.ogg",
  secondaryBlast: "audio/secondary-blast.ogg",
  steelHit: "audio/steel-hit.ogg",
  hullCollapse: "audio/hull-collapse.ogg",
  waterFragments: "audio/water-fragments.ogg",
  deckRoll: "audio/deck-roll.ogg",
  wireCatch: "audio/wire-catch.ogg",
  deckTouchdown: "audio/deck-touchdown.ogg",
  shipMachinery: "audio/ship-machinery.ogg",
  hullWash: "audio/hull-wash.ogg",
  generalAlarm: "audio/general-alarm.ogg",
  radioKey: "audio/radio-key.ogg",
  radioStatic: "audio/radio-static.ogg",
  oceanWind: "audio/ocean-wind.ogg",
  reefSurf: "audio/reef-surf.ogg",
  fuelFire: "audio/fuel-fire.ogg",
  albatross: "audio/albatross.ogg",
};

/** Japanese and Midway-based engines, and combat: nothing on a US deck at the start plays them. */
const IS_LATE_CUE = /^(catalina|zero|val|kate)Engine|^(gun|cannon|bullet|aa|flak|bomb|depthCharge|waterColumn|torpedo(Hit|Entry)|aircraftCrash|secondaryBlast|steelHit|hullCollapse|waterFragments|airframeHit|engine(Rough|Seize)|fuelFire|generalAlarm)/;
const LATE_CUES = Object.fromEntries(Object.entries(CUE_FILES).filter(([key]) => IS_LATE_CUE.test(key)));
const LAUNCH_CUES = Object.fromEntries(Object.entries(CUE_FILES).filter(([key]) => !IS_LATE_CUE.test(key)));

/** Speech clips, keyed `speech:<slug>`; a missing clip is silent and keeps its caption. */
const SPEECH_FILES: Record<string, string> = Object.fromEntries(
  speechSlugList().map((slug) => [`speech:${slug}`, `audio/voice/${slug}.ogg`]),
);

/** Engine layers, per perspective and operating state. The SBD bank keeps the historic keys. */
const ENGINE_LAYERS = {
  exterior: ["engineExtIdle", "engineExtCruise", "engineExtPower"],
  interior: ["engineIntIdle", "engineIntCruise", "engineIntPower"],
} as const;
/** The TBD bank the player hears when flying the torpedo loadout; AI TBDs reuse the exterior side. */
const TBD_ENGINE_LAYERS = {
  exterior: ["tbdEngineExtIdle", "tbdEngineExtCruise", "tbdEngineExtPower"],
  interior: ["tbdEngineIntIdle", "tbdEngineIntCruise", "tbdEngineIntPower"],
} as const;
const STATE_CENTERS = [0.16, 0.5, 0.9];

/** The listener's state this frame. `cockpit` drives the perspective cross-fade. */
export interface IListenerState {
  cockpit: boolean;
  /** Player airframe id (`sbd` default); selects the SBD vs TBD engine bank. */
  airframe?: string;
  onDeck: boolean;
  /** Within shipboard PA range; gates the `pa` channel only. */
  nearPA?: boolean;
  /** Listener world position, used to schedule acoustic travel time. */
  listener?: { x: number; y: number; z: number };
  deckSpeed?: number;
  engineCut?: boolean;
  damage?: number;
  /** Stall intensity and load factor; they drive the airframe buffeting layer, not a horn. */
  stall?: number;
  gforce?: number;
  rpm: number;
  throttle: number;
  ias: number;
  brakes?: boolean;
}

/**
 * A battle/airframe sound event. Enriched by the simulation with where and what it was, so audio can
 * schedule it by travel time, pan it and choose the right weapon/material identity.
 */
export interface ISoundEvent {
  readonly type?: string;
  /** Airframe selecting an airframe-specific cue (engine start/stop); defaults to SBD. */
  readonly airframe?: string;
  /** Explicit cue override; a weapon family key (`gun50`, `aa25`) or asset key. */
  readonly cue?: string;
  readonly weapon?: string;
  readonly material?: "deck" | "water" | "air" | "steel" | "underwater";
  readonly outcome?: string;
  readonly source?: string;
  readonly at?: { x: number; y: number; z: number };
  readonly vel?: { x: number; y: number; z: number };
  readonly distance?: number;
  readonly request?: ISpeechRequest;
  readonly action?: "start" | "stop" | string;
  readonly wire?: boolean;
  readonly fragments?: boolean;
}

/** A continuous world loop the scene reconciles each frame: ship fire, reef surf at the atoll. */
export interface IEmitterSpec {
  readonly id: string;
  /** Cue key in `CUE_FILES`. */
  readonly key: string;
  /** An `Object3D` to weld to, or a fixed world point. */
  readonly source: unknown;
  readonly volume: number;
}

/** One-shot volume and cooldown by cue family; distance is applied per event. */
const ONE_SHOT: Record<string, { volume: number; cooldown: number; fade?: boolean }> = {
  gun50: { volume: 0.5, cooldown: 0.05 },
  gun30: { volume: 0.45, cooldown: 0.06 },
  gun77: { volume: 0.4, cooldown: 0.06 },
  cannon20: { volume: 0.55, cooldown: 0.08 },
  bulletNear: { volume: 0.4, cooldown: 0.05 },
  aaHeavy: { volume: 0.7, cooldown: 0.1 },
  aa11: { volume: 0.55, cooldown: 0.08 },
  aa20: { volume: 0.5, cooldown: 0.07 },
  aa25: { volume: 0.5, cooldown: 0.07 },
  // A heavy-AA volley bursts several rounds within the same frame, and the cue cooldown is what
  // decides how many of them the pilot hears. Measured at 0.08 s with three bursts 100 m off the
  // wing: one sounded and two were swallowed, so every salvo collapsed to a single pop and flak
  // read as silent. 0.02 s still caps a runaway at 50 voices a second but lets a volley sound
  // like a volley.
  flakAirburst: { volume: 0.7, cooldown: 0.02 },
  bombShackle: { volume: 0.55, cooldown: 0.15 },
  torpedoRelease: { volume: 0.55, cooldown: 0.15 },
  bombDeck: { volume: 0.85, cooldown: 0.05 },
  bombWater: { volume: 0.75, cooldown: 0.05 },
  bombUnderwater: { volume: 0.8, cooldown: 0.05 },
  depthCharge: { volume: 0.85, cooldown: 0.05 },
  waterColumnFall: { volume: 0.5, cooldown: 0.05 },
  torpedoHit: { volume: 0.9, cooldown: 0.05 },
  torpedoEntry: { volume: 0.6, cooldown: 0.1 },
  aircraftCrash: { volume: 0.7, cooldown: 0.1 },
  secondaryBlast: { volume: 0.75, cooldown: 0.1 },
  steelHit: { volume: 0.4, cooldown: 0.05 },
  hullCollapse: { volume: 0.7, cooldown: 0.5 },
  waterFragments: { volume: 0.35, cooldown: 0.06 },
  wireCatch: { volume: 0.7, cooldown: 0.4 },
  deckTouchdown: { volume: 0.6, cooldown: 0.3 },
  airframeHit: { volume: 0.6, cooldown: 0.08 },
  gearTravel: { volume: 0.5, cooldown: 0.5 },
  flapTravel: { volume: 0.45, cooldown: 0.5 },
  engineStart: { volume: 0.6, cooldown: 1 },
  engineStop: { volume: 0.6, cooldown: 1 },
  engineSeize: { volume: 0.8, cooldown: 1 },
  tbdEngineStart: { volume: 0.6, cooldown: 1 },
  tbdEngineStop: { volume: 0.6, cooldown: 1 },
  radioKey: { volume: 0.25, cooldown: 0.2 },
  generalAlarm: { volume: 0.8, cooldown: 3 },
  albatross: { volume: 0.5, cooldown: 8 },
};

/** A simple engineering starting point for acoustic travel time; temperature changes it. */
const SOUND_SPEED = 343;

/**
 * The player's own weapon cue: it sounds at the listener's own ear, not at a world point, so it
 * is neither panned nor distance-attenuated, and it has its own cooldown lane so a distant AI
 * gunner firing the same weapon family can never claim the slot ahead of the player's shot. The
 * value is the flat mix gain; only the player's own trigger uses it.
 */
const OWN_SHOT: Record<string, number> = {
  gun30: 0.8,
};

/**
 * Seconds from a subsurface burst to its water column falling back onto the sea. The plume rises
 * ballistically, so this is a free-fall time, not a mixing choice: a column that tops out around
 * twelve metres is in the air about this long.
 */
const COLUMN_FALL_DELAY = 1.55;

/** Ceiling on simultaneous continuous world emitters; the quietest are culled first. */
const EMITTER_BUDGET = 12;

/** Audio falloff range in metres; past it an event contributes nothing. */
const FALLOFF: Record<string, number> = {
  gun50: 1400,
  gun30: 900,
  gun77: 900,
  cannon20: 1400,
  bulletNear: 250,
  aaHeavy: 9000,
  aa11: 4500,
  aa20: 3200,
  aa25: 3200,
  flakAirburst: 6000,
  bombDeck: 9000,
  bombWater: 6000,
  bombUnderwater: 11000,
  depthCharge: 12000,
  waterColumnFall: 4000,
  torpedoHit: 8000,
  torpedoEntry: 4000,
  aircraftCrash: 5000,
  secondaryBlast: 6000,
  steelHit: 3000,
  hullCollapse: 9000,
  waterFragments: 2500,
  fuelFire: 0,
  reefSurf: 0,
  albatross: 4000,
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Triangular weight around a state centre, so adjacent operating states overlap. */
function stateWeight(rpm: number, center: number): number {
  return Math.max(0, 1 - Math.abs(rpm - center) / 0.42);
}

export class Soundscape {
  /** What `loadLate` streams in after the reveal: speech, plus cues the deck start cannot play. */
  static readonly latePaths = [...Object.values(SPEECH_FILES), ...Object.values(LATE_CUES)];

  /** Load the cues the deck start plays; a missing file is skipped and reported once. */
  static load(assets: Assets): Promise<Buffers> {
    return Soundscape.loadInto(assets, LAUNCH_CUES, new Map());
  }

  /**
   * Add the speech clips and the combat and enemy-engine cues to `buffers` after the reveal: about
   * 7 MB nobody hears on the deck. A cue that fires before its clip lands is silent (a line keeps
   * its caption), exactly as a missing file always was.
   */
  static loadLate(assets: Assets, buffers: Buffers): Promise<Buffers> {
    return Soundscape.loadInto(assets, { ...LATE_CUES, ...SPEECH_FILES }, buffers as Map<string, AudioBuffer>);
  }

  private static async loadInto(assets: Assets, files: Record<string, string>, buffers: Map<string, AudioBuffer>): Promise<Buffers> {
    const entries = await Promise.allSettled(
      Object.entries(files).map(async ([key, path]) => [key, await assets.audio(path)] as const),
    );
    const failed: string[] = [];
    const names = Object.keys(files);
    entries.forEach((result, index) => {
      if (result.status === "fulfilled") buffers.set(result.value[0], result.value[1]);
      else failed.push(`${names[index]}: ${String((result as PromiseRejectedResult).reason).slice(0, 90)}`);
    });
    // Reported only when something failed: the doc comment promised a missing file is reported
    // once, and a per-boot "140 loaded" line is noise the gates had to ignore.
    if (failed.length > 0)
      console.warn(`Audio: ${failed.length} packaged cue(s) failed to load; those cues stay silent: ${failed.slice(0, 12).join("; ")}`);
    return buffers;
  }

  readonly bus: IAudioTarget;
  readonly speech: SpeechQueue;
  readonly buffers: Buffers;
  readonly #speechBus: ISpeechBus | undefined;
  active = false;
  /** Continuous voices, keyed, started at most once and reused every frame. */
  readonly #loops = new Map<string, IVoice>();
  readonly #lastAt = new Map<string, number>();
  #muted = false;
  #paused = false;
  #disposed = false;
  #layersStarted = false;
  #reported = 0;
  #perspective = 0;
  #lastT = 0;
  /** World cues awaiting acoustic arrival, and the listener position they are measured against. */
  #pending: Array<{ cue: string; at: { x: number; y: number; z: number }; emitAt: number; detune: number }> = [];
  #listener = { x: 0, y: 0, z: 0 };
  /** Continuous positional loops (burning ships, reef surf), reconciled against the scene. */
  readonly #emitters = new Map<string, { key: string; voice: IVoice }>();

  constructor(buffers: Buffers, bus: IAudioTarget, speechBus?: ISpeechBus) {
    this.buffers = buffers;
    this.bus = bus;
    this.#speechBus = speechBus;
    this.speech = new SpeechQueue(speechBus ?? (bus as unknown as ISpeechBus), buffers);
  }

  /** True while a spoken line sounds; the scene ducks effects under it. */
  /** Lines the queue has started; a scenario reads it to tell "not requested" from "not audible". */
  get spokenLines(): number {
    return this.speech.spoken;
  }

  get speaking(): boolean {
    return this.speech.speaking;
  }

  /** Live counters for the capture tool and the dev overlay; no voice handles leak out. */
  debug(): {
    active: boolean;
    speaking: boolean;
    paused: boolean;
    muted: boolean;
    spoken: number;
    queued: number;
    perspective: number;
    emitters: number;
    pending: number;
    layers: number;
    buffers: number;
    voices: number;
    pooled: number;
    layerGains: Record<string, number>;
  } {
    const layerGains: Record<string, number> = {};
    for (const [key, voice] of this.#loops) layerGains[key] = Number(voice.gain.gain.value.toFixed(4));
    return {
      active: this.active,
      speaking: this.speaking,
      paused: this.#paused,
      muted: this.#muted,
      spoken: this.speech.spoken,
      queued: this.speech.queued,
      perspective: this.#perspective,
      emitters: this.#emitters.size,
      pending: this.#pending.length,
      layers: this.#loops.size,
      buffers: this.buffers.size,
      voices: this.bus.voices ?? 0,
      pooled: this.bus.pooled ?? 0,
      layerGains,
    };
  }

  get muted(): boolean {
    return this.#muted;
  }

  set muted(v: boolean) {
    this.#muted = v;
    this.bus.setVolume(v || this.#paused ? 0 : 0.6, 0.04);
  }

  /** Safe to call on every gesture: the buses unlock themselves, this is only a nudge. */
  start(): void {
    void this.bus.unlock().catch(() => undefined);
    void this.#speechBus?.unlock?.().catch(() => undefined);
  }

  /** Starts the continuous layers once; a missing buffer simply leaves that layer out. */
  #startLayers(): void {
    if (this.#layersStarted) return;
    this.#layersStarted = true;
    this.active = true;
    const start = (key: string, volume: number) => {
      const buffer = this.buffers.get(key);
      if (!buffer) return;
      this.#loops.set(key, this.bus.music(buffer, { loop: true, volume, fade: 0.2 }));
    };
    for (const key of [...ENGINE_LAYERS.exterior, ...ENGINE_LAYERS.interior, ...TBD_ENGINE_LAYERS.exterior, ...TBD_ENGINE_LAYERS.interior]) start(key, 0);
    start("airflowExterior", 0);
    start("airflowCockpit", 0);
    start("engineRough", 0);
    start("propWindmill", 0);
    start("buffet", 0);
    start("deckRoll", 0);
    start("shipMachinery", 0);
    start("hullWash", 0);
    start("radioStatic", 0);
    start("oceanWind", 0);
    start("diveBrake", 0);
    start("cockpitRattle", 0);
  }

  /** Drive every continuous layer's gain and pitch from the listener's real state. */
  update(p: IListenerState, paused: boolean, dt = 1 / 60): void {
    if (this.#disposed) return;
    this.#startLayers();
    const now = this.bus.listener.context.currentTime;
    this.#lastT = now;
    this.#paused = paused;
    if (p.listener) this.#listener = { x: p.listener.x, y: p.listener.y, z: p.listener.z };
    // Duck effects 4 dB under speech so a warning is legible; the speech bus is untouched.
    const level = this.#muted || paused ? 0 : this.speaking ? 0.38 : 0.6;
    this.bus.setVolume(level, 0.08);
    this.speech.update(dt, paused, p.nearPA ?? p.onDeck, this.#muted);
    // A paused world freezes pending cues; shift their clock so resume does not dump a backlog.
    if (paused) for (const q of this.#pending) q.emitAt += dt;
    else this.#flush();
    // Perspective ramps over ~150 ms; the same engine phase keeps running underneath.
    const target = p.cockpit ? 1 : 0;
    this.#perspective += (target - this.#perspective) * (1 - Math.exp(-dt / 0.15));
    const inside = this.#perspective;
    const rpm = p.rpm ?? p.throttle ?? 0;
    const dead = !!p.engineCut;
    const rough = clamp01(p.damage ?? 0);
    // The flyable Douglas bank follows the loadout: SBD by default, TBD on the torpedo loadout.
    const banks = p.airframe === "tbd" ? TBD_ENGINE_LAYERS : ENGINE_LAYERS;
    const idleBanks = p.airframe === "tbd" ? ENGINE_LAYERS : TBD_ENGINE_LAYERS;
    for (const [perspective, keys] of Object.entries(banks) as Array<[string, readonly string[]]>) {
      const side = perspective === "interior" ? inside : 1 - inside;
      keys.forEach((key, i) => {
        const weight = (dead ? 0 : side * stateWeight(rpm, STATE_CENTERS[i] ?? 0.5)) * (1 - rough * 0.7);
        this.#setGain(key, weight * 0.9, 0.18);
        this.#setRate(key, 0.78 + rpm * 0.5, 0.2);
      });
    }
    // The parked bank stays silent so switching airframes never doubles the engine.
    for (const keys of Object.values(idleBanks)) for (const key of keys) this.#setGain(key, 0, 0.18);
    this.#setGain("engineRough", dead ? 0 : rough * 0.8, 0.25);
    this.#setGain("propWindmill", dead && (p.ias ?? 0) > 30 ? 0.7 : 0, 0.25);
    // Buffeting is the honest replacement for a modern stall horn: it rises with stall and load.
    const buffet = Math.min(1, (p.stall ?? 0) * 0.45 + Math.max(0, Math.abs(p.gforce ?? 1) - 4) * 0.08);
    this.#setGain("buffet", buffet * 0.6, 0.2);
    // Slipstream tracks airspeed, not power: it is what a dead-stick dive still sounds like.
    const wind = Math.min(1, ((p.ias ?? 0) / 150) ** 1.5);
    this.#setGain("airflowCockpit", wind * inside * 0.5, 0.25);
    this.#setGain("airflowExterior", wind * (1 - inside) * 0.4, 0.25);
    const diveBrake = p.brakes ? Math.min(1, ((p.ias ?? 0) / 130) ** 1.2) * 0.7 : 0;
    this.#setGain("diveBrake", diveBrake, 0.2);
    const rattle = inside * Math.min(1, rough * 0.45 + buffet * 0.45 + rpm * 0.15);
    this.#setGain("cockpitRattle", rattle * 0.35, 0.2);
    const deck = p.onDeck ? Math.min(1, (p.deckSpeed ?? 0) / 40) * (1 - inside * 0.5) : 0;
    this.#setGain("deckRoll", deck * 0.7, 0.2);
    this.#setGain("shipMachinery", p.onDeck ? 0.35 * (1 - inside) : 0, 0.5);
    this.#setGain("hullWash", p.onDeck ? 0.25 * (1 - inside) : 0, 0.5);
    this.#setGain("oceanWind", (1 - inside) * 0.12, 0.6);
    this.#setGain("radioStatic", this.speaking ? 0.15 : 0, 0.1);
    if (this.#reported === 0 && !this.buffers.size) {
      this.#reported = Date.now();
      console.info("Audio: no packaged cues loaded; running silent and preserving captions.");
    }
  }

  #setGain(key: string, value: number, tau: number): void {
    const voice = this.#loops.get(key);
    if (!voice) return;
    voice.gain.gain.setTargetAtTime?.(value, this.#lastT, tau);
  }

  #setRate(key: string, value: number, tau: number): void {
    const voice = this.#loops.get(key);
    const param = (voice?.source as { playbackRate?: AudioParam } | null | undefined)?.playbackRate;
    param?.setTargetAtTime?.(value, this.#lastT, tau);
  }

  /** One-shot cue with the family's cooldown and distance falloff; missing buffers stay quiet. */
  #play(key: string, attenuation = 1, lane = "", ownVolume?: number): boolean {
    if (this.#disposed || this.#muted || this.#paused) return false;
    const buffer = this.buffers.get(key);
    const tune = ONE_SHOT[key];
    if (!buffer || !tune || attenuation <= 0.01) return false;
    const now = this.bus.listener.context.currentTime;
    const clock = lane + key;
    if (now - (this.#lastAt.get(clock) ?? -Infinity) < tune.cooldown) return true;
    this.#lastAt.set(clock, now);
    this.bus.play(buffer, { volume: (ownVolume ?? tune.volume) * attenuation, fade: tune.fade ? 0.05 : undefined });
    return true;
  }

  /** A one-shot at a world point: the panner carries the distance and direction. */
  #playAt(key: string, at: { x: number; y: number; z: number }, detune = 0): boolean {
    if (this.#disposed || this.#muted || this.#paused) return false;
    const buffer = this.buffers.get(key);
    const tune = ONE_SHOT[key];
    if (!buffer || !tune) return false;
    const attenuation = Math.max(0, 1 - this.#distance(at) / (FALLOFF[key] ?? 1));
    if (attenuation <= 0.01) return false;
    const now = this.bus.listener.context.currentTime;
    if (now - (this.#lastAt.get(key) ?? -Infinity) < tune.cooldown) return true;
    this.#lastAt.set(key, now);
    this.bus.playAt(buffer, { x: at.x, y: at.y, z: at.z } as never, {
      volume: tune.volume * attenuation,
      refDistance: 60,
      rolloffFactor: 0.7,
      detune,
    });
    return true;
  }

  /** The cue a sound event maps to, or undefined when it has no shipped sample. */
  #cueFor(e: ISoundEvent): string | undefined {
    switch (e.type) {
      case "gun":
        return e.weapon ?? "gun50";
      case "aa":
        return e.weapon || undefined;
      case "flak":
        return "flakAirburst";
      case "bulletNear":
        return "bulletNear";
      case "gear":
        return "gearTravel";
      case "flap":
        return "flapTravel";
      case "wire":
        return "wireCatch";
      case "engine": {
        const tbd = e.airframe === "tbd";
        return e.action === "stop" ? (tbd ? "tbdEngineStop" : "engineStop") : tbd ? "tbdEngineStart" : "engineStart";
      }
      case "engineStart":
        return e.airframe === "tbd" ? "tbdEngineStart" : "engineStart";
      case "engineStop":
        return e.airframe === "tbd" ? "tbdEngineStop" : "engineStop";
      case "depthCharge":
        return "depthCharge";
      case "collapse":
        return "hullCollapse";
      case "secondary":
        return "secondaryBlast";
      case "explosion":
        if (e.outcome === "secondary") return "secondaryBlast";
        if (e.outcome === "collapse") return "hullCollapse";
        if (e.outcome === "depthCharge") return "depthCharge";
        if (e.material === "underwater") return "bombUnderwater";
        if (e.material === "water") return "bombWater";
        if (e.material === "air") return "aircraftCrash";
        if (e.outcome === "torpedo") return "torpedoHit";
        return "bombDeck";
      case "splash":
        if (e.fragments) return "waterFragments";
        if (e.outcome === "torpedoEntry" || e.weapon === "torpedo") return "torpedoEntry";
        // A bomb fused to burst below the surface is heard through the water, not through the air:
        // the crack is filtered off and what arrives is a deep whump well ahead of the plume.
        return e.material === "underwater" ? "bombUnderwater" : "bombWater";
      case "torpedoEntry":
        return "torpedoEntry";
      case "bomb":
        return e.weapon === "torpedo" ? "torpedoRelease" : "bombShackle";
      case "damage":
        return e.material === "steel" ? "steelHit" : "airframeHit";
      case "hit":
        return e.material === "steel" ? "steelHit" : "airframeHit";
      case "steelHit":
        return "steelHit";
      case "radio":
        return "radioKey";
      case "land":
        return e.wire ? "wireCatch" : "deckTouchdown";
      case "alarm":
        return "generalAlarm";
      default:
        return e.cue;
    }
  }

  #distance(at: { x: number; y: number; z: number }): number {
    const l = this.#listener;
    return Math.hypot(at.x - l.x, at.y - l.y, at.z - l.z);
  }

  /**
   * Restrained Doppler from the source's real radial velocity. The pilot never hears their own
   * engine or headset shifted, so only world events with a velocity carry it. A few dozen cents is
   * a passing aeroplane; the full ±1200 is a laboratory siren.
   */
  #doppler(e: ISoundEvent, at: { x: number; y: number; z: number }): number {
    if (!e.vel) return 0;
    const dx = at.x - this.#listener.x;
    const dy = at.y - this.#listener.y;
    const dz = at.z - this.#listener.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const radial = (e.vel.x * dx + e.vel.y * dy + e.vel.z * dz) / len;
    return Math.max(-60, Math.min(60, (-radial / SOUND_SPEED) * 1200 * 0.3));
  }

  /**
   * One battle/airframe event. A world event is scheduled by acoustic travel time from its position
   * and re-evaluated against the listener's motion each frame; a local/headset cue sounds at once.
   */
  event(e: ISoundEvent): void {
    if (e.type === "speech") {
      if (e.request) this.speak(e.request);
      return;
    }
    const cue = this.#cueFor(e);
    if (!cue) return;
    if (!e.at) {
      const d = typeof e.distance === "number" ? e.distance : 0;
      const own = OWN_SHOT[cue];
      this.#play(cue, Math.max(0, 1 - d / (FALLOFF[cue] ?? 1)), own === undefined ? "" : "own:", own);
      return;
    }
    const at = { x: e.at.x, y: e.at.y, z: e.at.z };
    const now = this.bus.listener.context.currentTime;
    this.#pending.push({ cue, at, emitAt: now, detune: this.#doppler(e, at) });
    // A subsurface burst is two sounds, not one. The concussion arrives first, through the water;
    // the column it threw up is still climbing, and only lands a second and a half later. Both are
    // scheduled on the same queue, so both still carry their own acoustic travel time to the ear.
    if (e.material === "underwater")
      this.#pending.push({ cue: "waterColumnFall", at, emitAt: now + COLUMN_FALL_DELAY, detune: 0 });
    if (this.#pending.length > 96) this.#pending.shift();
  }

  /** Sound every pending world cue whose travel time has elapsed at the listener's current range. */
  #flush(): void {
    if (!this.#pending.length) return;
    const now = this.bus.listener.context.currentTime;
    this.#pending = this.#pending.filter((p) => {
      if (now - p.emitAt < this.#distance(p.at) / SOUND_SPEED) return true;
      this.#playAt(p.cue, p.at, p.detune);
      return false;
    });
  }

  /** Offer a friendly line to the bounded speech queue. */
  speak(request: ISpeechRequest): boolean {
    return this.speech.request(request);
  }

  /**
   * Reconcile the continuous positional loops against the scene's current state. Called every frame
   * with the complete desired set; a loop that is no longer wanted is stopped, one already playing
   * only has its gain retargeted, and a missing cue is silently absent.
   */
  syncEmitters(specs: readonly IEmitterSpec[]): void {
    if (this.#disposed) return;
    // At most 12 continuous world emitters (PRD mix target). Cull the quietest, which are the
    // farthest; the player's own engine is a layer, not an emitter, and is never culled here.
    const wanted = specs.length > EMITTER_BUDGET ? [...specs].sort((a, b) => b.volume - a.volume).slice(0, EMITTER_BUDGET) : specs;
    const now = this.bus.listener.context.currentTime;
    const keep = new Set(wanted.map((s) => s.id));
    for (const [id, entry] of [...this.#emitters]) {
      if (keep.has(id)) continue;
      this.bus.stopVoice(entry.voice);
      this.#emitters.delete(id);
    }
    for (const spec of wanted) {
      const buffer = this.buffers.get(spec.key);
      if (!buffer) continue;
      const existing = this.#emitters.get(spec.id);
      if (existing && existing.key === spec.key) {
        existing.voice.gain.gain.setTargetAtTime?.(spec.volume, now, 0.35);
        continue;
      }
      if (existing) {
        this.bus.stopVoice(existing.voice);
        this.#emitters.delete(spec.id);
      }
      const voice = this.bus.playAt(buffer, spec.source, { loop: true, volume: spec.volume, fade: 0.5, refDistance: 80, rolloffFactor: 0.8 });
      this.#emitters.set(spec.id, { key: spec.key, voice });
    }
  }

  /** Stops every voice and closes the buses. Safe to call twice. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.active = false;
    this.#loops.clear();
    this.#lastAt.clear();
    this.#pending = [];
    for (const entry of this.#emitters.values()) this.bus.stopVoice(entry.voice);
    this.#emitters.clear();
    this.speech.dispose();
    if (this.#speechBus && (this.#speechBus as unknown) !== (this.bus as unknown)) this.#speechBus.dispose();
    this.bus.dispose();
  }
}
