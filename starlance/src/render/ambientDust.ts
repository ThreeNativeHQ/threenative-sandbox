// Ambient sand: a few hundred motes blown across the camera in a wrapped box, so speed reads on an
// empty plain and the air has depth. One InstancedMesh; each frame the CPU wraps every mote into
// the box around the camera, turns it to face the lens and shrinks it near the box edge and the
// lens so nothing pops. Plain Three.js: no positionNode (the owned renderer does not draw one).
import {
  type Camera,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { attribute, float, length, smoothstep, uv, vec3, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial } from "three/webgpu";

/** Every control says which way to move it. */
export const DUST = {
  /** Motes in the box. Up: denser air. */
  count: 420,
  /** Box size in metres (x, y, z) around the camera. */
  box: [70, 26, 140] as const,
  /** Wind in m/s; the sand streams along it. */
  wind: [-9, 0.4, 3] as const,
  /** Mote width in metres, and how many times longer it is than wide. */
  size: [0.08, 0.22] as const,
  streak: 5,
  /** Peak opacity. Up: more visible grit. */
  alpha: 0.6,
  /** Sun-lit dust colour (linear; auto exposure lifts it about 3x, so keep it dark). */
  colour: [0.34, 0.24, 0.14] as const,
};

export interface IAmbientDust {
  update(camera: Camera, dt: number): void;
  dispose(): void;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Deterministic 0..1 per (index, salt), so a mote keeps its identity. */
const unit = (i: number, salt: number): number => {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

export function createAmbientDust(add: <T extends InstancedMesh>(mesh: T) => T): IAmbientDust {
  const material = new MeshBasicNodeMaterial({
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  const soft = float(1).sub(smoothstep(0, 0.5, length(uv().sub(0.5))));
  material.colorNode = vec4(vec3(...DUST.colour), soft.mul(DUST.alpha));
  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), material, DUST.count);
  mesh.frustumCulled = false;
  const base = Array.from({ length: DUST.count }, (_, i) => [
    unit(i, 1),
    unit(i, 2),
    unit(i, 3),
    DUST.size[0] + unit(i, 4) * (DUST.size[1] - DUST.size[0]),
  ]);
  const [bx, by, bz] = DUST.box;
  const rel = new Vector3();
  const scale = new Vector3();
  const matrix = new Matrix4();
  const facing = new Quaternion();
  let clock = 0;
  add(mesh);
  return {
    update(camera, dt) {
      clock += dt;
      camera.getWorldQuaternion(facing);
      for (let i = 0; i < DUST.count; i += 1) {
        const [u, v, w, size] = base[i] as number[];
        const wrap = (t: number): number => t - Math.floor(t);
        // A fixed fraction of the box, slid along the wind and the camera, wrapped back in.
        rel.set(
          (wrap(u! - (camera.position.x + DUST.wind[0] * clock) / bx) - 0.5) * bx,
          (wrap(v! - (camera.position.y + DUST.wind[1] * clock) / by) - 0.5) * by,
          (wrap(w! - (camera.position.z + DUST.wind[2] * clock) / bz) - 0.5) * bz,
        );
        const d = rel.length();
        const fade = smooth(3, 10, d) * (1 - smooth(40, 70, d));
        scale.set(size! * DUST.streak * fade, size! * fade, 1);
        matrix.compose(rel.add(camera.position), facing, scale);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

// ---- ground dust -------------------------------------------------------------------------------

/** Every control says which way to move it. */
export const GROUND_DUST = {
  /** Pool size shared by the plumes and the wind sheet. */
  pool: 900,
  /** Plume puffs per second at full strength, over both wingtips together. */
  plumeRate: 0,
  /** Altitude over the ground (m) where the plume is full and where it stops. */
  plumeAltitude: [6, 30] as const,
  /** Wingtip spacing of the two plumes (m). */
  wingSpan: 1.9,
  /** Wind sheet puffs per second (low drifting dust). */
  windRate: 0,
  /** Dust devils: how many, how tall (m) and the spacing of their anchors along the course (m). */
  devils: 2,
  devilHeight: 46,
  devilSpacing: 900,
  /** Dust colour (linear, kept dark: auto exposure lifts it about 3x). */
  colour: [0.5, 0.29, 0.14] as const,
};

const DEBUG = false;

export interface IGroundDust {
  /** Call once per frame with the ship position, the camera and the frame time. */
  update(ship: Vector3, camera: Camera, dt: number): void;
  dispose(): void;
}

export function createGroundDust(
  add: <T extends InstancedMesh>(mesh: T) => T,
  groundHeight: (x: number, z: number) => number,
): IGroundDust {
  const G = GROUND_DUST;
  const devilPuffs = 26;
  const count = G.pool + G.devils * devilPuffs;
  const geometry = new PlaneGeometry(1, 1);
  const alpha = new InstancedBufferAttribute(new Float32Array(count), 1);
  geometry.setAttribute("aAlpha", alpha);
  const material = new MeshBasicNodeMaterial({
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  const soft = float(1).sub(smoothstep(0, 0.5, length(uv().sub(0.5))));
  material.colorNode = vec4(vec3(...G.colour), soft.mul(attribute("aAlpha", "float")));
  const mesh = new InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  add(mesh);

  // Pool of puffs: position, velocity, age, life, start/end size, peak alpha.
  const px = new Float32Array(G.pool);
  const py = new Float32Array(G.pool);
  const pz = new Float32Array(G.pool);
  const vx = new Float32Array(G.pool);
  const vy = new Float32Array(G.pool);
  const vz = new Float32Array(G.pool);
  const age = new Float32Array(G.pool).fill(1e9);
  const life = new Float32Array(G.pool).fill(1);
  const s0 = new Float32Array(G.pool);
  const s1 = new Float32Array(G.pool);
  const a0 = new Float32Array(G.pool);
  let head = 0;
  let owed = 0;
  let windOwed = 0;
  let clock = 0;
  const last = new Vector3();
  const heading = new Vector3(0, 0, -1);
  let primed = false;
  const facing = new Quaternion();
  const matrix = new Matrix4();
  const place = new Vector3();
  const scale = new Vector3();
  const rand = (a: number, b: number): number => a + (b - a) * Math.random();

  const spawn = (
    x: number,
    y: number,
    z: number,
    ux: number,
    uy: number,
    uz: number,
    l: number,
    a: number,
    from: number,
    to: number,
  ): void => {
    const i = head;
    head = (head + 1) % G.pool;
    px[i] = x;
    py[i] = y;
    pz[i] = z;
    vx[i] = ux;
    vy[i] = uy;
    vz[i] = uz;
    age[i] = 0;
    life[i] = l;
    a0[i] = a;
    s0[i] = from;
    s1[i] = to;
  };

  return {
    update(ship, camera, dt) {
      clock += dt;
      const step = Math.max(dt, 1e-3);
      if (!primed) {
        last.copy(ship);
        primed = true;
      }
      const dx = ship.x - last.x;
      const dz = ship.z - last.z;
      const speed = Math.hypot(dx, dz) / step;
      if (speed > 1) heading.set(dx / (speed * step), 0, dz / (speed * step));
      last.copy(ship);

      // Plumes: two puffs streams kicked up under the wingtips, strong when low and fast.
      const gy = groundHeight(ship.x, ship.z);
      const alt = ship.y - gy;
      const low = 1 - smooth(G.plumeAltitude[0], G.plumeAltitude[1], alt);
      const strength = low * Math.min(1, speed / 25);
      if (DEBUG && Math.floor(clock) !== Math.floor(clock - dt))
        console.warn(
          `TN_DUSTDBG live=${Array.from(age).filter((a) => a < 1).length} ship=${ship.x.toFixed(0)},${ship.y.toFixed(1)},${ship.z.toFixed(0)} cam=${camera.position.x.toFixed(0)},${camera.position.y.toFixed(1)},${camera.position.z.toFixed(0)} head=${heading.x.toFixed(2)},${heading.z.toFixed(2)} alt=${alt.toFixed(1)} speed=${speed.toFixed(1)} strength=${strength.toFixed(2)} dt=${dt.toFixed(3)}`,
        );
      owed += G.plumeRate * strength * dt;
      while (owed >= 1) {
        owed -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const x = ship.x - heading.z * side * G.wingSpan + rand(-0.8, 0.8);
        const z = ship.z + heading.x * side * G.wingSpan + rand(-0.8, 0.8);
        spawn(
          x,
          groundHeight(x, z) + rand(0.8, 1.8),
          z,
          -heading.z * side * rand(0.2, 0.7) + heading.x * speed * rand(0.1, 0.45),
          rand(2, 5),
          heading.x * side * rand(0.2, 0.7) + heading.z * speed * rand(0.1, 0.45),
          rand(2.2, 3.2),
          rand(0.3, 0.5) * (0.4 + 0.6 * strength),
          rand(0.8, 1.4),
          rand(2.6, 4.5),
        );
      }
      // Wind sheet: low drifting dust ahead of and around the camera.
      windOwed += G.windRate * dt;
      while (windOwed >= 1) {
        windOwed -= 1;
        const x = camera.position.x + rand(-90, 90);
        const z = camera.position.z - rand(-20, 170);
        spawn(
          x,
          groundHeight(x, z) + rand(0.3, 2.5),
          z,
          rand(-7, -4),
          rand(0, 0.5),
          rand(1, 3),
          rand(4, 7),
          rand(0.07, 0.15),
          rand(3, 5),
          rand(8, 14),
        );
      }

      camera.getWorldQuaternion(facing);
      for (let i = 0; i < G.pool; i += 1) {
        age[i] = (age[i] as number) + dt;
        const t = (age[i] as number) / (life[i] as number);
        if (t >= 1) {
          scale.set(0, 0, 0);
          alpha.setX(i, 0);
        } else {
          const drag = Math.exp(-1.4 * dt);
          vx[i] = (vx[i] as number) * drag;
          vz[i] = (vz[i] as number) * drag;
          vy[i] = (vy[i] as number) * drag - 0.4 * dt;
          px[i] = (px[i] as number) + (vx[i] as number) * dt;
          py[i] = (py[i] as number) + (vy[i] as number) * dt;
          pz[i] = (pz[i] as number) + (vz[i] as number) * dt;
          const size = (s0[i] as number) + ((s1[i] as number) - (s0[i] as number)) * Math.sqrt(t);
          scale.set(size, size, 1);
          // Fade in over the first tenth, out over the rest.
          place.set(px[i] as number, py[i] as number, pz[i] as number);
          // Puffs near the lens fade out so none ever fills the frame.
          const near = smooth(3, 11, place.distanceTo(camera.position));
          alpha.setX(i, (a0[i] as number) * near * Math.min(1, t * 10) * (1 - t) ** 1.5);
        }
        matrix.compose(place, facing, scale);
        mesh.setMatrixAt(i, matrix);
      }

      // Dust devils: a few fixed in the world, one anchor per `devilSpacing` along the course.
      for (let d = 0; d < G.devils; d += 1) {
        const n = Math.floor((-ship.z + 250 + (d * G.devilSpacing) / G.devils) / G.devilSpacing);
        const hash = Math.sin(n * 12.9898 + d * 78.233) * 43758.5453;
        const jitter = hash - Math.floor(hash);
        const cx = (jitter - 0.5) * 520 + (d === 0 ? -90 : 90);
        const cz = -(n * G.devilSpacing - (d * G.devilSpacing) / G.devils) - 0;
        const cy = groundHeight(cx, cz);
        for (let j = 0; j < devilPuffs; j += 1) {
          const k = G.pool + d * devilPuffs + j;
          const u = j / (devilPuffs - 1);
          const h = u * G.devilHeight;
          const r = 2 + h * 0.3;
          const a = u * 9 + clock * 2.4 + jitter * 6;
          place.set(cx + Math.cos(a) * r + h * 0.35, cy + h, cz + Math.sin(a) * r);
          const size = 3.5 + h * 0.2;
          scale.set(size, size, 1);
          alpha.setX(
            k,
            0.22 * (1 - 0.65 * u) * smooth(5, 40, Math.hypot(cx - ship.x, cz - ship.z)),
          );
          matrix.compose(place, facing, scale);
          mesh.setMatrixAt(k, matrix);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      alpha.needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
