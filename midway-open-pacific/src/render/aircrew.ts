/**
 * One seated aircrew station — the shared pilot rig, its seat, and a rear station's flexible-gun
 * pivot — fitted into whichever cockpit carries it.
 *
 * Extracted from the Douglas factory so the ported TBD's own procedural cockpit can seat the same
 * rig without importing the Douglas module: `imported-aircraft.ts` imports `devastator.ts`, so the
 * reverse would be a cycle. This is render-only; it reads and writes no sim, input or camera state.
 */
import { SkeletalMesh3D } from "@threenative/core";
import * as T from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { box, mat, rod } from "./assets.js";
import { REAR_GUN_HINGE } from "../sim/gun-mount.js";

/** The deck crew's rigged pilot, which both the Douglas and the TBD seat in their cockpits. */
export const AIRCREW_PILOT_URL = "carrier-aircraft-pilot.glb";

/** The approved twin rear gun. Its cradle hinge is the origin and its barrels run aft (+Z). */
export const AIRCREW_GUN_URL = "weapon.rear-gun.glb";

let pilotRig: GLTF | undefined;
let gunRig: GLTF | undefined;
let gripClip: T.AnimationClip | undefined;

/**
 * The baked neutral grip, as local quaternions of the four arm bones, measured on root's accepted
 * `gunner-grip` bake of the game's own export (`tools/extract-gunner-grip.mjs`, rest space checked
 * there). Only these four bones override the `sit` body idle; a static hold is enough because the
 * gun aims on its own pivot, not through the man's hands.
 */
export const GUNNER_GRIP_ARMS: Readonly<
  Record<string, readonly [number, number, number, number]>
> = Object.freeze({
  upperarm_l: [0.14411, -0.07332, -0.74977, 0.64164],
  lowerarm_l: [0.00061, 0.0144, -0.07052, 0.99741],
  upperarm_r: [0.10767, 0.08663, 0.85991, 0.49138],
  lowerarm_r: [0.01159, -0.16726, 0.07036, 0.98333],
});

/** The grip clip name the gunner station plays, and the fallback where no bake is available. */
export const GUNNER_GRIP_CLIP = "gunner-grip";

/**
 * Graft the baked arm hold onto the shipped `sit` clip: every non-arm track is copied unchanged and
 * the four arm quaternions become two constant keys, so the seated body still idles while the hands
 * stay on the grips. The graft is valid only because the bake and the shipped rig share one rest
 * pose, which `tools/extract-gunner-grip.mjs` verifies bone by bone before these constants are cut.
 */
function buildGripClip(sit: T.AnimationClip): T.AnimationClip {
  const tracks = sit.tracks.map((track) => {
    const arm = GUNNER_GRIP_ARMS[track.name.replace(/\.quaternion$/, "")];
    if (!arm || !track.name.endsWith(".quaternion")) return track.clone();
    return new T.QuaternionKeyframeTrack(track.name, [0, sit.duration], [...arm, ...arm]);
  });
  return new T.AnimationClip(GUNNER_GRIP_CLIP, sit.duration, tracks);
}

/** Hand the loaded pilot GLTF to every cockpit factory. Idempotent, so each load re-publishes it. */
export function configureAircrewPilot(gltf: GLTF): void {
  pilotRig = gltf;
  const sit = gltf.animations.find((clip) => clip.name === "sit");
  if (!sit) throw new Error("The aircrew pilot rig has no sit clip to graft the gunner grip onto.");
  gripClip = buildGripClip(sit);
}

/** Hand the loaded rear gun to every cockpit factory. Idempotent, like the pilot. */
export function configureAircrewGun(gltf: GLTF): void {
  gunRig = gltf;
}

/**
 * The seated rig's own joints in its local frame, measured on the shipped `sit` clip at mixer t = 0
 * (yaw 0, facing +Z, nose -Z game frame). Furniture is derived from the pelvis so a seat can never
 * drift off the man it carries — an earlier hand-placed pan sat 0.85 m in front of the gunner.
 */
export const SEATED_PELVIS: readonly [number, number, number] = [0.003, 0.625, -0.286];

/**
 * The seated eye relative to the posed `Head` bone: 0.08 m up and 0.055 m along the face's forward
 * axis, so `eye = head + offset` reproduces the SBD's documented cockpit eye (0, 1.080, -1.650)
 * from its measured head joint (-0.003, 0.998, -1.597). Measured once, shared by every station.
 */
const EYE_OFFSET: readonly [number, number, number] = [0, 0.08, 0.055];

/** A seated crew station: the rig root, its own fittings, the seated eye, and any gun pivot. */
export interface ISeatedStation {
  /** The whole station, rig plus fittings; what `userData.crew[0]` hides for a pilot. */
  root: T.Group;
  /** The station's fittings, registered in the airframe's `userData.owned` for disposal. */
  furniture: T.Group;
  player: SkeletalMesh3D;
  /** The seated eye in aircraft-root coordinates, measured off the posed skeleton. */
  eye: T.Vector3;
  /** The flexible gun's pivot on a rear station; the controls arm turns this and nothing else. */
  gun?: T.Group;
}

/**
 * A seat pan, backrest and legs under a seated crew man's measured pelvis, built in his local frame
 * so the caller yaws and places the station as one. The pan sits 0.075 m below the pelvis joint (the
 * sit bones) and the backrest just behind his back at local -Z.
 */
function seatedFurniture(parent: T.Object3D, seat: T.Material, frame: T.Material): void {
  const [px, py, pz] = SEATED_PELVIS;
  box(parent, 0.42, 0.06, 0.44, px, py - 0.105, pz, seat);
  box(parent, 0.44, 0.46, 0.06, px, py + 0.095, pz - 0.135, seat);
  for (const x of [-0.17, 0.17]) rod(parent, [x, py - 0.105, pz], [x, 0.05, pz], 0.018, frame);
}

/** A local point in the station frame, placed into the aircraft frame: seat plus the station yaw. */
function stationToRoot(
  seat: readonly [number, number, number],
  yaw: number,
  local: readonly [number, number, number],
): [number, number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [
    seat[0] + local[0] * c + local[2] * s,
    seat[1] + local[1],
    seat[2] - local[0] * s + local[2] * c,
  ];
}

export interface ISeatedStationOptions {
  /** Build the placeholder twin-gun mount and publish its pivot. */
  gun?: boolean;
  /**
   * Build the procedural seat. Off where the airframe already models its own, so the drawn seat
   * never doubles up with the source cockpit.
   */
  furniture?: boolean;
}

/**
 * One seated crew man on the deck crew's `sit` clip: the rig, his seat, and — on a rear station —
 * the flexible-gun pivot the controls arm turns.
 *
 * The likeness, weights, textures and skeleton are the shared `carrier-aircraft-pilot.glb`; only
 * the `sit` clip is the additional Quaternius UAL motion, so a second man is an independent
 * `SkeletalMesh3D` clone with its own mixer. The gun is its own pivot group, so hiding the man in a
 * first-person station never hides the seat, the fittings or the gun.
 */
export function createSeatedStation(
  name: string,
  seat: readonly [number, number, number],
  yaw: number,
  options: ISeatedStationOptions = {},
): ISeatedStation {
  if (!pilotRig) throw new Error(`Load the aircrew pilot rig before building the ${name}.`);
  const root = new T.Group();
  root.name = `${name} crew`;
  const fittings = new T.Group();
  fittings.name = `${name} cockpit fittings`;
  const furniture = new T.Group();
  furniture.position.set(...seat);
  furniture.rotation.y = yaw;
  if (options.furniture !== false)
    seatedFurniture(furniture, mat(0x5c5340, { roughness: 0.85, metalness: 0.05 }), mat(0x4a5148, { metalness: 0.55, roughness: 0.5 }));
  fittings.add(furniture);
  let gun: T.Group | undefined;
  if (options.gun) {
    // The approved twin gun, its own pivot on the station, carried in the aircraft frame so a yaw or
    // pitch swings the gun and never the man, his seat or the airframe. The supplied model carries
    // its own pedestal; nothing procedural is drawn. The pivot is placed in the station frame at
    // root's approved hinge offset and parented to the station root (not the fittings), so the
    // shared GLTF geometry is never handed to the scene's per-instance disposal.
    if (!gunRig) throw new Error(`Load the aircrew rear gun before building the ${name}.`);
    const pivot = stationToRoot(seat, yaw, REAR_GUN_HINGE);
    gun = new T.Group();
    gun.name = `${name} gun pivot`;
    gun.position.set(...pivot);
    gun.add(gunRig.scene.clone(true));
    root.add(gun);
  }
  root.add(fittings);
  // The gunner holds the baked grip grafted onto `sit`; the pilot keeps the plain seated clip.
  const clip = options.gun ? GUNNER_GRIP_CLIP : "sit";
  const clips = options.gun && gripClip ? [...pilotRig.animations, gripClip] : pilotRig.animations;
  const player = new SkeletalMesh3D({
    source: pilotRig.scene,
    clips,
    // Only the seated clip belongs to this occupant; the standing hero clips stay on the deck crew.
    requiredClips: [clip],
    // A seated man travels nowhere; an in-place idle must keep its authored rate.
    strideSync: false,
  });
  player.root.name = name;
  player.root.position.set(...seat);
  player.root.rotation.y = yaw;
  player.play(clip);
  player.update(0);
  root.add(player.root);
  root.traverse((node) => {
    if (!(node instanceof T.Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
  });
  // The seated eye point, in the aircraft's own frame. Measured off the posed skeleton rather than
  // typed in, so a cockpit view follows the rig wherever it is fitted.
  const head = player.root.getObjectByName("Head");
  if (!head) throw new Error(`The pilot rig has no Head bone to sight the ${name} from.`);
  player.root.updateMatrixWorld(true);
  const eye = head
    .getWorldPosition(new T.Vector3())
    .add(new T.Vector3(...EYE_OFFSET).applyAxisAngle(new T.Vector3(0, 1, 0), yaw));
  return { root, furniture: fittings, player, eye, gun };
}
