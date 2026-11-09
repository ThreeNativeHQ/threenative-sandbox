/**
 * The low-draw stand-in for an airframe the render camera resolves to only a few tens of pixels.
 *
 * The recovery burst is 64 aircraft in the landing pattern plus the hulls they circle: in
 * report-REC's census one 48 px carrier cost 147 draws and one 30 px AI Devastator cost 92, because
 * every airframe is drawn as one submit per mesh — 22 meshes for a Douglas, 95 for the ported TBD.
 * Below a few tens of pixels none of that structure is resolvable, so one merged geometry in one
 * representative material is indistinguishable and costs one draw.
 *
 * Built once per airframe type at load from the already-loaded model — no reduced GLB ships and no
 * shipped bytes change. The merged geometry, its material and its average texture colour are cached
 * by airframe name and shared by every instance; only the tiny `T.Mesh` wrapper is per aircraft, so
 * releasing one aircraft never disposes another's geometry.
 *
 * One deliberate limit, measured rather than assumed: the merged mesh is static, so it is only ever
 * shown for aircraft small enough that a stopped propeller and stowed gear are not resolvable. Every
 * animated node stays on the full-detail path, which the caller keeps and toggles between.
 */
import * as T from "three";
import { addInSlices, mergeParts } from "@threenative/core";

export interface AirframeLod {
  geometry: T.BufferGeometry;
  material: T.Material;
}

/** Merged stand-ins, keyed by build (`Mitsubishi A6M3`, `Douglas TBD-1 Devastator`, `hornet`, ...). */
const cache = new Map<string, AirframeLod | null>();
/** Average texture colour, so a material shared by many meshes samples once. */
// Keyed by the texture itself: the owned engine binds no `uuid` on a texture, so a uuid key folds
// every texture into one `undefined` entry.
const textureColour = new WeakMap<T.Texture, T.Color>();

/**
 * The merged stand-in for `full`, built and cached on first request. Null when there is nothing to merge.
 *
 * A hull reuses this: one supplied carrier is 246k–347k triangles across 94–146 meshes and, drawn
 * just inside `FAR_HULL` for a speck, costs more draw submissions than the entire parked deck load.
 * The explicit `key` lets the three US carriers that share `hornet.glb` — and any two ships of one
 * catalog class — build and share one stand-in instead of one per ship name. The geometry is baked
 * in `full`'s own local frame, so the caller shows it as a sibling of `full` inside the same parent.
 */
export function airframeLod(full: T.Object3D, key = full.name || `${full.type}#${full.id}`): AirframeLod | null {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const built = buildLod(full);
  cache.set(key, built);
  return built;
}

/** Drop every cached stand-in. Verification switch only; the scene never calls it. */
export function clearAirframeLod(): void {
  for (const lod of cache.values()) {
    lod?.geometry.dispose();
    lod?.material.dispose();
  }
  cache.clear();
}

function buildLod(full: T.Object3D): AirframeLod | null {
  const steps = buildLodSteps(full);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** One slot per step of `buildLodSteps`: one per mesh of the largest hull, with room to spare. */
const LOD_STEP_SLOTS = Array.from({ length: 8192 }, (_, i) => i);
const pending = new Map<string, Promise<AirframeLod | null>>();

/**
 * `airframeLod`, built one source mesh per step in the frame's headroom. A hull that streams in
 * after the reveal merged its stand-in in one task of 190-490 ms; the caller shows the full hull
 * until this settles. Two hulls of one class share the one build.
 */
export function airframeLodSliced(full: T.Object3D, key: string): Promise<AirframeLod | null> {
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let build = pending.get(key);
  if (build === undefined) {
    build = (async () => {
      const steps = buildLodSteps(full);
      let step = steps.next();
      await addInSlices(LOD_STEP_SLOTS, () => {
        step = steps.next();
      }, { marker: false, while: () => !step.done });
      while (!step.done) step = steps.next();
      cache.set(key, step.value);
      pending.delete(key);
      return step.value;
    })();
    pending.set(key, build);
  }
  return build;
}

function* buildLodSteps(full: T.Object3D): Generator<void, AirframeLod | null, void> {
  // Every source and its placement in `full`'s frame, read now: the hull keeps sailing while the
  // steps run, and a park or decor added after this call must stay out of the stand-in.
  full.updateMatrixWorld(true);
  const toLocal = full.matrixWorld.clone().invert();
  const sources: Array<{ geometry: T.BufferGeometry; place: T.Matrix4 }> = [];
  let representative: T.Material | null = null;
  let heaviest = -1;
  full.traverse((node) => {
    if (!(node as T.Mesh).isMesh) return;
    const mesh = node as T.Mesh;
    // A skinned mesh's vertices are its bind pose, not what the mixer draws: merging a seated crew
    // figure would bake a standing T-pose into the distant stand-in. The posed figure stays on the
    // full-detail path, which the caller hides when it shows the merge.
    if ((mesh as T.SkinnedMesh).isSkinnedMesh === true) return;
    const geometry = mesh.geometry as T.BufferGeometry | undefined;
    if (!geometry?.getAttribute("position")) return;
    if (Array.isArray(mesh.material)) return;
    const triangles = geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
    if (triangles > heaviest) {
      heaviest = triangles;
      representative = mesh.material;
    }
    sources.push({ geometry, place: new T.Matrix4().multiplyMatrices(toLocal, mesh.matrixWorld) });
  });
  const parts: T.BufferGeometry[] = [];
  for (const { geometry, place } of sources) {
    yield;
    // Non-indexed and position/normal/uv only: `mergeGeometries` rejects a mixed attribute set and
    // the second UV or vertex-colour channel a supplied model may carry is not worth a second draw.
    const plain = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    for (const name of Object.keys(plain.attributes))
      if (name !== "position" && name !== "normal" && name !== "uv") plain.deleteAttribute(name);
    if (!plain.getAttribute("normal")) plain.computeVertexNormals();
    if (!plain.getAttribute("uv")) {
      const count = plain.getAttribute("position").count;
      plain.setAttribute("uv", new T.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    plain.applyMatrix4(place);
    parts.push(plain);
  }
  if (!parts.length || !representative) return null;
  yield;
  const merged = mergeLod(parts);
  for (const part of parts) part.dispose();
  if (!merged) return null;
  const material = new T.MeshStandardMaterial({
    color: averageColour(representative),
    metalness: 0.05,
    roughness: 0.72,
    envMapIntensity: 0.6,
    side: (representative as T.MeshStandardMaterial).side,
  });
  paintFromGpu(representative, material);
  return { geometry: merged, material };
}

function mergeLod(parts: T.BufferGeometry[]): T.BufferGeometry | null {
  // `mergeParts` keeps the authored normals and texture coordinates; it refuses rather than
  // returning `null`, so the null the caller's contract expects is translated here. Every part is
  // already de-indexed, placed and carrying position/normal/uv, so the preserved channels are the
  // attribute set this file has always read.
  try {
    const merged = mergeParts(
      parts.map((geometry) => ({ geometry })),
      { label: "airframe-lod", preserve: ["uv", "normal"] },
    );
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  } catch {
    return null;
  }
}

/**
 * The colour the stand-in is drawn in.
 *
 * A flat material carries the colour outright. A mapped one has white as its colour and its whole
 * look in the texture, so the texture is averaged once into a single sRGB average and converted to
 * linear — a white Kate is exactly the "loses its markings" revert this file exists to avoid. With
 * neither, or with an image this platform cannot draw, a mid grey stands in until `paintFromGpu`
 * reads the texture's mean off the GPU.
 */
function averageColour(material: T.Material): T.Color {
  const standard = material as T.MeshStandardMaterial;
  if (standard.map) {
    const key = standard.map;
    const cached = textureColour.get(key);
    if (cached) return cached;
    const sampled = sampleAverage(standard.map);
    if (sampled) {
      textureColour.set(key, sampled);
      return sampled;
    }
    return new T.Color(0x808080);
  }
  return standard.color?.clone() ?? new T.Color(0x808080);
}

interface IMeanRenderer {
  render(scene: T.Object3D, camera: T.Camera): void;
  getRenderTarget(): unknown;
  setRenderTarget(target: unknown): void;
  readRenderTargetPixelsAsync?(target: unknown, x: number, y: number, w: number, h: number): Promise<ArrayLike<number>>;
}

let meanRenderer: IMeanRenderer | undefined;
const gpuMeans = new WeakMap<T.Texture, Promise<T.Color | null>>();

/** The renderer `paintFromGpu` draws with. The owned engine keeps no CPU pixels to average. */
export function setStandInRenderer(renderer: unknown): void {
  meanRenderer = renderer as IMeanRenderer;
}

/**
 * The owned engine's `texture.image` is `{ width, height }` with no pixels, so the canvas average
 * throws and every textured stand-in drew white. The GPU has the pixels: one quad draws the map into
 * a 1x1 target, where the sampler takes the 1x1 mip — the mean of the whole image — and that one
 * pixel is read back.
 */
function paintFromGpu(source: T.Material, standIn: T.MeshStandardMaterial): void {
  const map = (source as T.MeshStandardMaterial).map;
  if (!map || textureColour.has(map)) return;
  let mean = gpuMeans.get(map);
  if (mean === undefined) {
    mean = gpuMean(map).catch(() => null);
    gpuMeans.set(map, mean);
  }
  void mean.then((colour) => {
    if (!colour) return;
    textureColour.set(map, colour);
    standIn.color.copy(colour);
  });
}

async function gpuMean(map: T.Texture): Promise<T.Color | null> {
  const renderer = meanRenderer;
  if (!renderer?.readRenderTargetPixelsAsync) return null;
  const target = new T.RenderTarget(1, 1, { depthBuffer: false });
  target.texture.colorSpace = T.SRGBColorSpace;
  const scene = new T.Scene();
  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new T.Mesh(new T.PlaneGeometry(2, 2), new T.MeshBasicMaterial({ map, toneMapped: false }));
  scene.add(quad);
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
  } finally {
    renderer.setRenderTarget(previous);
  }
  try {
    const pixel = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
    return new T.Color(pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255).convertSRGBToLinear();
  } finally {
    quad.geometry.dispose();
    (quad.material as T.Material).dispose();
    target.dispose();
  }
}

function sampleAverage(texture: T.Texture): T.Color | null {
  const image = texture.image as CanvasImageSource | undefined;
  if (!image || typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, 8, 8);
    const data = context.getImageData(0, 0, 8, 8).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
    }
    const n = data.length / 4;
    return new T.Color(r / n / 255, g / n / 255, b / n / 255).convertSRGBToLinear();
  } catch {
    return null;
  }
}
