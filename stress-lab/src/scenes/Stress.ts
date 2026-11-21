import {
  Billboard3D,
  GPUParticles3D,
  GroundSnap,
  InstancedBatch,
  Scene,
  type SceneFrame,
  SkeletalMesh3D,
  VirtualShadowNode,
  createRandom,
  debugFlag,
  getPlatform,
  isMobile,
  markStatic,
  resolveTargetFps,
  version,
} from "@threenative/core";
import {
  Area3D,
  CharacterBody3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
} from "@threenative/physics";
import {
  AudioListener,
  Group,
  type InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  type PerspectiveCamera,
  PointLight,
  PositionalAudio,
  Quaternion,
  Raycaster,
  SpotLight,
  type Texture,
  Vector3,
} from "three";
import config from "../../threenative.config.js";
import { type IPlayerModel } from "../entities/Player.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting, shadeLikeSubstrate } from "../render/lighting.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { setupSky, SKY_OPTIONS } from "../render/sky.js";
import {
  type IStrataPreparedWorld,
  STRATA,
  type Strata,
  prepareStrataWorldCells,
  setupStrataLayers,
  strataEnabled,
  strataHeightAt,
} from "../render/stressStrata.js";
import {
  AVENUE,
  THROW,
  WALKER_FADE_SECONDS,
  WALKER_STATES,
  WALKER_STATE_SECONDS,
  playCamera,
  playKit,
} from "../render/stressPlay.js";
import {
  TORCH_COLOR,
  TORCH_INTENSITY,
  TORCH_RANGE,
  barrelGeometry,
  bodyMaterial,
  canopyFarGeometry,
  canopyGeometry,
  canopyMaterial,
  crateGeometry,
  fireClock,
  fireMaterial,
  firePositions,
  groundGeometry,
  groundMaterial,
  houseGeometry,
  propMaterial,
  rockFarGeometry,
  rockGeometry,
  rockMaterial,
  roofGeometry,
  roofMaterial,
  trunkFarGeometry,
  trunkGeometry,
  trunkMaterial,
  wallMaterial,
} from "../render/stress.js";
import {
  SPOTLIGHT_ANGLE,
  SPOTLIGHT_COLOR,
  SPOTLIGHT_DISTANCE,
  SPOTLIGHT_INTENSITY,
  billboardGeometry,
  billboardMaterial,
  glassGeometry,
  glassMaterial,
  leafCutoutMaterial,
  leafGeometry,
  markerGeometry,
  markerMaterial,
  npcGeometry,
  npcMaterial,
} from "../render/stressExtended.js";
import type { GameState } from "../state.js";
import { stressReport } from "../stressReport.js";
import { type GameCtx, Play } from "./Play.js";

/**
 * Layer sizes. `real` is a mid-size open-world frame (a town in a forest with townsfolk, a few
 * campfires and loose physics props); `?max` (TN_DEBUG_MAX natively) is the same world pushed until
 * something gives. Each layer is switched off with `?no<Layer>`, e.g. `?noCrowd&noParticles`.
 */
const PRESETS = {
  real: {
    trees: 4_000,
    rocks: 6_000,
    houses: 120,
    props: 600,
    crowd: 120,
    bodies: 300,
    fires: 12,
    firePerEmitter: 1_500,
    lights: 16,
  },
  max: {
    trees: 12_000,
    rocks: 18_000,
    houses: 300,
    props: 1_500,
    crowd: 300,
    bodies: 800,
    fires: 32,
    firePerEmitter: 3_000,
    lights: 32,
  },
} as const;
/** The layers `?load=N` multiplies; fires, fire particles and lights stay fixed. Same list in the vanilla lab. */
const DENSITY = ["trees", "rocks", "houses", "props", "crowd", "bodies"] as const;

function loadFactor(): number {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("load");
  const load = raw === null ? 1 : Number(raw);
  if (!(load > 0 && load <= 16))
    throw new Error(`?load must be a number in (0, 16], got "${raw}".`);
  return load;
}
const LAYERS = ["trees", "rocks", "houses", "props", "crowd", "bodies", "fires", "lights"] as const;
type Layer = (typeof LAYERS)[number];
/**
 * PRD-898: `?stress&systems` loads the engine systems the plain scene never touches, one layer per
 * engine-owned JavaScript row: frozen roots (`markStatic`), LOD chains (a cooked prop chain and
 * authored instanced levels), grounded walkers (`GroundSnap`) and one ground ray per walker per tick.
 * Each layer is switched off with `?no<Layer>`, as the world layers are. Plain `?stress` is unchanged.
 */
const SYSTEMS = ["frozen", "lods", "grounded", "rays"] as const;
type System = (typeof SYSTEMS)[number];
/**
 * `?stress&extended` adds uncovered subsystem layers: billboards, CharacterBody3D patrols, Area3D
 * sensors, alpha-cutout + transparent geometry, shadowed SpotLights, scattered dynamic instance
 * matrix updates, PositionalAudio emitters, Raycaster scene picking, and live HUD ticks.
 */
const EXTENDED = [
  "billboards",
  "characters",
  "areas",
  "transparent",
  "spotlights",
  "dynamicBatch",
  "audio",
  "picking",
  "hud",
] as const;
type Extended = (typeof EXTENDED)[number];
/** Authored instanced LOD switch distances, metres. */
const FAR_LOD = 60;

const EXTENDED_SIZES = {
  characters: 24,
  areas: 16,
  cutoutLeaves: 400,
  glassPanels: 120,
  spotlights: 4,
  markers: 2_000,
  audio: 24,
  raysPerFrame: 8,
} as const;

const WORLD = 180; // half-size, metres
const TOWN = 45; // half-size of the cleared town square
const ORBIT = { radius: 70, height: 24, seconds: 40 } as const;
const BODY_SIZE = 0.6;
const DROP_EVERY = 8;

export class Stress extends Scene<GameState, IPhysicsContext> {
  #mannequin: IPlayerModel | undefined;
  #lodProp: Object3D | undefined;
  #sky: Texture | undefined;
  #loadStart = 0;
  #post: ReturnType<typeof setupPost> | undefined;
  #disposeLighting: (() => void) | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #disposeExtended: (() => void) | undefined;
  #strataWorld: IStrataPreparedWorld | undefined;
  #disposeStrata: (() => void) | undefined;

  static override readonly initialState: GameState = { ...Play.initialState, mode: "stress" };

  override async load(ctx: GameCtx): Promise<void> {
    this.#loadStart = Date.now();
    const [mannequin, sky, lodProp, strataWorld] = await Promise.all([
      ctx.assets.model<IPlayerModel>("mannequin.glb"),
      SKY_OPTIONS.sky === "photo" ? ctx.assets.texture("sky.jpg") : undefined,
      debugFlag("systems") && !debugFlag("noLods")
        ? ctx.assets.model<{ scene: Object3D }>("lod-prop.glb")
        : undefined,
      strataEnabled("worldCells")
        ? prepareStrataWorldCells(loadFactor(), strataEnabled("splatGround"))
        : undefined,
    ]);
    this.#mannequin = mannequin;
    this.#sky = sky;
    this.#lodProp = lodProp?.scene;
    this.#strataWorld = strataWorld;
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#mannequin === undefined) throw new Error("Stress scene did not finish loading.");
    const presetName = debugFlag("max") ? "max" : "real";
    const enabled = (layer: Layer) => !debugFlag(`no${layer[0]?.toUpperCase()}${layer.slice(1)}`);
    const system = (layer: System) =>
      debugFlag("systems") && !debugFlag(`no${layer[0]?.toUpperCase()}${layer.slice(1)}`);
    const extended = (layer: Extended) =>
      debugFlag("extended") && !debugFlag(`no${layer[0]?.toUpperCase()}${layer.slice(1)}`);
    const strata = (layer: Strata) => strataEnabled(layer);
    const surfaceY = (x: number, z: number) => (strata("splatGround") ? strataHeightAt(x, z) : 0);
    // `?load=N` scales the world's density for a break-point ramp; the vanilla lab reads the same knob.
    const load = loadFactor();
    // `?play` is the same world as a shipped game draws it: textured surfaces from a material library,
    // several meshes per layer, a camera that walks the streets, walkers that change gait and thrown
    // objects that are born and die. It makes no `random()` call, so `real` places the same world.
    const kit = debugFlag("play") ? playKit() : undefined;
    const base = PRESETS[presetName];
    const size: Record<keyof typeof base, number> = { ...base };
    for (const key of DENSITY) size[key] = Math.round(base[key] * load);
    const counts: Record<string, number> = {};
    const random = createRandom(4242);
    const spot = (avoidTown: boolean): [number, number] => {
      for (;;) {
        const x = (random() * 2 - 1) * WORLD;
        const z = (random() * 2 - 1) * WORLD;
        if (!avoidTown || Math.abs(x) > TOWN || Math.abs(z) > TOWN) return [x, z];
      }
    };

    if (!strata("strataPost")) {
      setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
    }
    // The same setup the kit's own scene runs, so the lab pays what a kit game pays.
    const { key, dispose: disposeLighting } = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    this.#disposeLighting = disposeLighting;
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    // A whole valley under one sun: camera-centred cached clip levels instead of one fitted map.
    // `?plainShadow` keeps the kit's single fitted map instead, to isolate the virtual shadow cost.
    const shadowNode = debugFlag("plainShadow")
      ? undefined
      : new VirtualShadowNode(key, {
          clipExtents: [16, 48, 160],
          // Finding: unset, the kit's 4096² sun map sizes every level and the atlas passes the device
          // texture limit, which loses the Wasm renderer (TN_VIRTUAL_SHADOW_UNSUPPORTED).
          mapSize: 2048,
        });
    if (shadowNode !== undefined) key.shadow.shadowNode = shadowNode;
    // Finding: the kit's radius 2 exceeds the Wasm engine's 2-texel page guard, and the renderer is
    // lost (TN_VIRTUAL_SHADOW_UNSUPPORTED). 1.5 is the widest PCF radius the guard accepts.
    key.shadow.radius = 1.5;
    if (!strata("strataPost")) {
      this.#post = ctx.entities.add(
        "quality",
        setupPost(ctx.renderer, ctx.scene, ctx.camera, {
          godraysLight: key,
          mobile: isMobile(),
          software: ctx.renderer.softwareAdapter !== undefined,
          gpuClass: ctx.renderer.gpuClass?.class,
          onTierChanged: (tier) =>
            this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment)),
          targetFps: resolveTargetFps(config, getPlatform()).targetFps,
          // Pinned so every run draws the same work; `?adaptive` lets the kit's quality policy react.
          ...(debugFlag("adaptive") ? {} : { tier: "high" as const }),
          ready: () => ctx.startup.phase === "ready",
        }),
      );
    }
    ctx.add(ctx.camera);

    if (!strata("splatGround")) {
      const ground = new Mesh(groundGeometry, kit?.ground ?? groundMaterial);
      ground.scale.set(WORLD * 2, 1, WORLD * 2);
      ground.receiveShadow = true;
      ctx.add(ground);
      const groundBody = new Object3D();
      groundBody.position.y = -0.5;
      ctx.add(groundBody);
      new RigidBody3D({
        object: groundBody,
        physics: ctx.physics,
        shape: CollisionShape3D.box(WORLD * 2, 1, WORLD * 2),
        type: "fixed",
      });
    }

    if (enabled("trees")) {
      const far = (geometry: typeof trunkGeometry) =>
        system("lods") ? { lods: [{ distance: FAR_LOD, geometry }] } : {};
      const species = (kit?.trees ?? [undefined]).map((tree) => ({
        trunks: new InstancedBatch({
          geometry: tree?.trunk ?? trunkGeometry,
          material: tree?.bark ?? trunkMaterial,
          ...far(trunkFarGeometry),
        }),
        canopies: new InstancedBatch({
          geometry: tree?.canopy ?? canopyGeometry,
          material: tree?.leaf ?? canopyMaterial,
          ...far(canopyFarGeometry),
        }),
      }));
      for (let i = 0; i < size.trees; i += 1) {
        const [x, z] = spot(true);
        const y = surfaceY(x, z);
        const height = 5 + random() * 7;
        const spin = random() * Math.PI * 2;
        const { trunks, canopies } = species[i % species.length] as (typeof species)[number];
        trunks.place({ position: [x, y, z], rotation: [0, spin, 0], scale: [1, height * 0.45, 1] });
        canopies.place({
          position: [x, y + height * 0.3, z],
          rotation: [0, spin, 0],
          scale: [height * 0.28, height * 0.75, height * 0.28],
        });
      }
      species.forEach(({ trunks, canopies }, i) => {
        trunks.build({
          castShadow: true,
          receiveShadow: true,
          name: `trunks${i}`,
          parent: ctx.scene,
        });
        canopies.build({
          castShadow: true,
          receiveShadow: true,
          name: `canopies${i}`,
          parent: ctx.scene,
        });
      });
      counts.trees = size.trees;
    }
    if (enabled("rocks")) {
      const kinds = (kit?.rocks ?? [{ geometry: rockGeometry, material: rockMaterial }]).map(
        (kind) =>
          new InstancedBatch(
            system("lods")
              ? { ...kind, lods: [{ distance: FAR_LOD, geometry: rockFarGeometry }] }
              : kind,
          ),
      );
      for (let i = 0; i < size.rocks; i += 1) {
        const [x, z] = spot(false);
        const s = 0.3 + random() * 1.6;
        (kinds[i % kinds.length] as InstancedBatch).place({
          position: [x, surfaceY(x, z) + s * 0.2, z],
          rotation: [random() * 3, random() * 3, 0],
          scale: [s, s * 0.7, s],
        });
      }
      kinds.forEach((rocks, i) =>
        rocks.build({
          castShadow: true,
          receiveShadow: true,
          name: `rocks${i}`,
          parent: ctx.scene,
        }),
      );
      counts.rocks = size.rocks;
    }
    const pickRoot = extended("picking") ? new Group() : undefined;
    if (pickRoot !== undefined) ctx.add(pickRoot);
    if (enabled("houses")) {
      // Hand-placed buildings, one mesh each, as a level editor exports them.
      const columns = Math.ceil(Math.sqrt(size.houses));
      for (let i = 0; i < size.houses; i += 1) {
        const house = new Group();
        const w = 4 + random() * 4;
        const h = 3 + random() * 4;
        const style = kit?.houses[i % kit.houses.length];
        const walls = new Mesh(houseGeometry, style?.wall ?? wallMaterial);
        walls.scale.set(w, h, w * 0.8);
        const roof = new Mesh(style?.roof ?? roofGeometry, style?.roofing ?? roofMaterial);
        roof.scale.set(w * 0.9, w * 0.5, w * 0.75);
        roof.position.y = h;
        const parts = [walls, roof];
        if (kit !== undefined && style !== undefined) {
          const chimney = new Mesh(kit.chimney, style.wall);
          chimney.scale.set(w, w * 0.9, w);
          chimney.position.y = h;
          parts.push(chimney);
        }
        for (const part of parts) {
          part.castShadow = true;
          part.receiveShadow = true;
        }
        house.add(...parts);
        // `play` moves each house away from both axes, so two avenues cross the town.
        const street = (at: number) => (kit === undefined ? at : at + Math.sign(at || 1) * AVENUE);
        const cx = street(((i % columns) / (columns - 1 || 1) - 0.5) * TOWN * 1.8);
        const cz = street((Math.floor(i / columns) / (columns - 1 || 1) - 0.5) * TOWN * 1.8);
        const hx = cx + (random() - 0.5) * 3;
        const hz = cz + (random() - 0.5) * 3;
        house.position.set(hx, surfaceY(hx, hz), hz);
        house.rotation.y = Math.floor(random() * 4) * (Math.PI / 2);
        if (pickRoot !== undefined) pickRoot.add(house);
        else ctx.add(house);
        if (system("frozen")) markStatic(house);
      }
      counts.houses = size.houses;
    }
    if (enabled("props")) {
      // Unique props, each with its own material: crates and barrels dressing the streets.
      for (let i = 0; i < size.props; i += 1) {
        // `real` gives each prop its own colour-only material; `play` shares a library, as a level does.
        // `systems&lods` draws every prop from the cooked chain, so each one is a LOD-managed mesh.
        const prop =
          this.#lodProp !== undefined
            ? this.#lodProp.clone()
            : kit === undefined
              ? new Mesh(i % 2 === 0 ? crateGeometry : barrelGeometry, propMaterial(i))
              : new Mesh(
                  kit.propGeometries[i % kit.propGeometries.length],
                  kit.propMaterials[(i * 7) % kit.propMaterials.length],
                );
        const s = 0.5 + random() * 0.6;
        prop.scale.setScalar(s);
        prop.position.set((random() * 2 - 1) * TOWN, s / 2, (random() * 2 - 1) * TOWN);
        prop.rotation.y = random() * Math.PI;
        prop.traverse((object) => {
          object.castShadow = true;
          object.receiveShadow = true;
        });
        ctx.add(prop);
        if (system("frozen")) markStatic(prop);
      }
      counts.props = size.props;
      if (system("frozen")) counts.frozen = (enabled("houses") ? size.houses : 0) + size.props;
      if (this.#lodProp !== undefined) counts.lodProps = size.props;
    }

    const walkers: {
      character: SkeletalMesh3D;
      holder: Group;
      radius: number;
      speed: number;
      phase: number;
      angle: number;
      state: number;
      snap: GroundSnap | undefined;
    }[] = [];
    if (enabled("crowd")) {
      for (let i = 0; i < size.crowd; i += 1) {
        const holder = new Group();
        const character = new SkeletalMesh3D({
          source: this.#mannequin.scene,
          clips: this.#mannequin.animations,
          requiredClips: kit === undefined ? ["Walk_Loop"] : WALKER_STATES.map(({ clip }) => clip),
          strideRoot: holder,
        });
        character.root.traverse((object) => {
          object.castShadow = true;
        });
        character.play("Walk_Loop");
        holder.add(character.root);
        ctx.add(holder);
        const radius = 6 + random() * (TOWN - 8);
        const speed = 1.2 + random() * 0.4;
        const phase = random() * Math.PI * 2;
        const snap = system("grounded") ? new GroundSnap(character.root) : undefined;
        walkers.push({ character, holder, radius, speed, phase, angle: phase, state: 0, snap });
      }
      counts.crowd = size.crowd;
      if (system("grounded")) counts.grounded = size.crowd;
      if (system("rays")) counts.rays = size.crowd;
    }

    const bodies: RigidBody3D[] = [];
    if (enabled("bodies")) {
      for (let i = 0; i < size.bodies; i += 1) {
        const box = new Mesh(crateGeometry, kit?.body ?? bodyMaterial);
        box.scale.setScalar(BODY_SIZE);
        box.castShadow = true;
        box.receiveShadow = true;
        ctx.add(box);
        bodies.push(
          new RigidBody3D({
            object: box,
            physics: ctx.physics,
            shape: CollisionShape3D.box(BODY_SIZE, BODY_SIZE, BODY_SIZE),
            mass: 4,
          }),
        );
      }
      counts.bodies = size.bodies;
    }
    const dropBodies = () => {
      bodies.forEach((body, i) => {
        const pile = i % 6;
        body.position = {
          x: Math.cos(pile) * 12 + random() * 3,
          y: 4 + (i / 6) * 0.7,
          z: Math.sin(pile) * 12 + random() * 3,
        };
        body.linearVelocity = { x: 0, y: 0, z: 0 };
      });
    };
    dropBodies();

    const fires: [number, number][] = [];
    for (let i = 0; i < Math.max(size.fires, size.lights); i += 1) {
      const angle = (i / Math.max(size.fires, size.lights)) * Math.PI * 2;
      fires.push([Math.cos(angle) * TOWN * 0.7, Math.sin(angle) * TOWN * 0.7]);
    }
    if (enabled("fires")) {
      for (const [x, z] of fires.slice(0, size.fires)) {
        const fire = new GPUParticles3D({
          amount: size.firePerEmitter,
          material: fireMaterial(),
          start: firePositions(size.firePerEmitter),
          process: firePositions(size.firePerEmitter),
        });
        fire.position.set(x, 0, z);
        ctx.add(fire);
      }
      counts.particles = size.fires * size.firePerEmitter;
    }
    const torches: PointLight[] = [];
    if (enabled("lights")) {
      for (const [x, z] of fires.slice(0, size.lights)) {
        const torch = new PointLight(TORCH_COLOR, TORCH_INTENSITY, TORCH_RANGE, 2);
        torch.position.set(x, 2.5, z);
        ctx.add(torch);
        torches.push(torch);
      }
      counts.lights = size.lights;
    }

    shadeLikeSubstrate(ctx.scene);
    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, key, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(this.#post?.tier ?? "high", materialEnvironment),
      }),
    );
    if (kit !== undefined) Object.assign(counts, kit.counts);
    const ext = setupExtendedLayers({
      ctx,
      extended,
      load,
      walkers,
      fires,
      pickRoot,
      counts,
    });
    this.#disposeExtended = ext.dispose;
    const strataSetup = setupStrataLayers({
      ctx,
      strata,
      load,
      preparedWorld: this.#strataWorld,
      shadowNode,
      counts,
    });
    this.#disposeStrata = strataSetup.dispose;
    const thrown: { mesh: Mesh; born: number; vx: number; vz: number }[] = [];
    let spawned = 0;
    const gpu = ctx.renderer.gpuClass?.fields;
    const post = this.#post;
    stressReport.begin(
      {
        commit: `core@${version}`,
        // Read at report time: with `?adaptive` the lane is named by the tier the quality policy landed on.
        get preset() {
          return `${presetName}${kit === undefined ? "" : "-play"}${load === 1 ? "" : `x${load}`}${
            debugFlag("adaptive") ? `-adaptive-${post?.tier ?? "high"}` : ""
          }`;
        },
        layers: [
          ...LAYERS.filter(enabled),
          ...SYSTEMS.filter(system),
          ...EXTENDED.filter(extended),
          ...STRATA.filter(strata),
        ],
        adapter: gpu === undefined ? "unknown" : `${gpu.vendor} / ${gpu.architecture}`,
        viewport: `${ctx.viewport.size.width}x${ctx.viewport.size.height}`,
        counts,
      },
      getPlatform().runtime === "web" ? Date.now() - this.#loadStart : null,
    );

    const camera = ctx.camera as PerspectiveCamera;
    camera.far = 600;
    camera.updateProjectionMatrix();
    const still = debugFlag("still");
    const rays = system("rays") && walkers.length > 0;
    const space = ctx.physics.directSpaceState;
    const closeup = debugFlag("closeup");
    // `?freezeAt=<s>` orbits until that time, then holds: a paired capture after a real pan path.
    const freezeAt = Number(
      new URLSearchParams(globalThis.location?.search ?? "").get("freezeAt") ?? 0,
    );
    let time = 0;
    let sinceDrop = 0;
    return (_frameCtx, dt) => {
      time += dt;
      fireClock.value = time;
      // `?still` holds the first pose (camera and walkers), so a before/after capture pair frames
      // the same image; `?closeup` frames the innermost walker (open ground) for judging its shadow.
      const clock = still ? 0 : freezeAt > 0 ? Math.min(time, freezeAt) : time;
      const orbit = (clock / ORBIT.seconds) * Math.PI * 2;
      camera.position.set(
        Math.cos(orbit) * ORBIT.radius,
        ORBIT.height + Math.sin(orbit * 2) * 4,
        Math.sin(orbit) * ORBIT.radius,
      );
      camera.lookAt(0, 2, 0);
      if (kit !== undefined) {
        const pose = playCamera(clock);
        camera.position.set(...pose.position);
        camera.lookAt(...pose.target);
        torches.forEach((torch, i) => {
          torch.intensity = TORCH_INTENSITY * (0.85 + 0.15 * Math.sin(clock * 11 + i));
        });
        // Game churn: an object is born every `THROW.every` seconds, flies an arc and is removed.
        while (!still && spawned < Math.floor(time / THROW.every)) {
          const [x, z] = fires[spawned % fires.length] as [number, number];
          const mesh = new Mesh(
            kit.propGeometries[spawned % kit.propGeometries.length],
            kit.propMaterials[(spawned * 5) % kit.propMaterials.length],
          );
          mesh.scale.setScalar(0.4);
          mesh.position.set(x, 1, z);
          mesh.castShadow = true;
          ctx.add(mesh);
          const aim = spawned * 2.399;
          thrown.push({ mesh, born: time, vx: Math.cos(aim) * 4, vz: Math.sin(aim) * 4 });
          spawned += 1;
        }
        for (let i = thrown.length - 1; i >= 0; i -= 1) {
          const item = thrown[i] as (typeof thrown)[number];
          const age = time - item.born;
          if (age > THROW.life) {
            item.mesh.removeFromParent();
            thrown.splice(i, 1);
            continue;
          }
          item.mesh.position.x += item.vx * dt;
          item.mesh.position.z += item.vz * dt;
          item.mesh.position.y = Math.max(
            0.2,
            1 + THROW.speed * age - 0.5 * THROW.gravity * age * age,
          );
          item.mesh.rotation.x = age * 3;
        }
      }
      for (const [index, walker] of walkers.entries()) {
        let angle = walker.phase + (clock * walker.speed) / walker.radius;
        if (kit !== undefined) {
          // Each walker changes gait on its own beat, with a short crossfade, and covers ground at that gait.
          const state =
            Math.floor((clock + index * 0.37) / WALKER_STATE_SECONDS + index) %
            WALKER_STATES.length;
          const gait = WALKER_STATES[state] as (typeof WALKER_STATES)[number];
          if (state !== walker.state) {
            walker.state = state;
            walker.character.play(gait.clip, { fade: WALKER_FADE_SECONDS });
          }
          walker.angle += still ? 0 : (dt * gait.speed) / walker.radius;
          angle = walker.angle;
        }
        walker.holder.position.set(
          Math.cos(angle) * walker.radius,
          0,
          Math.sin(angle) * walker.radius,
        );
        walker.holder.rotation.y = -angle;
        walker.character.update(still ? 0 : dt);
        // PRD-898 `rays`: one ground ray per walker per tick, as a character controller casts one.
        let ground = 0;
        if (rays) {
          const at = walker.holder.position;
          const hit = space.intersectRay({
            from: { x: at.x, y: at.y + 2, z: at.z },
            to: { x: at.x, y: at.y - 4, z: at.z },
          });
          if (hit !== undefined) ground = hit.position.y;
        }
        walker.snap?.apply(walker.character.root, ground, dt);
      }
      const subject = closeup ? walkers.reduce((a, b) => (b.radius < a.radius ? b : a)) : undefined;
      if (subject) {
        const at = subject.holder.position;
        camera.position.set(at.x * 1.12 + 2, 2.6, at.z * 1.12 + 2);
        camera.lookAt(at.x, 0.8, at.z);
      }
      sinceDrop += dt;
      if (sinceDrop > DROP_EVERY) {
        sinceDrop = 0;
        dropBodies();
      }
      ext.tick(clock, dt, still);
      strataSetup.tick(clock, dt, still);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#disposeStrata?.();
    this.#disposeStrata = undefined;
    this.#strataWorld = undefined;
    this.#disposeExtended?.();
    this.#disposeExtended = undefined;
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#disposeLighting?.();
    this.#disposeLighting = undefined;
    super.exit(ctx);
  }
}

interface IExtendedSetup {
  readonly ctx: GameCtx;
  readonly extended: (layer: Extended) => boolean;
  readonly load: number;
  readonly walkers: readonly { readonly holder: Group }[];
  readonly fires: readonly [number, number][];
  readonly pickRoot: Group | undefined;
  readonly counts: Record<string, number>;
}

function setupExtendedLayers({
  ctx,
  extended,
  load,
  walkers,
  fires,
  pickRoot,
  counts,
}: IExtendedSetup): {
  tick: (clock: number, dt: number, still: boolean) => void;
  dispose: () => void;
} {
  const random = createRandom(9191);
  const billboards: Billboard3D[] = [];
  if (extended("billboards")) {
    const count = walkers.length > 0 ? walkers.length : Math.round(120 * load);
    for (let i = 0; i < count; i += 1) {
      const bar = new Mesh(billboardGeometry, billboardMaterial);
      const holder = walkers[i]?.holder;
      if (holder !== undefined) {
        bar.position.set(0, 2.2, 0);
        holder.add(bar);
      } else {
        bar.position.set((random() * 2 - 1) * TOWN, 2.2, (random() * 2 - 1) * TOWN);
        ctx.add(bar);
      }
      billboards.push(
        new Billboard3D(bar, {
          camera: ctx.camera,
          lockAxis: i % 2 === 0 ? "y" : undefined,
        }),
      );
    }
    counts.billboards = billboards.length;
  }

  const npcs: { body: CharacterBody3D; cx: number; cz: number; phase: number }[] = [];
  if (extended("characters")) {
    const npcCount = Math.round(EXTENDED_SIZES.characters * load);
    for (let i = 0; i < npcCount; i += 1) {
      const cx = (random() * 2 - 1) * (TOWN * 0.75);
      const cz = (random() * 2 - 1) * (TOWN * 0.75);
      const mesh = new Mesh(npcGeometry, npcMaterial);
      mesh.position.set(cx, 1, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      ctx.add(mesh);
      const body = new CharacterBody3D({
        object: mesh,
        physics: ctx.physics,
        shape: CollisionShape3D.capsule(0.32, 0.45),
        offset: 0.02,
      });
      npcs.push({ body, cx, cz, phase: (i / npcCount) * Math.PI * 2 });
    }
    counts.characters = npcs.length;
  }

  const areas: Area3D[] = [];
  let areaEnteredCount = 0;
  if (extended("areas")) {
    for (let i = 0; i < EXTENDED_SIZES.areas; i += 1) {
      const angle = (i / EXTENDED_SIZES.areas) * Math.PI * 2;
      const area = new Area3D({
        physics: ctx.physics,
        position: { x: Math.cos(angle) * TOWN * 0.55, y: 1, z: Math.sin(angle) * TOWN * 0.55 },
        shape: CollisionShape3D.sphere(3),
      });
      area.on("bodyEntered", () => {
        areaEnteredCount += 1;
      });
      areas.push(area);
    }
    counts.areas = areas.length;
  }

  if (extended("transparent")) {
    const cutoutMat = leafCutoutMaterial();
    const cutoutCount = Math.round(EXTENDED_SIZES.cutoutLeaves * load);
    for (let i = 0; i < cutoutCount; i += 1) {
      const leaf = new Mesh(leafGeometry, cutoutMat);
      leaf.position.set((random() * 2 - 1) * TOWN * 1.4, 0.7, (random() * 2 - 1) * TOWN * 1.4);
      leaf.rotation.y = random() * Math.PI * 2;
      leaf.castShadow = true;
      leaf.receiveShadow = true;
      ctx.add(leaf);
    }
    const glassCount = Math.round(EXTENDED_SIZES.glassPanels * load);
    for (let i = 0; i < glassCount; i += 1) {
      const glass = new Mesh(glassGeometry, glassMaterial);
      glass.position.set((random() * 2 - 1) * TOWN * 0.9, 1.2, (random() * 2 - 1) * TOWN * 0.9);
      glass.rotation.y = random() * Math.PI;
      ctx.add(glass);
    }
    counts.transparent = cutoutCount + glassCount;
  }

  const spotlights: { light: SpotLight; baseAngle: number }[] = [];
  if (extended("spotlights")) {
    for (let i = 0; i < EXTENDED_SIZES.spotlights; i += 1) {
      const baseAngle = (i / EXTENDED_SIZES.spotlights) * Math.PI * 2 + Math.PI / 4;
      const spot = new SpotLight(
        SPOTLIGHT_COLOR,
        SPOTLIGHT_INTENSITY,
        SPOTLIGHT_DISTANCE,
        SPOTLIGHT_ANGLE,
        0.35,
        2,
      );
      spot.position.set(Math.cos(baseAngle) * 32, 12, Math.sin(baseAngle) * 32);
      spot.target.position.set(Math.cos(baseAngle) * 8, 0, Math.sin(baseAngle) * 8);
      spot.castShadow = true;
      spot.shadow.camera.near = 1;
      spot.shadow.camera.far = SPOTLIGHT_DISTANCE;
      spot.shadow.radius = 1.5;
      ctx.add(spot);
      ctx.add(spot.target);
      spotlights.push({ light: spot, baseAngle });
    }
    counts.spotlights = spotlights.length;
  }

  let dynamicMesh: InstancedMesh | undefined;
  let dynamicIndices: Uint32Array | undefined;
  let dynamicBase: Float32Array | undefined;
  const markerPos = new Vector3();
  const markerQuat = new Quaternion();
  const markerScale = new Vector3(1, 1, 1);
  const markerMat = new Matrix4();
  if (extended("dynamicBatch")) {
    const total = Math.round(EXTENDED_SIZES.markers * load);
    const batch = new InstancedBatch({ geometry: markerGeometry, material: markerMaterial });
    const animated: number[] = [];
    const baseCoords: number[] = [];
    for (let i = 0; i < total; i += 1) {
      const x = (random() * 2 - 1) * TOWN * 2.2;
      const y = 1.8 + random() * 2.5;
      const z = (random() * 2 - 1) * TOWN * 2.2;
      batch.place({ position: [x, y, z], rotation: [0, random() * Math.PI * 2, 0] });
      if (i % 20 === 0) {
        animated.push(i);
        baseCoords.push(x, y, z);
      }
    }
    dynamicMesh = batch.build({ name: "extendedMarkers", parent: ctx.scene });
    dynamicIndices = new Uint32Array(animated);
    dynamicBase = new Float32Array(baseCoords);
    counts.dynamicBatch = total;
  }

  let audioListener: AudioListener | undefined;
  const audioVoices: PositionalAudio[] = [];
  if (extended("audio") && typeof globalThis.AudioContext === "function") {
    audioListener = new AudioListener();
    ctx.camera.add(audioListener);
    for (let i = 0; i < EXTENDED_SIZES.audio; i += 1) {
      const voice = new PositionalAudio(audioListener);
      // Silent AudioNode source marks hasPlaybackControl = false cleanly so sync(true) runs every frame without audible playback.
      voice.setNodeSource(audioListener.context.createGain());
      voice.setRefDistance(4);
      voice.setRolloffFactor(1);
      const walker = walkers[i];
      if (i >= EXTENDED_SIZES.audio / 2 && walker !== undefined) {
        walker.holder.add(voice);
      } else {
        const [fx, fz] = fires[i % Math.max(1, fires.length)] ?? [0, 0];
        voice.position.set(fx, 1.5, fz);
        ctx.add(voice);
      }
      audioVoices.push(voice);
    }
    counts.audio = audioVoices.length;
  }

  const raycaster = extended("picking") ? new Raycaster() : undefined;
  const rayOrigin = new Vector3();
  const rayDir = new Vector3();
  let pickSink = 0;
  if (raycaster !== undefined && pickRoot !== undefined) {
    if (pickRoot.children.length === 0) {
      for (let i = 0; i < 16; i += 1) {
        const box = new Mesh(glassGeometry, billboardMaterial);
        box.position.set((random() * 2 - 1) * TOWN, 1, (random() * 2 - 1) * TOWN);
        pickRoot.add(box);
      }
    }
    raycaster.far = 200;
    counts.picking = EXTENDED_SIZES.raysPerFrame;
  }

  const hudActive = extended("hud");
  let hudTick = 0;
  if (hudActive) counts.hud = 1;

  return {
    tick: (clock, dt, still) => {
      for (const billboard of billboards) billboard.update(ctx.camera);
      for (const npc of npcs) {
        if (!still) {
          const a = clock * 1.1 + npc.phase;
          npc.body.velocity.set(Math.cos(a) * 3.5, npc.body.velocity.y, Math.sin(a) * 3.5);
        } else {
          npc.body.velocity.set(0, 0, 0);
        }
        npc.body.moveAndSlide(still ? 0 : dt);
      }
      if (!still) {
        for (const { light, baseAngle } of spotlights) {
          const sweep = baseAngle + Math.sin(clock * 0.7) * 0.45;
          light.target.position.set(Math.cos(sweep) * 10, 0, Math.sin(sweep) * 10);
        }
      }
      if (
        !still &&
        dynamicMesh !== undefined &&
        dynamicIndices !== undefined &&
        dynamicBase !== undefined
      ) {
        for (let i = 0; i < dynamicIndices.length; i += 1) {
          const idx = dynamicIndices[i] as number;
          const bx = dynamicBase[i * 3] as number;
          const by = dynamicBase[i * 3 + 1] as number;
          const bz = dynamicBase[i * 3 + 2] as number;
          markerPos.set(bx, by + Math.sin(clock * 3 + idx) * 0.5, bz);
          markerQuat.setFromAxisAngle(UP_AXIS, clock * 1.5 + idx);
          markerMat.compose(markerPos, markerQuat, markerScale);
          dynamicMesh.setMatrixAt(idx, markerMat);
        }
        dynamicMesh.instanceMatrix.needsUpdate = true;
      }
      if (raycaster !== undefined && pickRoot !== undefined) {
        for (let i = 0; i < EXTENDED_SIZES.raysPerFrame; i += 1) {
          const angle = clock * 0.6 + (i / EXTENDED_SIZES.raysPerFrame) * Math.PI * 2;
          rayOrigin.set(Math.cos(angle) * 40, 2.2, Math.sin(angle) * 40);
          rayDir.set(-Math.cos(angle), -0.05, -Math.sin(angle)).normalize();
          raycaster.set(rayOrigin, rayDir);
          pickSink += raycaster.intersectObject(pickRoot, true).length;
        }
      }
      if (hudActive) {
        hudTick += 1;
        ctx.state.set({ stressTick: hudTick + (areaEnteredCount & 0) + (pickSink & 0) });
      }
    },
    dispose: () => {
      for (const area of areas) area.dispose();
      for (const { body } of npcs) body.dispose();
      for (const voice of audioVoices) {
        voice.disconnect();
        voice.removeFromParent();
      }
      audioListener?.removeFromParent();
      for (const { light } of spotlights) {
        light.target.removeFromParent();
        light.removeFromParent();
        light.dispose();
      }
    },
  };
}

const UP_AXIS = new Vector3(0, 1, 0);
