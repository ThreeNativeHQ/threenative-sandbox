// Effects for the player's weapons: muzzle flashes, charge orb, trails, impacts, shockwaves.
// Two tiers. Pooled meshes (billboard sprites, stretched spark shards) carry everything that needs
// a direction or a per-effect fade; GPU particles (the emitters from fx.ts) carry soft puffs:
// ion trails and dust. Palette is LANES.md: cyan-white #9ff6ff core, cyan #1fd9ff glow, warm
// terracotta/ochre for the ground. Colours run above 1 with tone mapping off so bloom catches them.
import { GPUParticles3D } from "@threenative/core";
import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Sprite,
  Vector3,
} from "three";
import {
  exp,
  float,
  length,
  max,
  normalView,
  pow,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from "three/webgpu";
import type { GameCtx } from "../world.js";
import { type IRecipe, type Rgb, createEmitter } from "./fx.js";

const NEG_Z = new Vector3(0, 0, -1);
const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _v = new Vector3();
const rnd = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

const CORE: Rgb = [0.85, 1.5, 1.7]; // #9ff6ff, bright enough for bloom but kept cyan by the filmic curve
const GLOW: Rgb = [0.05, 0.85, 1.25]; // #1fd9ff

/** A random unit vector within `half` radians of `dir`. */
function cone(dir: Vector3, half: number, out: Vector3): Vector3 {
  _a.crossVectors(dir, Math.abs(dir.y) > 0.95 ? NEG_Z : UP).normalize();
  _b.crossVectors(dir, _a);
  const theta = Math.random() * half;
  const phi = Math.random() * Math.PI * 2;
  return out
    .copy(dir)
    .multiplyScalar(Math.cos(theta))
    .addScaledVector(_a, Math.cos(phi) * Math.sin(theta))
    .addScaledVector(_b, Math.sin(phi) * Math.sin(theta));
}

// ---- materials --------------------------------------------------------------------------------

const additive = {
  blending: AdditiveBlending,
  depthWrite: false,
  toneMapped: false,
  transparent: true,
} as const;

/** A hot centre, a soft halo and four spikes: reads as a muzzle flash at any size. */
function starMaterial(colour: Rgb, spikes: number): SpriteNodeMaterial {
  const material = new SpriteNodeMaterial(additive);
  const u = uv().sub(0.5);
  const r = length(u);
  const hot = exp(r.mul(r).mul(-70));
  const halo = exp(r.mul(-9)).mul(0.55);
  const cross = max(
    exp(u.x.abs().mul(-45)).mul(exp(u.y.abs().mul(-5))),
    exp(u.y.abs().mul(-45)).mul(exp(u.x.abs().mul(-5))),
  ).mul(spikes);
  const alpha = hot
    .add(halo)
    .add(cross)
    .mul(float(1).sub(smoothstep(0.34, 0.5, r)))
    .clamp(0, 1);
  material.colorNode = vec4(vec3(...colour), alpha);
  return material;
}

function ringMaterial() {
  const opacity = uniform(1);
  const material = new SpriteNodeMaterial(additive);
  const r = length(uv().sub(0.5)).mul(2);
  const band = exp(pow(r.sub(0.86).mul(11), 2).negate());
  material.colorNode = vec4(
    vec3(...CORE),
    band.mul(float(1).sub(smoothstep(0.95, 1, r))).mul(opacity),
  );
  return { material, opacity };
}

function shellMaterial() {
  const opacity = uniform(1);
  const material = new MeshBasicNodeMaterial(additive);
  const rim = pow(float(1).sub(normalView.z.abs()), 2.2);
  material.colorNode = vec4(vec3(...GLOW), rim.mul(0.9).add(0.06).mul(opacity));
  return { material, opacity };
}

// ---- pooled sprites ---------------------------------------------------------------------------

interface IFlash {
  readonly sprite: Sprite;
  age: number;
  life: number;
  size: number;
}

class Flashes {
  readonly #items: IFlash[] = [];
  constructor(
    private readonly ctx: GameCtx,
    material: SpriteNodeMaterial,
    count: number,
  ) {
    for (let i = 0; i < count; i++) {
      const sprite = new Sprite(material);
      sprite.visible = false;
      ctx.add(sprite);
      ctx.interpolate(sprite);
      this.#items.push({ sprite, age: 0, life: 1, size: 1 });
    }
  }

  emit(at: Vector3, size: number, life: number): void {
    const f = this.#items.find((i) => !i.sprite.visible) ?? this.#items[0];
    if (f === undefined) return;
    f.age = 0;
    f.life = life;
    f.size = size;
    f.sprite.position.copy(at);
    f.sprite.scale.setScalar(size);
    f.sprite.visible = true;
    this.ctx.resetInterpolation(f.sprite);
  }

  update(dt: number): void {
    for (const f of this.#items) {
      if (!f.sprite.visible) continue;
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) f.sprite.visible = false;
      else f.sprite.scale.setScalar(f.size * (1 + 0.5 * t) * (1 - t * t));
    }
  }
}

interface IRing {
  readonly sprite: Sprite;
  readonly shell: Mesh;
  readonly ringOpacity: { value: number };
  readonly shellOpacity: { value: number };
  age: number;
  life: number;
  from: number;
  to: number;
  withShell: boolean;
}

class Rings {
  readonly #items: IRing[] = [];
  constructor(ctx: GameCtx, count: number) {
    const geometry = new SphereGeometry(1, 20, 14);
    for (let i = 0; i < count; i++) {
      const r = ringMaterial();
      const s = shellMaterial();
      const sprite = new Sprite(r.material);
      const shell = new Mesh(geometry, s.material);
      sprite.visible = false;
      shell.visible = false;
      shell.frustumCulled = false;
      ctx.add(sprite);
      ctx.add(shell);
      this.#items.push({
        sprite,
        shell,
        ringOpacity: r.opacity,
        shellOpacity: s.opacity,
        age: 0,
        life: 1,
        from: 1,
        to: 1,
        withShell: false,
      });
    }
  }

  emit(at: Vector3, from: number, to: number, life: number, withShell: boolean): void {
    const r = this.#items.find((i) => !i.sprite.visible) ?? this.#items[0];
    if (r === undefined) return;
    Object.assign(r, { age: 0, life, from, to, withShell });
    r.sprite.position.copy(at);
    r.shell.position.copy(at);
    r.sprite.visible = true;
    r.shell.visible = withShell;
  }

  update(dt: number): void {
    for (const r of this.#items) {
      if (!r.sprite.visible) continue;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        r.sprite.visible = false;
        r.shell.visible = false;
        continue;
      }
      const e = 1 - (1 - t) ** 3;
      const size = r.from + (r.to - r.from) * e;
      r.sprite.scale.setScalar(size * 2);
      r.shell.scale.setScalar(size);
      r.ringOpacity.value = (1 - t) ** 1.5;
      r.shellOpacity.value = (1 - t) ** 2;
    }
  }
}

// ---- pooled shards ----------------------------------------------------------------------------

interface IShard {
  readonly mesh: Mesh;
  readonly vel: Vector3;
  age: number;
  life: number;
  width: number;
  length: number;
}

/** Spark streaks (stretched along their velocity) or tumbling debris (`stretch` 0). */
class Shards {
  readonly #items: IShard[] = [];
  constructor(
    ctx: GameCtx,
    count: number,
    materials: readonly (MeshBasicMaterial | MeshStandardMaterial)[],
    private readonly stretch: number,
    private readonly gravity: number,
  ) {
    const geometry = new BoxGeometry(1, 1, 1);
    for (let i = 0; i < count; i++) {
      const mesh = new Mesh(geometry, materials[i % materials.length]);
      mesh.visible = false;
      mesh.frustumCulled = false;
      ctx.add(mesh);
      this.#items.push({ mesh, vel: new Vector3(), age: 0, life: 1, width: 0.05, length: 0.1 });
    }
  }

  emit(
    at: Vector3,
    dir: Vector3,
    speed: number,
    life: number,
    width: number,
    length: number,
  ): void {
    const s = this.#items.find((i) => !i.mesh.visible);
    if (s === undefined) return; // ponytail: a full pool drops the spark; raise the count if bursts clip
    s.age = 0;
    s.life = life;
    s.width = width;
    s.length = length;
    s.vel.copy(dir).multiplyScalar(speed);
    s.mesh.position.copy(at);
    s.mesh.visible = true;
  }

  update(dt: number): void {
    const drag = Math.exp(-2.2 * dt);
    for (const s of this.#items) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      const t = s.age / s.life;
      if (t >= 1) {
        s.mesh.visible = false;
        continue;
      }
      s.vel.multiplyScalar(drag);
      s.vel.y -= this.gravity * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      const k = 1 - t;
      if (this.stretch > 0) {
        const speed = s.vel.length();
        if (speed > 1e-4)
          s.mesh.quaternion.setFromUnitVectors(NEG_Z, _v.copy(s.vel).divideScalar(speed));
        s.mesh.scale.set(s.width * k, s.width * k, (s.length + speed * this.stretch) * k);
      } else {
        s.mesh.scale.setScalar(s.width * k);
        s.mesh.rotation.x += dt * 9;
        s.mesh.rotation.y += dt * 7;
      }
    }
  }
}

// ---- GPU particle puffs -----------------------------------------------------------------------

function gpu(ctx: GameCtx, recipe: IRecipe) {
  const options = createEmitter(recipe);
  const big = 30_000;
  const particles = ctx.add(
    new GPUParticles3D({
      ...options,
      bounds: new Box3(new Vector3(-big, -big, -big), new Vector3(big, big, big)),
      graceSeconds: Number.POSITIVE_INFINITY,
      lifetime: options.lifetime,
    }),
  );
  particles.frustumCulled = false;
  return {
    emit: (at: Vector3, count = recipe.burst) =>
      particles.emitParticle({ count, origin: { x: at.x, y: at.y, z: at.z } }),
    dispose: () => {
      particles.removeFromParent();
      particles.detach();
      options.material.dispose();
    },
  };
}

// ---- the effect set ---------------------------------------------------------------------------

export interface IShotFx {
  /** One cannon fired: flash, forward spark cone, and a short ring for a hyper shot. */
  muzzle(at: Vector3, dir: Vector3, hyper: boolean): void;
  /** Call every tick: orb at the nose grows with `charge` (0..1), motes fall into it. */
  charge(nose: Vector3, dir: Vector3, charge: number, dt: number): void;
  /** The charged shot leaves: bright flash, ring and a recoil spray. */
  release(nose: Vector3, dir: Vector3): void;
  /** A puff of ion for a charged/homing shot or a bomb; call every other tick. */
  trail(at: Vector3): void;
  /** Spark spray along the bolt plus a hit flash. */
  hitEnemy(at: Vector3, dir: Vector3): void;
  /** Warm dust and terracotta debris. */
  hitGround(at: Vector3, dir: Vector3): void;
  /** Expanding ring (and a shell when `radius` is big). */
  shockwave(at: Vector3, radius: number, seconds: number): void;
  update(dt: number): void;
  dispose(): void;
}

const ION_TRAIL: IRecipe = {
  burst: 2,
  life: [0.14, 0.24],
  speed: [0.3, 2.2],
  size: [0.3, 0.62],
  drag: 2,
  acceleration: [0, 0, 0],
  grow: 0.3,
  additive: true,
  colours: [CORE, GLOW, [0.02, 0.2, 0.6]],
  alpha: 0.9,
  seed: 83,
};
const DUST: IRecipe = {
  burst: 12,
  life: [0.6, 1.1],
  speed: [2, 8],
  size: [0.7, 1.5],
  drag: 2.2,
  acceleration: [0, 1.2, 0],
  grow: 2.4,
  additive: false,
  // Terracotta / ochre, kept dim so it reads as dust and not as a glow.
  colours: [
    [0.5, 0.31, 0.17],
    [0.38, 0.22, 0.12],
    [0.22, 0.13, 0.08],
  ],
  alpha: 0.55,
  seed: 97,
};

export function createShotFx(ctx: GameCtx): IShotFx {
  const flashes = new Flashes(ctx, starMaterial([1.1, 1.8, 2.0], 0.9), 24);
  const orb = new Sprite(starMaterial(GLOW, 0));
  orb.visible = false;
  ctx.add(orb);
  ctx.interpolate(orb);
  const rings = new Rings(ctx, 4);

  const spark = new MeshBasicMaterial({ ...additive, color: 0xffffff });
  spark.color.setRGB(...CORE);
  const ion = new MeshBasicMaterial({ ...additive, color: 0xffffff });
  ion.color.setRGB(...GLOW);
  const ember = new MeshBasicMaterial({ ...additive, color: 0xffffff });
  ember.color.setRGB(1.6, 0.8, 0.25);
  const sparks = new Shards(ctx, 120, [spark, ion], 0.035, 0);
  const embers = new Shards(ctx, 40, [ember], 0.03, 14);
  const debris = new Shards(
    ctx,
    40,
    [
      new MeshStandardMaterial({
        color: 0x8a4a2c,
        roughness: 0.9,
        metalness: 0.05,
        flatShading: true,
      }),
      new MeshStandardMaterial({
        color: 0xa8743a,
        roughness: 0.9,
        metalness: 0.05,
        flatShading: true,
      }),
      new MeshStandardMaterial({
        color: 0x5e3322,
        roughness: 0.95,
        metalness: 0.05,
        flatShading: true,
      }),
    ],
    0,
    22,
  );
  // Motes: ion streaks that fall into the charge orb. They live in a nose-relative frame.
  const moteMaterial = ion;
  const moteGeometry = new BoxGeometry(1, 1, 1);
  const motes = Array.from({ length: 18 }, () => {
    const mesh = new Mesh(moteGeometry, moteMaterial);
    mesh.visible = false;
    mesh.frustumCulled = false;
    ctx.add(mesh);
    ctx.interpolate(mesh);
    return { mesh, off: new Vector3(), age: 0, life: 0.3 };
  });
  const trail = gpu(ctx, ION_TRAIL);
  const dust = gpu(ctx, DUST);
  const lastNose = new Vector3();
  let clock = 0;
  let moteDebt = 0;

  const burst = (
    pool: Shards,
    at: Vector3,
    dir: Vector3,
    n: number,
    half: number,
    speed: readonly [number, number],
    life: readonly [number, number],
    width: number,
    len: number,
  ) => {
    for (let i = 0; i < n; i++)
      pool.emit(
        at,
        cone(dir, half, _c),
        rnd(speed[0], speed[1]),
        rnd(life[0], life[1]),
        width * rnd(0.7, 1.3),
        len,
      );
  };

  return {
    muzzle(at, dir, hyper) {
      _v.copy(at).addScaledVector(dir, 0.35);
      flashes.emit(_v, hyper ? 2.1 : 1.15, hyper ? 0.09 : 0.07);
      burst(sparks, _v, dir, hyper ? 8 : 5, 0.3, [16, 34], [0.1, 0.2], 0.035, 0.12);
      if (hyper) rings.emit(_v, 0.3, 1.5, 0.12, false);
    },

    charge(nose, dir, charge, dt) {
      clock += dt;
      lastNose.copy(nose);
      if (charge > 0.02) {
        orb.visible = true;
        orb.position.copy(nose).addScaledVector(dir, 0.4);
        orb.scale.setScalar(
          (0.35 + 1.9 * charge) * (1 + 0.1 * Math.sin(clock * 45)) * (charge >= 1 ? 1.15 : 1),
        );
        moteDebt += dt * (30 + 60 * charge);
        while (moteDebt >= 1) {
          moteDebt -= 1;
          const m = motes.find((x) => !x.mesh.visible);
          if (m === undefined) break;
          m.off
            .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
            .normalize()
            .multiplyScalar(rnd(1.6, 3.2));
          m.age = 0;
          m.life = rnd(0.2, 0.34);
          m.mesh.visible = true;
          ctx.resetInterpolation(m.mesh);
        }
      } else orb.visible = false;
      for (const m of motes) {
        if (!m.mesh.visible) continue;
        m.age += dt;
        const t = m.age / m.life;
        if (t >= 1) {
          m.mesh.visible = false;
          continue;
        }
        const k = (1 - t) ** 1.6;
        m.mesh.position.copy(lastNose).addScaledVector(dir, 0.4).addScaledVector(m.off, k);
        // The cockpit view sits 1.4 m behind the orb, inside the motes' reach: a mote in the pilot's
        // lap would draw over the dash, so it goes out before it gets there.
        if (m.mesh.position.distanceToSquared(ctx.camera.position) < 0.64) {
          m.mesh.visible = false;
          continue;
        }
        m.mesh.quaternion.setFromUnitVectors(NEG_Z, _v.copy(m.off).negate().normalize());
        m.mesh.scale.set(0.045, 0.045, 0.45 * (1 - t) + 0.05);
      }
    },

    release(nose, dir) {
      _c.copy(nose).addScaledVector(dir, 0.6);
      flashes.emit(_c, 4.2, 0.14);
      rings.emit(_c, 0.3, 2.2, 0.2, false);
      _v.copy(dir).negate();
      burst(sparks, _c, _v, 14, 0.9, [8, 22], [0.18, 0.34], 0.05, 0.2);
      burst(sparks, _c, dir, 8, 0.3, [20, 40], [0.12, 0.22], 0.04, 0.15);
    },

    trail(at) {
      trail.emit(at);
    },

    hitEnemy(at, dir) {
      flashes.emit(at, 2.2, 0.06);
      burst(sparks, at, dir, 9, 0.55, [12, 30], [0.14, 0.3], 0.04, 0.15);
      _v.copy(dir).negate();
      burst(sparks, at, _v, 4, 0.9, [5, 14], [0.1, 0.2], 0.03, 0.1);
    },

    hitGround(at, dir) {
      dust.emit(at);
      // Debris and embers throw back and up from the surface, not along the bolt.
      _v.copy(dir).multiplyScalar(-0.45).addScaledVector(UP, 1).normalize();
      burst(debris, at, _v, 8, 0.75, [5, 15], [0.5, 0.85], 0.16, 0);
      burst(embers, at, _v, 6, 0.6, [6, 16], [0.2, 0.4], 0.05, 0.1);
    },

    shockwave(at, radius, seconds) {
      const big = radius >= 10;
      flashes.emit(at, radius * (big ? 0.35 : 0.8), big ? 0.18 : 0.1);
      rings.emit(at, radius * 0.08, radius, seconds, big);
      if (big) rings.emit(at, radius * 0.04, radius * 0.7, seconds * 0.7, false);
    },

    update(dt) {
      flashes.update(dt);
      rings.update(dt);
      sparks.update(dt);
      embers.update(dt);
      debris.update(dt);
    },

    dispose() {
      trail.dispose();
      dust.dispose();
    },
  };
}
