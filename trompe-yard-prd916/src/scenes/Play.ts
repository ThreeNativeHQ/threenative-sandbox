import {
  debugValue,
  fetchAsset,
  type ICtx,
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
} from "@threenative/core";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import { type IPhysicsContext, buildStaticColliders } from "@threenative/physics";
import {
  Group,
  Mesh,
  type PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  type Texture,
} from "three";
import { FirstPerson } from "../entities/FirstPerson.js";
import {
  COURTYARD_TEXTURES,
  type ICourtyardSwatch,
  type ICourtyardSwatches,
  type ICourtyardTextures,
  courtyardSurfaces,
} from "../render/courtyardSurfaces.js";
import { setupCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { floorMaterial, worldGridUVs } from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { SKY_OPTIONS, setupSky } from "../render/sky.js";
import type { GameState } from "../state.js";

/** PRD-916 test scene: `?level=blockout/courtyard.glb` is the gray BEFORE arm; the default is the FLUX 3 Klein paint. */
const LEVEL = debugValue("level") ?? "courtyard-klein.glb";

/** Open paving in the courtyard's middle (its bounds centre is x 5, z 0). */
const SPAWN = { x: 5, y: 1.2, z: 0 } as const;
/** Facing the stairs and the steel door at the start. */
const SPAWN_YAW = 0;

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/** The surface classes trompe cuts a swatch for. */
const SWATCH_CLASSES = ["wall", "floor"] as const;

/** One class in `*.swatches.json`: the file next to the GLB, and the metres one tile of it covers. */
interface ISwatchSpec {
  readonly file: string;
  readonly metres?: number;
  readonly metresX?: number;
  readonly metresY?: number;
}

/**
 * The paint's own true-scale swatches, if trompe wrote them next to the level. A level without them
 * (the gray blockout, a cook from before the swatches) returns undefined and the courtyard renders
 * exactly as it did before: the swatch is an improvement to the near field, never a requirement.
 */
async function loadSwatches(
  assets: GameCtx["assets"],
  level: string,
): Promise<ICourtyardSwatches | undefined> {
  let table: Record<string, ISwatchSpec | undefined>;
  try {
    const response = await fetchAsset(assets, level.replace(/\.glb$/iu, ".swatches.json"));
    table = (await response.json()) as Record<string, ISwatchSpec | undefined>;
  } catch {
    return undefined;
  }
  const swatches: { wall?: ICourtyardSwatch; floor?: ICourtyardSwatch } = {};
  for (const name of SWATCH_CLASSES) {
    const spec = table[name];
    const metresX = spec?.metresX ?? spec?.metres;
    const metresY = spec?.metresY ?? spec?.metres;
    if (spec === undefined || metresX === undefined || metresY === undefined) continue;
    try {
      // RepeatWrapping because world UVs run past 1, sRGB because the pixels are colour, and mipmaps
      // because the shader reads the swatch's mean colour off its top mip. Anisotropy 8 keeps a wall
      // seen along its own face from smearing its courses into one line.
      swatches[name] = {
        map: await assets.texture(spec.file, { wrap: RepeatWrapping, anisotropy: 8 }),
        metresX,
        metresY,
      };
    } catch {
      // Listed but not written by this cook: the class keeps the baked paint's look.
    }
  }
  return swatches;
}

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    playerX: -2,
    score: 0,
  };

  #level!: { scene: Group };
  #textures!: ICourtyardTextures;
  #swatches: ICourtyardSwatches | undefined;
  #sky: Texture | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    const T = COURTYARD_TEXTURES;
    const colour = (path: string) => ctx.assets.texture(path);
    const data = (path: string) => ctx.assets.texture(path, { data: true });
    const [aMap, aNormal, aRough, cMap, cNormal, cRough] = await Promise.all([
      colour(T.asphalt.map),
      data(T.asphalt.normal),
      data(T.asphalt.rough),
      colour(T.concrete.map),
      data(T.concrete.normal),
      data(T.concrete.rough),
    ]);
    this.#textures = {
      asphalt: { map: aMap, normal: aNormal, rough: aRough },
      concrete: { map: cMap, normal: cNormal, rough: cRough },
    };
    this.#swatches = await loadSwatches(ctx.assets, LEVEL);
    [this.#level, this.#sky] = await Promise.all([
      ctx.assets.model<{ scene: Group }>(LEVEL),
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
    // The level is a gray blockout that trompe painted with Meta Muse Image (OpenRouter) and baked
    // into one albedo texture: see README.md. Everything in `level` becomes a fixed trimesh body
    // below, so the player collides with exactly the triangles it sees.
    const level = new Group();
    // trompe exports one painted mesh; split it into Poly Haven floor and props and AI-painted walls.
    let painted: Mesh | undefined;
    this.#level.scene.updateMatrixWorld(true);
    this.#level.scene.traverse((object) => {
      if (painted === undefined && object instanceof Mesh) painted = object;
    });
    if (painted === undefined) throw new Error(`${LEVEL} has no mesh.`);
    const placed = new Mesh(
      painted.geometry.clone().applyMatrix4(painted.matrixWorld),
      painted.material,
    );
    const courtyard = new Group();
    for (const mesh of courtyardSurfaces(placed, this.#textures, this.#swatches)) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      courtyard.add(mesh);
    }
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
    const player = new FirstPerson(ctx, SPAWN, SPAWN_YAW);
    const camera = ctx.camera as PerspectiveCamera;
    afterPhysics(ctx, () => player.placeCamera(camera));
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
      player.update(frameCtx, dt);
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
