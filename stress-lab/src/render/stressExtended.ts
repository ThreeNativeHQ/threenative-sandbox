// Generated look for `?stress&extended`: materials and shapes for the extended stress layers.
// `scenes/Stress.ts` decides counts and motion; this file decides what they look like.
import {
  BoxGeometry,
  CapsuleGeometry,
  DataTexture,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
} from "three";

export const billboardGeometry = new PlaneGeometry(1.1, 0.16);
export const billboardMaterial = new MeshBasicMaterial({ color: 0x38d37f });

export const npcGeometry = new CapsuleGeometry(0.32, 0.9, 4, 8);
export const npcMaterial = new MeshStandardMaterial({ color: 0x4588c9, roughness: 0.5 });

export const leafGeometry = new PlaneGeometry(1.3, 1.3);

function leafCutoutTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const angle = Math.atan2(dy, dx);
      const radius = Math.hypot(dx, dy);
      const lobe = 0.72 + 0.18 * Math.sin(angle * 7);
      const inside = radius <= lobe;
      const i = (y * size + x) * 4;
      const shade = 140 + Math.round(60 * (1 - Math.min(1, radius)));
      data[i] = Math.round(shade * 0.45);
      data[i + 1] = shade;
      data[i + 2] = Math.round(shade * 0.35);
      data[i + 3] = inside ? 255 : 0;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function leafCutoutMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    map: leafCutoutTexture(),
    alphaTest: 0.5,
    side: DoubleSide,
    roughness: 0.75,
  });
}

export const glassGeometry = new BoxGeometry(1.6, 2.2, 0.15);
export const glassMaterial = new MeshStandardMaterial({
  color: 0x7fd4ff,
  transparent: true,
  opacity: 0.42,
  roughness: 0.15,
  depthWrite: false,
});

export const markerGeometry = new OctahedronGeometry(0.35, 0);
export const markerMaterial = new MeshStandardMaterial({
  color: 0xf4c44e,
  roughness: 0.35,
  metalness: 0.6,
});

export const SPOTLIGHT_COLOR = 0xffe4b5;
export const SPOTLIGHT_INTENSITY = 120;
export const SPOTLIGHT_DISTANCE = 65;
export const SPOTLIGHT_ANGLE = Math.PI / 5;
