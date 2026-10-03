/**
 * The game's imported airframes, chosen by an explicit airframe id.
 *
 * The Douglas SBD-3 (battle-of-pacific/assets/generated) keeps its textures and 12 clips and its
 * own clip-driven animator. The TBD-1 and B5N2 come through tools/import-aircraft.sh already at
 * real size, so nothing here scales a model.
 */
import { AnimationPlayer, type ICtx, softCircleDataTexture } from "@threenative/core";
import * as T from "three";
import type { WebGPURenderer } from "three/webgpu";
import { mat, rod } from "./assets.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import {
  AIRCREW_GUN_URL,
  AIRCREW_PILOT_URL,
  configureAircrewGun,
  configureAircrewPilot,
  createSeatedStation,
  type ISeatedStation,
} from "./aircrew.js";
import {
  createCockpitInterior,
  ensureCockpitMaterials,
  getCockpitMaterials,
  type CockpitInterior,
} from "./cockpit-detail.js";
import { createDauntlessGear } from "./dauntless.js";
import { createZero } from "./imported-fleet.js";
import { disposeDevastator, makeDevastator } from "./devastator.js";
export { animateDevastator, disposeDevastator, makeDevastator } from "./devastator.js";

/** The detailed interior is a real-metre cockpit, scaled into the Douglas canopy opening. */
const COCKPIT_SCALE = 0.52;
const COCKPIT_POSITION: [number, number, number] = [0, 0.342, -2.482];

/**
 * The same real-metre interior, fitted inside the imported TBD's own greenhouse. `COCKPIT_POSITION`
 * is the panel origin; the shared `EYE` sits 1.42 x 0.52 m above and 1.6 x 0.52 m behind it.
 *
 * The first fit used the measured pilot eye (0, 3.45, -2.35), but a live raycast from the game
 * camera (tools/capture-player-aircraft.mjs pattern) found that eye 0.20–0.30 m ABOVE the closed
 * canopy roof, so the forward-down sightline met the opaque `airframebody` at 0.955 m instead of the
 * panel. Lowering the eye to (0, 2.95, -2.35) seats it under the roof: the down-forward ray now
 * reaches the instrument panel, and the forward view passes through the single-sided glazing (whose
 * backfaces are culled from inside). The exterior is never hidden and no canopy is re-authored.
 */
const TBD_COCKPIT_POSITION: [number, number, number] = [0, 2.2116, -3.182];

const surfaceClips = [
  "flight.pitch-up",
  "flight.pitch-down",
  "flight.roll-right",
  "flight.roll-left",
  "flight.rudder-right",
  "flight.rudder-left",
  "flaps.deploy",
];
/** Which airframe a group is; the id the rest of the game asks for. */
export type AirframeId = "sbd3" | "tbd1" | "b5n2" | "a6m3";

const DOUGLAS_URL = "/assets/aircraft.douglas-sbd3.glb";

/**
 * The airframes imported by tools/import-aircraft.sh: metres, +Y up, span on X, wheels on y = 0,
 * and the propeller cut out of the fused mesh into its own child named `propeller` whose origin
 * sits on the real shaft, so spinning it about its own local Z is the whole animation. `ai` is the
 * reduced-detail build of the same airframe for wing aircraft and parked deck loads; the Kate
 * ships at one detail only.
 *
 * Nose direction is measured per file rather than assumed — see createAirframe.
 */
const IMPORTS = {
  b5n2: {
    name: "Nakajima B5N2",
    hero: "/assets/aircraft.b5n2-kate.glb",
    ai: "/assets/aircraft.b5n2-kate.glb",
  },
} as const;

/** Measured with tools/probe-glb.mjs: the A6M3 pivots its propeller under this node. */
const ZERO_PROPELLER = "VINTThreeNativePivot";

/** Rad/s at full throttle — about 2200 rpm, the rate dauntless.ts turns a propeller. */
const PROP_RATE = 231;
const TAU = Math.PI * 2;

let source: GLTF;
const imported = new Map<string, GLTF>();
const instances = new WeakMap<
  T.Group,
  {
    player: AnimationPlayer;
    canopyMaterial: T.Material;
    /** The per-instance trimmed canopy clone, the only pane geometry this aircraft owns. */
    canopyGeometry: T.BufferGeometry;
    /** The frame trimmed to match the pane cut, when the supplied model separates it. */
    canopyFrameGeometry?: T.BufferGeometry;
    blades: T.Object3D[];
    blur: T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>;
    instrumentRoot: T.Group;
    interior: CockpitInterior | undefined;
    actions: Map<string, T.AnimationAction>;
    gear: ReturnType<typeof createDauntlessGear>;
    pilot: ISeatedStation;
    gunner: ISeatedStation;
  }
>();

/**
 * The clip-driven rig built for an imported airframe that the game flies itself (the player TBD).
 *
 * The supplied GLB separates the moving parts and ships one clip per motion, so the real work is a
 * mixer over the clone and a mapping from the sim's control values to clip weights and times. Kept
 * apart from `instances`, which is the Douglas' hand-built animator and gear.
 */
const animatedImports = new WeakMap<
  T.Group,
  {
    mixer: T.AnimationMixer;
    actions: Map<string, T.AnimationAction>;
    instrumentRoot: T.Group;
    interior: CockpitInterior | undefined;
    torpedo: T.Object3D | undefined;
    /** The hook this file adds, because neither supplied airframe ships one. */
    hook: T.Group;
  }
>();

/** Idempotent: ctx.assets caches each model, and the anisotropy pass writes the same value again. */
export async function loadImportedAircraft(ctx: Pick<ICtx, "assets" | "renderer">): Promise<void> {
  const anisotropy = (ctx.renderer.raw as WebGPURenderer).getMaxAnisotropy();
  const urls = [
    DOUGLAS_URL,
    AIRCREW_PILOT_URL,
    AIRCREW_GUN_URL,
    ...new Set(Object.values(IMPORTS).flatMap((airframe) => [airframe.hero, airframe.ai])),
  ];
  const [models] = await Promise.all([
    Promise.all(urls.map((url) => ctx.assets.model<GLTF>(url))),
    ensureCockpitMaterials(ctx.assets, anisotropy),
  ]);
  urls.forEach((url, i) => {
    const model = models[i]!;
    imported.set(url, model);
    model.scene.traverse((node) => {
      if (!(node instanceof T.Mesh)) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        for (const value of Object.values(material)) {
          if (value instanceof T.Texture) {
            value.anisotropy = anisotropy;
            value.needsUpdate = true;
          }
        }
      }
    });
  });
  source = imported.get(DOUGLAS_URL)!;
  configureAircrewPilot(imported.get(AIRCREW_PILOT_URL)!);
  configureAircrewGun(imported.get(AIRCREW_GUN_URL)!);
}

/**
 * The rear radioman/gunner's station in the Douglas' own frame (nose -Z, +X starboard).
 *
 * Measured, not guessed: with the rig's baked `sit` clip the seated Head bone sits 1.175 m above
 * the rig origin and the mesh tops out at 1.36 m, so the origin is dropped 0.26 m to keep the head
 * under the canopy roof (1.184 m at z = -0.80). He faces aft (the rig faces +Z at yaw 0, like the
 * deck party), which puts his back at z = -0.98 and his knees at z = -0.20, aft of the pilot's eye
 * (z = -1.650) and forward of the canopy's rear edge (z = +0.20).
 */
const GUNNER_SEAT: readonly [number, number, number] = [0, -0.26, -0.55];

/**
 * The front pilot's station in the Douglas' own frame (nose -Z, +X starboard), facing the nose.
 *
 * The rig faces +Z at yaw 0, so the pilot is yawed PI and the same measured `sit` pose that fits
 * the radioman is mirrored fore-aft. Chosen from the cockpit's own eye (0, 1.080, -1.650): with the
 * rig origin here that eye lands on the posed Head joint, and the seated crown (origin + 1.378 m)
 * reaches 1.178 m — under the 1.207 m canopy glass at this z — while his feet stay inside the nose.
 */
const PILOT_SEAT: readonly [number, number, number] = [0, -0.2, -1.81];

/**
 * The station aft of which the Douglas canopy glass is cut away, in the aircraft's own frame.
 *
 * Kept ~0.44 m behind the pilot's eye (z = -1.650) so he keeps the whole forward greenhouse while
 * the gunner at z = -0.763 stands in an open rear cockpit. The measured frame runs z = -2.697…0.129
 * and its transverse hoops sit at z ≈ -2.31, -1.96, -1.58, -1.21, -0.87, -0.29. The cut is placed on
 * the **-1.21 hoop** rather than between hoops: cutting mid-span left the longitudinal rails with
 * open, unjoined ends behind the pilot (root's SBD stub), and a cut on a hoop leaves that hoop's
 * remains as the opening's rear lip.
 */
const REAR_OPEN_Z = -1.21;

/**
 * A clone of `mesh`'s geometry with everything aft of the plane z = `aftOf` cut away, in the
 * aircraft's own frame. Each triangle that crosses the plane is split at it rather than dropped by
 * its centroid: a centroid test leaves whole diagonal triangles spanning the opening, which is what
 * put a broad pane across the gunner and the firing ray. Attributes are interpolated on the split
 * so the retained glass and its frame keep clean edges. `mesh.matrixWorld` maps its vertices into
 * the root frame, where the cockpit stations live, so the cut is in metres of the airframe.
 */
function openCanopyAft(mesh: T.Mesh, aftOf: number): T.BufferGeometry {
  const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const position = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  const uv = source.getAttribute("uv");
  const toRoot = mesh.matrixWorld;
  const probe = new T.Vector3();
  interface Cut {
    p: number[];
    n: number[];
    u: number[];
    z: number;
  }
  const at = (i: number): Cut => {
    probe.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(toRoot);
    return {
      p: [position.getX(i), position.getY(i), position.getZ(i)],
      n: normal ? [normal.getX(i), normal.getY(i), normal.getZ(i)] : [],
      u: uv ? [uv.getX(i), uv.getY(i)] : [],
      z: probe.z,
    };
  };
  const mix = (a: Cut, b: Cut, f: number): Cut => ({
    p: a.p.map((v, k) => v + (b.p[k]! - v) * f),
    n: a.n.map((v, k) => v + (b.n[k]! - v) * f),
    u: a.u.map((v, k) => v + (b.u[k]! - v) * f),
    z: aftOf,
  });
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const push = (c: Cut): void => {
    positions.push(...c.p);
    if (normal) normals.push(...c.n);
    if (uv) uvs.push(...c.u);
  };
  for (let t = 0; t < position.count; t += 3) {
    const tri = [at(t), at(t + 1), at(t + 2)];
    const kept: Cut[] = [];
    for (let k = 0; k < 3; k++) {
      const cur = tri[k]!;
      const nxt = tri[(k + 1) % 3]!;
      const curIn = cur.z <= aftOf;
      if (curIn) kept.push(cur);
      if (curIn !== nxt.z <= aftOf) kept.push(mix(cur, nxt, (aftOf - cur.z) / (nxt.z - cur.z)));
    }
    for (let k = 1; k + 1 < kept.length; k++) {
      push(kept[0]!);
      push(kept[k]!);
      push(kept[k + 1]!);
    }
  }
  source.dispose();
  const trimmed = new T.BufferGeometry();
  trimmed.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
  if (normal) trimmed.setAttribute("normal", new T.Float32BufferAttribute(normals, 3));
  if (uv) trimmed.setAttribute("uv", new T.Float32BufferAttribute(uvs, 2));
  trimmed.computeBoundingSphere();
  trimmed.computeBoundingBox();
  return trimmed;
}

/** Metres, nose -Z; the body's origin is the flight model's centre of gravity. */
export function createDouglas(withCockpit = false): T.Group {
  if (!source) throw new Error("Load the Douglas aircraft before constructing its instances.");
  const root = new T.Group();
  root.name = "Douglas SBD-3";
  const model = source.scene.clone(true);
  const span = new T.Box3().setFromObject(model).getSize(new T.Vector3()).x;
  if (!Number.isFinite(span) || span <= 0)
    throw new Error("Douglas aircraft has no measurable wingspan.");
  model.scale.multiplyScalar(12.66 / span);
  model.rotation.y = Math.PI;
  // The source is exported gear-up; lift its propeller clear of the existing 1.82m wheel datum.
  model.position.y = 0.35;
  root.add(model);
  const gear = createDauntlessGear();
  root.add(gear.gear);
  // Keep the fixed tailwheel on the flight model's contact datum. Only extend its strut
  // to the imported fuselage; moving the whole assembly with the model leaves it floating.
  root.updateMatrixWorld(true);
  const attachment = new T.Raycaster(
    new T.Vector3(0, -2, 4.19),
    new T.Vector3(0, 1, 0),
  ).intersectObject(model, true)[0];
  if (!attachment) throw new Error("Douglas tailwheel has no fuselage attachment above its mount.");
  rod(
    gear.tail,
    [0, -0.29, 4.19],
    [0, attachment.point.y, 4.19],
    0.043,
    mat(0x84939b, { metalness: 0.85, roughness: 0.26 }),
  );
  root.traverse((node) => {
    if (node instanceof T.Mesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  // Blender inspection: node_7 is the pane mesh; node_8 is the separate metal frame.
  // The supplied GLB marks both opaque, making the cockpit windshield a solid grey wall.
  const canopy = model.getObjectByName("defaultMaterial_node_7");
  if (!(canopy instanceof T.Mesh) || !(canopy.material instanceof T.MeshStandardMaterial))
    throw new Error("Douglas aircraft is missing its separate canopy glass mesh.");
  const canopyMaterial = canopy.material.clone();
  canopyMaterial.color.set(0xc3dbe0);
  canopyMaterial.map = null;
  canopyMaterial.normalMap = null;
  canopyMaterial.transparent = true;
  canopyMaterial.opacity = 0.09;
  canopyMaterial.depthWrite = false;
  canopyMaterial.metalness = 0;
  canopyMaterial.roughness = 0.12;
  canopyMaterial.forceSinglePass = true;
  canopy.material = canopyMaterial;
  canopy.castShadow = false;
  // The rear cockpit is open. The supplied canopy is one glass mesh over both stations and ships no
  // rear section to slide or hide, so its own triangles aft of the partition are dropped: the pilot
  // keeps the forward greenhouse and the flexible gun fires through an open rear cockpit rather
  // than through sealed glazing. The geometry is cloned because the original belongs to the shared
  // GLTF's scene; `disposeDouglas` gives the clone back.
  root.updateMatrixWorld(true);
  const canopyGeometry = openCanopyAft(canopy, REAR_OPEN_Z);
  canopy.geometry = canopyGeometry;
  // The metal frame is a separate mesh over the same greenhouse; cut it at the same plane or the
  // closed rear frame and its full-width hoop stay behind the gunner with the glass gone.
  const canopyFrame = model.getObjectByName("defaultMaterial_node_8");
  const canopyFrameGeometry =
    canopyFrame instanceof T.Mesh ? openCanopyAft(canopyFrame, REAR_OPEN_Z) : undefined;
  if (canopyFrame instanceof T.Mesh) canopyFrame.geometry = canopyFrameGeometry!;
  // Fuselage shells that share the cockpit's space and peek around the detailed interior.
  const cockpitFuselage = ["defaultMaterial_node_12", "defaultMaterial_node_18"]
    .map((name) => model.getObjectByName(name))
    .filter((node): node is T.Object3D => Boolean(node));
  const cockpitShell = [canopy, ...(canopyFrame ? [canopyFrame] : []), ...cockpitFuselage];
  const blades = ["defaultMaterial_node_15", "defaultMaterial_node_16"].map((name) => {
    const mesh = model.getObjectByName(name);
    if (!(mesh instanceof T.Mesh))
      throw new Error(`Douglas aircraft is missing propeller blade ${name}.`);
    return mesh;
  });
  const propellerPivot = model.getObjectByName("Circle008_Circle031ThreeNativePivot");
  if (!propellerPivot) throw new Error("Douglas aircraft is missing its propeller pivot.");
  root.updateMatrixWorld(true);
  const inversePivot = propellerPivot.matrixWorld.clone().invert();
  const vertex = new T.Vector3();
  let bladeRadius = 0;
  for (const blade of blades) {
    const transform = inversePivot.clone().multiply(blade.matrixWorld);
    const positions = blade.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i).applyMatrix4(transform);
      bladeRadius = Math.max(bladeRadius, Math.hypot(vertex.x, vertex.y));
    }
  }
  const blur = new T.Mesh(
    new T.PlaneGeometry(bladeRadius * 2, bladeRadius * 2),
    new T.MeshBasicMaterial({
      map: softCircleDataTexture(64, 0.8),
      color: 0xa3aaa3,
      transparent: true,
      opacity: 0.045,
      side: T.DoubleSide,
      depthWrite: false,
      forceSinglePass: true,
      toneMapped: false,
    }),
  );
  blur.name = "Propeller motion blur";
  propellerPivot.add(blur);
  const instrumentRoot = new T.Group();
  instrumentRoot.name = "Douglas live cockpit instruments";
  const cockpitMaterials = getCockpitMaterials();
  const interior = withCockpit && cockpitMaterials ? createCockpitInterior(cockpitMaterials) : undefined;
  if (interior) {
    interior.root.scale.setScalar(COCKPIT_SCALE);
    interior.root.position.set(...COCKPIT_POSITION);
    instrumentRoot.add(interior.root);
    root.userData.cockpit = new T.Vector3(
      COCKPIT_POSITION[0] + interior.eye[0] * COCKPIT_SCALE,
      COCKPIT_POSITION[1] + interior.eye[1] * COCKPIT_SCALE,
      COCKPIT_POSITION[2] + interior.eye[2] * COCKPIT_SCALE,
    );
  }
  root.add(instrumentRoot);
  const propeller = source.animations.find((clip) => clip.name === "propeller.spin");
  if (!propeller) throw new Error("Douglas aircraft is missing propeller.spin.");
  const propTracks = new Set(propeller.tracks.map((track) => track.name));
  // Composite source clips include the propeller. Strip that shared track so simultaneous
  // elevator, aileron and rudder input cannot blend away the independent throttle-driven spin.
  const clips = [
    propeller,
    ...surfaceClips.map((name) => {
      const clip = source.animations.find((candidate) => candidate.name === name);
      if (!clip) throw new Error(`Douglas aircraft is missing ${name}.`);
      return new T.AnimationClip(
        name,
        clip.duration,
        clip.tracks.filter((track) => !propTracks.has(track.name)),
      );
    }),
  ];
  const player = new AnimationPlayer({
    root: model,
    clips,
    requiredClips: clips.map((clip) => clip.name),
    strideRoot: root,
    strideSync: false,
  });
  const actions = new Map(
    clips.map((clip) => {
      const action = player.mixer.clipAction(clip).play();
      action.paused = clip !== propeller;
      action.setEffectiveWeight(clip === propeller ? 1 : 0);
      return [clip.name, action] as const;
    }),
  );
  root.userData.importedAircraft = true;
  // Every Douglas is a Douglas, whether it came through the AI wrapper or the player's own seat:
  // this flag is what selects `animateDouglas` and `resetAirframeAnimation`, so it belongs here.
  root.userData.douglas = true;
  // Exposed for symmetry with every other airframe, but animateDouglas owns it: the mixer writes
  // this pivot's quaternion from propeller.spin every frame, so spinPropeller cannot move it.
  root.userData.propeller = propellerPivot;
  root.userData.cockpitInterior = instrumentRoot;
  root.userData.cockpitShell = cockpitShell;
  root.userData.cockpitRig = interior;
  // Both seats of the two-man cockpit. The forward pilot is `userData.crew[0]`: the cockpit view
  // hides that one with the player's own aircraft. The gunner sits behind that camera and is
  // published separately, so the crew hook can never take him off the aircraft. `userData.gunner`
  // is the man's own rig root — not the station — so a first-person station can hide the gunner
  // without taking his seat, the fittings or the gun with him; `userData.rearGun` is the separate
  // pivot the controls arm turns.
  const pilot = createSeatedStation("Douglas front pilot", PILOT_SEAT, Math.PI);
  root.add(pilot.root);
  root.userData.crew = [pilot.root];
  root.userData.pilotRig = pilot.player;
  root.userData.pilotEye = pilot.eye;
  const gunner = createSeatedStation("Douglas rear gunner", GUNNER_SEAT, 0, { gun: true });
  root.add(gunner.root);
  root.userData.gunner = gunner.player.root;
  root.userData.gunnerRig = gunner.player;
  root.userData.gunnerEye = gunner.eye;
  root.userData.rearGun = gunner.gun;
  root.userData.owned = [
    ...((root.userData.owned as T.Object3D[] | undefined) ?? []),
    pilot.furniture,
    gunner.furniture,
  ];
  instances.set(root, {
    player,
    actions,
    gear,
    canopyMaterial,
    canopyGeometry,
    canopyFrameGeometry,
    blades,
    blur,
    instrumentRoot,
    interior,
    pilot,
    gunner,
  });
  animateDouglas(root, {}, 0);
  return root;
}

interface IDouglasControls {
  rpm?: number;
  throttle?: number;
  elevator?: number;
  controlAileron?: number;
  aileron?: number;
  rudder?: number;
  flapPos?: number;
  brakePos?: number;
  gearPos?: number;
  wheelAngle?: number;
}

export function animateDouglas(root: T.Group, p: IDouglasControls, dt: number): void {
  const instance = instances.get(root);
  if (!instance) throw new Error("This object is not an imported Douglas aircraft.");
  const { actions, player, gear, blades, blur, interior } = instance;
  const rpm = Math.max(0, p.rpm ?? p.throttle ?? 0.18);
  for (const blade of blades) blade.visible = rpm < 0.24;
  blur.visible = rpm >= 0.24;
  if (interior) interior.update(p);
  actions.get("propeller.spin")!.setEffectiveTimeScale(rpm * 26);
  for (const [positive, negative, value] of [
    ["flight.pitch-up", "flight.pitch-down", p.elevator ?? 0],
    ["flight.roll-right", "flight.roll-left", p.controlAileron ?? p.aileron ?? 0],
    ["flight.rudder-right", "flight.rudder-left", p.rudder ?? 0],
  ] as const) {
    actions.get(positive)!.setEffectiveWeight(T.MathUtils.clamp(value, 0, 1));
    actions.get(negative)!.setEffectiveWeight(T.MathUtils.clamp(-value, 0, 1));
  }
  const flap = actions.get("flaps.deploy")!;
  flap.setEffectiveWeight(1);
  flap.time =
    flap.getClip().duration * T.MathUtils.clamp(Math.max(p.flapPos ?? 0, p.brakePos ?? 0), 0, 1);
  for (const { group, sign, wheel } of gear.gearLegs) {
    group.rotation.z = (-sign * (1 - (p.gearPos ?? 1)) * Math.PI) / 2;
    wheel.rotation.x = p.wheelAngle ?? 0;
  }
  // The supplied Douglas is exported gear-up and has no wheel wells for this added gear to fold
  // into, so a folded leg hangs in open air under the wing and reads as a pale box from above.
  // With the gear up the aircraft simply carries none: draw the assembly only while it is down.
  gear.gear.visible = (p.gearPos ?? 1) > 0.02;
  // Each seated man holds the sit idle, driven at the frame's own dt so a paused (dt = 0) frame
  // freezes him, exactly like the propeller.
  instance.pilot.player.update(dt);
  instance.gunner.player.update(dt);
  player.update(dt);
}

export function disposeDouglas(root: T.Group): void {
  const instance = instances.get(root);
  if (!instance) return;
  instance.player.dispose();
  // The seated crews' skinned geometry is the shared pilot GLTF's; only their mixer bindings are ours.
  instance.pilot.player.dispose();
  instance.gunner.player.dispose();
  instance.canopyMaterial.dispose();
  instance.canopyGeometry.dispose();
  instance.canopyFrameGeometry?.dispose();
  instance.blur.geometry.dispose();
  instance.blur.material.map?.dispose();
  instance.blur.material.dispose();
  instance.interior?.dispose();
  instance.instrumentRoot.traverse((node) => {
    if (!(node instanceof T.Mesh)) return;
    node.geometry.dispose();
    if (node.material instanceof T.MeshBasicMaterial) node.material.dispose();
  });
  instance.gear.gear.traverse((node) => {
    if (!(node instanceof T.Mesh)) return;
    node.geometry.dispose();
    // Gear materials come from the shared mat() cache and belong to the whole scene.
  });
  instances.delete(root);
}

/**
 * One aircraft of a named airframe, at the requested detail.
 *
 * The id is explicit on purpose: a caller asks for the airframe it means, so no team or kind
 * mapping can quietly hand back the wrong silhouette. `ai` is the reduced-detail build where the
 * airframe has one; where it does not, the same model serves both and says so here.
 */
/**
 * The arresting hook the supplied airframes do not ship.
 *
 * Neither the TBD nor the Kate GLB has a hook — nine clips each, none of them a hook — and this
 * game recovers onto a carrier deck every sortie, so the one part a player watches on every landing
 * was the one part missing. The imported Douglas already carries one tied to gear position;
 * this is the same part and the same convention on the Kate, so the two airframes behave alike rather than one of them being silently hookless.
 *
 * The stinger is placed from the model's own bounds, not from typed-in metres: its root sits at the
 * tail on the centreline, just under the fuselage, so a change to the airframe's scale carries it.
 */
function addArrestingHook(root: T.Group, model: T.Object3D): T.Group {
  const bounds = new T.Box3().setFromObject(model);
  const size = bounds.getSize(new T.Vector3());
  const hook = new T.Group();
  hook.name = "arresting hook";
  // Bow is -Z by the import contract, so the tail is the +Z end of the bounds.
  hook.position.set(0, bounds.min.y + size.y * 0.18, bounds.max.z * 0.86);
  const reach = size.z * 0.17;
  const steel = mat(0x2e3336);
  const tip = mat(0x8d9498);
  rod(hook, [0, 0, 0], [0, -reach * 0.22, reach], 0.035, steel);
  rod(hook, [0, -reach * 0.22, reach], [0, -reach * 0.36, reach * 1.11], 0.055, tip);
  // Stowed against the fuselage; `animateImportedAirframe` lowers it with the gear.
  hook.rotation.x = 0;
  root.add(hook);
  root.userData.arrestingHook = hook;
  return hook;
}

export function createAirframe(id: AirframeId, detail: "hero" | "ai", animated = false): T.Group {
  // The Dauntless and the Zero keep the constructors that measured them; only their propeller is
  // republished here, so one animator can find any airframe's propeller the same way.
  if (id === "sbd3") return createDouglas();
  // The Devastator is drawn from the ported standalone airframe, not a supplied GLB.
  if (id === "tbd1") return makeDevastator(detail, animated);
  if (id === "a6m3") {
    const zero = createZero();
    zero.userData.propeller = requirePropeller(zero, ZERO_PROPELLER, "Mitsubishi A6M3", "aircraft.mitsubishi-a6m3.glb");
    return zero;
  }
  const airframe = IMPORTS[id as keyof typeof IMPORTS] as (typeof IMPORTS)[keyof typeof IMPORTS] | undefined;
  if (!airframe)
    throw new Error(`Unknown airframe id "${String(id)}": expected sbd3, tbd1, b5n2 or a6m3.`);
  const url = airframe[detail];
  const gltf = imported.get(url);
  if (!gltf) throw new Error(`Load the imported aircraft before constructing the ${airframe.name}.`);
  const root = new T.Group();
  root.name = airframe.name;
  // Already metres, wheels on y = 0 and nose -Z out of the import: never scaled or rotated here.
  const model = gltf.scene.clone(true);
  model.traverse((node) => {
    if (node instanceof T.Mesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  root.add(model);
  const propeller = requirePropeller(model, "propeller", airframe.name, url);
  root.updateMatrixWorld(true);

  // Which way the file points, measured from the model itself rather than assumed. The game flies
  // every model nose -Z, and the propeller IS the nose, so its own sign along the fuselage says
  // which end is which: a mis-exported airframe gets turned instead of flown backwards. Every
  // shipped model satisfies -Z today, so this is a no-op — it earns its place by having caught a
  // Blender +Y-to-glTF -Z axis error in tools/blender/align-aircraft.py that nothing else saw.
  let shaft = propeller.getWorldPosition(new T.Vector3());
  if (!(Math.abs(shaft.z) > 0.5))
    throw new Error(`${airframe.name} propeller sits at neither end of its fuselage.`);
  if (shaft.z > 0) {
    model.rotation.y = Math.PI;
    root.updateMatrixWorld(true);
    shaft = propeller.getWorldPosition(new T.Vector3());
  }

  // The blade disc at speed, the way dauntless.ts fades one: a soft circle that comes up as the
  // blades go out. Sized from the propeller's own measured diameter, and parented to the root at
  // the shaft rather than to the propeller, so it keeps the root's scale and never spins.
  const span = new T.Box3().setFromObject(propeller).getSize(new T.Vector3());
  const radius = Math.max(span.x, span.y) / 2;
  if (!(radius > 0)) throw new Error(`${airframe.name} propeller has no measurable diameter.`);
  const blur = new T.Mesh(
    new T.PlaneGeometry(radius * 2, radius * 2),
    new T.MeshBasicMaterial({
      map: softCircleDataTexture(64, 0.8),
      color: 0xa3aaa3,
      transparent: true,
      opacity: 0,
      side: T.DoubleSide,
      depthWrite: false,
      forceSinglePass: true,
      toneMapped: false,
    }),
  );
  blur.name = "Propeller motion blur";
  blur.position.copy(shaft);
  blur.visible = false;
  root.add(blur);

  root.userData.importedAircraft = true;
  root.userData.propeller = propeller;
  // The scene's generic per-frame path spins `prop`; this is the same object under the name
  // createZero established, so an imported airframe drops into it without a special case.
  root.userData.prop = propeller;
  root.userData.propAngle = 0;
  root.userData.propBlur = blur;

  // The one imported airframe the player flies: build the clip rig, the visible store and the
  // shared instrument panel. AI and parked instances stay on the cheap generic prop/gear path,
  // so a strike's worth of TBDs do not each carry a mixer and a cockpit.
  if (animated) {
    const spin = gltf.animations.find((clip) => clip.name === "propeller.spin");
    if (!spin) throw new Error(`${airframe.name} (${url}) has no propeller.spin clip to drive.`);
    const mixer = new T.AnimationMixer(model);
    const actions = new Map<string, T.AnimationAction>();
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip);
      action.play();
      // Surfaces, flaps and gear hold the time the animator writes; only the propeller runs free.
      action.paused = clip.name !== "propeller.spin";
      action.setEffectiveWeight(clip.name === "propeller.spin" ? 1 : 0);
      actions.set(clip.name, action);
    }
    let torpedo: T.Object3D | undefined;
    const instrumentRoot = new T.Group();
    instrumentRoot.name = "TBD live cockpit instruments";
    const cockpitMaterials = getCockpitMaterials();
    const interior = cockpitMaterials ? createCockpitInterior(cockpitMaterials) : undefined;
    if (interior) {
      interior.root.scale.setScalar(COCKPIT_SCALE);
      interior.root.position.set(...TBD_COCKPIT_POSITION);
      instrumentRoot.add(interior.root);
      root.userData.cockpit = new T.Vector3(
        TBD_COCKPIT_POSITION[0] + interior.eye[0] * COCKPIT_SCALE,
        TBD_COCKPIT_POSITION[1] + interior.eye[1] * COCKPIT_SCALE,
        TBD_COCKPIT_POSITION[2] + interior.eye[2] * COCKPIT_SCALE,
      );
      root.userData.cockpitInterior = instrumentRoot;
    }
    root.add(instrumentRoot);
    root.userData.animatedAirframe = true;
    const hook = addArrestingHook(root, model);
    animatedImports.set(root, { mixer, actions, instrumentRoot, interior, torpedo, hook });
  }
  return root;
}

function requirePropeller(root: T.Object3D, name: string, model: string, file: string): T.Object3D {
  const propeller = root.getObjectByName(name);
  // A silently missing pivot is the failure the whole import was built to remove: without it the
  // propeller is fused into the airframe and no rotation can look right, so this never falls back.
  if (!propeller)
    throw new Error(`${model} (${file}) has no child named "${name}" to spin as its propeller.`);
  return propeller;
}

/**
 * Turn one aircraft's propeller. `rpmNormalised` is 0 at rest and 1 at full throttle.
 *
 * The angle lives on the group, so two aircraft at different throttle settings never share a
 * rotation, and a paused frame (dt = 0) advances nothing.
 */
export function spinPropeller(group: T.Group, rpmNormalised: number, dt: number): void {
  const propeller = group.userData.propeller as T.Object3D | undefined;
  if (!propeller)
    throw new Error(`${group.name || "This object"} is not an airframe with a propeller to spin.`);
  const rpm = Math.max(0, rpmNormalised);
  const angle = ((group.userData.propAngle as number | undefined) ?? 0) + dt * rpm * PROP_RATE;
  group.userData.propAngle = angle % TAU;
  propeller.rotation.z = group.userData.propAngle as number;
  const blur = group.userData.propBlur as
    | T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>
    | undefined;
  // Only an airframe that owns a blur disc may hide its blades; the rest would just vanish.
  if (!blur) return;
  propeller.visible = rpm < 0.38;
  blur.visible = rpm > 0.15;
  blur.material.opacity = Math.min(1, rpm * 2.5);
}

/**
 * Drive one player-flown imported airframe from the sim's control values.
 *
 * The supplied clips are each a single axis, keyed from rest at time 0, so a control value maps to
 * a clip time (gear, flaps) or to a time on whichever of an opposed pair has the sign. Every
 * action lives on this group's own mixer, so two TBDs at different throttle, flap or gear settings
 * never share a transform, and `dt = 0` freezes the propeller.
 */
export function animateImportedAirframe(
  root: T.Group,
  p: {
    rpm?: number;
    throttle?: number;
    elevator?: number;
    controlAileron?: number;
    aileron?: number;
    rudder?: number;
    flapPos?: number;
    gearPos?: number;
    torpedo?: number;
  },
  dt: number,
): void {
  const rig = animatedImports.get(root);
  if (!rig) throw new Error(`${root.name || "This object"} has no imported animation rig.`);
  const action = (name: string): T.AnimationAction => {
    const found = rig.actions.get(name);
    if (!found) throw new Error(`${root.name} is missing its ${name} clip.`);
    return found;
  };
  const hold = (name: string, value: number): void => {
    const a = action(name);
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.time = a.getClip().duration * T.MathUtils.clamp(value, 0, 1);
  };
  const opposed = (positive: string, negative: string, value: number): void => {
    const v = T.MathUtils.clamp(value, -1, 1);
    hold(v >= 0 ? positive : negative, Math.abs(v));
    action(v >= 0 ? negative : positive).setEffectiveWeight(0);
  };
  const rpm = Math.max(0, p.rpm ?? p.throttle ?? 0);
  action("propeller.spin").setEffectiveTimeScale(rpm * 26);
  opposed("flight.pitch-up", "flight.pitch-down", p.elevator ?? 0);
  opposed("flight.roll-right", "flight.roll-left", p.controlAileron ?? p.aileron ?? 0);
  opposed("flight.rudder-right", "flight.rudder-left", p.rudder ?? 0);
  // gear.retract runs deployed (time 0) to stowed (full), so gearPos 1 = down = time 0.
  hold("gear.retract", 1 - T.MathUtils.clamp(p.gearPos ?? 1, 0, 1));
  // The hook comes down with the gear, the same tie the Douglas uses: the simulation
  // carries no separate hook state, and inventing one here would put the drawn part ahead of what
  // `recovery.ts` actually gates an arrestment on.
  if (rig.hook) rig.hook.rotation.x = T.MathUtils.clamp(p.gearPos ?? 1, 0, 1) * 0.42;
  hold("flaps.deploy", p.flapPos ?? 0);
  const blur = root.userData.propBlur as T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial> | undefined;
  if (blur) {
    root.userData.propeller!.visible = rpm < 0.38;
    blur.visible = rpm > 0.15;
    blur.material.opacity = Math.min(1, rpm * 2.5);
  }
  if (rig.torpedo) rig.torpedo.visible = (p.torpedo ?? 0) > 0;
  rig.interior?.update(p);
  rig.mixer.update(dt);
}

/**
 * Rewind one airframe's own animation to its rest time, so a pooled reuse starts where a fresh
 * clone would. Imported AI airframes carry no rig and are a no-op.
 */
export function resetAirframeAnimation(root: T.Group): void {
  const instance = instances.get(root);
  if (instance) {
    instance.player.mixer.setTime(0);
    instance.pilot.player.mixer.setTime(0);
    instance.gunner.player.mixer.setTime(0);
    return;
  }
  animatedImports.get(root)?.mixer.setTime(0);
}

/**
 * Give back what this one aircraft owns, and nothing else.
 *
 * Geometry, materials and textures come from the shared GLTF that `ctx.assets` owns and outlive
 * every instance, so only the blur disc, the per-instance panel and the visible store built for
 * this group are disposed. Procedural parts another constructor built for its own instance stay in
 * that instance's `userData.owned`, where the scene's model disposal already gives them back.
 */
export function disposeAirframe(group: T.Group): void {
  if (instances.has(group)) {
    disposeDouglas(group);
    return;
  }
  if (group.userData.devastator) {
    disposeDevastator(group);
    return;
  }
  const rig = animatedImports.get(group);
  if (rig) {
    // The clips belong to the shared GLTF; only this mixer's bindings and this instance's own
    // panel and store are ours to give back.
    rig.mixer.stopAllAction();
    const mixerRoot = rig.mixer.getRoot();
    if (mixerRoot) rig.mixer.uncacheRoot(mixerRoot);
    rig.interior?.dispose();
    rig.torpedo?.traverse((node) => (node as T.Mesh).geometry?.dispose());
    animatedImports.delete(group);
  }
  const blur = group.userData.propBlur as
    | T.Mesh<T.PlaneGeometry, T.MeshBasicMaterial>
    | undefined;
  if (!blur) return;
  blur.geometry.dispose();
  blur.material.map?.dispose();
  blur.material.dispose();
  blur.removeFromParent();
  delete group.userData.propBlur;
}
