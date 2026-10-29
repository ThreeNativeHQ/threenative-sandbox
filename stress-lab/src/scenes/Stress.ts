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
  version,
} from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { Group, Mesh, Object3D, type PerspectiveCamera, PointLight, type Texture } from "three";
import { type IPlayerModel } from "../entities/Player.js";
import { setupLighting } from "../render/lighting.js";
import { setupPost } from "../render/postprocessing.js";
import { setupSky } from "../render/sky.js";
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

  static override readonly initialState: GameState = { ...Play.initialState, mode: "stress" };

  override async load(ctx: GameCtx): Promise<void> {
    this.#loadStart = Date.now();
    const [mannequin, sky] = await Promise.all([
      ctx.assets.model<IPlayerModel>("mannequin.glb"),
      ctx.assets.texture("sky.jpg"),
    ]);
    this.#mannequin = mannequin;
    this.#sky = sky;
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#mannequin === undefined || this.#sky === undefined)
      throw new Error("Stress scene did not finish loading.");
    const presetName = debugFlag("max") ? "max" : "real";
    const enabled = (layer: Layer) => !debugFlag(`no${layer[0]?.toUpperCase()}${layer.slice(1)}`);
    const size = PRESETS[presetName];
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
    const { key } = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
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
        // Pinned so every run draws the same work; `?adaptive` lets the kit's quality policy react.
        ...(debugFlag("adaptive") ? {} : { tier: "high" as const }),
        ready: () => ctx.startup.phase === "ready",
      }),
    );
    ctx.add(ctx.camera);

    const ground = new Mesh(groundGeometry, groundMaterial);
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
      const trunks = new InstancedBatch({ geometry: trunkGeometry, material: trunkMaterial });
      const canopies = new InstancedBatch({ geometry: canopyGeometry, material: canopyMaterial });
      for (let i = 0; i < size.trees; i += 1) {
        const [x, z] = spot(true);
        const height = 5 + random() * 7;
        const spin = random() * Math.PI * 2;
        trunks.place({ position: [x, 0, z], rotation: [0, spin, 0], scale: [1, height * 0.45, 1] });
        canopies.place({
          position: [x, height * 0.3, z],
          rotation: [0, spin, 0],
          scale: [height * 0.28, height * 0.75, height * 0.28],
        });
      }
      trunks.build({ castShadow: true, receiveShadow: true, name: "trunks", parent: ctx.scene });
      canopies.build({
        castShadow: true,
        receiveShadow: true,
        name: "canopies",
        parent: ctx.scene,
      });
      counts.trees = size.trees;
    }
    if (enabled("rocks")) {
      const rocks = new InstancedBatch({ geometry: rockGeometry, material: rockMaterial });
      for (let i = 0; i < size.rocks; i += 1) {
        const [x, z] = spot(false);
        const s = 0.3 + random() * 1.6;
        rocks.place({
          position: [x, s * 0.2, z],
          rotation: [random() * 3, random() * 3, 0],
          scale: [s, s * 0.7, s],
        });
      }
      rocks.build({ castShadow: true, receiveShadow: true, name: "rocks", parent: ctx.scene });
      counts.rocks = size.rocks;
    }
    if (enabled("houses")) {
      // Hand-placed buildings, one mesh each, as a level editor exports them.
      const columns = Math.ceil(Math.sqrt(size.houses));
      for (let i = 0; i < size.houses; i += 1) {
        const house = new Group();
        const w = 4 + random() * 4;
        const h = 3 + random() * 4;
        const walls = new Mesh(houseGeometry, wallMaterial);
        walls.scale.set(w, h, w * 0.8);
        const roof = new Mesh(roofGeometry, roofMaterial);
        roof.scale.set(w * 0.9, w * 0.5, w * 0.75);
        roof.position.y = h;
        for (const part of [walls, roof]) {
          part.castShadow = true;
          part.receiveShadow = true;
        }
        house.add(walls, roof);
        const cx = ((i % columns) / (columns - 1 || 1) - 0.5) * TOWN * 1.8;
        const cz = (Math.floor(i / columns) / (columns - 1 || 1) - 0.5) * TOWN * 1.8;
        house.position.set(cx + (random() - 0.5) * 3, 0, cz + (random() - 0.5) * 3);
        house.rotation.y = Math.floor(random() * 4) * (Math.PI / 2);
        ctx.add(house);
      }
      counts.houses = size.houses;
    }
    if (enabled("props")) {
      // Unique props, each with its own material: crates and barrels dressing the streets.
      for (let i = 0; i < size.props; i += 1) {
        const prop = new Mesh(i % 2 === 0 ? crateGeometry : barrelGeometry, propMaterial(i));
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
    }[] = [];
    if (enabled("crowd")) {
      for (let i = 0; i < size.crowd; i += 1) {
        const holder = new Group();
        const character = new SkeletalMesh3D({
          source: this.#mannequin.scene,
          clips: this.#mannequin.animations,
          requiredClips: ["Walk_Loop"],
          strideRoot: holder,
        });
        character.root.traverse((object) => {
          object.castShadow = true;
        });
        character.play("Walk_Loop");
        holder.add(character.root);
        ctx.add(holder);
        walkers.push({
          character,
          holder,
          radius: 6 + random() * (TOWN - 8),
          speed: 1.2 + random() * 0.4,
          phase: random() * Math.PI * 2,
        });
      }
      counts.crowd = size.crowd;
    }

    const bodies: RigidBody3D[] = [];
    if (enabled("bodies")) {
      for (let i = 0; i < size.bodies; i += 1) {
        const box = new Mesh(crateGeometry, bodyMaterial);
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
    if (enabled("lights")) {
      for (const [x, z] of fires.slice(0, size.lights)) {
        const torch = new PointLight(TORCH_COLOR, TORCH_INTENSITY, TORCH_RANGE, 2);
        torch.position.set(x, 2.5, z);
        ctx.add(torch);
      }
      counts.lights = size.lights;
    }

    const gpu = ctx.renderer.gpuClass?.fields;
    stressReport.begin(
      {
        commit: `core@${version}`,
        preset: presetName,
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
    let time = 0;
    let sinceDrop = 0;
    return (_frameCtx, dt) => {
      time += dt;
      fireClock.value = time;
      // `?still` holds the first pose, so a before/after capture pair frames the same view.
      const orbit = still ? 0 : (time / ORBIT.seconds) * Math.PI * 2;
      camera.position.set(
        Math.cos(orbit) * ORBIT.radius,
        ORBIT.height + Math.sin(orbit * 2) * 4,
        Math.sin(orbit) * ORBIT.radius,
      );
      camera.lookAt(0, 2, 0);
      for (const walker of walkers) {
        const angle = walker.phase + (time * walker.speed) / walker.radius;
        walker.holder.position.set(
          Math.cos(angle) * walker.radius,
          0,
          Math.sin(angle) * walker.radius,
        );
        walker.holder.rotation.y = -angle;
        walker.character.update(dt);
      }
      sinceDrop += dt;
      if (sinceDrop > DROP_EVERY) {
        sinceDrop = 0;
        dropBodies();
      }
    };
  }

  override exit(ctx: GameCtx): void {
    this.#post?.dispose();
    this.#post = undefined;
    super.exit(ctx);
  }
}
