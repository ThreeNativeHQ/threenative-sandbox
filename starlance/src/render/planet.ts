// A gas giant and a small moon hanging in the sky: unlit banded spheres lit by the sun's direction,
// pinned to the camera (they never parallax) and drawn behind everything the camera sees nearer.
import { type Camera, Group, Mesh, SphereGeometry, Vector3 } from "three";
import { dot, float, mix, normalWorld, positionLocal, sin, smoothstep, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";

/** Every control says which way to move it. */
export const PLANET = {
  /** Distance from the camera (m); the size follows from the angular radius. Keep inside the far plane. */
  distance: 4500,
  /** Planet: direction (right of the heading, above the horizon), angular radius in degrees. */
  giant: { dir: [0.42, 0.3, -0.86] as const, radius: 5.5 },
  /** Moon: direction, angular radius in degrees. */
  moon: { dir: [-0.05, 0.4, -0.92] as const, radius: 1.1 },
  /** Band colours, pale to dark (linear-ish, kept dim: the sky's own exposure lifts them). */
  bands: [0xe0a070, 0x9a5238, 0xd9b890, 0x6a3a30] as const,
};

const hex = (n: number) => vec3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);

function body(radiusDeg: number, bands: boolean, sun: Vector3, tint: number): Mesh {
  const r = PLANET.distance * Math.tan((radiusDeg * Math.PI) / 180);
  const material = new MeshBasicNodeMaterial();
  material.fog = false;
  const y = positionLocal.y.div(r);
  const stripe = sin(y.mul(11).add(sin(y.mul(41)).mul(0.35)))
    .mul(0.5)
    .add(0.5);
  const base = bands
    ? mix(
        mix(hex(PLANET.bands[0]), hex(PLANET.bands[1]), smoothstep(0.2, 0.8, stripe)),
        mix(
          hex(PLANET.bands[2]),
          hex(PLANET.bands[3]),
          smoothstep(0.35, 0.95, sin(y.mul(7.3)).mul(0.5).add(0.5)),
        ),
        0.45,
      )
    : hex(tint);
  const lit = dot(normalWorld, vec3(sun.x, sun.y, sun.z))
    .mul(0.5)
    .add(0.5);
  material.colorNode = base.mul(float(0.12).add(smoothstep(0.25, 0.85, lit).mul(0.7)));
  const mesh = new Mesh(new SphereGeometry(r, 48, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

export interface ISkyBodies {
  readonly group: Group;
  /** Call once per frame: keeps the bodies at a fixed bearing from the camera. */
  update(camera: Camera): void;
}

export function createSkyBodies(sunDirection: Vector3): ISkyBodies {
  const group = new Group();
  const placed: [Mesh, Vector3][] = [
    [
      body(PLANET.giant.radius, true, sunDirection, 0),
      new Vector3(...PLANET.giant.dir).normalize(),
    ],
    [
      body(PLANET.moon.radius, false, sunDirection, 0xb9a99a),
      new Vector3(...PLANET.moon.dir).normalize(),
    ],
  ];
  for (const [mesh] of placed) group.add(mesh);
  return {
    group,
    update(camera) {
      for (const [mesh, dir] of placed)
        mesh.position.copy(camera.position).addScaledVector(dir, PLANET.distance);
    },
  };
}
