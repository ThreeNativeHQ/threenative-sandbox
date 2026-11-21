import {
  Atmosphere,
  type OutputRenderer,
  VirtualShadowNode,
  WaterSurface3D,
  debugFlag,
} from "@threenative/core";
import {
  Heightfield,
  type IShadowRegion,
  type IWorldPackage,
  WorldCells,
} from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  BackSide,
  BufferAttribute,
  type Camera,
  ClampToEdgeWrapping,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NoColorSpace,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  type Scene,
  SphereGeometry,
  UnsignedByteType,
  Vector3,
} from "three";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import {
  attribute,
  cameraPosition,
  dot,
  exp,
  float,
  mix,
  mrt,
  mx_fractal_noise_float,
  normalView,
  normalWorld,
  normalize,
  output,
  pass,
  positionLocal,
  positionWorld,
  pow,
  saturation,
  screenSize,
  screenUV,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { SUN_DIRECTION } from "./sky.js";

function createRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

export const STRATA = ["worldCells", "foliage", "splatGround", "water", "strataPost"] as const;
export type Strata = (typeof STRATA)[number];

export interface IStrataContext {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly renderer: OutputRenderer;
  readonly physics: IPhysicsContext;
  add(object: Object3D): void;
}

export interface IStrataPreparedWorld {
  readonly cells: WorldCells;
  readonly follow: { readonly position: { x: number; y: number; z: number } };
  readonly totalPlacements: number;
  setShadowNode(node: VirtualShadowNode | undefined): void;
}

const CELL_COUNT = 12;
const CELL_SIZE = 30;
const WORLD_HALF = (CELL_COUNT * CELL_SIZE) / 2;
const PLACEMENTS_PER_CELL = 125; // 144 * 125 = 18,000 placements at load=1
const FOLIAGE_COUNT = 4_000;
const LAKE_CENTER = { x: 76, z: 24, radius: 32 } as const;
const WALK_ORBIT = { radius: 48, speed: 11 } as const;

export function strataEnabled(layer: Strata): boolean {
  return debugFlag("strata") && !debugFlag(`no${layer[0]?.toUpperCase()}${layer.slice(1)}`);
}

/** Deterministic strata heightfield elevation; flat in the central plaza (`r < 44`) and depressed at the lake basin. */
export function strataHeightAt(x: number, z: number): number {
  const centerDist = Math.hypot(x, z);
  const hillMask = smoothstepJs(44, 58, centerDist);
  const rolling =
    (Math.sin(x * 0.032) * Math.cos(z * 0.029) * 3.8 + Math.sin((x + z) * 0.065) * 1.4 + 2.1) *
    hillMask;
  const lakeDist = Math.hypot(x - LAKE_CENTER.x, z - LAKE_CENTER.z);
  const lakeDip = (1 - smoothstepJs(10, LAKE_CENTER.radius, lakeDist)) * 2.9;
  return rolling - lakeDip;
}

function smoothstepJs(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function groundY(x: number, z: number, withSplat: boolean): number {
  return withSplat ? strataHeightAt(x, z) : 0;
}

function insideLake(x: number, z: number): boolean {
  return Math.hypot(x - LAKE_CENTER.x, z - LAKE_CENTER.z) < LAKE_CENTER.radius + 2;
}

function proceduralSplatTexture(
  size: number,
  seed: number,
  baseRgb: readonly [number, number, number],
  accentRgb: readonly [number, number, number],
  srgb: boolean,
): DataTexture {
  const rand = createRandom(seed);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      const wave =
        0.5 + 0.25 * Math.sin((x / size) * Math.PI * 4) + 0.25 * Math.cos((y / size) * Math.PI * 6);
      const t = Math.min(1, Math.max(0, wave * 0.65 + rand() * 0.35));
      data[idx] = Math.round(baseRgb[0] + (accentRgb[0] - baseRgb[0]) * t);
      data[idx + 1] = Math.round(baseRgb[1] + (accentRgb[1] - baseRgb[1]) * t);
      data[idx + 2] = Math.round(baseRgb[2] + (accentRgb[2] - baseRgb[2]) * t);
      data[idx + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function leafCutoutTexture(size = 32): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const v = y / (size - 1);
    const bladeHalf = 0.08 + 0.34 * Math.sin(v * Math.PI) * (1 - v * 0.25);
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1);
      const dist = Math.abs(u - 0.5);
      const inside = dist <= bladeHalf && v > 0.02 && v < 0.98;
      const idx = (y * size + x) * 4;
      const shade = 0.72 + 0.28 * (1 - dist / Math.max(bladeHalf, 0.05));
      data[idx] = Math.round(48 * shade);
      data[idx + 1] = Math.round((84 + 62 * v) * shade);
      data[idx + 2] = Math.round(34 * shade);
      data[idx + 3] = inside ? 255 : 0;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildProceduralModel(url: string): Object3D {
  const group = new Object3D();
  const trunkMat = new MeshStandardMaterial({ color: 0x563c2a, roughness: 0.92 });
  const canopyMat = new MeshStandardMaterial({ color: 0x264e27, roughness: 0.84 });
  const bushMat = new MeshStandardMaterial({ color: 0x35642e, roughness: 0.88 });

  if (url.includes("tree-lod2")) {
    const crown = new Mesh(new ConeGeometry(1.5, 6.2, 5).translate(0, 3.1, 0), canopyMat);
    group.add(crown);
    return group;
  }
  if (url.includes("tree-lod1")) {
    const trunk = new Mesh(new CylinderGeometry(0.16, 0.28, 3.4, 5).translate(0, 1.7, 0), trunkMat);
    const crown = new Mesh(new ConeGeometry(1.5, 4.6, 7).translate(0, 4.7, 0), canopyMat);
    trunk.castShadow = true;
    crown.castShadow = true;
    group.add(trunk, crown);
    return group;
  }
  if (url.includes("tree-lod0")) {
    const trunk = new Mesh(new CylinderGeometry(0.16, 0.28, 3.4, 7).translate(0, 1.7, 0), trunkMat);
    const crownLower = new Mesh(new ConeGeometry(1.6, 3.2, 10).translate(0, 3.8, 0), canopyMat);
    const crownUpper = new Mesh(new ConeGeometry(1.1, 2.8, 10).translate(0, 5.5, 0), canopyMat);
    for (const part of [trunk, crownLower, crownUpper]) {
      part.castShadow = true;
      part.receiveShadow = true;
    }
    group.add(trunk, crownLower, crownUpper);
    return group;
  }
  if (url.includes("bush-lod1")) {
    const bush = new Mesh(new IcosahedronGeometry(0.85, 0).translate(0, 0.65, 0), bushMat);
    group.add(bush);
    return group;
  }
  const bush = new Mesh(new IcosahedronGeometry(0.85, 1).translate(0, 0.65, 0), bushMat);
  bush.castShadow = true;
  bush.receiveShadow = true;
  group.add(bush);
  return group;
}

/**
 * Loads procedural `WorldCells` ahead of `Stress.enter()` without external GLBs or HTTP fetches.
 */
export async function prepareStrataWorldCells(
  load: number,
  withSplatGround: boolean,
): Promise<IStrataPreparedWorld> {
  const rand = createRandom(6201);
  const perCell = Math.max(12, Math.round(PLACEMENTS_PER_CELL * load));
  const treePerCell = Math.round(perCell * 0.64);
  const bushPerCell = Math.max(4, perCell - treePerCell);
  const maxRecords = CELL_COUNT * CELL_COUNT * perCell;
  const records = new Float32Array(maxRecords * 8);
  const cells: {
    x: number;
    z: number;
    runs: { asset: string; offset: number; count: number }[];
  }[] = [];
  const quat = new Quaternion();
  const up = new Vector3(0, 1, 0);
  let cursor = 0;

  const pushPlacements = (
    cellX: number,
    cellZ: number,
    count: number,
    scaleMin: number,
    scaleRange: number,
  ) => {
    const offset = cursor;
    let written = 0;
    const minX = -WORLD_HALF + cellX * CELL_SIZE;
    const minZ = -WORLD_HALF + cellZ * CELL_SIZE;
    for (let attempt = 0; attempt < count * 3 && written < count; attempt += 1) {
      const x = minX + rand() * CELL_SIZE;
      const z = minZ + rand() * CELL_SIZE;
      if (Math.hypot(x, z) < 46 || insideLake(x, z)) continue;
      const y = groundY(x, z, withSplatGround);
      quat.setFromAxisAngle(up, rand() * Math.PI * 2);
      const scale = scaleMin + rand() * scaleRange;
      const base = cursor * 8;
      records[base] = x;
      records[base + 1] = y;
      records[base + 2] = z;
      records[base + 3] = quat.x;
      records[base + 4] = quat.y;
      records[base + 5] = quat.z;
      records[base + 6] = quat.w;
      records[base + 7] = scale;
      cursor += 1;
      written += 1;
    }
    return { offset, count: written };
  };

  for (let cz = 0; cz < CELL_COUNT; cz += 1) {
    for (let cx = 0; cx < CELL_COUNT; cx += 1) {
      const treeRun = pushPlacements(cx, cz, treePerCell, 0.8, 0.65);
      const bushRun = pushPlacements(cx, cz, bushPerCell, 0.75, 0.7);
      const runs: { asset: string; offset: number; count: number }[] = [];
      if (treeRun.count > 0) runs.push({ asset: "pine", ...treeRun });
      if (bushRun.count > 0) runs.push({ asset: "shrub", ...bushRun });
      cells.push({ x: cx, z: cz, runs });
    }
  }

  const trimmed = records.slice(0, cursor * 8);
  const manifest: IWorldPackage = {
    version: 1,
    extent: {
      minX: -WORLD_HALF,
      minZ: -WORLD_HALF,
      sizeX: CELL_COUNT * CELL_SIZE,
      sizeZ: CELL_COUNT * CELL_SIZE,
    },
    cellSize: CELL_SIZE,
    terrain: {
      heightmap: "strata/heightmap.u16",
      columns: 2,
      rows: 2,
      spacing: CELL_COUNT * CELL_SIZE,
      heightMin: -4,
      heightMax: 12,
    },
    assets: {
      pine: {
        glb: "strata/tree-lod0.glb",
        lods: [
          { glb: "strata/tree-lod1.glb", distance: 26 },
          { glb: "strata/tree-lod2.glb", distance: 64 },
        ],
        bounds: { min: [-1.6, 0, -1.6], max: [1.6, 7.2, 1.6] },
        maxDistance: 175,
      },
      shrub: {
        glb: "strata/bush-lod0.glb",
        lods: [{ glb: "strata/bush-lod1.glb", distance: 22 }],
        bounds: { min: [-0.9, 0, -0.9], max: [0.9, 1.6, 0.9] },
        maxDistance: 95,
      },
    },
    placements: "strata/placements.f32",
    cells,
  };

  const follow = { position: { x: WALK_ORBIT.radius, y: 0, z: 0 } };
  let shadowNode: VirtualShadowNode | undefined;
  const cellsWorld = await WorldCells.load({
    url: "strata/world.json",
    surface: new MeshStandardMaterial(),
    follow,
    ring: 2,
    terrain: false,
    gpuScene: false,
    lodTransition: "temporal",
    lodHysteresis: 0.15,
    occlusion: "off",
    data: {
      manifest,
      placements: trimmed.buffer,
    },
    loadModel: async (url) => buildProceduralModel(url),
    shadows: {
      cast: true,
      castLevels: 2,
      receive: true,
      invalidate: (region?: IShadowRegion) => {
        if (region === undefined) shadowNode?.invalidateAll();
        else shadowNode?.invalidateRegion(region);
      },
    },
    budgets: {
      residentCells: 36,
      instances: Math.max(8_000, cursor),
      bytes: Math.max(8_000, cursor) * 32,
    },
  });

  return {
    cells: cellsWorld,
    follow,
    totalPlacements: cursor,
    setShadowNode: (node) => {
      shadowNode = node;
      shadowNode?.setFocus(follow.position);
    },
  };
}

function crossCardFoliageGeometry(): PlaneGeometry {
  const a = new PlaneGeometry(0.95, 1.15, 1, 2);
  a.translate(0, 0.575, 0);
  const b = new PlaneGeometry(0.95, 1.15, 1, 2);
  b.rotateY(Math.PI * 0.5);
  b.translate(0, 0.575, 0);
  const aPos = a.attributes.position;
  const bPos = b.attributes.position;
  const aNorm = a.attributes.normal;
  const bNorm = b.attributes.normal;
  const aUv = a.attributes.uv;
  const bUv = b.attributes.uv;
  const aIdx = a.index;
  const bIdx = b.index;
  if (!aPos || !bPos || !aNorm || !bNorm || !aUv || !bUv || !aIdx || !bIdx) return a;
  const posArr = new Float32Array((aPos.count + bPos.count) * 3);
  posArr.set(aPos.array as Float32Array, 0);
  posArr.set(bPos.array as Float32Array, aPos.count * 3);
  const normArr = new Float32Array((aNorm.count + bNorm.count) * 3);
  normArr.set(aNorm.array as Float32Array, 0);
  normArr.set(bNorm.array as Float32Array, aNorm.count * 3);
  const uvArr = new Float32Array((aUv.count + bUv.count) * 2);
  uvArr.set(aUv.array as Float32Array, 0);
  uvArr.set(bUv.array as Float32Array, aUv.count * 2);
  const swayArr = new Float32Array(aPos.count + bPos.count);
  for (let i = 0; i < swayArr.length; i += 1) {
    swayArr[i] = Math.min(1, Math.max(0, (posArr[i * 3 + 1] ?? 0) / 1.15));
  }
  const indices = new Uint16Array(aIdx.count + bIdx.count);
  for (let i = 0; i < aIdx.count; i += 1) indices[i] = aIdx.getX(i);
  for (let i = 0; i < bIdx.count; i += 1) indices[aIdx.count + i] = bIdx.getX(i) + aPos.count;

  const merged = new PlaneGeometry(1, 1);
  merged.setAttribute("position", aPos.clone().copyArray(posArr));
  merged.setAttribute("normal", aNorm.clone().copyArray(normArr));
  merged.setAttribute("uv", aUv.clone().copyArray(uvArr));
  merged.setAttribute("sway", new BufferAttribute(swayArr, 1));
  merged.setIndex(Array.from(indices));
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  a.dispose();
  b.dispose();
  return merged;
}

function createSplatGround(disposables: { dispose(): void }[]): {
  mesh: Mesh;
  heights: Heightfield;
} {
  const heights = Heightfield.fromSampler({
    columns: 129,
    rows: 129,
    width: WORLD_HALF * 2,
    depth: WORLD_HALF * 2,
    origin: { x: -WORLD_HALF, z: -WORLD_HALF },
    sampleHeight: strataHeightAt,
  });
  const textures = [
    proceduralSplatTexture(64, 11, [74, 104, 48], [98, 128, 60], true),
    proceduralSplatTexture(64, 12, [68, 52, 34], [94, 70, 44], true),
    proceduralSplatTexture(64, 13, [46, 74, 34], [64, 96, 44], true),
    proceduralSplatTexture(64, 14, [96, 94, 88], [132, 128, 118], true),
    proceduralSplatTexture(64, 15, [120, 128, 255], [136, 132, 250], false),
    proceduralSplatTexture(64, 16, [180, 175, 165], [225, 220, 210], false),
  ] as const;
  for (const tex of textures) disposables.push(tex);

  const worldUv = positionWorld.xz.mul(0.08);
  const macroUv = positionWorld.xz.mul(0.014);
  const grass = texture(textures[0], worldUv).rgb;
  const dirt = texture(textures[1], worldUv).rgb;
  const moss = texture(textures[2], worldUv).rgb;
  const cliff = texture(textures[3], positionWorld.xy.add(positionWorld.zy).mul(0.06)).rgb;
  const splatNoise = texture(textures[4], macroUv).r;
  const micro = texture(textures[5], worldUv).r;

  const slope = float(1).sub(normalWorld.y.clamp(0, 1));
  const rockMask = smoothstep(0.18, 0.42, slope);
  const mossMask = smoothstep(0.35, 0.72, splatNoise);
  const lowDirtMask = float(1).sub(smoothstep(-0.8, 0.8, positionWorld.y));
  const blended = mix(grass, moss, mossMask);
  const shoreMix = mix(blended, dirt, lowDirtMask.mul(0.65));
  const finalAlbedo = mix(shoreMix, cliff, rockMask).mul(mix(float(0.84), float(1.12), micro));

  const material = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0.0 });
  material.colorNode = finalAlbedo;
  const geometry = heights.toGeometry();
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  disposables.push(geometry, material);
  return { mesh, heights };
}

function createStrataPost(
  ctx: IStrataContext,
  disposables: { dispose(): void }[],
): {
  dispose: () => void;
} {
  const air = new Atmosphere({
    rayleigh: [0.0058, 0.0135, 0.0331],
    mie: [0.004, 0.004, 0.004],
    ozone: [0.00065, 0.001881, 0.000085],
    planetRadius: 6360,
    atmosphereRadius: 6460,
  });
  air.setSunDirection(SUN_DIRECTION);
  ctx.add(air);

  const sunUniform = uniform(SUN_DIRECTION.clone());
  const dir = normalize(positionLocal);
  const skyGrad = air.radiance(dir) as Node<"vec3">;
  const clouds = mx_fractal_noise_float(dir.mul(4.5), 3, 2, 0.5).smoothstep(0.15, 0.65);
  const horizonMask = smoothstep(0.02, 0.35, dir.y);
  const sunDisc = smoothstep(Math.cos(0.014), Math.cos(0.007), dot(dir, sunUniform));
  const domeMat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  domeMat.colorNode = mix(skyGrad, vec3(0.95, 0.96, 0.99), clouds.mul(horizonMask).mul(0.5)).add(
    vec3(2.2, 2.0, 1.7).mul(sunDisc),
  );
  const domeGeo = new SphereGeometry(480, 32, 16);
  const dome = new Mesh(domeGeo, domeMat);
  dome.frustumCulled = false;
  ctx.add(dome);
  disposables.push(domeGeo, domeMat);

  let chain: { dispose(): void } | undefined;
  if (ctx.renderer.kind === "webgpu" && ctx.renderer.createRenderChain !== undefined) {
    ctx.scene.fogNode = null;
    ctx.scene.fog = null;
    const world = pass(ctx.scene, ctx.camera);
    world.setMRT(mrt({ output, normal: normalView }));
    const depth = world.getTextureNode("depth");
    const airDepth = depth.r.min(depth.sample(screenUV.add(vec2(0, screenSize.y.reciprocal()))).r);
    const viewDist = world.getViewZNode().negate();
    const airComposite = air.aerialPerspective(world, viewDist);
    const airOutput = mix(
      airComposite,
      world.getTextureNode("output"),
      airDepth.greaterThanEqual(1).toFloat(),
    );
    const contact = ao(depth, null as never, ctx.camera);
    contact.radius.value = 0.85;
    contact.scale.value = 0.8;
    contact.samples.value = 8;
    contact.resolutionScale = 0.5;
    const filtered = denoise(
      contact.getTextureNode(),
      depth,
      null as never,
      ctx.camera,
    ) as unknown as Node<"vec4">;
    chain = ctx.renderer.createRenderChain({
      input: airOutput,
      worldPass: world,
      request: {
        stages: ["ambientOcclusion", "grade"],
        tier: "high",
      },
      stages: [
        {
          name: "ambientOcclusion",
          minimumTier: "medium",
          build: (input) =>
            (input as Node<"vec4">).mul(
              vec4(
                vec3(
                  mix(1, filtered.r, float(0.72).mul(float(1).sub(smoothstep(40, 180, viewDist)))),
                ),
                1,
              ),
            ),
        },
        {
          name: "grade",
          after: "ambientOcclusion",
          minimumTier: "low",
          build: (input) => vec4(saturation((input as Node<"vec4">).rgb, float(1.06)), 1),
        },
      ],
    });
  }

  return {
    dispose: () => {
      chain?.dispose();
      air.dispose?.();
    },
  };
}

export interface IStrataSetup {
  readonly tick: (clock: number, dt: number, still: boolean) => void;
  readonly dispose: () => void;
}

export function setupStrataLayers(options: {
  readonly ctx: IStrataContext;
  readonly strata: (layer: Strata) => boolean;
  readonly load: number;
  readonly preparedWorld: IStrataPreparedWorld | undefined;
  readonly shadowNode: VirtualShadowNode | undefined;
  readonly counts: Record<string, number>;
}): IStrataSetup {
  const { ctx, strata, load, preparedWorld, shadowNode, counts } = options;
  const disposables: { dispose(): void }[] = [];
  const withSplat = strata("splatGround");

  if (withSplat) {
    const { mesh, heights } = createSplatGround(disposables);
    ctx.add(mesh);
    const groundBody = new Object3D();
    ctx.add(groundBody);
    new RigidBody3D({
      object: groundBody,
      physics: ctx.physics,
      shape: CollisionShape3D.heightfield(
        heights.rows,
        heights.columns,
        heights.toColliderHeights(),
        { x: heights.width, y: 1, z: heights.depth },
      ),
      type: "fixed",
    });
    counts.strataSplatGround = heights.rows * heights.columns;
  }

  const windClock = uniform(0);
  if (strata("foliage")) {
    const foliageTarget = Math.max(128, Math.round(FOLIAGE_COUNT * load));
    const cutout = leafCutoutTexture(32);
    disposables.push(cutout);
    const mat = new MeshStandardNodeMaterial({
      map: cutout,
      alphaTest: 0.45,
      transparent: false,
      side: DoubleSide,
      roughness: 0.85,
    });
    const weight = attribute<"float">("sway", "float");
    const wave = windClock
      .mul(Math.PI * 2 * 0.65)
      .add(positionWorld.x.mul(0.31))
      .add(positionWorld.z.mul(0.24))
      .sin()
      .mul(0.22)
      .mul(weight);
    const gust = windClock
      .mul(Math.PI * 2 * 0.24)
      .add(positionWorld.x.mul(0.07))
      .add(positionWorld.z.mul(0.11))
      .sin()
      .mul(0.12)
      .mul(weight);
    mat.positionNode = positionLocal.add(vec3(wave.add(gust), 0, wave.mul(0.35)));
    mat.castShadowPositionNode = positionLocal;
    (mat as MeshStandardNodeMaterial & { maxPositionOffset?: number }).maxPositionOffset = 0.35;

    const geo = crossCardFoliageGeometry();
    const mesh = new InstancedMesh(geo, mat, foliageTarget);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const rand = createRandom(7733);
    const dummy = new Object3D();
    let placed = 0;
    for (let attempt = 0; attempt < foliageTarget * 3 && placed < foliageTarget; attempt += 1) {
      const x = (rand() * 2 - 1) * (WORLD_HALF - 4);
      const z = (rand() * 2 - 1) * (WORLD_HALF - 4);
      if (Math.hypot(x, z) < 42 || insideLake(x, z)) continue;
      dummy.position.set(x, groundY(x, z, withSplat), z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.setScalar(0.75 + rand() * 0.75);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      placed += 1;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    ctx.add(mesh);
    disposables.push(geo, mat);
    counts.strataFoliage = placed;
  }

  let water: WaterSurface3D | undefined;
  if (strata("water")) {
    water = new WaterSurface3D({
      level: -0.45,
      maxThickness: 4,
      reflection: { resolutionScale: 0.5, refreshInterval: 1 },
    });
    const waterGeo = new PlaneGeometry(92, 92, 24, 24);
    waterGeo.rotateX(-Math.PI / 2);
    const ripple = vec2(
      positionWorld.x.mul(0.18).add(windClock.mul(1.4)).sin().mul(0.008),
      positionWorld.z.mul(0.22).sub(windClock.mul(1.1)).cos().mul(0.008),
    );
    const waterMat = new MeshStandardNodeMaterial({
      transparent: true,
      roughness: 0.08,
      metalness: 0.15,
    });
    const mirror = water.reflectionAt(ripple);
    const depthMeters = water.thicknessAt(ripple);
    const absorption = exp(depthMeters.mul(-0.45)).clamp(0, 1);
    const beneath = water.refractionAt(ripple);
    const tintedWater = mix(vec3(0.04, 0.17, 0.22), beneath, absorption);
    const fresnel = pow(
      float(1).sub(dot(normalWorld, normalize(cameraPosition.sub(positionWorld))).clamp(0, 1)),
      float(3),
    ).mul(0.75);
    waterMat.colorNode = mix(tintedWater, mirror, fresnel);
    const waterMesh = new Mesh(waterGeo, waterMat);
    waterMesh.position.set(LAKE_CENTER.x, -0.45, LAKE_CENTER.z);
    waterMesh.receiveShadow = true;
    ctx.add(waterMesh);
    disposables.push(waterGeo, waterMat);
    counts.strataWater = 1;
  }

  let postHandle: { dispose(): void } | undefined;
  if (strata("strataPost")) {
    postHandle = createStrataPost(ctx, disposables);
    counts.strataPost = 1;
  }

  if (strata("worldCells") && preparedWorld !== undefined) {
    preparedWorld.setShadowNode(shadowNode);
    ctx.add(preparedWorld.cells);
    counts.strataWorldCells = preparedWorld.totalPlacements;
  }

  let frameCount = 0;
  let primedArrays = false;
  return {
    tick: (clock, _dt, still) => {
      windClock.value = clock;
      frameCount += 1;
      if (strata("worldCells") && preparedWorld !== undefined) {
        if (!still) {
          const angle = (clock * WALK_ORBIT.speed) / WALK_ORBIT.radius;
          const x = Math.cos(angle) * WALK_ORBIT.radius;
          const z = Math.sin(angle) * WALK_ORBIT.radius;
          preparedWorld.follow.position.x = x;
          preparedWorld.follow.position.z = z;
          preparedWorld.follow.position.y = groundY(x, z, withSplat);
          shadowNode?.setFocus(preparedWorld.follow.position);
        }
        if (!primedArrays || frameCount % 30 === 0) {
          primedArrays = true;
          preparedWorld.cells.traverse((obj) => {
            if (obj instanceof InstancedMesh) {
              // Mirrors `diagnostics.ts` accessing `instanceMatrix.array` so bridge array sync stays active.
              void obj.instanceMatrix.array.length;
            }
          });
        }
      }
    },
    dispose: () => {
      preparedWorld?.setShadowNode(undefined);
      preparedWorld?.cells.dispose();
      postHandle?.dispose();
      water?.dispose();
      for (const item of disposables) item.dispose();
    },
  };
}
