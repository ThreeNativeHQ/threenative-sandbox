import {
  AudioBus,
  type ICtx,
  Scene,
  type SceneFrame,
  getPlatform,
  isMobile,
} from "@threenative/core";
import type { Object3D, PerspectiveCamera, Texture } from "three";
import { Enemies } from "../entities/Enemies.js";
import { ARENA_RADIUS, Rail } from "../entities/Rail.js";
import { Ship } from "../entities/Ship.js";
import { Weapons } from "../entities/Weapons.js";
import { Wingmen } from "../entities/Wingmen.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { type ICockpit, createCockpit } from "../render/cockpit.js";
import { createFx } from "../render/fx.js";
import { createHud } from "../render/hud.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { RailCamera } from "../render/railCamera.js";
import { SKY_OPTIONS, setupSky } from "../render/sky.js";
import { type IStageTextures, buildStage } from "../render/stage.js";
import type { GameState, Phase } from "../state.js";
import type { SfxName, World } from "../world.js";

type GameCtx = ICtx<GameState>;

const SFX: readonly SfxName[] = [
  "laser",
  "charged",
  "explosion",
  "hit",
  "lock",
  "bomb",
  "pickup",
  "alarm",
];
const TEXTURES = {
  groundDiff: "aerial_rocks_02_diff",
  groundNormal: "aerial_rocks_02_nor_gl",
  groundRough: "aerial_rocks_02_rough",
  rockDiff: "rock_face_03_diff",
  rockNormal: "rock_face_03_nor_gl",
  rockRough: "rock_face_03_rough",
} as const;

const INITIAL: GameState = {
  phase: "flying",
  shield: 255,
  shieldMax: 255,
  boost: 0,
  hits: 0,
  distance: 0,
  bombs: 3,
  laserLevel: 0,
  charge: 0,
  locked: false,
  autopilot: false,
  skipTo: 0,
};

export class Play extends Scene<GameState> {
  static override readonly initialState: GameState = INITIAL;

  #model: Object3D | undefined;
  #sky: Texture | undefined;
  #textures: IStageTextures | undefined;
  #sounds = new Map<SfxName, AudioBuffer>();
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #dispose: (() => void)[] = [];

  override async load(ctx: GameCtx): Promise<void> {
    const keys = Object.keys(TEXTURES) as (keyof typeof TEXTURES)[];
    const [model, sky, textures, sounds] = await Promise.all([
      ctx.assets.model<{ scene: Object3D }>("starfighter.glb"),
      SKY_OPTIONS.sky === "photo" ? ctx.assets.texture("sky.jpg") : undefined,
      Promise.all(keys.map((key) => ctx.assets.texture(`textures/${TEXTURES[key]}_2k.jpg`))),
      Promise.all(SFX.map((name) => ctx.assets.audio(`sfx/${name}.wav`))),
    ]);
    this.#model = model.scene;
    this.#sky = sky;
    this.#textures = Object.fromEntries(
      keys.map((key, i) => [key, textures[i]]),
    ) as unknown as IStageTextures;
    SFX.forEach((name, i) => this.#sounds.set(name, sounds[i] as AudioBuffer));
    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(
      ctx.renderer.raw,
      ctx.scene,
      this.#environment(ctx),
    );
  }

  #environment(ctx: GameCtx) {
    return {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
  }

  override enter(ctx: GameCtx): SceneFrame<GameState> {
    if (this.#model === undefined || this.#textures === undefined)
      throw new Error("Play.enter ran before load() finished.");
    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    const materialEnvironment = this.#environment(ctx);
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: lighting.key,
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment)),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);

    const rail = new Rail();
    const stage = buildStage(rail, this.#textures);
    ctx.add(stage.root);
    const ship = new Ship(this.#model.clone());
    ctx.add(ship.mesh);
    ctx.interpolate(ship.mesh);
    const bus = new AudioBus({ camera });
    this.#dispose.push(() => bus.dispose());
    const fx = createFx(ctx);
    this.#dispose.push(() => fx.dispose());
    const hud = createHud(camera);
    this.#dispose.push(() => hud.dispose());
    // ponytail: test-only seams read from the page URL (`?autopilot=1&skipTo=4800`): playtest setup
    // cannot write state (the bridge's state provider is read-only), so scenarios pass `--url`.
    // Native has no URL, so both stay off there.
    const query = String(globalThis.location?.search ?? "");
    const urlAutopilot = /[?&]autopilot=1\b/.test(query);
    const urlSkipTo = Number(/[?&]skipTo=(\d+)/.exec(query)?.[1] ?? 0);
    const w: World = {
      ctx,
      camera,
      cameraRig: new RailCamera(camera),
      rail,
      ship,
      weapons: new Weapons(ctx),
      enemies: new Enemies(ctx),
      wingmen: new Wingmen(ctx, this.#model),
      stage,
      fx,
      sfx: (name, at) => {
        const buffer = this.#sounds.get(name);
        if (buffer === undefined) return;
        if (at === undefined) bus.play(buffer, { cue: name });
        else bus.playAt(buffer, at, { cue: name, refDistance: 25 });
      },
      get autopilot() {
        return urlAutopilot || ctx.state.getState().autopilot;
      },
    };
    // The cockpit loads on the first frame, not in `load()`: 4 MB the spawn camera never sees.
    // `C` works once it lands. Asking 120 frames in crashed the renderer once (TN_POST_NORMAL_UNSUPPORTED,
    // a normal-mapped material arriving late), so this stays at the first frame.
    let cockpit: ICockpit | undefined;
    let sceneLive = true;
    let cockpitRequested = false;
    this.#dispose.push(() => {
      sceneLive = false;
      cockpit?.dispose();
    });
    ctx.entities.add("ship", ship);
    ctx.entities.add("weapons", w.weapons);
    ctx.entities.add("enemies", w.enemies);
    ctx.entities.add("wingmen", w.wingmen);
    ctx.entities.add("camera", w.cameraRig);

    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, lighting.key, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(this.#post.tier, materialEnvironment),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const { measurement, source, intensity } = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        measurement,
        source,
        intensity,
        this.#environmentSample,
      );
    }

    ctx.state.set({ ...INITIAL, autopilot: ctx.state.getState().autopilot === true });
    const patch: Partial<GameState> = {};
    let skipped = false;
    return (frameCtx, dt) => {
      loading.update();
      if (!cockpitRequested) {
        cockpitRequested = true;
        void frameCtx.assets.model<{ scene: Object3D }>("cockpit.glb").then((model) => {
          if (!sceneLive) return;
          cockpit = createCockpit(model.scene, camera);
          w.cameraRig.cockpitReady = true;
        });
      }
      const state = frameCtx.state.getState();
      if (state.phase === "clear" || state.phase === "down") {
        w.cameraRig.update(w, dt);
        hud.update(w, state, dt);
        cockpit?.update(w, state, dt);
        if (frameCtx.input.justPressed("restart")) void frameCtx.goto("play");
        return;
      }
      const skipTo = Math.max(state.skipTo, urlSkipTo);
      if (skipTo > rail.s && !skipped) {
        rail.s = skipTo;
        skipped = true;
      }
      ship.update(w, dt);
      w.weapons.update(w, dt);
      w.enemies.update(w, dt);
      w.wingmen.update(w, dt);
      fx.update(dt);
      w.cameraRig.update(w, dt);

      let phase: Phase = state.phase;
      if (phase === "flying" && rail.done) {
        phase = "arena";
        ship.enterArena(rail.arenaCenter, ARENA_RADIUS);
      }
      if (!ship.alive) phase = "down";
      else if (w.enemies.bossDefeated) phase = "clear";

      patch.phase = phase;
      patch.shield = ship.shield;
      patch.shieldMax = ship.shieldMax;
      patch.boost = ship.boost;
      patch.hits = w.enemies.kills;
      patch.distance = rail.s;
      patch.bombs = w.weapons.bombs;
      patch.laserLevel = w.weapons.laserLevel;
      patch.charge = w.weapons.charge;
      patch.locked = w.weapons.lockedTarget !== null;
      frameCtx.state.set(patch);
      hud.update(w, frameCtx.state.getState(), dt);
      cockpit?.update(w, frameCtx.state.getState(), dt);
    };
  }

  override exit(): void {
    for (const dispose of this.#dispose.splice(0)) dispose();
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
  }
}
