// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The hybrid look: Poly Haven CC0 scans where a tiling material reads best, the AI paint where the
// level needs unique detail. trompe exports the courtyard as one mesh, so it is split here:
//   floor — upward faces at ground height: the AI paint's colour (so it matches the scene) times
//           the fine variation of Poly Haven "Asphalt 02", plus its normal and roughness: sharp at
//           the player's feet without a generic scan's colour
//   props — connected parts under PROP_SIZE (boxes, bollards, the round base): "Concrete Floor Worn 001"
//   walls — everything else: the AI paint's colour times the fine variation of "Concrete Floor Worn
//           001", plus its normal and roughness, so a wall at first-person distance is grain and not
//           a magnified blur. The paint keeps the colour and the brick layout; the scan only adds.
// The owned engine's TSL has one UV set, which the paint uses, so the details project world metres
// from positionWorld instead: along xz for the floor, along each face's own plane for the walls.
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
  cameraViewMatrix,
  cross,
  dot,
  max,
  mix,
  normalWorld,
  positionWorld,
  step,
  texture,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { worldGridUVs } from "./materials.js";

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

export interface ICourtyardTextures {
  readonly asphalt: { readonly map: Texture; readonly normal: Texture; readonly rough: Texture };
  readonly concrete: { readonly map: Texture; readonly normal: Texture; readonly rough: Texture };
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
export function courtyardSurfaces(painted: Mesh, textures: ICourtyardTextures): Mesh[] {
  const parts = classify(painted.geometry);
  const { asphalt, concrete } = textures;
  const props = worldGridUVs(pick(painted.geometry, parts.props));
  // The owned engine's TSL has one UV set, which the AI paint uses. The floor is flat, so its
  // detail coordinates are world metres from positionWorld.xz.
  const floor = pick(painted.geometry, parts.floor);
  const walls = pick(painted.geometry, parts.walls);
  const T = COURTYARD_TEXTURES;
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
  const floorMaterial = new MeshStandardNodeMaterial();
  floorMaterial.colorNode = texture(paint, uv()).rgb.mul(mix(1, variation, FLOOR_DETAIL));
  floorMaterial.roughnessNode = texture(asphalt.rough, metres).r;
  // The walls take the floor's treatment, projected on each face's own plane: a wall facing x runs u
  // along z, one facing z runs u along x, and a horizontal face is a floor. v is height everywhere.
  const up = step(max(abs(normalWorld.x), abs(normalWorld.z)), abs(normalWorld.y));
  const across = step(abs(normalWorld.z), abs(normalWorld.x));
  const plane = mix(
    vec2(mix(positionWorld.x, positionWorld.z, across), positionWorld.y),
    vec2(positionWorld.x, positionWorld.z),
    up,
  ).div(WALL_TILE);
  const grain = dot(texture(concrete.map, plane).rgb, vec3(0.2126, 0.7152, 0.0722)).div(
    CONCRETE_MEAN,
  );
  // The relief's tangent frame is the projection's own: along u, and that crossed with the face
  // normal. The paint's atlas UVs are not the detail's, so a tangent frame from them would tilt it.
  const along = mix(vec3(1, 0, 0), vec3(0, 0, 1), across);
  const relief = texture(concrete.normal, plane).xyz.mul(2).sub(1).mul(WALL_RELIEF);
  const wallMaterial = new MeshStandardNodeMaterial();
  wallMaterial.colorNode = texture(paint, uv()).rgb.mul(mix(1, grain, WALL_DETAIL));
  wallMaterial.roughnessNode = texture(concrete.rough, plane).r;
  wallMaterial.normalNode = normalWorld
    .add(along.mul(relief.x))
    .add(cross(normalWorld, along).mul(relief.y))
    .normalize()
    // A normalNode speaks view space; the mesh's world-baked geometry is no part of the maths here.
    .transformNormalByViewMatrix(cameraViewMatrix);
  return [
    new Mesh(floor, floorMaterial),
    new Mesh(
      props,
      new MeshStandardMaterial({
        map: tiled(concrete.map, T.concrete.tile),
        normalMap: tiled(concrete.normal, T.concrete.tile),
        roughnessMap: tiled(concrete.rough, T.concrete.tile),
      }),
    ),
    new Mesh(walls, wallMaterial),
  ].map((mesh, i) => {
    mesh.name = ["courtyard-floor", "courtyard-props", "courtyard-walls"][i] ?? "courtyard";
    return mesh;
  });
}
