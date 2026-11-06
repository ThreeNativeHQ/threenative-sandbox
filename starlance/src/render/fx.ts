// Particle effects on GPUParticles3D (spawn tier). A burst is a request; the engine reserves its
// own ring slots, so a second explosion never moves the first one's live particles. Geometry,
// colour and timing are all ours: amber -> white-hot cores with dark smoke, cyan sparks for hits.
import { GPUParticles3D } from "@threenative/core";
import { Box3, Mesh, RingGeometry, Sprite, Vector3 } from "three";
import {
  Fn,
  If,
  cos,
  exp,
  float,
  hash,
  instanceIndex,
  length,
  mix,
  sin,
  smoothstep,
  step,
  time,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  type ComputeNode,
  MeshBasicNodeMaterial,
  type Node,
  SpriteNodeMaterial,
  type StorageBufferNode,
  type UniformNode,
} from "three/webgpu";
import type { GameCtx } from "../world.js";
import { createAmbientDust } from "./ambientDust.js";

export interface IFx {
  /** An explosion of `size` metres (fighter ~3, boss part ~8). */
  explode(at: Vector3, size: number): void;
  /** A small spark burst: shield hit, deflected shot, ground scrape. */
  spark(at: Vector3): void;
  update(dt: number): void;
  dispose(): void;
}

interface IBuffers {
  readonly positions: StorageBufferNode<"vec3">;
  readonly velocities: StorageBufferNode<"vec3">;
  readonly births: StorageBufferNode<"float">;
}
interface IRequest {
  readonly first: UniformNode<"uint", number>;
  readonly count: UniformNode<"uint", number>;
  readonly origin: UniformNode<"vec3", Vector3>;
}

export type Rgb = readonly [number, number, number];
export interface IRecipe {
  /** Particles per burst; the ring holds `RING` overlapping bursts. */
  readonly burst: number;
  readonly life: readonly [number, number];
  readonly speed: readonly [number, number];
  readonly size: readonly [number, number];
  /** Per-second velocity loss (exponential). */
  readonly drag: number;
  readonly acceleration: Rgb;
  /** Sprite scale at the end of life, relative to the start. */
  readonly grow: number;
  readonly additive: boolean;
  /** Colour at birth, mid-life and death (values above 1 feed the bloom). */
  readonly colours: readonly [Rgb, Rgb, Rgb];
  readonly alpha: number;
  readonly seed: number;
}

const RING = 6;
const TAU = Math.PI * 2;
const BIG = 30_000;

const burstKey = (born: Node<"float">) => born.max(0).mul(1000).toUint();
type Key = ReturnType<typeof burstKey>;
const rand = (seed: number, salt: number, key: Key) =>
  hash(instanceIndex.add(seed + salt).add(key));

export function createEmitter(r: IRecipe) {
  const capacity = r.burst * RING;
  const material = new SpriteNodeMaterial({
    blending: r.additive ? AdditiveBlending : undefined,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  const life = (key: Key) => float(r.life[0]).add(rand(r.seed, 13, key).mul(r.life[1] - r.life[0]));
  const direction = (key: Key) => {
    const z = rand(r.seed, 29, key).mul(2).sub(1);
    const a = rand(r.seed, 31, key).mul(TAU);
    const s = float(1).sub(z.mul(z)).max(0).sqrt();
    return vec3(cos(a).mul(s), z, sin(a).mul(s));
  };
  const speed = (key: Key) =>
    float(r.speed[0]).add(rand(r.seed, 23, key).mul(r.speed[1] - r.speed[0]));
  const colour = (phase: Node<"float">) => {
    const c = r.colours.map((c) => vec3(...c));
    return mix(mix(c[0]!, c[1]!, smoothstep(0, 0.35, phase)), c[2]!, smoothstep(0.35, 1, phase));
  };
  // The material reads the birth stamp the engine writes, so it binds once the engine made it.
  const bindMaterial = (born: Node<"float">): void => {
    const key = burstKey(born);
    const age = time.sub(born);
    const lifetime = life(key);
    const alive = varying(step(0, age).mul(step(age, lifetime)));
    const phase = varying(age.div(lifetime).clamp(0, 1));
    const size = float(r.size[0]).add(rand(r.seed, 41, key).mul(r.size[1] - r.size[0]));
    material.scaleNode = vec2(size.mul(mix(1, r.grow, phase)).mul(alive));
    const soft = float(1).sub(smoothstep(0.0, 0.5, length(uv().sub(0.5))));
    material.colorNode = vec4(
      colour(phase),
      soft
        .mul(float(1).sub(smoothstep(0.55, 1, phase)))
        .mul(r.alpha)
        .mul(alive),
    );
  };
  const spawn = ({ positions, velocities, births }: IBuffers, request: IRequest): ComputeNode => {
    bindMaterial(births.toAttribute());
    return Fn(() => {
      If(instanceIndex.lessThan(request.count), () => {
        const slot = request.first.add(instanceIndex).mod(uint(capacity));
        velocities.element(slot).assign(request.origin);
        positions.element(slot).assign(request.origin);
      });
    })().compute(capacity);
  };
  const process = (
    { positions, velocities, births }: IBuffers,
    runtime: { readonly time: Node<"float"> },
  ): ComputeNode =>
    Fn(() => {
      const born = births.element(instanceIndex);
      const key = burstKey(born);
      const t = runtime.time.sub(born).clamp(0, life(key));
      // Distance travelled under exponential drag: v0 (1 - e^(-k t)) / k.
      const travelled = speed(key)
        .mul(float(1).sub(exp(float(-r.drag).mul(t))))
        .div(r.drag);
      const local = direction(key)
        .mul(travelled)
        .add(vec3(...r.acceleration).mul(t.mul(t).mul(0.5)));
      positions.element(instanceIndex).assign(velocities.element(instanceIndex).add(local));
    })().compute(capacity);
  return {
    amount: capacity,
    burst: r.burst,
    lifetime: r.life[1],
    material,
    onCull: "pause" as const,
    process,
    spawn,
  };
}

// Debris streaks: fast, short-lived and gravity-bound, amber at birth and coal-dark at death.
const DEBRIS: IRecipe = {
  burst: 40,
  life: [0.3, 0.7],
  speed: [18, 45],
  size: [0.15, 0.35],
  drag: 0.6,
  acceleration: [0, -9, 0],
  grow: 0.45,
  additive: true,
  colours: [
    [3.4, 1.7, 0.4],
    [1.7, 0.55, 0.12],
    [0.12, 0.04, 0.02],
  ],
  alpha: 1,
  seed: 131,
};
// Embers: slow, long-lived, barely falling; the last thing visible after the fireball.
const EMBERS: IRecipe = {
  burst: 24,
  life: [1.2, 2.2],
  speed: [2, 6],
  size: [0.08, 0.16],
  drag: 1.1,
  acceleration: [0, -1.5, 0],
  grow: 0.5,
  additive: true,
  colours: [
    [3, 1.2, 0.3],
    [1.3, 0.35, 0.06],
    [0.22, 0.06, 0.02],
  ],
  alpha: 1,
  seed: 149,
};

const FIRE: Omit<IRecipe, "burst" | "size" | "speed" | "seed"> = {
  life: [0.35, 0.85],
  drag: 1.9,
  acceleration: [0, 1.5, 0],
  grow: 0.35,
  additive: true,
  // Amber -> white core, per the guide: white-hot at birth, amber mid-life, ember red at death.
  colours: [
    [3.2, 2.9, 2.0],
    [2.4, 0.95, 0.18],
    [0.55, 0.08, 0.02],
  ],
  alpha: 0.95,
};
const SMOKE: Omit<IRecipe, "burst" | "size" | "speed" | "seed"> = {
  life: [0.9, 1.8],
  drag: 1.4,
  acceleration: [0, 2.2, 0],
  grow: 2.4,
  additive: false,
  colours: [
    [0.1, 0.085, 0.085],
    [0.06, 0.05, 0.05],
    [0.03, 0.028, 0.03],
  ],
  alpha: 0.55,
};

type Emitter = ReturnType<typeof createEmitter>;

// ---- pooled meshes: blast flash and shockwave ring -------------------------------------------

// Additive with tone mapping off, so colours above 1 reach the bloom pass instead of clipping.
const ADDITIVE = {
  blending: AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
  transparent: true,
} as const;

const FLASH_POOL = 8;
const FLASH_SECONDS = 0.08;
const FLASH_SCALE = 2.5;
const WHITE_HOT: Rgb = [4, 3.6, 2.8];
const RING_POOL = 6;
const RING_SECONDS = 0.4;
const RING_FROM = 0.2;
const RING_TO = 3;
const RING_ALPHA = 0.8;
const SHOCK: Rgb = [2.6, 1.3, 0.5];

/** White-hot core with a soft halo; the pool animates the alpha uniform, never the shader. */
function flashMaterial(): { material: SpriteNodeMaterial; opacity: UniformNode<"float", number> } {
  const opacity = uniform(0);
  const material = new SpriteNodeMaterial(ADDITIVE);
  const r = length(uv().sub(0.5)).mul(2);
  const glow = exp(r.mul(r).mul(-3.2))
    .mul(0.7)
    .add(exp(r.mul(-6)).mul(0.5));
  material.colorNode = vec4(vec3(...WHITE_HOT), glow.mul(opacity).clamp(0, 1));
  return { material, opacity };
}

function ringMaterial(): {
  material: MeshBasicNodeMaterial;
  opacity: UniformNode<"float", number>;
} {
  const opacity = uniform(0);
  const material = new MeshBasicNodeMaterial(ADDITIVE);
  material.colorNode = vec4(vec3(...SHOCK), opacity);
  return { material, opacity };
}

interface IFlash {
  readonly sprite: Sprite;
  readonly opacity: UniformNode<"float", number>;
  age: number;
}
interface IRing {
  readonly mesh: Mesh<RingGeometry, MeshBasicNodeMaterial>;
  readonly opacity: UniformNode<"float", number>;
  age: number;
  to: number;
}

export function createFx(ctx: GameCtx): IFx {
  const make = (recipe: IRecipe) => {
    const options = createEmitter(recipe);
    const particles = ctx.add(
      new GPUParticles3D({
        ...options,
        bounds: new Box3(new Vector3(-BIG, -BIG, -BIG), new Vector3(BIG, BIG, BIG)),
        graceSeconds: Number.POSITIVE_INFINITY,
        lifetime: options.lifetime,
      }),
    );
    particles.frustumCulled = false;
    return { particles, burst: options.burst, options } as {
      particles: GPUParticles3D;
      burst: number;
      options: Emitter;
    };
  };
  const fireS = make({ ...FIRE, burst: 34, size: [0.9, 2.1], speed: [3, 11], seed: 11 });
  const fireL = make({ ...FIRE, burst: 90, size: [2.6, 6.5], speed: [10, 34], seed: 23 });
  const smokeS = make({ ...SMOKE, burst: 12, size: [1.6, 3.2], speed: [1, 5], seed: 37 });
  const smokeL = make({ ...SMOKE, burst: 32, size: [4.5, 9.5], speed: [3, 14], seed: 53 });
  const sparks = make({
    burst: 18,
    life: [0.22, 0.5],
    speed: [7, 20],
    size: [0.1, 0.26],
    drag: 2.6,
    acceleration: [0, -3, 0],
    grow: 0.2,
    additive: true,
    // Player hits: cyan-white core fading to the ion glow.
    colours: [
      [2.2, 3.0, 3.0],
      [0.15, 1.4, 2.4],
      [0.02, 0.25, 0.7],
    ],
    alpha: 1,
    seed: 71,
  });
  const debris = make(DEBRIS);
  const embers = make(EMBERS);
  const all = [fireS, fireL, smokeS, smokeL, sparks, debris, embers];
  // `emitParticle` copies the origin before it returns, so one scratch object serves every burst.
  const _origin = { x: 0, y: 0, z: 0 };
  const at = (v: Vector3) => {
    _origin.x = v.x;
    _origin.y = v.y;
    _origin.z = v.z;
    return _origin;
  };
  const _o = new Vector3();

  // Both pools stay visible with opacity 0 when idle: hiding them would compile their pipeline on
  // the first blast, and the flicker of that compile is the one frame a player always sees.
  const flashes: IFlash[] = [];
  for (let i = 0; i < FLASH_POOL; i++) {
    const { material, opacity } = flashMaterial();
    const sprite = ctx.add(new Sprite(material));
    sprite.scale.setScalar(FLASH_SCALE);
    flashes.push({ sprite, opacity, age: Number.POSITIVE_INFINITY });
  }
  const rings: IRing[] = [];
  const ringGeometry = new RingGeometry(0.9, 1, 48);
  for (let i = 0; i < RING_POOL; i++) {
    const { material, opacity } = ringMaterial();
    const mesh = ctx.add(new Mesh(ringGeometry, material));
    mesh.scale.setScalar(RING_FROM);
    rings.push({ mesh, opacity, age: Number.POSITIVE_INFINITY, to: RING_FROM });
  }

  const dust = createAmbientDust((mesh) => ctx.add(mesh));

  return {
    explode(where, size) {
      const big = size >= 6;
      (big ? fireL : fireS).particles.emitParticle({
        count: big ? fireL.burst : fireS.burst,
        origin: at(where),
      });
      (big ? smokeL : smokeS).particles.emitParticle({
        count: big ? smokeL.burst : smokeS.burst,
        origin: at(where),
      });
      // A huge blast (boss, bomb) is several offset fireballs, not one scaled-up sprite cloud.
      if (size >= 11) {
        for (const [x, y, z] of [
          [1, 0.4, 0],
          [-1, 0.2, 0.6],
          [0, -0.3, -1],
        ] as const) {
          _o.set(where.x + x * size * 0.35, where.y + y * size * 0.3, where.z + z * size * 0.35);
          fireL.particles.emitParticle({ count: fireL.burst, origin: at(_o) });
        }
      }
      debris.particles.emitParticle({ count: debris.burst, origin: at(where) });
      embers.particles.emitParticle({ count: embers.burst, origin: at(where) });

      // Flash: the brightest thing in the frame for a twelfth of a second.
      const flash = flashes.find((f) => f.age >= FLASH_SECONDS) ?? flashes[0]!;
      flash.age = 0;
      flash.sprite.position.copy(where);
      flash.sprite.scale.setScalar(size * FLASH_SCALE);
      flash.opacity.value = 1;

      // Shockwave: a flat ring in the screen plane, thrown open by the blast.
      const ring = rings.find((r) => r.age >= RING_SECONDS) ?? rings[0]!;
      ring.age = 0;
      ring.to = size * RING_TO;
      ring.mesh.position.copy(where);
      ring.mesh.quaternion.copy(ctx.camera.quaternion);
      ring.mesh.scale.setScalar(RING_FROM);
      ring.opacity.value = RING_ALPHA;
    },
    spark(where) {
      sparks.particles.emitParticle({ count: sparks.burst, origin: at(where) });
    },
    update(dt) {
      dust.update(ctx.camera, dt);
      for (const f of flashes) {
        if (f.age >= FLASH_SECONDS) continue;
        f.age = Math.min(f.age + dt, FLASH_SECONDS);
        f.opacity.value = Math.max(0, 1 - f.age / FLASH_SECONDS);
      }
      // The camera faces one way every frame, so the rings are re-aimed after the camera moves.
      const facing = ctx.camera.quaternion;
      for (const r of rings) {
        if (r.age >= RING_SECONDS) continue;
        r.age = Math.min(r.age + dt, RING_SECONDS);
        const t = r.age / RING_SECONDS;
        const e = 1 - (1 - t) * (1 - t); // fast out of the blast, then coasting
        r.mesh.scale.setScalar(RING_FROM + (r.to - RING_FROM) * e);
        r.mesh.quaternion.copy(facing);
        r.opacity.value = Math.max(0, RING_ALPHA * (1 - t));
      }
    },
    dispose() {
      dust.dispose();
      for (const e of all) {
        e.particles.removeFromParent();
        e.particles.detach();
        e.options.material.dispose();
      }
      for (const f of flashes) {
        f.sprite.removeFromParent();
        f.sprite.material.dispose();
      }
      for (const r of rings) {
        r.mesh.removeFromParent();
        r.mesh.material.dispose();
      }
      ringGeometry.dispose();
    },
  };
}
