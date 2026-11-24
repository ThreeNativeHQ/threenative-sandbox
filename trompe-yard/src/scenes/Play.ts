import {
  type ICtx,
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import {
  type IPhysicsContext,
  buildStaticColliders,
} from "@threenative/physics";
import {
  Group,
  Mesh,
  type PerspectiveCamera,
  PlaneGeometry,
  type Texture,
  type Vector3,
} from "three";
import { type IPlayerModel, Player } from "../entities/Player.js";
import { followCamera, setupCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import {
  floorMaterial,
  worldGridUVs,
} from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { SKY_OPTIONS, setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState } from "../state.js";

/** Open paving in the courtyard's middle (its bounds centre is x 5, z 0). */
const SPAWN = { x: 5, y: 1.2, z: 0 } as const;

export type GameCtx = ICtx<GameState, IPhysicsContext>;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    playerX: -2,
    score: 0,
  };

  #model: IPlayerModel | undefined;
  #level!: { scene: Group };
  #sky: Texture | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    [this.#model, this.#level, this.#sky] = await Promise.all([
      ctx.assets.model<IPlayerModel>("mannequin.glb"),
      ctx.assets.model<{ scene: Group }>("courtyard-muse.glb"),
      // Only the photo-sky override reads the photograph; the atmosphere sky is computed.
      SKY_OPTIONS.sky === "photo" ? ctx.assets.texture("sky.jpg") : undefined,
    ]);
    // The cloud noise is the same every run of this build: generate it once, then read it back.
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#model === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin.glb.");
    const showTouchControls = isMobile() && isTouchscreenAvailable();
    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    // isMobile() arrives as an argument because src/render/ imports no framework package: the
    // platform decision is made here, in portable game code, exactly like createRandom.
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: lighting.key,
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment)),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    setupCamera(ctx.camera as PerspectiveCamera);
    const loading = createLoadingScreen(ctx);
    ctx.add(ctx.camera);
    const touchControls = showTouchControls
      ? ctx.entities.add("touch-controls", new TouchControls(ctx.camera as PerspectiveCamera))
      : undefined;
    // The level is a gray blockout that trompe painted with Meta Muse Image (OpenRouter) and baked
    // into one albedo texture: see README.md. Everything in `level` becomes a fixed trimesh body
    // below, so the player collides with exactly the triangles it sees.
    const level = new Group();
    const courtyard = this.#level.scene;
    courtyard.traverse((object) => {
      object.castShadow = true;
      object.receiveShadow = true;
    });
    level.add(courtyard);
    // The far floor runs out to the haze line under the courtyard, so the sky meets ground.
    const groundSize = 12_000;
    const groundGeometry = new PlaneGeometry(groundSize, groundSize).rotateX(-Math.PI / 2);
    groundGeometry.translate(0, -0.25, 0);
    const ground = new Mesh(worldGridUVs(groundGeometry), floorMaterial);
    ground.receiveShadow = true;
    ctx.add(ground);
    let texturedMaps = 0;
    courtyard.traverse((object) => {
      if (object instanceof Mesh && object.material.map) texturedMaps += 1;
    });
    ctx.entities.add("courtyard", { debug: () => ({ texturedMaps }) });
    ctx.add(level);
    buildStaticColliders(ctx, level);
    const player = new Player(ctx, this.#model);
    player.body.teleport(SPAWN);
    const camera = ctx.camera as PerspectiveCamera;
    const probe = (from: Vector3, to: Vector3) =>
      ctx.physics.directSpaceState.intersectRay({ from, to })?.distance;
    // Whether a wall stands between the player and the lens: what a playtest asserts. The ray
    // starts inside the player's capsule, which the query ignores.
    let hidden = false;
    ctx.entities.add("camera", { debug: () => ({ hidden }) });
    afterPhysics(ctx, (dt) => {
      followCamera(camera, player.mesh.position, dt, probe);
      hidden = probe(player.mesh.position, camera.position) !== undefined;
    });
    ctx.entities.add("player", player);
    // Loaded character and all arena meshes are attached before the single material traversal.
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
    const statePatch: Partial<GameState> = {};
    return (frameCtx, dt) => {
      loading.update();
      player.update(
        frameCtx,
        dt,
        touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size),
      );
      statePatch.playerX = player.mesh.position.x;
      frameCtx.state.set(statePatch);
    };
  }
  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
  }
}
