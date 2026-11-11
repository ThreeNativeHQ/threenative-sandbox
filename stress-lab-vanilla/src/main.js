// The vanilla arm of the stress lab: `sandbox/stress-lab`'s scene in plain three.js, on WebGPU, with no
// framework. It exists so the stress benchmark has a control: the same layers, counts and triangles,
// drawn by ordinary three.js, measured by the same `__TN_STRESS__` report.
//
// Why it lives outside the framework: PRD-828 moves engine work from JS into C++. That claim is only
// worth reading against a second implementation that moved nothing.
import {
  AdditiveBlending,
  AnimationMixer,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  EquirectangularReflectionMapping,
  Euler,
  FogExp2,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Points,
  PointsNodeMaterial,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { deinterleaveGeometry } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { attribute, cos, float, fract, sin, uniform, vec3 } from "three/tsl";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { publish, StressReport } from "./report.js";
import {
  AVENUE,
  THROW,
  WALKER_FADE_SECONDS,
  WALKER_STATES,
  WALKER_STATE_SECONDS,
  playCamera,
  playKit,
} from "./stressPlay.ts";

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
};
/** The layers `?load=N` multiplies; fires, fire particles and lights stay fixed. Same list as the Wasm arm. */
const DENSITY = ["trees", "rocks", "houses", "props", "crowd", "bodies"];
const LAYERS = ["trees", "rocks", "houses", "props", "crowd", "bodies", "fires", "lights"];

const WORLD = 180;
const TOWN = 45;
const ORBIT = { radius: 70, height: 24, seconds: 40 };
const BODY_SIZE = 0.6;
const DROP_EVERY = 8;
const SKY_RANGE = 2.5;
const SUN_DIRECTION = new Vector3(0.555, 0.742, 0.38).normalize();
const TORCH_COLOR = 0xff9a4a;
const TORCH_INTENSITY = 30;
const TORCH_RANGE = 14;

const params = new URLSearchParams(globalThis.location.search);
const flag = (name) => params.has(name);

function loadFactor() {
  const raw = params.get("load");
  const load = raw === null ? 1 : Number(raw);
  if (!(load > 0 && load <= 16)) throw new Error(`?load must be a number in (0, 16], got "${raw}".`);
  return load;
}

/** `createRandom` from core is a mulberry32; the same generator keeps the two arms' placement statistics equal. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One campfire's particles, in emitter space: rising, narrowing, cooling from yellow to red. TSL on the GPU,
 * the same curve the Wasm arm's `fireMaterial` draws; the vertex shader is the whole animation.
 */
function fireMaterial() {
  const clock = uniform(0);
  const seed = attribute("aSeed", "vec4");
  const t = fract(clock.mul(seed.x.mul(0.5).add(0.45)).add(seed.y));
  const angle = seed.z.mul(6.2831853).add(t.mul(2));
  const radius = seed.w.mul(0.7).mul(t.mul(-0.8).add(1));
  const material = new PointsNodeMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  material.positionNode = vec3(cos(angle).mul(radius), t.mul(3.2), sin(angle).mul(radius));
  const heat = float(1).sub(t);
  material.colorNode = vec3(1, heat.mul(0.7).add(0.15), heat.mul(heat).mul(0.25)).mul(
    heat.mul(0.9),
  );
  material.opacityNode = heat;
  material.sizeNode = heat.mul(0.55).add(0.12).mul(90);
  return { material, clock };
}

/** `?noTrees` and friends switch a layer off by name, the same convention the Wasm arm reads. */
const enabled = (layer) => !flag(`no${layer[0].toUpperCase()}${layer.slice(1)}`);

/** The world `Stress.ts` builds, in the same order and with the same counts. */
function build(scene, { mannequin, sky, load }) {
  const presetName = flag("max") ? "max" : "real";
  const base = PRESETS[presetName];
  const size = { ...base };
  for (const key of DENSITY) size[key] = Math.round(base[key] * load);
  const counts = {};
  // `?play`: the same gameplay preset `Stress.ts` draws (stressPlay.ts is a verbatim copy). It makes no
  // `random()` call, so without the flag nothing below changes.
  const kit = flag("play") ? playKit() : undefined;
  const random = createRandom(4242);
  const spot = (avoidTown) => {
    for (;;) {
      const x = (random() * 2 - 1) * WORLD;
      const z = (random() * 2 - 1) * WORLD;
      if (!avoidTown || Math.abs(x) > TOWN || Math.abs(z) > TOWN) return [x, z];
    }
  };

  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  scene.backgroundIntensity = SKY_RANGE;
  scene.environment = sky;
  scene.environmentIntensity = SKY_RANGE;
  scene.fog = new FogExp2(0x9fb4c6, 0.0035);

  // One sun, one fitted shadow map: the same shadow technique the plain-Shadow arm of the Wasm engine runs.
  const sun = new DirectionalLight(0xfff1e0, 4.5);
  sun.position.copy(SUN_DIRECTION).multiplyScalar(120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.radius = 1.5;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  const extent = WORLD * 0.9;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  const ground = new Mesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    kit?.ground ?? new MeshStandardMaterial({ color: 0x5d6b3a, roughness: 0.95 }),
  );
  ground.scale.set(WORLD * 2, 1, WORLD * 2);
  ground.receiveShadow = true;
  scene.add(ground);

  const material = (color, roughness) => new MeshStandardMaterial({ color, roughness });
  const trunk = new CylinderGeometry(0.12, 0.2, 1, 7).translate(0, 0.5, 0);
  const canopy = new ConeGeometry(1, 1, 9).translate(0, 0.5, 0);
  const rock = new DodecahedronGeometry(0.5, 0);
  const house = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const roof = new ConeGeometry(0.8, 0.6, 4).rotateY(Math.PI / 4).translate(0, 0.3, 0);
  const crate = new BoxGeometry(1, 1, 1);
  const barrel = new CylinderGeometry(0.4, 0.4, 1, 12);

  /** One instanced draw per geometry: what the Wasm arm's renderer merges into one draw too. */
  const instances = (geometry, tint, capacity, name) => {
    // `tint` is a colour for `real`, or a ready material from the `play` kit.
    const mesh = new InstancedMesh(geometry, tint.isMaterial ? tint : material(tint, 0.85), capacity);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const matrix = new Matrix4();
    const position = new Vector3();
    const euler = new Euler();
    const scaleVector = new Vector3();
    let placed = 0;
    return {
      place(at, spin, scale, hue) {
        position.set(at[0], at[1], at[2]);
        matrix.makeRotationFromEuler(euler.set(spin[0], spin[1], spin[2]));
        matrix.scale(scaleVector.set(scale[0], scale[1], scale[2]));
        matrix.setPosition(position);
        mesh.setMatrixAt(placed, matrix);
        if (hue !== undefined) mesh.setColorAt(placed, hue);
        placed += 1;
      },
      done() {
        mesh.count = placed;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
        scene.add(mesh);
      },
    };
  };

  if (enabled("trees")) {
    // `play`: one trunk mesh and one canopy mesh per species, tree `i` uses species `i % n`.
    const share = kit === undefined ? size.trees : Math.ceil(size.trees / kit.trees.length);
    const species =
      kit === undefined
        ? [
            {
              trunks: instances(trunk, 0x5a4030, share, "trunks"),
              canopies: instances(canopy, 0x2f5a2a, share, "canopies"),
            },
          ]
        : kit.trees.map((tree, i) => ({
            trunks: instances(tree.trunk, tree.bark, share, `trunks${i}`),
            canopies: instances(tree.canopy, tree.leaf, share, `canopies${i}`),
          }));
    for (let i = 0; i < size.trees; i += 1) {
      const [x, z] = spot(true);
      const height = 5 + random() * 7;
      const spin = random() * Math.PI * 2;
      const { trunks, canopies } = species[i % species.length];
      trunks.place([x, 0, z], [0, spin, 0], [1, height * 0.45, 1]);
      canopies.place(
        [x, height * 0.3, z],
        [0, spin, 0],
        [height * 0.28, height * 0.75, height * 0.28],
      );
    }
    for (const { trunks, canopies } of species) {
      trunks.done();
      canopies.done();
    }
    counts.trees = size.trees;
  }
  if (enabled("rocks")) {
    const kinds =
      kit === undefined
        ? [instances(rock, 0x7c7a74, size.rocks, "rocks")]
        : kit.rocks.map((kind, i) =>
            instances(kind.geometry, kind.material, Math.ceil(size.rocks / kit.rocks.length), `rocks${i}`),
          );
    for (let i = 0; i < size.rocks; i += 1) {
      const [x, z] = spot(false);
      const s = 0.3 + random() * 1.6;
      kinds[i % kinds.length].place([x, s * 0.2, z], [random() * 3, random() * 3, 0], [s, s * 0.7, s]);
    }
    for (const rocks of kinds) rocks.done();
    counts.rocks = size.rocks;
  }
  if (enabled("houses")) {
    const columns = Math.ceil(Math.sqrt(size.houses));
    // `real` batches the houses; `play` builds each one as its own group of meshes, as `Stress.ts` does.
    const batched =
      kit === undefined
        ? {
            walls: instances(house, 0xc9b99a, size.houses, "walls"),
            roofs: instances(roof, 0x8a3b2c, size.houses, "roofs"),
          }
        : undefined;
    // `play` moves each house away from both axes, so two avenues cross the town.
    const street = (at) => (kit === undefined ? at : at + Math.sign(at || 1) * AVENUE);
    for (let i = 0; i < size.houses; i += 1) {
      const w = 4 + random() * 4;
      const h = 3 + random() * 4;
      const cx = street(((i % columns) / (columns - 1 || 1) - 0.5) * TOWN * 1.8);
      const cz = street((Math.floor(i / columns) / (columns - 1 || 1) - 0.5) * TOWN * 1.8);
      const atX = cx + (random() - 0.5) * 3;
      const atZ = cz + (random() - 0.5) * 3;
      const spin = Math.floor(random() * 4) * (Math.PI / 2);
      if (batched !== undefined) {
        batched.walls.place([atX, 0, atZ], [0, spin, 0], [w, h, w * 0.8]);
        batched.roofs.place([atX, h, atZ], [0, spin, 0], [w * 0.9, w * 0.5, w * 0.75]);
        continue;
      }
      const style = kit.houses[i % kit.houses.length];
      const group = new Group();
      const walls = new Mesh(house, style.wall);
      walls.scale.set(w, h, w * 0.8);
      const roofMesh = new Mesh(style.roof, style.roofing);
      roofMesh.scale.set(w * 0.9, w * 0.5, w * 0.75);
      roofMesh.position.y = h;
      const chimney = new Mesh(kit.chimney, style.wall);
      chimney.scale.set(w, w * 0.9, w);
      chimney.position.y = h;
      const parts = [walls, roofMesh, chimney];
      for (const part of parts) {
        part.castShadow = true;
        part.receiveShadow = true;
      }
      group.add(...parts);
      group.position.set(atX, 0, atZ);
      group.rotation.y = spin;
      scene.add(group);
    }
    if (batched !== undefined) {
      batched.walls.done();
      batched.roofs.done();
    }
    counts.houses = size.houses;
  }
  if (enabled("props")) {
    // Unique props, each with its own colour: crates and barrels dressing the streets.
    // `play` shares a material library across single meshes, as a level does; `real` batches coloured instances.
    const crates = kit === undefined ? instances(crate, 0xffffff, size.props, "crates") : undefined;
    const barrels = kit === undefined ? instances(barrel, 0xffffff, size.props, "barrels") : undefined;
    const tint = new Color();
    for (let i = 0; i < size.props; i += 1) {
      const s = 0.5 + random() * 0.6;
      const at = [(random() * 2 - 1) * TOWN, s / 2, (random() * 2 - 1) * TOWN];
      if (kit !== undefined) {
        const prop = new Mesh(
          kit.propGeometries[i % kit.propGeometries.length],
          kit.propMaterials[(i * 7) % kit.propMaterials.length],
        );
        prop.scale.setScalar(s);
        prop.position.set(at[0], at[1], at[2]);
        prop.rotation.y = random() * Math.PI;
        prop.castShadow = true;
        prop.receiveShadow = true;
        scene.add(prop);
        continue;
      }
      tint.setHSL((i * 0.137) % 1, 0.45, 0.45);
      (i % 2 === 0 ? crates : barrels).place([at[0], at[1], at[2]], [0, random() * Math.PI, 0], [s, s, s], tint);
    }
    crates?.done();
    barrels?.done();
    counts.props = size.props;
  }

  const walkers = [];
  if (enabled("crowd")) {
    const source = mannequin.scene;
    const clip = mannequin.animations.find((animation) => animation.name === "Walk_Loop");
    if (clip === undefined) throw new Error("mannequin.glb has no Walk_Loop clip");
    // `play`: all four gaits must exist, as `requiredClips` demands in `Stress.ts`.
    const gaitClips =
      kit === undefined
        ? undefined
        : WALKER_STATES.map(({ clip: name }) => {
            const found = mannequin.animations.find((animation) => animation.name === name);
            if (found === undefined) throw new Error(`mannequin.glb has no ${name} clip`);
            return found;
          });
    // The mannequin's quantized attributes are interleaved, and three's WebGPU backend re-packs an
    // interleaved buffer as Uint32 — `unorm32x4` is not a WebGPU vertex format, so the pipeline fails.
    // De-interleaving keeps each attribute at its own width, which is what the device accepts.
    source.traverse((object) => {
      if (object.geometry !== undefined) deinterleaveGeometry(object.geometry);
    });
    for (let i = 0; i < size.crowd; i += 1) {
      const holder = new Group();
      const character = cloneSkinned(source);
      character.traverse((object) => {
        object.castShadow = true;
      });
      // Plain three.js animates every rig in JS: 120 mixers, one per walker, exactly what P1 measures.
      const mixer = new AnimationMixer(character);
      // `play` keeps one action per gait and crossfades between them; Walk_Loop (state 0) starts playing.
      const actions = gaitClips?.map((gait) => mixer.clipAction(gait));
      (actions?.[0] ?? mixer.clipAction(clip)).play();
      holder.add(character);
      scene.add(holder);
      const radius = 6 + random() * (TOWN - 8);
      const speed = 1.2 + random() * 0.4;
      const phase = random() * Math.PI * 2;
      walkers.push({ mixer, holder, radius, speed, phase, actions, angle: phase, state: 0 });
    }
    counts.crowd = size.crowd;
  }

  const bodies = [];
  if (enabled("bodies")) {
    const bodyMaterial = kit?.body ?? material(0xb07a3a, 0.7);
    for (let i = 0; i < size.bodies; i += 1) {
      const box = new Mesh(crate, bodyMaterial);
      box.scale.setScalar(BODY_SIZE);
      box.castShadow = true;
      box.receiveShadow = true;
      scene.add(box);
      bodies.push(box);
    }
    counts.bodies = size.bodies;
  }
  const dropVelocity = bodies.map(() => new Vector3());
  const dropBodies = () => {
    bodies.forEach((body, i) => {
      const pile = i % 6;
      body.position.set(
        Math.cos(pile) * 12 + random() * 3,
        4 + (i / 6) * 0.7,
        Math.sin(pile) * 12 + random() * 3,
      );
      dropVelocity[i].set(0, 0, 0);
    });
  };
  dropBodies();

  const fires = [];
  const emitters = Math.max(size.fires, size.lights);
  for (let i = 0; i < emitters; i += 1) {
    const angle = (i / emitters) * Math.PI * 2;
    fires.push([Math.cos(angle) * TOWN * 0.7, Math.sin(angle) * TOWN * 0.7]);
  }
  const campfires = [];
  if (enabled("fires")) {
    const seeds = new Float32Array(size.firePerEmitter * 4);
    for (let i = 0; i < seeds.length; i += 1) seeds[i] = random();
    for (const [x, z] of fires.slice(0, size.fires)) {
      const geometry = new BufferGeometry();
      // One vertex per particle: a placeholder position (the shader places every particle) and its four
      // random numbers, so the emitter's animation costs the GPU and no JS at all.
      geometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array(size.firePerEmitter * 3), 3),
      );
      geometry.setAttribute("aSeed", new BufferAttribute(seeds, 4));
      const { material: sprite, clock } = fireMaterial();
      const points = new Points(geometry, sprite);
      points.position.set(x, 0, z);
      points.frustumCulled = false;
      scene.add(points);
      campfires.push({ points, clock });
    }
    counts.particles = size.fires * size.firePerEmitter;
  }
  const torches = kit === undefined ? undefined : [];
  if (enabled("lights")) {
    for (const [x, z] of fires.slice(0, size.lights)) {
      const torch = new PointLight(TORCH_COLOR, TORCH_INTENSITY, TORCH_RANGE, 2);
      torch.position.set(x, 2.5, z);
      scene.add(torch);
      torches?.push(torch);
    }
    counts.lights = size.lights;
  }

  // The shadow pass is inside the frame's draw counters and three's WebGPU renderer publishes no
  // split, so the casters' triangle count is summed once here: main = frame total - this.
  let shadowTriangles = 0;
  scene.traverse((object) => {
    if (object.castShadow !== true || object.geometry === undefined) return;
    const count = object.isInstancedMesh === true ? object.count : 1;
    const geometry = object.geometry;
    const triangles =
      geometry.index === null ? geometry.attributes.position.count / 3 : geometry.index.count / 3;
    shadowTriangles += triangles * count;
  });

  if (kit !== undefined) Object.assign(counts, kit.counts);
  const still = flag("still");
  const freezeAt = Number(params.get("freezeAt") ?? 0);
  let time = 0;
  let sinceDrop = 0;
  // `play`: objects thrown from the campfires, born every `THROW.every` seconds and removed after `THROW.life`.
  const thrown = [];
  let spawned = 0;
  return {
    counts,
    shadowTriangles,
    layers: LAYERS.filter(enabled),
    preset: `${presetName}${kit === undefined ? "" : "-play"}${load === 1 ? "" : `x${load}`}`,
    update(dt, camera) {
      time += dt;
      for (const fire of campfires) fire.clock.value = time;
      // `?still` holds the first pose (camera and walkers), so a before/after pair frames the same image.
      const clock = still ? 0 : freezeAt > 0 ? Math.min(time, freezeAt) : time;
      if (kit === undefined) {
        const orbit = (clock / ORBIT.seconds) * Math.PI * 2;
        camera.position.set(
          Math.cos(orbit) * ORBIT.radius,
          ORBIT.height + Math.sin(orbit * 2) * 4,
          Math.sin(orbit) * ORBIT.radius,
        );
        camera.lookAt(0, 2, 0);
      } else {
        const pose = playCamera(clock);
        camera.position.set(...pose.position);
        camera.lookAt(...pose.target);
        torches.forEach((torch, i) => {
          torch.intensity = TORCH_INTENSITY * (0.85 + 0.15 * Math.sin(clock * 11 + i));
        });
        while (!still && spawned < Math.floor(time / THROW.every)) {
          const [x, z] = fires[spawned % fires.length];
          const mesh = new Mesh(
            kit.propGeometries[spawned % kit.propGeometries.length],
            kit.propMaterials[(spawned * 5) % kit.propMaterials.length],
          );
          mesh.scale.setScalar(0.4);
          mesh.position.set(x, 1, z);
          mesh.castShadow = true;
          scene.add(mesh);
          const aim = spawned * 2.399;
          thrown.push({ mesh, born: time, vx: Math.cos(aim) * 4, vz: Math.sin(aim) * 4 });
          spawned += 1;
        }
        for (let i = thrown.length - 1; i >= 0; i -= 1) {
          const item = thrown[i];
          const age = time - item.born;
          if (age > THROW.life) {
            item.mesh.removeFromParent();
            thrown.splice(i, 1);
            continue;
          }
          item.mesh.position.x += item.vx * dt;
          item.mesh.position.z += item.vz * dt;
          item.mesh.position.y = Math.max(0.2, 1 + THROW.speed * age - 0.5 * THROW.gravity * age * age);
          item.mesh.rotation.x = age * 3;
        }
      }
      for (const [index, walker] of walkers.entries()) {
        let angle = walker.phase + (clock * walker.speed) / walker.radius;
        if (kit !== undefined) {
          // Each walker changes gait on its own beat, with a short crossfade, and covers ground at that gait.
          const state =
            Math.floor((clock + index * 0.37) / WALKER_STATE_SECONDS + index) % WALKER_STATES.length;
          const gait = WALKER_STATES[state];
          if (state !== walker.state) {
            walker.actions[walker.state].fadeOut(WALKER_FADE_SECONDS);
            walker.actions[state].reset().fadeIn(WALKER_FADE_SECONDS).play();
            walker.state = state;
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
        walker.mixer.update(still ? 0 : dt);
      }
      // Plain three.js has no physics engine here: gravity, a floor and a pile, on the same 300 bodies.
      for (let i = 0; i < bodies.length; i += 1) {
        const body = bodies[i];
        dropVelocity[i].y -= 9.81 * dt;
        body.position.addScaledVector(dropVelocity[i], dt);
        const floor = BODY_SIZE / 2;
        if (body.position.y < floor) {
          body.position.y = floor;
          dropVelocity[i].y = 0;
        }
      }
      sinceDrop += dt;
      if (sinceDrop > DROP_EVERY) {
        sinceDrop = 0;
        dropBodies();
      }
    },
  };
}

async function main() {
  const loadStart = performance.now();
  const renderer = new WebGPURenderer({
    antialias: true,
    powerPreference: "high-performance",
    trackTimestamp: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(globalThis.innerWidth, globalThis.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new Scene();
  const camera = new PerspectiveCamera(
    55,
    globalThis.innerWidth / globalThis.innerHeight,
    0.1,
    600,
  );
  const [sky, mannequin] = await Promise.all([
    new TextureLoader().loadAsync("/sky.jpg"),
    new GLTFLoader().loadAsync("/mannequin.glb"),
  ]);
  if (flag("attrs")) {
    mannequin.scene.traverse((object) => {
      if (object.geometry === undefined) return;
      for (const [name, value] of Object.entries(object.geometry.attributes))
        console.log(`ATTR ${name} ${value.array.constructor.name} itemSize ${value.itemSize} normalized ${value.normalized} interleaved ${value.isInterleavedBufferAttribute === true} stride ${value.data?.stride}`);
    });
  }
  const world = build(scene, { mannequin, sky, load: loadFactor() });

  const info = (await navigator.gpu?.requestAdapter())?.info;
  const report = new StressReport();
  report.begin(
    {
      commit: "three@0.187.0",
      preset: world.preset,
      layers: world.layers,
      adapter: info ? [info.vendor, info.architecture].filter(Boolean).join(" / ") : "unknown",
      viewport: `${globalThis.innerWidth}x${globalThis.innerHeight}`,
      counts: world.counts,
    },
    performance.now() - loadStart,
  );

  let last = performance.now();
  // GPU time per frame: one resolve in flight; it sums the passes of every frame since the last one, so divide.
  let gpuMs;
  let gpuFrames = 0;
  let resolving = false;
  const frame = (start) => {
    // `entry` is the callback's start, which is where the frame's own cost begins (see report.js).
    const entry = performance.now();
    const hitched = entry - last > 250;
    const dt = Math.min(0.1, (entry - last) / 1000);
    last = entry;
    const updateStart = entry;
    world.update(dt, camera);
    const renderStart = performance.now();
    renderer.render(scene, camera);
    const end = performance.now();
    gpuFrames += 1;
    if (!resolving) {
      const frames = gpuFrames;
      gpuFrames = 0;
      resolving = true;
      renderer
        .resolveTimestampsAsync()
        .then((ms) => {
          gpuMs = ms > 0 ? ms / frames : undefined;
        })
        .finally(() => {
          resolving = false;
        });
    }
    publish(
      report.frame(start, {
        entry,
        update: renderStart - updateStart,
        render: end - renderStart,
        gpu: gpuMs,
        draws: renderer.info.render.drawCalls,
        triangles: renderer.info.render.triangles,
        shadowTriangles: world.shadowTriangles,
        hitched,
      }),
    );
    globalThis.requestAnimationFrame(frame);
  };
  globalThis.requestAnimationFrame(frame);
}

await main();
