// Generated look for the stress lab: every colour, shape and particle curve the scene draws.
// The scene (`scenes/Stress.ts`) decides how many and where; this file decides what they look like.
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  MeshStandardMaterial,
  PlaneGeometry,
} from "three";
import {
  Fn,
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  sin,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  type ComputeNode,
  SpriteNodeMaterial,
  type StorageBufferNode,
} from "three/webgpu";

export const groundGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
export const groundMaterial = new MeshStandardMaterial({ color: 0x5d6b3a, roughness: 0.95 });

/** Unit-height trunk and canopy, scaled per tree by the scene. */
export const trunkGeometry = new CylinderGeometry(0.12, 0.2, 1, 7).translate(0, 0.5, 0);
export const canopyGeometry = new ConeGeometry(1, 1, 9).translate(0, 0.5, 0);
export const trunkMaterial = new MeshStandardMaterial({ color: 0x5a4030, roughness: 0.9 });
export const canopyMaterial = new MeshStandardMaterial({ color: 0x2f5a2a, roughness: 0.8 });

export const rockGeometry = new DodecahedronGeometry(0.5, 0);
export const rockMaterial = new MeshStandardMaterial({ color: 0x7c7a74, roughness: 0.85 });

export const houseGeometry = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
export const roofGeometry = new ConeGeometry(0.8, 0.6, 4).rotateY(Math.PI / 4).translate(0, 0.3, 0);
export const wallMaterial = new MeshStandardMaterial({ color: 0xc9b99a, roughness: 0.9 });
export const roofMaterial = new MeshStandardMaterial({ color: 0x8a3b2c, roughness: 0.7 });

export const crateGeometry = new BoxGeometry(1, 1, 1);
export const barrelGeometry = new CylinderGeometry(0.4, 0.4, 1, 12);

/** A prop's own material: real levels carry many materials that differ only in base colour. */
export function propMaterial(index: number): MeshStandardMaterial {
  const hue = (index * 0.137) % 1;
  const material = new MeshStandardMaterial({ roughness: 0.6 + (index % 5) * 0.06 });
  material.color.setHSL(hue, 0.45, 0.45);
  return material;
}

export const bodyMaterial = new MeshStandardMaterial({ color: 0xb07a3a, roughness: 0.7 });

export const TORCH_COLOR = 0xff9a4a;
export const TORCH_INTENSITY = 30;
export const TORCH_RANGE = 14;

/** Seconds of fire animation; the scene advances it once per frame. */
export const fireClock = uniform(0);

const FIRE_HEIGHT = 3.2;
const FIRE_RADIUS = 0.7;
const random = (salt: number) => hash(instanceIndex.add(salt));
/** 0 at birth, 1 at death: each particle loops on its own phase. */
const life = () => fract(fireClock.mul(random(1).mul(0.5).add(0.45)).add(random(2)));

/** One campfire's particles, in emitter space: rising, narrowing, cooling from yellow to red. */
export function fireMaterial(): SpriteNodeMaterial {
  const material = new SpriteNodeMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const t = life();
  const p = uv().sub(0.5);
  const puff = float(1).sub(p.length().mul(2)).max(0);
  const heat = float(1).sub(t);
  material.colorNode = vec4(
    vec3(1, heat.mul(0.7).add(0.15), heat.mul(heat).mul(0.25)).mul(heat.mul(0.9)),
    puff,
  );
  material.scaleNode = vec2(heat.mul(0.35).add(0.08));
  return material;
}

export function firePositions(amount: number) {
  return (buffers: { readonly positions: StorageBufferNode<"vec3"> }): ComputeNode =>
    Fn(() => {
      const t = life();
      const angle = random(3)
        .mul(Math.PI * 2)
        .add(t.mul(2));
      const radius = random(4)
        .mul(FIRE_RADIUS)
        .mul(float(1).sub(t.mul(0.8)));
      buffers.positions
        .element(instanceIndex)
        .assign(vec3(cos(angle).mul(radius), t.mul(FIRE_HEIGHT), sin(angle).mul(radius)));
    })().compute(amount);
}
