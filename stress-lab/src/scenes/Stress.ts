import {
  GPUParticles3D,
  InstancedBatch,
  Scene,
  type SceneFrame,
  SkeletalMesh3D,
  VirtualShadowNode,
  createRandom,
  debugFlag,
  getPlatform,
  isMobile,
  resolveTargetFps,
  version,
} from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { Group, Mesh, Object3D, type PerspectiveCamera, PointLight, type Texture } from "three";
import config from "../../threenative.config.js";
import { type IPlayerModel } from "../entities/Player.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting, shadeLikeSubstrate } from "../render/lighting.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { SKY_OPTIONS, setupSky } from "../render/sky.js";
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
  rockGeometry,
  rockMaterial,
  roofGeometry,
  roofMaterial,
  trunkGeometry,
  trunkMaterial,
  wallMaterial,
} from "../render/stress.js";
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

const WORLD = 180; // half-size, metres
const TOWN = 45; // half-size of the cleared town square
const ORBIT = { radius: 70, height: 24, seconds: 40 } as const;
const BODY_SIZE = 0.6;
const DROP_EVERY = 8;

export class Stress extends Scene<GameState, IPhysicsContext> {
  #mannequin: IPlayerModel | undefined;
  #sky: Texture | undefined;
  #loadStart = 0;
  #post: ReturnType<typeof setupPost> | undefined;
  #disposeLighting: (() => void) | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  static override readonly initialState: GameState = { ...Play.initialState, mode: "stress" };

  override async load(ctx: GameCtx): Promise<void> {
    this.#loadStart = Date.now();
    const [mannequin, sky] = await Promise.all([
      ctx.assets.model<IPlayerModel>("mannequin.glb"),
      SKY_OPTIONS.sky === "photo" ? ctx.assets.texture("sky.jpg") : undefined,
    ]);
    this.#mannequin = mannequin;
    this.#sky = sky;
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#mannequin === undefined) throw new Error("Stress scene did not finish loading.");
    const presetName = debugFlag("max") ? "max" : "real";
    const enabled = (layer: Layer) => !debugFlag(`no${layer[0]?.toUpperCase()}${layer.slice(1)}`);
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

    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
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
    if (!debugFlag("plainShadow"))
      key.shadow.shadowNode = new VirtualShadowNode(key, {
        clipExtents: [16, 48, 160],
        // Finding: unset, the kit's 4096² sun map sizes every level and the atlas passes the device
        // texture limit, which loses the Wasm renderer (TN_VIRTUAL_SHADOW_UNSUPPORTED).
        mapSize: 2048,
      });
    // Finding: the kit's radius 2 exceeds the Wasm engine's 2-texel page guard, and the renderer is
    // lost (TN_VIRTUAL_SHADOW_UNSUPPORTED). 1.5 is the widest PCF radius the guard accepts.
    key.shadow.radius = 1.5;
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
    ctx.add(ctx.camera);

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

    if (enabled("trees")) {
      const species = (kit?.trees ?? [undefined]).map((tree) => ({
        trunks: new InstancedBatch({
          geometry: tree?.trunk ?? trunkGeometry,
          material: tree?.bark ?? trunkMaterial,
        }),
        canopies: new InstancedBatch({
          geometry: tree?.canopy ?? canopyGeometry,
          material: tree?.leaf ?? canopyMaterial,
        }),
      }));
      for (let i = 0; i < size.trees; i += 1) {
        const [x, z] = spot(true);
        const height = 5 + random() * 7;
        const spin = random() * Math.PI * 2;
        const { trunks, canopies } = species[i % species.length] as (typeof species)[number];
        trunks.place({ position: [x, 0, z], rotation: [0, spin, 0], scale: [1, height * 0.45, 1] });
        canopies.place({
          position: [x, height * 0.3, z],
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
        (kind) => new InstancedBatch(kind),
      );
      for (let i = 0; i < size.rocks; i += 1) {
        const [x, z] = spot(false);
        const s = 0.3 + random() * 1.6;
        (kinds[i % kinds.length] as InstancedBatch).place({
          position: [x, s * 0.2, z],
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
        house.position.set(cx + (random() - 0.5) * 3, 0, cz + (random() - 0.5) * 3);
        house.rotation.y = Math.floor(random() * 4) * (Math.PI / 2);
        ctx.add(house);
      }
      counts.houses = size.houses;
    }
    if (enabled("props")) {
      // Unique props, each with its own material: crates and barrels dressing the streets.
      for (let i = 0; i < size.props; i += 1) {
        // `real` gives each prop its own colour-only material; `play` shares a library, as a level does.
        const prop =
          kit === undefined
            ? new Mesh(i % 2 === 0 ? crateGeometry : barrelGeometry, propMaterial(i))
            : new Mesh(
                kit.propGeometries[i % kit.propGeometries.length],
                kit.propMaterials[(i * 7) % kit.propMaterials.length],
              );
        const s = 0.5 + random() * 0.6;
        prop.scale.setScalar(s);
        prop.position.set((random() * 2 - 1) * TOWN, s / 2, (random() * 2 - 1) * TOWN);
        prop.rotation.y = random() * Math.PI;
        prop.castShadow = true;
        prop.receiveShadow = true;
        ctx.add(prop);
      }
      counts.props = size.props;
    }

    const walkers: {
      character: SkeletalMesh3D;
      holder: Group;
      radius: number;
      speed: number;
      phase: number;
      angle: number;
      state: number;
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
        walkers.push({ character, holder, radius, speed, phase, angle: phase, state: 0 });
      }
      counts.crowd = size.crowd;
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
        enabled: materialLightingEnabled(this.#post.tier, materialEnvironment),
      }),
    );
    if (kit !== undefined) Object.assign(counts, kit.counts);
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
            debugFlag("adaptive") ? `-adaptive-${post.tier}` : ""
          }`;
        },
        layers: LAYERS.filter(enabled),
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
    };
  }

  override exit(ctx: GameCtx): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#disposeLighting?.();
    this.#disposeLighting = undefined;
    super.exit(ctx);
  }
}
