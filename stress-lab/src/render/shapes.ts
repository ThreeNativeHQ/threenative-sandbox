// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Rounded, cached primitives — the single highest-leverage thing in this
// folder. A sharp BoxGeometry reads as Minecraft; the same box with a 0.14
// corner radius reads as a toy, and that soft corner-wrap is most of what
// separates a stack of boxes from something that looks designed.
//
// Nothing here is textured, on purpose. Surface variety comes from alternating
// palette entries across a run of meshes, never from a bitmap: `CanvasTexture`
// samples BLACK under `WebGPURenderer`, which is a trap worth knowing about
// before you spend an afternoon painting one.
import {
  BoxGeometry,
  type BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  type Material,
  MathUtils,
  Mesh,
  SphereGeometry,
  Vector3,
} from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

const roundedCache = new Map<string, BufferGeometry>();

/**
 * A box with rounded edges: every vertex of a segmented box pushed outward
 * from the clamped "inner" box by `radius`, then welded so normals interpolate
 * smoothly across the seams instead of faceting at them.
 */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius = 0.14,
  segments = 3,
): BufferGeometry {
  const key = `${width},${height},${depth},${radius},${segments}`;
  const cached = roundedCache.get(key);
  if (cached !== undefined) return cached;

  const limit = Math.min(radius, width / 2 - 1e-3, height / 2 - 1e-3, depth / 2 - 1e-3);
  const geometry = new BoxGeometry(width, height, depth, segments, segments, segments);
  // No UVs and no normals: both are rebuilt after welding, and a geometry with
  // stale UVs is a geometry someone will eventually try to texture.
  geometry.deleteAttribute("uv");
  geometry.deleteAttribute("normal");

  const position = geometry.attributes.position;
  if (position === undefined) throw new Error("Rounded box lost its position attribute.");
  const inner = new Vector3(width / 2 - limit, height / 2 - limit, depth / 2 - limit);
  const vertex = new Vector3();
  const clamped = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index);
    clamped.set(
      MathUtils.clamp(vertex.x, -inner.x, inner.x),
      MathUtils.clamp(vertex.y, -inner.y, inner.y),
      MathUtils.clamp(vertex.z, -inner.z, inner.z),
    );
    vertex.sub(clamped);
    const length = vertex.length();
    if (length > 1e-6) vertex.multiplyScalar(limit / length);
    position.setXYZ(index, vertex.x + clamped.x, vertex.y + clamped.y, vertex.z + clamped.z);
  }

  const welded = mergeVertices(geometry, 1e-4);
  welded.computeVertexNormals();
  roundedCache.set(key, welded);
  return welded;
}

export interface IShapeOptions {
  readonly castShadow?: boolean;
  readonly radius?: number;
  readonly receiveShadow?: boolean;
  readonly segments?: number;
}

function shadowed(mesh: Mesh, options: IShapeOptions): Mesh {
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
}

/** The workhorse: a rounded box that casts and receives shadows. */
export function block(
  width: number,
  height: number,
  depth: number,
  material: Material,
  options: IShapeOptions = {},
): Mesh {
  const geometry = roundedBox(width, height, depth, options.radius ?? 0.14, options.segments ?? 3);
  return shadowed(new Mesh(geometry, material), options);
}

export function ball(radius: number, material: Material, options: IShapeOptions = {}): Mesh {
  const segments = options.segments ?? 16;
  const geometry = new SphereGeometry(radius, segments, Math.max(6, Math.round(segments / 2)));
  return shadowed(new Mesh(geometry, material), options);
}

export function tube(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  material: Material,
  options: IShapeOptions = {},
): Mesh {
  const geometry = new CylinderGeometry(radiusTop, radiusBottom, height, options.segments ?? 16);
  return shadowed(new Mesh(geometry, material), options);
}

export function spike(
  radius: number,
  height: number,
  material: Material,
  options: IShapeOptions = {},
): Mesh {
  const geometry = new ConeGeometry(radius, height, options.segments ?? 14);
  return shadowed(new Mesh(geometry, material), options);
}

// A hand-rolled seeded PRNG used to live here, and it was a line-for-line copy of the
// `createRandom` the framework already exports — same multiplier, same increment, same
// sequence. It is gone. Nothing in this folder may import a framework package (that is what
// keeps `src/render/` portable Three.js), so a scene builds the seeded source and hands it
// down: see `createRandom` in `src/scenes/Play.ts`.
//
// Never `Math.random` for anything the world is built from. The world has to be byte-identical
// on every reload or a screenshot diff cannot tell a bug from a reroll, and `ctx.random` is
// what a playtest reads to prove the level was seeded at all.
