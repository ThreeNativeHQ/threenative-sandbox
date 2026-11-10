// Generated look and motion for the stress lab's `?play` preset: what a shipped game adds to the
// flat-colour `real` world. Textured surfaces from a small material library, several meshes per
// layer, and a camera that walks the streets before it climbs. Plain three.js only, so the vanilla
// lab runs the same file.
import {
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DodecahedronGeometry,
  IcosahedronGeometry,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  NoColorSpace,
  OctahedronGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const SIZE = 512;
/** Unreal's default sampler anisotropy; a textured surface at a grazing angle needs it. */
const ANISOTROPY = 8;

const hash = (x: number, y: number, seed: number): number => {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

/** Tileable value noise, three octaves, 0 to 1. */
function heightField(seed: number): Float32Array {
  const field = new Float32Array(SIZE * SIZE);
  for (let octave = 0; octave < 3; octave += 1) {
    const cells = 8 << octave;
    const gain = 0.57 / (1 << octave);
    const step = cells / SIZE;
    for (let y = 0; y < SIZE; y += 1) {
      const fy = y * step;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < SIZE; x += 1) {
        const fx = x * step;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = hash(x0 % cells, y0 % cells, seed + octave);
        const b = hash((x0 + 1) % cells, y0 % cells, seed + octave);
        const c = hash(x0 % cells, (y0 + 1) % cells, seed + octave);
        const d = hash((x0 + 1) % cells, (y0 + 1) % cells, seed + octave);
        const i = y * SIZE + x;
        field[i] =
          (field[i] ?? 0) + gain * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
  }
  return field;
}

function texture(data: Uint8Array, srgb: boolean): DataTexture {
  const map = new DataTexture(data, SIZE, SIZE);
  map.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  map.wrapS = RepeatWrapping;
  map.wrapT = RepeatWrapping;
  map.generateMipmaps = true;
  map.minFilter = LinearMipmapLinearFilter;
  map.anisotropy = ANISOTROPY;
  map.needsUpdate = true;
  return map;
}

/** One surface: base colour, tangent-space normal and roughness maps from one height field. */
function surface(seed: number, color: number, repeat = 1): MeshStandardMaterial {
  const height = heightField(seed);
  const base = new Color(color).convertLinearToSRGB();
  const albedo = new Uint8Array(SIZE * SIZE * 4);
  const normal = new Uint8Array(SIZE * SIZE * 4);
  const rough = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1)
    for (let x = 0; x < SIZE; x += 1) {
      const i = y * SIZE + x;
      const h = height[i] ?? 0;
      const shade = 0.7 + 0.6 * h;
      albedo[i * 4] = Math.min(255, base.r * shade * 255);
      albedo[i * 4 + 1] = Math.min(255, base.g * shade * 255);
      albedo[i * 4 + 2] = Math.min(255, base.b * shade * 255);
      albedo[i * 4 + 3] = 255;
      const dx = (height[y * SIZE + ((x + 1) % SIZE)] ?? 0) - h;
      const dy = (height[((y + 1) % SIZE) * SIZE + x] ?? 0) - h;
      const nx = -dx * 24;
      const ny = -dy * 24;
      const inv = 1 / Math.hypot(nx, ny, 1);
      normal[i * 4] = (nx * inv * 0.5 + 0.5) * 255;
      normal[i * 4 + 1] = (ny * inv * 0.5 + 0.5) * 255;
      normal[i * 4 + 2] = (inv * 0.5 + 0.5) * 255;
      normal[i * 4 + 3] = 255;
      rough[i * 4 + 1] = (0.55 + 0.45 * h) * 255;
      rough[i * 4 + 3] = 255;
    }
  const maps = [texture(albedo, true), texture(normal, false), texture(rough, false)] as const;
  for (const map of maps) map.repeat.set(repeat, repeat);
  return new MeshStandardMaterial({ map: maps[0], normalMap: maps[1], roughnessMap: maps[2] });
}

/** A lumpy rock: the vertices of a subdivided icosahedron pushed along their own direction. */
function rock(seed: number): BufferGeometry {
  const geometry = new IcosahedronGeometry(0.5, 1);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i += 1) {
    const [x, y, z] = [position.getX(i), position.getY(i), position.getZ(i)];
    // Keyed on the position, so the copies of one corner move together and the mesh stays closed.
    const push = 0.75 + 0.5 * hash(Math.round(x * 97), Math.round(y * 89 + z * 83), seed);
    position.setXYZ(i, x * push, y * push, z * push);
  }
  geometry.computeVertexNormals();
  return geometry;
}

const merged = (parts: BufferGeometry[]): BufferGeometry => {
  const geometry = mergeGeometries(parts);
  if (geometry === null) throw new Error("stressPlay: canopy parts do not merge");
  return geometry;
};

/** Unit-height canopies, base at the origin like the `real` cone: two conifers, two broadleaves, one tall pine. */
const canopies = (): BufferGeometry[] => [
  merged([
    new ConeGeometry(1, 0.5, 12).translate(0, 0.25, 0),
    new ConeGeometry(0.78, 0.45, 12).translate(0, 0.52, 0),
    new ConeGeometry(0.5, 0.4, 12).translate(0, 0.8, 0),
  ]),
  merged([
    new ConeGeometry(0.9, 0.62, 10).translate(0, 0.31, 0),
    new ConeGeometry(0.55, 0.55, 10).translate(0, 0.72, 0),
  ]),
  merged([
    new IcosahedronGeometry(0.5, 2).scale(1.5, 1, 1.5).translate(0, 0.5, 0),
    new IcosahedronGeometry(0.34, 2).translate(0.45, 0.62, 0.2),
    new IcosahedronGeometry(0.3, 2).translate(-0.4, 0.4, -0.3),
  ]),
  merged([
    new IcosahedronGeometry(0.42, 2).scale(1.4, 1.1, 1.4).translate(0, 0.46, 0),
    new IcosahedronGeometry(0.36, 2).translate(0.2, 0.7, -0.25),
  ]),
  merged([
    new ConeGeometry(0.7, 0.34, 9).translate(0, 0.17, 0),
    new ConeGeometry(0.6, 0.3, 9).translate(0, 0.4, 0),
    new ConeGeometry(0.46, 0.28, 9).translate(0, 0.62, 0),
    new ConeGeometry(0.3, 0.26, 9).translate(0, 0.87, 0),
  ]),
];

export interface IPlayKit {
  ground: MeshStandardMaterial;
  /** One entry per species: the scene picks `i % length`. */
  trees: {
    trunk: BufferGeometry;
    canopy: BufferGeometry;
    bark: MeshStandardMaterial;
    leaf: MeshStandardMaterial;
  }[];
  rocks: { geometry: BufferGeometry; material: MeshStandardMaterial }[];
  houses: { roof: BufferGeometry; wall: MeshStandardMaterial; roofing: MeshStandardMaterial }[];
  chimney: BufferGeometry;
  /** Hand-placed props: twelve meshes over a library of 24 materials (8 surfaces, 3 tints each). */
  propGeometries: BufferGeometry[];
  propMaterials: MeshStandardMaterial[];
  body: MeshStandardMaterial;
  counts: { materials: number; textures: number };
}

export function playKit(): IPlayKit {
  let seed = 100;
  const next = (color: number, repeat = 1) => surface((seed += 7), color, repeat);
  const barks = [next(0x5a4030, 2), next(0x4a3a2c, 2)];
  const leaves = [next(0x2f5a2a), next(0x3d6a2c), next(0x25492a)];
  const stones = [next(0x7c7a74), next(0x6a6660)];
  const walls = [next(0xc9b99a, 2), next(0xb8a48a, 2), next(0xa9a9a2, 2), next(0xd6c8b0, 2)];
  const roofs = [next(0x8a3b2c, 2), next(0x6e4a3a, 2), next(0x4d5560, 2)];
  const roofShapes = [
    new ConeGeometry(0.8, 0.6, 4).rotateY(Math.PI / 4).translate(0, 0.3, 0),
    new CylinderGeometry(0.62, 0.62, 1.1, 3)
      .rotateZ(Math.PI / 2)
      .rotateY(Math.PI / 2)
      .translate(0, 0.3, 0),
  ];
  const trunk = (sides: number) =>
    new CylinderGeometry(0.12, 0.2, 1, sides, 3).translate(0, 0.5, 0);
  const propSurfaces = [
    0x9a6a3a, 0x7a5a40, 0x8a8a86, 0x55606a, 0xa8443a, 0x4a6a8a, 0xb09a50, 0x6a7a4a,
  ].map((color) => next(color));
  const propMaterials = propSurfaces.flatMap((material) =>
    [1, 0.8, 0.62].map((tint) => {
      const copy = material.clone();
      copy.color.setScalar(tint);
      return copy;
    }),
  );
  const kit: Omit<IPlayKit, "counts"> = {
    ground: next(0x5d6b3a, 90),
    trees: canopies().map((canopy, i) => ({
      trunk: trunk(6 + (i % 3) * 2),
      canopy,
      bark: barks[i % barks.length] as MeshStandardMaterial,
      leaf: leaves[i % leaves.length] as MeshStandardMaterial,
    })),
    rocks: [0, 1, 2, 3].map((i) => ({
      geometry: rock(40 + i),
      material: stones[i % stones.length] as MeshStandardMaterial,
    })),
    houses: [0, 1, 2, 3, 4, 5].map((i) => ({
      roof: roofShapes[i % roofShapes.length] as BufferGeometry,
      wall: walls[i % walls.length] as MeshStandardMaterial,
      roofing: roofs[i % roofs.length] as MeshStandardMaterial,
    })),
    chimney: new BoxGeometry(0.12, 0.5, 0.12).translate(0.22, 0.25, 0.1),
    propGeometries: [
      new BoxGeometry(1, 1, 1),
      new CylinderGeometry(0.4, 0.4, 1, 12),
      new BoxGeometry(1.4, 0.5, 0.7),
      new CylinderGeometry(0.3, 0.45, 0.8, 10),
      new SphereGeometry(0.5, 12, 8),
      new TorusGeometry(0.4, 0.15, 8, 16).rotateX(Math.PI / 2),
      new ConeGeometry(0.4, 1, 10),
      new CapsuleGeometry(0.25, 0.5, 4, 10),
      new OctahedronGeometry(0.5, 1),
      new CylinderGeometry(0.5, 0.5, 0.15, 16),
      new BoxGeometry(0.2, 1.2, 0.2),
      new DodecahedronGeometry(0.5, 0),
    ],
    propMaterials,
    body: next(0xb07a3a),
  };
  // 24 surfaces of three maps each; the tinted prop copies share their surface's maps.
  return { ...kit, counts: { materials: 24 - 8 + propMaterials.length, textures: 24 * 3 } };
}

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const PLAY_LOOP_SECONDS = 40;
/** `play` moves every house this far from both town axes, which opens two avenues to walk. */
export const AVENUE = 8;
const EYE = 2.2;
const OVERVIEW = { radius: 70, height: 24 } as const;

/** The walk: west gate to the square, a left turn north, a fast half turn at the north end, and back. */
function street(t: number): { x: number; z: number; yaw: number } {
  if (t >= 24) return { x: -38, z: 0, yaw: 0 };
  const yaw = (Math.PI / 2) * smooth(5.75, 6.25, t) + Math.PI * smooth(12, 12.5, t);
  if (t < 6) return { x: -38 + (38 * t) / 6, z: 0, yaw };
  if (t < 12) return { x: 0, z: (38 * (t - 6)) / 6, yaw };
  return { x: 0, z: 38 - 36 * Math.min(1, Math.max(0, t - 12.5) / 5.5), yaw };
}

/**
 * The play camera, a 40 s loop. Seconds 0 to 18 walk the avenues at eye height: a quarter turn at
 * the square and a half turn in half a second at the north end (a player who looks behind).
 * Seconds 18 to 24 climb to the `real` overview orbit, and the last six seconds come back down.
 */
export function playCamera(clock: number): {
  position: [number, number, number];
  target: [number, number, number];
} {
  const t = ((clock % PLAY_LOOP_SECONDS) + PLAY_LOOP_SECONDS) % PLAY_LOOP_SECONDS;
  const walk = street(t);
  const orbit = (t / PLAY_LOOP_SECONDS) * Math.PI * 2;
  const up = smooth(18, 24, t) - smooth(34, 40, t);
  const mix = (a: number, b: number) => a + (b - a) * up;
  return {
    position: [
      mix(walk.x, Math.cos(orbit) * OVERVIEW.radius),
      mix(EYE, OVERVIEW.height + Math.sin(orbit * 2) * 4),
      mix(walk.z, Math.sin(orbit) * OVERVIEW.radius),
    ],
    target: [
      mix(walk.x + Math.cos(walk.yaw) * 10, 0),
      mix(EYE - 0.4, 2),
      mix(walk.z + Math.sin(walk.yaw) * 10, 0),
    ],
  };
}

/** What one walker does for a few seconds before it changes its mind: clip and ground speed in m/s. */
export const WALKER_STATES = [
  { clip: "Walk_Loop", speed: 1.4 },
  { clip: "Jog_Fwd_Loop", speed: 3 },
  { clip: "Idle_Loop", speed: 0 },
  { clip: "Sprint_Loop", speed: 6 },
] as const;
export const WALKER_STATE_SECONDS = 4;
export const WALKER_FADE_SECONDS = 0.3;

/** Thrown objects: ten spawns a second, each alive for three seconds, so thirty fly at any time. */
export const THROW = { every: 0.1, life: 3, speed: 9, gravity: 9.8 } as const;
