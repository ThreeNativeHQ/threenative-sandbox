// Dev-only rock lab: renders rock forms on a sand plane under a low sun, for `tools/rock-shot.mjs`.
// `?view=towers|boulders|mesas|close` picks the layout; nothing here ships.
import {
  AmbientLight,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  TextureLoader,
  Vector3,
} from "three";
import { MeshStandardNodeMaterial, WebGPURenderer } from "three/webgpu";
import { boulderGeometry, hoodooKit, mesaGeometry } from "../src/render/rockForms";
import { canyonWallChunks, rockMaterial, type IWallStation } from "../src/render/rocks";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "towers";
const W = 1280;
const H = 720;
const renderer = new WebGPURenderer({ antialias: true });
renderer.setSize(W, H);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new Scene();
scene.background = new Color(0x8fb4e8);
scene.fog = new FogExp2(0xe8c9a8, 0.0016);
const sun = new DirectionalLight(0xffd2a0, 3.2);
sun.position.set(-70, 38, 45);
scene.add(sun, new HemisphereLight(0x9cc0ff, 0x8a4a30, 0.9), new AmbientLight(0x442a20, 0.3));
const ground = new Mesh(
  new PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
  new MeshStandardNodeMaterial({ color: 0xb4592f, roughness: 1 }),
);
scene.add(ground);
const rockDiff = await new TextureLoader().loadAsync("/assets/textures/cliff_diff_2k.jpg");
const rockNormal = await new TextureLoader().loadAsync("/assets/textures/cliff_nor_gl_2k.jpg");
const cliffRough = await new TextureLoader().loadAsync("/assets/textures/cliff_rough_2k.jpg");
const cliffDiff = rockDiff;
const cliffNormal = rockNormal;
const mat = rockMaterial({ cliffDiff, cliffNormal, cliffRough }, true);
const flat = rockMaterial({ cliffDiff, cliffRough });
const kit = hoodooKit();
console.log("tris", JSON.stringify(kit.map((k) => (k.geo.getIndex()?.count ?? 0) / 3)));
const put = (g: Mesh["geometry"], x: number, z: number, s = 1, yaw = 0, sy = s, material = mat) => {
  const m = new Mesh(g, material);
  m.position.set(x, 0, z);
  m.scale.set(s, sy, s);
  m.rotation.y = yaw;
  scene.add(m);
};
const cam = new PerspectiveCamera(60, W / H, 0.5, 6000);
const look = new Vector3();
if (view === "towers") {
  const rows: [number, number, number, number][] = [
    [0, -40, 0, 1.15], [1, 18, -55, 1], [2, -22, -85, 1.1], [3, 40, -75, 1], [4, 8, -30, 1],
    [5, -12, -20, 1.1], [0, 60, -150, 1], [1, -75, -120, 1.1], [2, 90, -110, 0.9], [3, 25, -200, 1.1],
    [5, -50, -60, 1], [4, 55, -35, 1.2], [1, -110, -190, 1.1], [0, 120, -240, 1],
  ];
  rows.forEach(([i, x, z, s], n) => put((kit[i] as (typeof kit)[0]).geo, x, z, s, n * 1.7));
  for (let i = 0; i < 24; i += 1) {
    const a = i * 2.4;
    put(boulderGeometry(1.2 + (i % 4) * 0.5, 30 + i), Math.sin(a) * (20 + i * 6), -10 - ((i * 37) % 160), 1, a);
  }
  cam.position.set(0, 3, 16);
  look.set(0, 14, -60);
} else if (view === "close") {
  const i = Number(q.get("i") ?? 0);
  put((kit[i] as (typeof kit)[0]).geo, 0, 0, 1);
  const k = kit[i] as (typeof kit)[0];
  cam.position.set(-k.height * 0.35, k.height * 0.22, k.height * 0.85);
  look.set(0, k.height * 0.45, 0);
} else if (view === "canyon") {
  const st: IWallStation[] = [];
  for (let i = 0; i < 150; i += 1) {
    const env = Math.min(1, Math.max(0, (i - 10) / 30)) * Math.min(1, Math.max(0, (140 - i) / 20));
    st.push({ x: 8 * Math.sin(i * 0.05), z: -i * 4, rx: 1, rz: 0, width: [24, 26], env });
  }
  const chunks = canyonWallChunks(st, 77);
  console.log("wall tris", chunks.reduce((n, g) => n + (g.getIndex()?.count ?? 0) / 3, 0), "chunks", chunks.length);
  for (const g of chunks) scene.add(new Mesh(g, mat));
  cam.position.set(Number(q.get("cx") ?? 0), Number(q.get("cy") ?? 6), Number(q.get("cz") ?? -150));
  look.set(Number(q.get("lx") ?? 0), Number(q.get("ly") ?? 18), Number(q.get("lz") ?? -260));
} else if (view === "boulders") {
  for (let i = 0; i < 40; i += 1) put(boulderGeometry(0.8 + (i % 5) * 0.7, 20 + i), ((i % 8) - 3.5) * 9, -((i / 8) | 0) * 10 - 20, 1, i);
  cam.position.set(0, 4, 10);
  look.set(0, 1, -40);
} else {
  const specs = [[14, 4, 16], [12, 3, 17], [16, 5, 18], [10, 3, 19]];
  specs.forEach(([sides, layers, seed], n) => {
    const g = mesaGeometry({ radius: 1, height: 1, sides: sides + 30, rows: 28, layers: layers as number, seed: seed as number });
    put(g, -130 + n * 95, -150 - n * 30, 42 + n * 6, n, 34 + n * 9, flat);
  });
  cam.position.set(0, 6, 20);
  look.set(0, 20, -150);
}
cam.lookAt(look);
let frames = 0;
const tick = (): void => {
  renderer.render(scene, cam);
  frames += 1;
  if (frames === 30) {
    (window as unknown as { __stats: unknown }).__stats = {
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
    };
    (window as unknown as { __ready: boolean }).__ready = true;
  }
  requestAnimationFrame(tick);
};
tick();
