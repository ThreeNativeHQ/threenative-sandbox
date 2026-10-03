import { Scene, exposeDebug, onLaunchFailure } from "@threenative/core";
import { AudioBus } from "@threenative/core";
import { Vector3 } from "three";
import type { ICtx } from "@threenative/core";
import type * as T from "three";
import { Battle } from "../sim/battle.js";
import { LOADOUTS } from "../sim/armament.js";
import { ASSIGNMENTS, type Assignment } from "../sim/sortie.js";
import { clamp, distance2 } from "../sim/math.js";
import { loadImportedShips } from "../render/imported-ships.js";
import { loadEnvironment } from "../render/environment.js";
import { loadImportedAircraft } from "../render/imported-aircraft.js";
import { loadImportedFleet, loadImportedHulls } from "../render/imported-fleet.js";
import { loadDeckCrew } from "../render/deck-crew.js";
import { WorldView } from "../render/world.js";
import { nullShell, shell, type IHud, type Intent } from "../ui/port.js";
import type { IHudSnapshot, IUiSnapshot } from "../ui/state.js";
import { Soundscape } from "../audio.js";

/**
 * What the game publishes about itself.
 *
 * Small on purpose: it is the only thing a UI that does not share memory with the simulation can
 * read — a native HUD, or a playtest asserting that the aircraft actually left the deck.
 */
export type GameState = {
  /** The native web view mirrors these into the real HUD markup; the web build owns its own DOM. */
  ui?: IUiSnapshot;
  hud?: IHudSnapshot;
  status: string;
  mode: string;
  altitude: number;
  ias: number;
  throttle: number;
  airborne: boolean;
  /** Live smoke+glow particles. Zero while a target renders them is a native parity failure. */
  particles: number;
  /** Why the airframe was lost, so a scenario can tell the loss paths apart. */
  crashReason: string;
  /** Lines the speech queue actually started; zero with radio lines present is a silent voice path. */
  spoken: number;
  /** Lines the radio script wrote, spoken or not. */
  radioLines: number;
  /** Explosion bursts actually rendered. A native regression that drops the blast shows here. */
  explosions: number;
  /** Muzzle-flash bursts actually rendered, so a gun test proves the flash, not just the shot. */
  muzzle: number;
  /** Water-impact bursts actually rendered: the effect a released bomb's miss produces. */
  splashes: number;
  /**
   * Existing `WaterEffects` counters, exposed read-only so a native effects gate can prove the
   * whitewater solver accepted an impact rather than only that the request was queued.
   */
  waterAccepted: number;
  waterRejected: number;
  /** Bombs left on the rack, so a release test proves a weapon actually left the aircraft. */
  ordnance: number;
  /**
   * `battle.approach().ready` — the single assisted-final gate `finalReady` that `assistRecovery`
   * and the HUD's "READY FOR L" cue both read. Exposed read-only so a scenario can time the real
   * KeyL press from the game's own gate instead of guessing a duration.
   */
  recoveryReady: boolean;
  /**
   * The UI layer has a peer and has rendered at least once.
   *
   * `ctx.state.flush()` alone is not proof the HUD is alive: a native overlay attaches, subscribes
   * and stays blank until the page reports ready. This is that report, so a scenario can assert the
   * web view is really up rather than that the process booted.
   */
  uiReady: boolean;
};

/**
 * Every key `action` reacts to, bound by name so the framework latches the press.
 *
 * A one-shot key has to survive a keydown and keyup that land in the same task — which is exactly
 * what a scripted run does — and only `justPressed` sees that. Continuous controls (throttle,
 * stick, guns, transit) are read as held keys instead, because a hold is what they mean.
 */
export const ACTION_KEYS = [
  "Escape", "KeyP", "Slash", "KeyM", "KeyQ", "Tab", "Enter",
  "KeyB", "KeyF", "KeyG", "KeyN", "KeyU", "KeyI", "KeyR", "KeyT", "KeyH", "KeyL", "KeyJ", "KeyY",
  "BracketLeft", "BracketRight",
  "KeyC", "KeyO", "F1", "F2", "F3", "F4",
  "Digit1", "Digit2", "Digit3", "Digit4",
] as const;

/** The same codes as framework actions, so `input.justPressed` can latch each one. */
export const ACTION_BINDINGS = Object.fromEntries(
  ACTION_KEYS.map((code) => [code, { keys: [code] }]),
) as Record<string, { keys: string[] }>;

export class Midway extends Scene<GameState, undefined> {
  static override readonly initialState: GameState = {
    status: "briefing",
    mode: "deck",
    altitude: 0,
    crashReason: "",
    spoken: 0,
    radioLines: 0,
    ias: 0,
    throttle: 0,
    airborne: false,
    particles: 0,
    explosions: 0,
    muzzle: 0,
    splashes: 0,
    waterAccepted: 0,
    waterRejected: 0,
    ordnance: 0,
    recoveryReady: false,
    uiReady: false,
  };

  battle!: Battle;
  world!: WorldView;
  hud!: IHud;
  audio!: Soundscape;
  ctx!: ICtx<GameState, undefined>;
  paused = false;
  overlay: string | null = null;
  wall = 0;
  ended = false;
  private crashCam = false;
  started = false;
  /** Last tick's simulation-step time, for the slow-tick line. */
  private tickTimes = { step: 0, world: 0 };
  /**
   * Fixed-step time accumulated since the last drawn frame, handed to the once-per-frame
   * `WorldView.update`. The battle and the HUD still step per fixed tick; the render-side world
   * animation only needs the total time the frame covered, and running it once per frame is what
   * keeps a catch-up frame (up to five ticks) from updating the whole scene five times.
   */
  private worldDt = 0;
  private publishTick = 0;
  private mouseState = { fire: false, looking: false, lockClick: false, lx: 0, ly: 0 };
  /**
   * Live pointer view for capture tools. `fire`/`looking` are computed from the framework pointer
   * rather than the last polled frame, so a button release reads false in the same turn the tool
   * asserts it — the old window listener cleared these synchronously and the tools depend on it.
   */
  get mouse(): { fire: boolean; looking: boolean; lockClick: boolean; lx: number; ly: number } {
    const buttons = this.ctx?.input?.raw?.pointer?.buttons ?? 0;
    const live = this.battle?.status === "playing" && !this.paused;
    const looking = live && (buttons & 2) !== 0 && !this.battle?.player?.gunner;
    const blocked = this.battle?.player?.gunner === true
      && (!this.ctx?.input?.raw?.pointer?.captured || this.mouseState.lockClick);
    return {
      fire: live && (buttons & 1) !== 0 && !blocked,
      looking,
      lockClick: this.mouseState.lockClick,
      lx: this.mouseState.lx,
      ly: this.mouseState.ly,
    };
  }
  /** The held keys the scene is acting on; exposed because capture tools read `midway.keys`. */
  get keys(): ReadonlySet<string> {
    return this.ctx?.input?.raw?.keys ?? new Set<string>();
  }
  /** Set only from the engine's real lock state; it is the latch that turns an Esc unlock into a pause. */
  private wasCaptured = false;
  /** Briefing selection, kept on the scene so it survives a restart into a fresh Battle. */
  assignment: Assignment = "strike";
  private audioBuffers: ReadonlyMap<string, AudioBuffer> = new Map();
  private camPos = new Vector3();
  private nextAlbatross = 0;
  private cleanups: Array<() => void> = [];
  private stopReporting: () => void = () => {};

  /**
   * Keep the loading layer honest while the launch runs: the engine's own byte-weighted
   * `startup.progress` drives the bar, and its in-flight ledger names the file being loaded. A
   * launch the engine gives up on (stalled, or a lost GPU device) replaces both with the message
   * and the copy button — a loading screen that hangs with no text is a bug report nobody can file.
   *
   * On a timer rather than per frame on purpose: this launch renders about one frame a second
   * while the models decode, and a per-frame pump would update the bar exactly that often.
   */
  /**
   * What the launch is doing right now, in the player's words.
   *
   * Naming the outstanding asset is only right while there is one. Measured on this desktop: every
   * asset settles 5.6 s in and the world is not ready until 24 s, so a label that only ever names
   * an asset spends three quarters of the launch showing the last file that happened to be in
   * flight — which is exactly how "68% — weapon.torpedo.glb" reads as frozen.
   */
  private launchLabel(ctx: ICtx<GameState, undefined>): string {
    const [loading] = ctx.assets.progress.pending;
    if (loading !== undefined) return loading;
    if (!ctx.startup.compileSettled) return "Compiling shaders for the Pacific…";
    return "Warming up the first frames…";
  }

  private reportLaunch(ctx: ICtx<GameState, undefined>): () => void {
    let failure: string | undefined;
    const offFailure = onLaunchFailure((reported) => {
      failure = reported.message;
    });
    const publish = (): void => {
      shell.loading({
        ...(failure === undefined ? {} : { failure }),
        label: failure === undefined ? this.launchLabel(ctx) : "The launch stopped.",
        progress: ctx.startup.progress,
      });
    };
    publish();
    const timer = setInterval(publish, 250);
    return () => {
      clearInterval(timer);
      offFailure();
    };
  }

  async load(ctx: ICtx<GameState, undefined>): Promise<void> {
    const stopReporting = this.reportLaunch(ctx);
    const timed = async <R>(label: string, work: Promise<R>): Promise<R> => {
      const began = performance.now();
      const value = await work;
      console.log(`TN_LOAD_STEP:{"label":"${label}","ms":${(performance.now() - began).toFixed(1)}}`);
      return value;
    };
    const [, , , , , , buffers] = await Promise.all([
      timed("aircraft", loadImportedAircraft(ctx)),
      timed("ships", loadImportedShips(ctx)),
      timed("fleet", loadImportedFleet(ctx)),
      // The imported hulls the fleet is built from — Yorktown, the three Japanese carriers, the
      // cruisers, destroyers and submarines. Their sizes come from src/sim/catalog.ts, which
      // `Battle` has already read; this only brings in the geometry to draw them with.
      timed("hulls", loadImportedHulls(ctx)),
      timed("deck-crew", loadDeckCrew(ctx)),
      timed("environment", loadEnvironment(ctx)),
      timed("audio", Soundscape.load(ctx.assets)),
    ]);
    this.audioBuffers = buffers;
    this.stopReporting = stopReporting;
    console.log(`TN_LOAD_STEP:{"label":"scene-load-total","ms":${performance.now().toFixed(1)}}`);
    // Keep the opaque loading layer up until the first update has built the world and placed the
    // camera; hiding it here showed a few frames of an unlit, half-built scene.
  }

  enter(ctx: ICtx<GameState, undefined>): void {
    this.ctx = ctx;
    /**
     * Publish this scene for the capture scripts, in dev builds only. A script that needed the
     * scene used to re-`import()` `/src/game.ts` and walk the resource timeline for the module URL
     * the dev server already had — the same twenty-odd lines per script, and a second module
     * instance whenever that URL resolved to another copy. The engine puts the handle where a page
     * script reads it: `window.__THREENATIVE__.debug.scene`. A production build publishes nothing.
     */
    exposeDebug("scene", this);
    this.battle = new Battle();
    this.world = new WorldView({ scene: ctx.scene, camera: ctx.camera as T.PerspectiveCamera, renderer: ctx.renderer, viewport: ctx.viewport, add: (object) => ctx.add(object) }, this.battle);
    // The render-side world updates once per DRAWN frame, not once per fixed tick. `battle.step`
    // and every event consumer still run per tick; the world's own animation, placement and camera
    // read the accumulated fixed time here, so a catch-up frame that steps five times still
    // positions and animates the scene once. Registered before the particle packing and the matrix
    // walk below, which both read the camera and transforms this leaves behind.
    this.cleanups.push(
      ctx.beforeRender(() => {
        const began = performance.now();
        this.world.update(this.paused ? 0 : this.worldDt, this.wall, this.battle.status === "briefing");
        this.worldDt = 0;
        this.tickTimes.world = performance.now() - began;
        shell.cockpitView(this.world.cockpitView);
      }),
    );
    // The combat particle buffers are repacked for the camera once per actual world draw. The
    // engine's own beforeRender phase keeps the packing off the particle meshes: an own mesh
    // onBeforeRender marks the whole scene un-batchable at the full roster.
    this.cleanups.push(ctx.beforeRender(() => this.world.particles.prepare(this.world.camera.position)));
    // World transforms are the engine's walk: it sets `matrixWorldAutoUpdate = false` on the scene
    // at construction and runs `MatrixWorldPass` over the draw root each frame, which is the same
    // visible-only pass this game used to own — a hidden subtree is not recursed into, a class that
    // overrides `updateMatrixWorld` runs its own, and a hidden node holding a Bone is walked whole.
    // So this scene registers no second pass; `renderer.matrixWorld: "all"` is the named override
    // that restores three's every-node walk.
    this.hud = shell.hud(this.battle, this.world);
    // HUD state, timers and input feedback update on every fixed simulation tick; the canvas is
    // drawn once per presented frame from the latest state. `hud.update` used to clear and redraw
    // here for every fixed tick, so catch-up ticks repainted states that were never presented.
    this.cleanups.push(ctx.beforeRender(() => this.hud.draw()));
    this.audio = new Soundscape(
      this.audioBuffers,
      new AudioBus({ camera: ctx.camera, maxVoices: 48 }),
      new AudioBus({ camera: ctx.camera, maxVoices: 16 }),
    );
    this.cleanups.push(shell.onIntent((intent) => this.intent(intent)));
    this.updateLoadoutUI();
    this.updateAssignmentUI();
    shell.screen("flight", false);
    // The fleet warm-up — every hull compiled and one hidden render over the shadow and mirrored
    // passes — runs behind the loading screen now, not behind the briefing: the engine's readiness
    // gate waits on it, so the pipelines the first minutes of flight need exist before the world is
    // shown. The player's own view subtrees stay on the briefing's idle time (their compile is tens
    // of seconds on a loaded host, and holding it would put that in front of the world).
    const startup = ctx.startup as { hold?: (label: string, work: Promise<unknown>, budgetMs?: number) => void };
    const held = typeof startup.hold === "function";
    if (held) startup.hold!("midway-warm-passes", Promise.resolve().then(() => this.world.warmUpViews()), 45000);
    console.log(`TN_LOAD_STEP:{"label":"enter","ms":${performance.now().toFixed(1)}}`);
    void ctx.startup.whenReady().then(() => {
      this.stopReporting();
      console.log(`TN_LOAD_STEP:{"label":"ready","ms":${performance.now().toFixed(1)}}`);
      this.started = true;
      shell.screen("loading", false);
      if (this.battle.status === "briefing") {
        // Nothing on a native target can click "take the deck", so the sortie starts itself.
        if (shell === nullShell) this.begin(false);
        else shell.screen("briefing", true);
      }
      // Without a startup hold the whole warm-up is scheduled here; with one the gate above
      // already ran the fleet half and the player-view half is chained off it. Deferred past a
      // task boundary on purpose: the briefing was just made visible, and the player-view warm-up
      // opens with a synchronous build (the rear station, ~1 s of procedural texture and geometry)
      // that would otherwise land between `screen("briefing", true)` and the browser's next chance
      // to paint it. Measured: 2.7 s between this handler and the intro screen appearing, for work
      // the player never sees.
      if (!held) setTimeout(() => void this.world.warmUpViews(), 0);
    });
  }

  exit(): void {
    this.ctx.input.releaseMouse();
    this.audio.dispose();
    this.world.crew.dispose();
    this.world.ripples.dispose();
    this.world.ocean.dispose();
    this.world.particles.dispose();
    for (const off of this.cleanups) off();
    this.cleanups = [];
    this.clearInput();
  }

  /** One switch for everything the player asks for, whatever surface asked it. */
  private intent(intent: Intent): void {
    switch (intent.kind) {
      case "begin":
        // A fresh deck start taken from the debrief continues the operation from the carrier
        // rather than resetting the battle (upstream af5caac, where the DOM button did this).
        if (!intent.airborne && intent.fresh && this.battle.status === "debrief") this.continueOnDeck();
        else this.begin(intent.airborne, intent.fresh);
        break;
      case "briefing":
        this.restartToBriefing();
        break;
      case "key":
        this.action(intent.code);
        break;
      case "resume":
        this.resume();
        break;
      case "overlay":
        this.showOverlay(intent.id);
        break;
      case "loadout":
        this.selectLoadout(intent.id);
        break;
      case "assignment":
        this.selectAssignment(intent.id);
        break;
      case "quality":
        this.world.setQuality(intent.id);
        break;
      case "command":
        this.command(intent.id);
        break;
      case "target":
        this.designateTarget(intent.id);
        break;
      case "take-aircraft":
        this.takeAnotherAircraft();
        break;
      case "home":
        this.goHome();
        this.hideOverlays();
        break;
      case "audio":
        this.audio.start();
        this.audio.muted = !this.audio.muted;
        break;
      case "suspend":
        this.clearInput();
        if (this.battle.status === "playing" && !this.paused) this.showOverlay("pause-overlay");
        break;
    }
  }

  /**
   * Reads this frame's input from the framework rather than the window.
   *
   * `ctx.input` is the one surface the desktop and playtest transports can drive, so the keyboard
   * and mouse work identically in a browser, in a native window and under a scripted run.
   */
  private pollInput(): { keys: ReadonlySet<string>; fire: boolean } {
    const input = this.ctx.input;
    for (const code of ACTION_KEYS) if (input.justPressed(code)) this.action(code);
    const raw = input.raw;
    const live = this.battle.status === "playing" && !this.paused;
    const gunner = this.battle.player.gunner === true;
    const down = (raw.pointer.buttons & 1) !== 0;
    // On the gun the first press only takes the pointer lock; that press never fires.
    if (live && gunner && down && !raw.pointer.captured) {
      if (!this.mouseState.lockClick) {
        this.mouseState.lockClick = true;
        this.ctx.input.captureMouse();
      }
    } else if (!down) this.mouseState.lockClick = false;
    const looking = live && !gunner && (raw.pointer.buttons & 2) !== 0;
    const blocked = gunner && (!raw.pointer.captured || this.mouseState.lockClick);
    const fire = live && down && !blocked;
    if (fire && !this.mouseState.fire) this.audio.start();
    const { x, y } = raw.pointer.position;
    if (looking && this.mouseState.looking) {
      // Right-drag free-looks from the cockpit; the pilot's view is otherwise unchanged.
      this.world.lookYaw = clamp((this.world.lookYaw || 0) + (x - this.mouseState.lx) * 0.005, -2.7, 2.7);
      this.world.lookPitch = clamp((this.world.lookPitch || 0) - (y - this.mouseState.ly) * 0.004, -0.8, 0.95);
    }
    this.mouseState.fire = fire;
    this.mouseState.looking = looking;
    this.mouseState.lx = x;
    this.mouseState.ly = y;
    this.world.lookActive = looking;
    return { keys: raw.keys, fire };
  }

  update(_ctx: ICtx<GameState, undefined>, dt: number): void {
    const tickStart = performance.now();
    this.tickTimes.step = 0;
    this.wall += dt;
    const b = this.battle;
    const { keys, fire: mouseFire } = this.pollInput();
    // A lock granted late — after a pause, a menu, an exit or a seat change — must never outlive
    // the state that asked for it, even if the latch never saw it taken. Read the engine's real
    // capture state, not the request, and this runs paused too so the cursor cannot stay hidden.
    if ((!b.player.gunner || this.paused) && this.ctx.input.raw.pointer.captured) {
      this.wasCaptured = false;
      this.ctx.input.releaseMouse();
    }
    // Losing a lock we actually held is an Esc: the browser drops it with no keydown, and the
    // cursor comes back. Detect it before the controls are computed so the tick that lost the
    // lock opens the menu instead of spending one last round on a held trigger.
    if (
      b.player.gunner === true &&
      !this.paused &&
      this.wasCaptured &&
      !this.ctx.input.raw.pointer.captured
    ) {
      this.wasCaptured = false;
      this.showOverlay("pause-overlay");
    }
    const inFlight = b.status === "playing" && !this.paused;
    if (inFlight) {
      const turn = (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0);
      // Inverted pitch, as a flight-sim stick: pulling back (Down) raises the nose. The mouse
      // never commands pitch or roll — it fires the guns and, held right, moves the view.
      const pitch = (keys.has("ArrowDown") ? 1 : 0) - (keys.has("ArrowUp") ? 1 : 0);
      // Manning the gun, the same keys aim the rear station instead of the aircraft: the AI pilot
      // already holds the course, so a stray stick input must not disengage it. The gunner looks
      // aft, where the camera's screen-right is the aircraft's port (−X), so the keys are mapped
      // to the view rather than the aircraft's +X: D / ArrowRight raises the aim to the gunner's
      // right, A / ArrowLeft to the left.
      const gunner = b.player.gunner === true;
      const input = gunner
        ? {
            aimYaw: (keys.has("ArrowLeft") || keys.has("KeyA") ? 1 : 0) - (keys.has("ArrowRight") || keys.has("KeyD") ? 1 : 0),
            aimPitch: (keys.has("ArrowUp") || keys.has("KeyW") ? 1 : 0) - (keys.has("ArrowDown") || keys.has("KeyS") ? 1 : 0),
            fire: keys.has("Space") || mouseFire,
          }
        : {
            turn,
            pitch,
            rudder: (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyZ") ? 1 : 0),
            wheelBrake: keys.has("KeyK"),
            throttleUp: keys.has("KeyW"),
            throttleDown: keys.has("KeyS"),
            fire: keys.has("Space") || mouseFire,
          };
      if (gunner) this.aimFromPointer();
      // A battle-side exit from the station (crash, seat gone) must not leave the cursor locked.
      else if (this.wasCaptured) {
        this.wasCaptured = false;
        this.ctx.input.releaseMouse();
      }
      this.world.rear = !gunner && keys.has("KeyV");
      // Shift is a simulation control only: it runs extra fixed steps, and never touches
      // thrust, the camera, animation rates or audio. `canAccelerate()` gates it to level
      // flight above 120 m, undamaged, with no enemy aircraft within 2400 m or ship within
      // 2800 m, so it can never fast-forward a fight.
      const speed =
        (keys.has("ShiftLeft") || keys.has("ShiftRight")) && b.canAccelerate() ? 3 : 1;
      const stepStart = performance.now();
      for (let i = 0; i < speed; i += 1) b.step(1 / 60, input);
      this.tickTimes.step = performance.now() - stepStart;
      for (const e of b.events.splice(0)) {
        this.audio.event(e);
        if (e.type === "notice") this.hud.toast(e.text);
        if (e.type === "damage") this.hud.hitFlash = 1;
      }
    }
    if (!this.paused) this.worldDt += dt;
    const hudStart = performance.now();
    this.hud.update(dt);
    const hudEnd = performance.now();
    if ((this.publishTick += 1) % 6 === 0) this.publish();
    const p = b.player;
    const onShip = p.mode === "deck" || p.mode === "launch" || p.mode === "arrest" || p.mode === "service";
    const nearShip = onShip || b.ships.some((s: any) => s.team === "us" && s.kind === "carrier" && !s.sunk && distance2(s, p) < 1800 * 1800);
    this.world.camera.getWorldPosition(this.camPos);
    this.audio.update(
      {
        cockpit: this.world.cameraMode === 1 && !this.world.followBomb,
        airframe: p.airframe,
        onDeck: onShip,
        nearPA: nearShip,
        listener: { x: this.camPos.x, y: this.camPos.y, z: this.camPos.z },
        deckSpeed: p.deckSpeed ?? p.speed ?? 0,
        engineCut: p.engineCut,
        damage: 1 - (p.damage?.engine?.integrity ?? 1),
        stall: p.stall ?? 0,
        gforce: p.gforce ?? 1,
        rpm: p.rpm ?? p.throttle ?? 0,
        throttle: p.throttle ?? 0,
        ias: p.ias ?? p.speed ?? 0,
        brakes: p.brakes,
      },
      this.paused || b.status !== "playing",
      dt,
    );
    // A tick over 20 ms names its heaviest part: the fixed step can run up to five ticks in one
    // drawn frame, so one slow part here is what turns into a visible hitch. Silent otherwise. The
    // world now updates once per drawn frame, so its breakdown is the last frame's, not this tick's.
    const tickMs = performance.now() - tickStart;
    if (tickMs > 20) {
      const world: Record<string, number> = { ms: +this.tickTimes.world.toFixed(1) };
      for (const [k, v] of Object.entries(this.world.updateTimes)) world[k] = +v.toFixed(1);
      console.log(
        `TN_MIDWAY_SLOW_TICK:${JSON.stringify({
          ms: +tickMs.toFixed(1),
          bt: +b.time.toFixed(2),
          mode: p.mode,
          status: b.status,
          step: +this.tickTimes.step.toFixed(1),
          world,
          hud: +(hudEnd - hudStart).toFixed(1),
          after: +(performance.now() - hudEnd).toFixed(1),
        })}`,
      );
    }
    // Continuous world loops follow the scene: a burning hull hisses where it is, the atoll surf
    // only exists near the atoll. Passing the full set each frame makes a stopped loop impossible.
    const emitters: Array<{ id: string; key: string; source: unknown; volume: number }> = [];
    for (const s of b.ships) {
      if (s.sunk || !(s.fire > 0.12)) continue;
      const mesh = this.world.meshes.get(s.id);
      if (mesh) emitters.push({ id: `fire-${s.id}`, key: "fuelFire", source: mesh, volume: Math.min(0.85, 0.35 + s.fire * 0.35) });
    }
    // The player's own aircraft burns like any other wreck once it is going down, and the chase
    // camera is right on top of it — the fire has to be heard there, not only on distant hulls.
    const ownFire = p.mode === "wreck" ? 0 : Math.max(p.damage?.engine?.fire ?? 0, p.mode === "crashing" ? 0.7 : 0);
    if (ownFire > 0.12 && this.world.playerMesh)
      emitters.push({ id: "fire-player", key: "fuelFire", source: this.world.playerMesh, volume: Math.min(0.8, 0.3 + ownFire * 0.5) });
    const island = b.island;
    if (island) {
      const range = Math.sqrt(distance2(island, p));
      if (range < 4000) emitters.push({ id: "reef", key: "reefSurf", source: { x: island.x, y: 0, z: island.z }, volume: Math.min(0.5, 0.5 * (1 - range / 4000)) });
    }
    // AI aircraft engines carry their airframe identity: a TBD, Wildcat, Catalina, Zero, Val or
    // Kate is heard as itself, at its own state band, not as the player's Dauntless.
    const AI_ENGINE: Record<string, { idle: string; cruise: string; power: string }> = {
      sbd: { idle: "engineExtIdle", cruise: "engineExtCruise", power: "engineExtPower" },
      tbd: { idle: "tbdEngineExtIdle", cruise: "tbdEngineExtCruise", power: "tbdEngineExtPower" },
      wildcat: { idle: "wildcatEngineExtIdle", cruise: "wildcatEngineExtCruise", power: "wildcatEngineExtPower" },
      catalina: { idle: "catalinaEngineExtIdle", cruise: "catalinaEngineExtCruise", power: "catalinaEngineExtPower" },
      zero: { idle: "zeroEngineExtIdle", cruise: "zeroEngineExtCruise", power: "zeroEngineExtPower" },
      val: { idle: "valEngineExtIdle", cruise: "valEngineExtCruise", power: "valEngineExtPower" },
      kate: { idle: "kateEngineExtIdle", cruise: "kateEngineExtCruise", power: "kateEngineExtPower" },
    };
    for (const a of b.aircraft) {
      if (a.hp <= 0 || a.mode === "crashing") continue;
      const banks = AI_ENGINE[a.airframe];
      const mesh = this.world.meshes.get(a.id);
      if (!banks || !mesh) continue;
      const range = Math.sqrt(distance2(a, p));
      if (range > 2600) continue;
      const rpm = a.rpm ?? 0.7;
      const key = rpm < 0.4 ? banks.idle : rpm < 0.72 ? banks.cruise : banks.power;
      emitters.push({ id: `eng-${a.id}`, key, source: mesh, volume: Math.min(0.5, 0.5 * (1 - range / 2600)) });
    }
    this.audio.syncEmitters(emitters);
    if (island && Math.sqrt(distance2(island, p)) < 3000 && this.wall > this.nextAlbatross) {
      this.nextAlbatross = this.wall + 9 + Math.random() * 12;
      this.audio.event({ cue: "albatross", at: { x: island.x + 150, y: 20, z: island.z + 150 } });
    }
    // The pilot's own view ends with the aircraft. From the moment it is a wreck the camera watches
    // it go in from outside, the way the player watches the ones they shoot down.
    if ((p.mode === "crashing" || p.mode === "wreck" || p.mode === "downed") && !this.crashCam) {
      this.crashCam = true;
      this.wasCaptured = false;
      this.ctx.input.releaseMouse();
      if (this.world.cameraMode === 1) this.world.setCamera(0);
    } else if (p.mode !== "crashing" && p.mode !== "wreck" && p.mode !== "downed" && this.crashCam) this.crashCam = false;
    if ((b.status === "lost" || b.status === "won" || b.status === "debrief") && !this.ended) {
      this.ended = true;
      this.wasCaptured = false;
      this.ctx.input.releaseMouse();
      this.clearInput();
      // The hud channel's `debrief()` un-hides #debrief in the web view, but the native entry
      // re-applies `ui.screens` on every published ui snapshot. Without this the published
      // `screens.debrief` never leaves the false `begin()` set, so the first later snapshot hides
      // the dialog again — the debrief exists in the simulation and never on screen. Same
      // derivation hideOverlays uses, so both agree.
      this.syncDebriefScreen();
      this.hud.debrief();
    }
  }

  /** The one place `ui.screens.debrief` is derived from the battle, for the terminal states. */
  private syncDebriefScreen(): void {
    shell.screen("debrief", ["lost", "won", "debrief"].includes(this.battle.status));
  }

  /** Aim from the lock only; the lock's own loss is handled before the controls, in update(). */
  private aimFromPointer(): void {
    const pointer = this.ctx.input.raw.pointer;
    if (!pointer.captured) return;
    if (!this.wasCaptured) {
      // The first tick that sees the lock can still carry the cursor movement that took it — the
      // HUD button click walks the pointer across the screen — or the browser's warp into the
      // lock. Applying that one sample would snap the barrels to a clamp on entry, so drop it;
      // the engine's per-tick relative reset clears it, and the next real motion aims normally.
      this.wasCaptured = true;
      return;
    }
    const d = this.ctx.input.vector("aim");
    if (d.x !== 0 || d.y !== 0) this.battle.aimRear(-d.x * 0.004, -d.y * 0.004);
  }

  /** The state anything outside the simulation reads: a native HUD, or a playtest assertion. */
  private publish(): void {
    const p = this.battle.player;
    const mode = String(p.mode ?? "");
    this.ctx.state.set({
      status: String(this.battle.status),
      mode,
      altitude: Math.round(p.y ?? 0),
      ias: Math.round(p.ias ?? p.speed ?? 0),
      throttle: Number((p.throttle ?? 0).toFixed(2)),
      airborne: mode === "flight" || mode === "crashing",
      particles: this.world.particles.smoke.items.length + this.world.particles.glow.items.length,
      explosions: this.world.particles.counts.explosion ?? 0,
      crashReason: String(this.battle.crashReason ?? ""),
      spoken: this.audio.spokenLines,
      radioLines: this.battle.radio.length,
      muzzle: this.world.particles.counts.muzzle ?? 0,
      splashes: this.world.particles.counts.splash ?? 0,
      waterAccepted: this.world.ripples.effects.accepted,
      waterRejected: this.world.ripples.effects.rejected,
      ordnance: p.bombs ?? 0,
      recoveryReady: this.battle.approach().ready,
    });
    // `set` only stages the patch; the UI channel receives nothing until it is flushed. Without
    // this the native web view attaches, subscribes, and then waits forever for a first snapshot
    // — an overlay that is present and permanently blank.
    this.ctx.state.flush();
  }

  /** Drops the mouse state only: held keys are the framework's, and it clears them on blur. */
  private clearInput(): void {
    this.mouseState.fire = false;
    this.mouseState.looking = false;
    this.mouseState.lockClick = false;
    this.world.rear = false;
    this.world.lookActive = false;
  }

  private hideOverlays(): void {
    shell.overlay(null);
    this.syncDebriefScreen();
    this.overlay = null;
    this.hud.mapOpen = false;
    this.paused = false;
    // Opening or closing a menu always drops the lock; only resume() re-takes it, from a click.
    this.wasCaptured = false;
    this.ctx.input.releaseMouse();
    this.clearInput();
  }

  /** The pause/map/command buttons resume play; the click is the gesture that re-takes the lock. */
  private resume(): void {
    this.hideOverlays();
    if (this.battle.player.gunner) this.ctx.input.captureMouse();
  }

  private showOverlay(id: string): void {
    if (this.overlay === id) {
      this.hideOverlays();
      return;
    }
    this.hideOverlays();
    this.overlay = id;
    this.paused = true;
    shell.screen("debrief", false);
    shell.overlay(id);
    this.hud.mapOpen = id === "map-overlay";
    this.updateLoadoutUI();
    if (this.hud.mapOpen) {
      this.hud.drawMap();
      this.hud.lastContacts = "";
      this.hud.updateContactList();
      this.hud.lastBattleStatus = "";
      this.hud.updateBattleStatus();
    }
  }

  private begin(airborne = false, fresh = false): void {
    this.hideOverlays();
    shell.screen("debrief", false);
    this.ended = false;
    if (fresh) {
      const choice = this.battle.player.loadout;
      this.battle = new Battle();
      this.battle.selectAssignment(this.assignment);
      this.battle.selectLoadout(choice);
      this.world.reset(this.battle);
      this.hud.b = this.battle;
      this.hud.lastRadio = "";
      this.hud.lastContacts = "";
      this.hud.hitFlash = 0;
    }
    this.audio.start();
    this.battle.start(airborne);
    if (!airborne) this.audio.event({ type: "engineStart", airframe: this.battle.player.airframe });
    this.updateLoadoutUI();
    shell.screen("briefing", false);
    shell.screen("flight", true);
    this.clearInput();
    this.world.snap = true;
    this.world.followBomb = false;
    this.hud.toast(airborne ? "SCOUT TWO — SEARCH THE NORTHWEST SECTOR" : "HOLD W TO ADVANCE THE THROTTLE");
  }

  private restartToBriefing(): void {
    this.hideOverlays();
    this.battle = new Battle();
    this.battle.selectAssignment(this.assignment);
    this.world.reset(this.battle);
    this.hud.b = this.battle;
    this.hud.lastRadio = "";
    this.hud.lastContacts = "";
    this.hud.hitFlash = 0;
    this.ended = false;
    this.updateAssignmentUI();
    shell.screen("flight", false);
    shell.screen("briefing", true);
    shell.screen("debrief", false);
    this.updateLoadoutUI();
  }

  private updateLoadoutUI(notice?: string): void {
    const p = this.battle.player;
    const id = p.loadout || "bomb";
    const torpedo = id === "torpedo";
    const can = p.mode === "deck" && (p.deckSpeed || 0) < 0.5;
    shell.loadout({
      id,
      name: LOADOUTS[id].name,
      tagTitle: torpedo ? "DOUGLAS TBD DEVASTATOR" : "DOUGLAS SBD DAUNTLESS",
      tagRole: torpedo ? "TORPEDO BOMBER · DOUGLAS TBD-1 DEVASTATOR" : "SCOUT BOMBER · BOMBING SQUADRON SIX",
      note: torpedo ? "Low, slow, straight run · 1 aerial torpedo · no dive brakes" : "Steep dive attack · perforated dive brakes · lighter wing stores",
      deckEnabled: can,
      deckNote: can ? "Changes aircraft and payload." : "Stop on the flight deck to change loadout.",
      deckNotice: notice,
    });
  }

  /** The briefing choice outlives a restart, so replay launches the assignment the player picked. */
  private selectAssignment(id: string): void {
    if (!this.battle.selectAssignment(id)) return;
    this.assignment = id as Assignment;
    this.updateAssignmentUI();
  }

  private updateAssignmentUI(): void {
    shell.assignment(this.assignment, ASSIGNMENTS[this.assignment].brief);
  }

  private selectLoadout(id: string): void {
    if (!this.battle.selectLoadout(id)) {
      const notice = this.battle.events.at(-1);
      this.updateLoadoutUI(notice?.type === "notice" ? notice.text : undefined);
      if (notice?.type === "notice") this.hud.toast(notice.text);
      return;
    }
    this.world.setAirframe();
    // A different airframe is a different cockpit, and the new one has never been drawn. Warm it
    // here on the deck, where the compile is invisible, instead of in the first cockpit frame aloft.
    void this.world.warmUpViews();
    this.updateLoadoutUI();
  }

  private setCamera(mode: number): void {
    // Authority boundary: the gunner station is first-person only, so no route may change the view.
    if (this.battle.player.gunner) {
      this.hud.toast("CAMERA LOCKED — REAR GUNNER · Y FOR THE PILOT SEAT");
      return;
    }
    this.world.setCamera(mode);
    this.hud.toast(["CHASE CAMERA", "PILOT COCKPIT — HOLD RIGHT MOUSE TO LOOK", "WIDE CHASE CAMERA", "OVERHEAD ATTACK CAMERA — LOOKING DOWN ON YOUR AIRCRAFT"][mode]);
  }

  /** Y and the HUD button: swap the pilot and the rear gunner, or say why the seat is unavailable. */
  private toggleGunner(): void {
    const b = this.battle;
    if (b.player.gunner) {
      b.setGunner(false);
      this.wasCaptured = false;
      this.ctx.input.releaseMouse();
      this.hud.toast("PILOT — YOU HAVE CONTROL");
      return;
    }
    if (!b.setGunner(true)) {
      this.hud.toast("REAR GUN NEEDS AN SBD OR TBD IN FLIGHT");
      return;
    }
    this.audio.start();
    // The Y keydown and the HUD button are both user gestures. The request is asynchronous: the
    // lock is only trusted once raw.pointer.captured reports it, and a refusal leaves the cursor
    // free to click the canvas and try again.
    this.ctx.input.captureMouse();
    // The controls live in the persistent lower-centre hint; this transient line only says who has
    // the stick, so the two rows never repeat each other.
    this.hud.toast(
      b.player.rearAmmo > 0 ? "AI PILOT HAS THE STICK" : "REAR GUN EMPTY — INSPECT STATION · Y PILOT",
    );
  }

  private goHome(): void {
    const home = this.battle.goHome();
    if (!home) {
      this.hud.toast("NO OPERATIONAL FRIENDLY FLIGHT DECK");
      return;
    }
    this.hud.toast(`RETURN COURSE — ${home.name.toUpperCase()}`);
  }

  /** Take a replacement aircraft after a shoot-down. A refusal is surfaced by the battle's notice. */
  private takeAnotherAircraft(): void {
    if (!this.battle.takeAnotherAircraft()) return;
    this.world.snap = true;
    this.world.followBomb = false;
    this.audio.event({ type: "engineStart", airframe: this.battle.player.airframe });
    this.updateLoadoutUI();
    this.hud.toast("NEW AIRCRAFT ON DECK — HOLD W TO LAUNCH");
  }

  /**
   * The debrief's deck action. A short sortie's after-action report ends the sortie, not the war:
   * this resumes the same battle on the deck, where the service the recovery started finishes and
   * re-arms the aircraft. A lost or won mission uses the button to start a fresh operation instead.
   */
  private continueOnDeck(): void {
    if (!this.battle.continueAfterRecovery()) return;
    this.ended = false;
    this.hideOverlays();
    this.world.snap = true;
    this.world.followBomb = false;
    this.updateLoadoutUI();
    this.hud.toast("BACK ON DECK — REFUELLED AND REARMED, HOLD W TO LAUNCH AGAIN");
  }

  private designateTarget(id: string): void {
    if (!this.battle.designateTarget(id)) {
      this.hud.toast("CONTACT NOT ELIGIBLE FOR THIS ASSIGNMENT");
      return;
    }
    this.hud.lastContacts = "";
    this.hud.updateContactList();
    this.hud.drawMap();
    this.hud.toast(`DESIGNATED: ${this.battle.contacts.get(id)!.name.toUpperCase()}`);
  }

  private cycleTarget(): void {
    const cs = this.battle.targetContacts();
    if (!cs.length) {
      this.hud.toast("NO ELIGIBLE KNOWN CONTACTS");
      return;
    }
    const index = cs.findIndex((c) => c.id === this.battle.target);
    this.designateTarget(cs[(index + 1) % cs.length].id);
  }

  private command(cmd: string): void {
    this.battle.setCommand(cmd);
    this.hideOverlays();
    this.hud.toast(`SQUADRON ORDER: ${cmd.toUpperCase()}`);
  }

  private action(code: string): void {
    if (code === "Escape" || code === "KeyP" || code === "Slash") {
      if (this.overlay) this.hideOverlays();
      else this.showOverlay("pause-overlay");
      return;
    }
    if (code === "KeyM") {
      this.showOverlay("map-overlay");
      return;
    }
    if (code === "KeyQ") {
      this.showOverlay("command-overlay");
      return;
    }
    if (code === "F4") {
      this.hud.toggleFps();
      return;
    }
    if (this.overlay === "command-overlay" && /^Digit[1-4]$/.test(code)) {
      this.command(["cover", "strike", "engage", "rtb"][Number(code.slice(-1)) - 1]);
      return;
    }
    if (this.paused || this.battle.status !== "playing") return;
    const p = this.battle.player;
    // A wrecked aircraft takes no more orders; the keys go dead until it hits the water.
    if (p.mode === "crashing" || p.mode === "wreck") return;
    // Downed: no aircraft to command. The replacement order is the only one that lands; the map and
    // manual were already handled above, on their own paths.
    if (p.mode === "downed") {
      if (code === "Enter") this.takeAnotherAircraft();
      return;
    }
    // The rear-gun station owns the view: camera and view orders are refused at the route, not
    // merely reset a frame later.
    if (p.gunner && ["KeyC", "F1", "F2", "F3", "KeyJ", "KeyV"].includes(code)) {
      this.hud.toast("CAMERA LOCKED — REAR GUNNER · Y FOR THE PILOT SEAT");
      return;
    }
    // The AI pilot owns the aircraft while the player is on the gun; these orders would either
    // disengage it or drop the bombs from the wrong seat.
    if (p.gunner && ["KeyT", "KeyL", "KeyB", "KeyF", "KeyG", "KeyN", "KeyI", "KeyU", "BracketLeft", "BracketRight"].includes(code)) {
      this.hud.toast("AI PILOT HAS CONTROL — Y TO RETURN TO THE PILOT SEAT");
      return;
    }
    switch (code) {
      case "KeyY":
        this.toggleGunner();
        break;
      case "KeyB":
        this.battle.releaseOrdnance();
        break;
      case "KeyF":
        if (p.airframe === "tbd") {
          this.hud.toast("TBD HAS NO DIVE BRAKES — REDUCE THROTTLE");
          break;
        }
        p.brakes = !p.brakes;
        this.audio.event({ type: "flap" });
        this.hud.toast(`DIVE BRAKES ${p.brakes ? "EXTENDED" : "RETRACTED"}`);
        break;
      case "KeyG":
        if (p.mode === "deck" || p.mode === "arrest") {
          this.hud.toast("GEAR LOCKED WHILE ON DECK");
          break;
        }
        this.battle.toggleGear();
        this.audio.event({ type: "gear" });
        this.hud.toast(`LANDING GEAR ${p.gear ? "DOWN" : "UP"}`);
        break;
      case "KeyN":
        p.flaps = p.flaps < 0.15 ? 0.33 : p.flaps < 0.7 ? 1 : 0;
        // The SBD's dive brakes ARE its split flaps: one surface driven by
        // max(flapPos, brakePos). A flap-up order must release the brakes too, or the
        // panels (and their drag) stay out against the command and the wing never
        // comes clean. The TBD has no dive brakes, so it keeps its own state.
        if (p.flaps === 0 && p.airframe !== "tbd") p.brakes = false;
        this.audio.event({ type: "flap" });
        this.hud.toast(`FLAPS ${p.flaps === 0 ? "UP" : p.flaps < 0.7 ? "TAKEOFF" : "LANDING"}`);
        break;
      case "KeyU":
        p.assist = !p.assist;
        this.hud.toast(p.assist ? "STABILITY ASSIST ON" : "DIRECT FLIGHT — ROLL AND TRIM ARE YOURS");
        break;
      case "BracketLeft":
        p.trim = clamp(p.trim - 0.012, -0.1, 0.18);
        this.hud.toast(`PITCH TRIM ${(p.trim * 57.3).toFixed(1)}°`);
        break;
      case "BracketRight":
        p.trim = clamp(p.trim + 0.012, -0.1, 0.18);
        this.hud.toast(`PITCH TRIM ${(p.trim * 57.3).toFixed(1)}°`);
        break;
      case "KeyC":
        this.setCamera((this.world.cameraMode + 1) % 4);
        break;
      case "KeyO":
        // Direct jump to the overhead attack view, wherever the C cycle left off.
        this.setCamera(3);
        break;
      case "F1":
        this.setCamera(1);
        break;
      case "F2":
        this.setCamera(0);
        break;
      case "F3":
        this.setCamera(2);
        break;
      case "KeyI":
        p.engineCut = !p.engineCut;
        this.audio.event({ type: "engine", action: p.engineCut ? "stop" : "start", airframe: p.airframe });
        this.hud.toast(p.engineCut ? "ENGINE FUEL CUTOFF — ENGINE STOPPING / WING FIRES UNAFFECTED" : "ENGINE FUEL VALVE OPEN");
        break;
      case "KeyR":
        // In the rear station R is the belt change; in the pilot's seat it still sends the report.
        if (p.gunner) this.battle.reloadRear();
        else this.battle.report();
        break;
      case "KeyT":
        p.autopilot = !p.autopilot;
        if (p.autopilot) {
          p.nav = "search";
        }
        this.hud.toast(`COURSE HOLD ${p.autopilot ? "ENGAGED" : "OFF"}`);
        break;
      case "KeyH":
        this.goHome();
        break;
      case "KeyL":
        this.battle.assistRecovery();
        break;
      case "KeyJ":
        this.world.followBomb = !this.world.followBomb;
        this.world.snap = true;
        this.hud.toast(this.world.followBomb ? "WEAPON FOLLOW CAMERA" : "AIRCRAFT CAMERA");
        break;
      case "Tab":
        this.cycleTarget();
        break;
      case "Digit1":
        this.command("cover");
        break;
      case "Digit2":
        this.command("strike");
        break;
      case "Digit3":
        this.command("engage");
        break;
      case "Digit4":
        this.command("rtb");
        break;
    }
  }
}
