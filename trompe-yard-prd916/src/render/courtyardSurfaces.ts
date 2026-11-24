// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The hybrid look: Poly Haven CC0 scans where a tiling material reads best, the AI paint where the
// level needs unique detail. trompe exports the courtyard as one mesh, so it is split here:
//   floor — upward faces at ground height: the AI paint's colour (so it matches the scene) times
//           the fine variation of Poly Haven "Asphalt 02", plus its normal and roughness: sharp at
//           the player's feet without a generic scan's colour
//   props — connected parts under PROP_SIZE (boxes, bollards, the round base): the AI paint's colour
//           times "Concrete Floor Worn 001" exactly as on the walls, plus its normal and roughness:
//           a prop is painted like the wall it stands against, not left the scan's own clay grey
//   walls — everything else: the AI paint's colour times the fine variation of "Concrete Floor Worn
//           001", plus its normal and roughness, so a wall at first-person distance is grain and not
//           a magnified blur. The paint keeps the colour and the brick layout; the scan only adds.
// The owned engine's TSL has one UV set, which the paint uses, so the details project world metres
// from positionWorld instead: along xz for the floor, along each face's own plane for the walls.
// Everything that depends on range keys off the camera-to-fragment distance: at arm's length a wall's
// paint is magnified past its own resolution, so it takes an unsharp mask and a stronger grain, both
// faded out by NEAR_END metres — a far wall renders exactly as it did before.
// PRD-916 phase 2o adds the paint's own swatches: a true-scale tileable crop of the AI paint, cut by
// trompe next to the GLB (`*.swatches.json` names one file and its metres per class). Close to the
// camera that swatch replaces the magnified atlas, multiplied by the atlas at macro mip bias divided
// by the swatch's own mean, so it carries the paint's stains and per-panel tone instead of repeating
// a clean patch. Phase 2p also lets the swatch cover unpainted fill at every distance — a fill has
// nothing to show up close or far — while painted brick still hands back to the atlas by SWATCH_END
// metres. Phase 2s replaces phase 2p's guess at that (the atlas's local detail, which read a painted
// slab in shadow as fill) with the bake's own answer: a painted-coverage mask, 255 on a texel an
// accepted view painted and 0 on one the fill made up, so the swatch covers exactly what no view saw.
// Phase 2t moves that mask out of the atlas alpha into `courtyard-klein.painted.png` beside the GLB: the
// cook dropped a lossy alpha on an OPAQUE material off UASTC, and a canvas premultiplies, so every
// filled texel exported black. The atlas stays opaque RGB, so the fill takes its colour back. A class
// the cook did not write borrows the other class's swatch, so an unpainted step tread is paved in
// stone rather than left a fill.
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  type Texture,
  Vector3,
} from "three";
import {
  abs,
  cameraPosition,
  cameraViewMatrix,
  clamp,
  cross,
  distance,
  dot,
  float,
  max,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** A connected part whose bounding box is smaller than this on every axis is a prop, in metres. */
const PROP_SIZE = 3;
/** An upward face lower than this is floor, in metres. */
const FLOOR_HEIGHT = 0.3;
/** Mean linear luminance of asphalt_02_diff_2k.jpg, measured offline: dividing by it keeps the paint's average. */
const ASPHALT_MEAN = 0.1138;
/** How much of the asphalt's variation reaches the floor colour: 0 is the paint alone, 1 all of it. */
const FLOOR_DETAIL = 0.7;
/** Mean linear luminance of concrete_floor_worn_001_diff_2k.jpg, measured the same way: its 2048x2048 pixels decoded from sRGB to linear, then 0.2126 r + 0.7152 g + 0.0722 b averaged. */
const CONCRETE_MEAN = 0.094;
/** Metres one tile of the wall detail covers. */
const WALL_TILE = 1.5;
/** How much of the concrete's variation reaches the wall colour: 0 is the paint alone, 1 all of it. */
const WALL_DETAIL = 0.5;
/** Strength of the concrete's normal on the walls: the grain of a wall, not new shapes on it. */
const WALL_RELIEF = 0.6;
/** Camera distance in metres where the close-range terms start: arm's length from a wall. */
const NEAR_START = 1.5;
/** Camera distance in metres where they have faded out again and the far wall is untouched. */
const NEAR_END = 4;
/** Wall detail at arm's length: the paint is magnified there, so the grain must carry more of it. */
const WALL_DETAIL_NEAR = 0.75;
/** Wall relief at arm's length, for the same reason. */
const WALL_RELIEF_NEAR = 0.9;
/** Unsharp-mask strength on the paint at arm's length: 0 is the plain sample, 1 doubles the edge. */
const SHARPEN = 0.8;
/** Mip levels of blur the unsharp mask subtracts: what magnification smeared out of the joints. */
const SHARPEN_MIPS = 2;
/** How much of the concrete's variation reaches a prop's colour: the walls' mix, PROP_DETAIL of it. */
const PROP_DETAIL = 0.6;
/** Mip levels of the paint the near colour keeps: stains, moss and a panel's own tone, not mortar. */
const MACRO_MIPS = 3;
/** Camera distance in metres where a true-scale swatch starts to take over from the baked paint. */
const SWATCH_START = 2;
/** Camera distance in metres where the swatch has gone and the paint is all there is again. */
const SWATCH_END = 5;
/** Mip bias for a swatch's mean colour: far past its top mip, which is the whole image as one texel. */
const SWATCH_MEAN_BIAS = 16;

export interface ICourtyardTextures {
  readonly asphalt: { readonly map: Texture; readonly normal: Texture; readonly rough: Texture };
  readonly concrete: { readonly map: Texture; readonly normal: Texture; readonly rough: Texture };
}

/** A true-scale tileable crop of the AI paint, and the metres one tile of it covers. */
export interface ICourtyardSwatch {
  readonly map: Texture;
  readonly metresX: number;
  readonly metresY: number;
}

/** One swatch per surface class trompe cut one for; a class it did not write is absent. */
export interface ICourtyardSwatches {
  readonly wall?: ICourtyardSwatch;
  readonly floor?: ICourtyardSwatch;
}

/** Texture paths and the metres one tile covers, for `ctx.assets.texture`. */
export const COURTYARD_TEXTURES = {
  asphalt: {
    tile: 3,
    map: "polyhaven/asphalt_02_diff_2k.jpg",
    normal: "polyhaven/asphalt_02_nor_gl_2k.jpg",
    rough: "polyhaven/asphalt_02_rough_2k.jpg",
  },
  concrete: {
    tile: 3,
    map: "polyhaven/concrete_floor_worn_001_diff_2k.jpg",
    normal: "polyhaven/concrete_floor_worn_001_nor_gl_2k.jpg",
    rough: "polyhaven/concrete_floor_worn_001_rough_2k.jpg",
  },
} as const;

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();

/** Triangle index lists for floor, walls and props. */
function classify(geometry: BufferGeometry): { floor: number[]; walls: number[]; props: number[] } {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const triangles = (index?.count ?? position.count) / 3;
  const vertex = (t: number, k: number): number => index?.getX(t * 3 + k) ?? t * 3 + k;
  // Weld by position so faces that share a corner join one part, even where UV seams split vertices.
  const parent = new Int32Array(position.count).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] ?? i] ?? i;
      i = parent[i] ?? i;
    }
    return i;
  };
  const byKey = new Map<string, number>();
  for (let i = 0; i < position.count; i += 1) {
    const key = `${Math.round(position.getX(i) * 1000)},${Math.round(position.getY(i) * 1000)},${Math.round(position.getZ(i) * 1000)}`;
    const first = byKey.get(key);
    if (first === undefined) byKey.set(key, i);
    else parent[find(i)] = find(first);
  }
  for (let t = 0; t < triangles; t += 1) {
    const r = find(vertex(t, 0));
    parent[find(vertex(t, 1))] = r;
    parent[find(vertex(t, 2))] = r;
  }
  const min = new Map<number, Vector3>();
  const max = new Map<number, Vector3>();
  for (let i = 0; i < position.count; i += 1) {
    const r = find(i);
    _a.fromBufferAttribute(position, i);
    (min.get(r) ?? min.set(r, _a.clone()).get(r))?.min(_a);
    (max.get(r) ?? max.set(r, _a.clone()).get(r))?.max(_a);
  }
  const out = { floor: [] as number[], walls: [] as number[], props: [] as number[] };
  for (let t = 0; t < triangles; t += 1) {
    const r = find(vertex(t, 0));
    const size = (max.get(r) ?? _a).clone().sub(min.get(r) ?? _a);
    if (size.x < PROP_SIZE && size.y < PROP_SIZE && size.z < PROP_SIZE) {
      out.props.push(t);
      continue;
    }
    _a.fromBufferAttribute(position, vertex(t, 0));
    _b.fromBufferAttribute(position, vertex(t, 1));
    _c.fromBufferAttribute(position, vertex(t, 2));
    const up = _b.clone().sub(_a).cross(_c.clone().sub(_a)).normalize().y;
    const height = Math.max(_a.y, _b.y, _c.y);
    (up > 0.7 && height < FLOOR_HEIGHT ? out.floor : out.walls).push(t);
  }
  return out;
}

/** A non-indexed copy of the listed triangles with every attribute the source carries. */
function pick(geometry: BufferGeometry, triangles: readonly number[]): BufferGeometry {
  const source = geometry.index === null ? geometry : geometry.toNonIndexed();
  const picked = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const size = attribute.itemSize;
    const data = new Float32Array(triangles.length * 3 * size);
    for (const [n, t] of triangles.entries())
      for (let k = 0; k < 3; k += 1)
        for (let c = 0; c < size; c += 1)
          data[(n * 3 + k) * size + c] = attribute.getComponent(t * 3 + k, c);
    picked.setAttribute(name, new BufferAttribute(data, size));
  }
  if (!picked.hasAttribute("normal")) picked.computeVertexNormals();
  return picked;
}

const tiled = (texture: Texture, metres: number): Texture => {
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(1 / metres, 1 / metres);
  texture.anisotropy = 8;
  return texture;
};

/** Split the painted courtyard mesh and give each part its material. Returns the three meshes. */
export function courtyardSurfaces(
  painted: Mesh,
  textures: ICourtyardTextures,
  swatches?: ICourtyardSwatches,
  paintedMask?: Texture,
): Mesh[] {
  const parts = classify(painted.geometry);
  const { asphalt, concrete } = textures;
  // The owned engine's TSL has one UV set, which the AI paint uses. The floor is flat, so its
  // detail coordinates are world metres from positionWorld.xz.
  const floor = pick(painted.geometry, parts.floor);
  const walls = pick(painted.geometry, parts.walls);
  const T = COURTYARD_TEXTURES;
  // The scans' sampler state lives on the textures, not the materials: repeating tiles, and enough
  // anisotropy that a wall seen at a grazing angle keeps its grain instead of smearing it along one
  // axis. Set before any part samples them, or the grain is one clamped edge texel and the wall goes
  // soft again.
  for (const scan of [concrete.map, concrete.normal, concrete.rough]) tiled(scan, T.concrete.tile);
  const paint = (painted.material as MeshStandardMaterial).map;
  // PRD-916 BEFORE arm: the gray blockout has no painted map, so it renders as authored.
  if (paint === null) {
    painted.name = "courtyard-walls";
    return [painted];
  }
  const metres = positionWorld.xz.div(T.asphalt.tile);
  const variation = dot(texture(asphalt.map, metres).rgb, vec3(0.2126, 0.7152, 0.0722)).div(
    ASPHALT_MEAN,
  );
  // The walls take the floor's treatment, projected on each face's own plane: a wall facing x runs u
  // along z, one facing z runs u along x, and a horizontal face is a floor. v is height everywhere.
  const up = step(max(abs(normalWorld.x), abs(normalWorld.z)), abs(normalWorld.y));
  const across = step(abs(normalWorld.z), abs(normalWorld.x));
  // The projection in world metres before any tile — u along the wall, v its height, or x and z on
  // an upward face. The swatch divides it by its own metres, so its courses land at painted size.
  const worldU = mix(mix(positionWorld.x, positionWorld.z, across), positionWorld.x, up);
  const worldV = mix(positionWorld.y, positionWorld.z, up);
  const plane = vec2(worldU.div(WALL_TILE), worldV.div(WALL_TILE));
  const paintRgb = texture(paint, uv()).rgb;
  // PRD-916 phase 2o: the paint at macro mip bias is tone alone (stains, moss, a lighter panel), and
  // the swatch keeps its own colour by dividing its mean out and multiplying that tone back in.
  const atlasLow = texture(paint, uv()).bias(float(MACRO_MIPS)).rgb;
  // PRD-916 phases 2s and 2t: the bake's painted-coverage mask, read at the atlas' own uv — 255 where an
  // accepted view painted the texel, 0 where the fill made the colour up. It is its own linear data
  // texture (`courtyard-klein.painted.png`, a quarter of the atlas' side, so one mask texel covers the
  // same surface as a 4x4 atlas block), not the atlas' alpha: the cook keeps the atlas on UASTC only
  // while that alpha is opaque. Phase 2p guessed this from the atlas's local detail, which is noisy: a
  // painted slab in shadow read as flat fill and came back a patchy mix of swatch and atlas. A level
  // with no mask bakes 1, which is "a view painted all of it": no fill to cover.
  //
  // v is inverted for the mask alone: the atlas comes out of the GLB, and glTF images are not flipped
  // on upload (v 0 is the image's first row), while an asset texture is flipped on load (v 0 is its
  // last row) so an ordinary JPEG reads upright. Both files store the atlas' row order, so the mask is
  // sampled the right way up only with 1 - v.
  const maskUV = vec2(uv().x, uv().y.oneMinus());
  const paintedTexel = paintedMask === undefined ? float(1) : texture(paintedMask, maskUV).r;
  const swatchNear = smoothstep(
    SWATCH_START,
    SWATCH_END,
    distance(positionWorld, cameraPosition),
  ).oneMinus();
  // The paint's macro tone, taken from the atlas' colour at every texel: the atlas is opaque RGB, filled
  // texels included, so a fill has a tone to give again (phase 2s could not, because a canvas had
  // premultiplied its colour into black).
  const tone = atlasLow;
  /** A swatch at true scale, times the paint's macro tone: the near colour of its own class. */
  const swatchTone = (swatch: ICourtyardSwatch) => {
    const swatchUV = vec2(worldU.div(swatch.metresX), worldV.div(swatch.metresY));
    // The engine's TSL takes a texture and its uv and nothing else, so the swatch's mean colour is
    // the same sample biased past its top mip: a 1024 swatch is one texel from level 10 up, and no
    // wall is magnified enough to pull this back below it.
    const mean = texture(swatch.map, swatchUV).bias(float(SWATCH_MEAN_BIAS)).rgb;
    return texture(swatch.map, swatchUV).rgb.div(mean).mul(tone);
  };
  // A class with no swatch borrows the other class's texture rather than losing the term: a step
  // tread paved in the wall's stone reads as stone, where the cook's plain fill reads as nothing.
  const wallSwatch = swatches?.wall ?? swatches?.floor;
  const groundSwatch = swatches?.floor ?? swatches?.wall;
  const wallTone = wallSwatch === undefined ? undefined : swatchTone(wallSwatch);
  const groundTone = groundSwatch === undefined ? undefined : swatchTone(groundSwatch);
  const swatch =
    wallTone === undefined || groundTone === undefined
      ? undefined
      : {
          wall: wallTone,
          ground: groundTone,
          // Up close the atlas is magnified and the swatch is what it was a blur of; where the bake
          // painted nothing it stands in for the atlas at every range, and its own colour carries there
          // because `tone` is the fill's real colour again. Painted brick keeps today's far look: the
          // bake's own mask says a view painted it.
          weight: max(swatchNear, paintedTexel.oneMinus()),
        };
  const floorPaint = paintRgb.mul(mix(1, variation, FLOOR_DETAIL));
  const floorMaterial = new MeshStandardNodeMaterial();
  floorMaterial.colorNode =
    swatch === undefined ? floorPaint : mix(floorPaint, swatch.ground, swatch.weight);
  floorMaterial.roughnessNode = texture(asphalt.rough, metres).r;
  const grain = dot(texture(concrete.map, plane).rgb, vec3(0.2126, 0.7152, 0.0722)).div(
    CONCRETE_MEAN,
  );
  // The relief's tangent frame is the projection's own: along u, and that crossed with the face
  // normal. The paint's atlas UVs are not the detail's, so a tangent frame from them would tilt it.
  const along = mix(vec3(1, 0, 0), vec3(0, 0, 1), across);
  const relief = texture(concrete.normal, plane).xyz.mul(2).sub(1);
  /** A scan relief of the given strength as a normalNode wants it: a normalNode speaks view space. */
  const reliefNormal = (strength: typeof relief) =>
    normalWorld
      .add(along.mul(strength.x))
      .add(cross(normalWorld, along).mul(strength.y))
      .normalize()
      .transformNormalByViewMatrix(cameraViewMatrix);
  // 1 at arm's length and 0 by NEAR_END metres: the paint is only magnified where the player stands
  // close to a wall, so what magnification smears is only restored there.
  const near = smoothstep(NEAR_START, NEAR_END, distance(positionWorld, cameraPosition)).oneMinus();
  // Unsharp mask: the paint minus the same paint two mips up, added back. Magnification makes the
  // mortar joints a mip-0 blur no filter can undo, but the contrast across them is what reads as
  // stone blocks, and it is exactly what subtracting the blurred copy restores. Clamped, so the
  // overshoot cannot leave the paint's range and darken a bright joint or clip a dark one.
  const sharpened = clamp(
    paintRgb.add(
      paintRgb
        .sub(texture(paint, uv()).bias(float(SHARPEN_MIPS)).rgb)
        .mul(near.mul(float(SHARPEN))),
    ),
  );
  const wallMaterial = new MeshStandardNodeMaterial();
  // The swatch replaces the magnified paint up close, and the grain and relief stay on top of it at
  // every range: the swatch is what the paint was a blur of, not a different surface.
  const wallRgb =
    swatch === undefined
      ? sharpened
      : mix(sharpened, mix(swatch.wall, swatch.ground, up), swatch.weight);
  wallMaterial.colorNode = wallRgb.mul(mix(1, grain, mix(WALL_DETAIL, WALL_DETAIL_NEAR, near)));
  wallMaterial.roughnessNode = texture(concrete.rough, plane).r;
  wallMaterial.normalNode = reliefNormal(relief.mul(mix(WALL_RELIEF, WALL_RELIEF_NEAR, near)));
  // A prop is painted like the wall it stands against: the paint's colour times the scan's grain,
  // with the scan's own normal at full strength and its roughness — its atlas UVs still sample the
  // paint, and the detail is projected from positionWorld because the one UV set is the paint's.
  const propsMaterial = new MeshStandardNodeMaterial();
  // A node material paints from colorNode, but the game's playtest counts `map` to prove the painted
  // atlas is bound before the first frame (Play.ts); both point at that same texture.
  propsMaterial.map = paint;
  propsMaterial.colorNode = texture(paint, uv()).rgb.mul(mix(1, grain, PROP_DETAIL));
  propsMaterial.roughnessNode = texture(concrete.rough, plane).r;
  propsMaterial.normalNode = reliefNormal(relief);
  return [
    new Mesh(floor, floorMaterial),
    new Mesh(pick(painted.geometry, parts.props), propsMaterial),
    new Mesh(walls, wallMaterial),
  ].map((mesh, i) => {
    mesh.name = ["courtyard-floor", "courtyard-props", "courtyard-walls"][i] ?? "courtyard";
    return mesh;
  });
}
