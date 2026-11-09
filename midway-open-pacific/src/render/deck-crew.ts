/**
 * The flight-deck party around the player's aircraft.
 *
 * One rigged figure is loaded once per uniform and instanced per station. A carrier deck is not
 * a crowd of identical figures: every man here has a job, stands where that job puts him relative
 * to the aircraft, and runs his own clip at his own phase and rate, so no two are in step. Roles
 * follow 1942 US carrier practice — the yellow-shirted plane director ahead of the nose, chockmen
 * at the main wheels, plane captain at the engine, ordnance under the wing, fuel and
 * arresting-gear details standing clear of the launch path, and the pilot walking his aircraft
 * before he boards it.
 */
import { SkeletalMesh3D, type ICtx } from "@threenative/core";
import * as T from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { WebGPURenderer } from "three/webgpu";
import { mat } from "./assets.js";

/** Clips baked by tools/blender/rig-deck-crew.py; the loader fails closed if any is missing. */
const CLIPS = [
  "crew.signal",
  "crew.idle",
  "crew.wait",
  "crew.chock",
  "crew.service",
  "crew.walk",
] as const;

/** Clips on the director and pilot rigs, built by tools/import-people.sh from the same skeleton. */
const HERO_CLIPS = ["gesture", "idle", "walk"] as const;

type Rig = "crew" | "director" | "pilot";

interface IStation {
  /** Shown in nothing; it documents why the man is standing there. */
  readonly job: string;
  /** Which uniform stands here: the sailor party, the yellow director, or the pilot. */
  readonly rig: Rig;
  /** Duty clip on that rig: a `crew.*` name for sailors, gesture/idle for the hero rigs. */
  readonly clip: string;
  /** Cap-band colour, the trade marking a deck hand is actually recognised by. Sailors only:
   * the director and pilot arrive in their own marked uniforms. */
  readonly band: number;
  /** Metres in the aircraft's frame: +x starboard, -z ahead of the nose. */
  readonly x: number;
  readonly z: number;
  /** Facing, radians; 0 looks along the deck run, Math.PI looks back at the aircraft. */
  readonly yaw: number;
}

const YELLOW = 0xc8a63c;
const BLUE = 0x3f5f86;
const RED = 0x8f3b33;
const GREEN = 0x4e6b44;
const PURPLE = 0x5d4570;
const BROWN = 0x6d5a3f;
const WHITE = 0xb9bcb4;

const STATIONS: readonly IStation[] = [
  // The launch spot itself.
  { job: "plane director", rig: "director", clip: "gesture", band: YELLOW, x: -4.6, z: -7.2, yaw: Math.PI },
  { job: "chockman, port main", rig: "crew", clip: "crew.chock", band: BLUE, x: -2.6, z: -0.2, yaw: 1.9 },
  { job: "chockman, starboard main", rig: "crew", clip: "crew.chock", band: BLUE, x: 2.6, z: -0.2, yaw: -1.9 },
  { job: "plane captain, engine", rig: "crew", clip: "crew.service", band: BROWN, x: -1.9, z: -3.7, yaw: 1.3 },
  { job: "ordnanceman, bomb rack", rig: "crew", clip: "crew.service", band: RED, x: 2.5, z: 0.9, yaw: -1.2 },
  // Standing clear of the launch path.
  { job: "fuel detail", rig: "crew", clip: "crew.wait", band: PURPLE, x: -8.4, z: 4.6, yaw: 2.5 },
  { job: "arresting-gear crew", rig: "crew", clip: "crew.wait", band: GREEN, x: 8.8, z: 9.4, yaw: -2.4 },
  // The talker stands at his phone box: idle, never the walk cycle in place.
  { job: "deck talker", rig: "crew", clip: "crew.idle", band: WHITE, x: -10.2, z: -9.5, yaw: 0.25 },
  { job: "safety observer", rig: "crew", clip: "crew.idle", band: WHITE, x: 10.1, z: -6.2, yaw: -1.6 },
  { job: "handler, forward park", rig: "crew", clip: "crew.idle", band: BLUE, x: -6.8, z: 13.4, yaw: 2.9 },
  { job: "handler, respot", rig: "director", clip: "gesture", band: YELLOW, x: 5.4, z: 15.8, yaw: 3.5 },
  // The pilot walks his aircraft, then boards it when the deck run starts.
  { job: "pilot, walkaround", rig: "pilot", clip: "idle", band: BROWN, x: -3.2, z: -2.9, yaw: 1.4 },
];

/**
 * Where the five men working the aircraft stand once the deck run starts, as an offset from
 * their station in the aircraft's frame: sideways to the deck edge, out from under the wings.
 * The rest of the party already stands clear of the launch path and holds its station.
 */
const CLEAR_OFFSET: Readonly<Record<number, readonly [number, number]>> = {
  0: [-4.6, 1.2],
  1: [-6.2, 1.0],
  2: [6.2, 1.0],
  3: [-6.5, 0.7],
  4: [6.3, 1.1],
};

/** Where the pilot stands to board: at the cockpit side, in the aircraft's frame. */
const PILOT_BOARD: readonly [number, number] = [-1.4, -2.5];
/** Close enough to climb in: the pilot hides past this distance from the board point. */
const BOARD_RADIUS = 0.4;

/** Walk speed fallback, m/s, until a sailor's own stride report arrives. */
const FALLBACK_WALK_SPEED = 1.4;
/** The launch hustle: clearing men move and animate this much faster than a walk. */
const CLEAR_URGENCY = 1.35;

/** Baked rig heights, set by the rigging pipeline and asserted by check-fleet / check-asset-polish. */
const RIG_HEIGHT: Readonly<Record<Rig, number>> = { crew: 1.83, director: 1.8, pilot: 1.78 };

const WALK_CLIP: Readonly<Record<Rig, string>> = { crew: "crew.walk", director: "walk", pilot: "walk" };

const sources: Record<Rig, GLTF | undefined> = { crew: undefined, director: undefined, pilot: undefined };
let bandRing: T.TorusGeometry | undefined;

export async function loadDeckCrew(ctx: Pick<ICtx, "assets" | "renderer">): Promise<void> {
  const [crew, director, pilot] = await Promise.all([
    ctx.assets.model<GLTF>("deck-crew.glb"),
    ctx.assets.model<GLTF>("flight-deck-director.glb"),
    ctx.assets.model<GLTF>("carrier-aircraft-pilot.glb"),
  ]);
  sources.crew = crew;
  sources.director = director;
  sources.pilot = pilot;
  const anisotropy = (ctx.renderer.raw as WebGPURenderer).getMaxAnisotropy();
  for (const source of [crew, director, pilot]) {
    source.scene.traverse((node) => {
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
  }
}

/**
 * The trade colour, as a cloth band around the sailor's own white cap.
 *
 * The mesh already wears period headgear, so a helmet shell on top of it read as two hats with the
 * cap poking out above and the shell across the eyes. A band leaves the head as modelled and still
 * marks the trade. The rebuilt original cap is about 0.208m across at 1.762m above the soles.
 */
function makeCapBand(colour: number): T.Mesh {
  bandRing ??= new T.TorusGeometry(0.103, 0.005, 6, 32);
  const band = new T.Mesh(bandRing, mat(colour, { roughness: 0.88, metalness: 0.02 }));
  band.rotation.x = -Math.PI / 2;
  band.castShadow = true;
  return band;
}

interface ISailor {
  readonly station: IStation;
  readonly player: SkeletalMesh3D;
  readonly rate: number;
  readonly walkClip: string;
  /** duty: working the station; walking: travelling on the walk cycle. */
  mode: "duty" | "walking";
  /** m/s the walk clip covers at rate 1, read off the sailor's own stride report. */
  walkSpeed: number;
  /** Duty-clip time saved when called away, restored on return so phases never resync. */
  dutyTime: number;
}

export class DeckCrew {
  readonly group = new T.Group();
  /** Public so a capture run can prove the party is not twelve men moving as one. */
  readonly sailors: ISailor[] = [];
  private readonly base: T.Vector3[] = [];

  constructor() {
    if (!sources.crew || !sources.director || !sources.pilot)
      throw new Error("Load the deck crew before constructing the flight-deck party.");
    const loaded: Record<Rig, GLTF> = { crew: sources.crew, director: sources.director, pilot: sources.pilot };
    this.group.name = "Flight-deck party";
    for (const [index, station] of STATIONS.entries()) {
      const source = loaded[station.rig];
      const player = new SkeletalMesh3D({
        source: source.scene,
        clips: source.animations,
        requiredClips: station.rig === "crew" ? CLIPS : HERO_CLIPS,
        // No `size` here. Skin-aware normalisation measures to the crown *bone*, which stops in
        // the middle of the skull, so asking for 1.74m produced a 2.03m sailor. The rig is baked
        // to a known height instead, and scaled from it.
        strideSync: false,
      });
      // Men are not issued in one size; vary height a little so the party does not read as a row
      // of copies. The source height is a pipeline constant, asserted by tools/check-fleet.mjs.
      player.root.scale.setScalar((1.72 + ((index * 7) % 5) * 0.025) / RIG_HEIGHT[station.rig]);
      player.root.position.set(station.x, 0, station.z);
      player.root.rotation.y = station.yaw;
      player.root.userData.rig = station.rig;
      player.root.traverse((node) => {
        if (node instanceof T.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      this.base.push(player.root.position.clone());
      if (station.rig === "crew") this.attachCapBand(player.root, station.band);
      player.play(station.clip);
      // Two men on the same clip must never move as one. Phase comes from the action's start
      // time; rate is applied to the sailor's own `dt` in update() rather than to the action,
      // because AnimationPlayer's stride pass rewrites an in-place clip's timeScale back to 1 on
      // every frame even when strideSync is off, and patching around the engine is not our call.
      const clip = player.clip(station.clip);
      const rate = 0.86 + ((index * 11) % 7) * 0.043;
      player.mixer.clipAction(clip).time = clip.duration * (((index * 5) % 12) / 12);
      this.group.add(player.root);
      this.sailors.push({ station, player, rate, walkClip: WALK_CLIP[station.rig], mode: "duty", walkSpeed: 0, dutyTime: 0 });
    }
  }

  /** Ride the head bone, so a kneeling or crouching man keeps his band on. */
  private attachCapBand(root: T.Object3D, colour: number): void {
    root.updateMatrixWorld(true);
    const head = root.getObjectByName("Head");
    if (!head) throw new Error("The deck-crew rig is missing its Head bone.");
    const band = makeCapBand(colour);
    // The rig carries the normalising scale, so undo it before adding metre-authored geometry.
    const scale = head.getWorldScale(new T.Vector3()).x || 1;
    band.scale.setScalar(1 / scale);
    // Local coordinates of the rebuilt cap's 1.762m cross-section; the old band's radius floated
    // beyond this source mesh. Keep the thin trade marking on the cap cloth.
    band.position.set(0, 0.1935 / scale, 0.0155 / scale);
    head.add(band);
  }

  /**
   * Advance the party's clips, walking the men around the aircraft out to the deck edge while
   * `clearTarget` is 1 (the deck run) and back to their stations when it returns to 0.
   *
   * Called-away men travel on the walk cycle at the speed their own stride report measures, so
   * feet match ground — never the old eased slide on a working clip. The pilot instead walks to
   * the cockpit side and boards (hides) until the deck is safe again.
   */
  update(dt: number, clearTarget = 0): void {
    const clearing = clearTarget === 1;
    for (const [index, sailor] of this.sailors.entries()) {
      const walking = sailor.mode === "walking";
      const urgency = clearing && walking ? CLEAR_URGENCY : 1;
      sailor.player.update(dt * sailor.rate * urgency);
      if (walking && sailor.walkSpeed <= 0) {
        const measured = sailor.player.stride.clipGroundSpeed;
        if (measured > 0.05) sailor.walkSpeed = measured;
      }
      const root = sailor.player.root;
      const home = this.base[index];
      const isPilot = sailor.station.rig === "pilot";
      let target: readonly [number, number] | null = null;
      if (isPilot) target = clearing ? PILOT_BOARD : [home.x, home.z];
      else {
        const offset = CLEAR_OFFSET[index];
        if (offset) target = clearing ? [home.x + offset[0], home.z + offset[1]] : [home.x, home.z];
      }
      // Stationary hands hold their duty clip; only the called-away travel.
      if (!target) continue;
      if (isPilot && !clearing) root.visible = true;
      if (!root.visible) continue;
      const dx = target[0] - root.position.x;
      const dz = target[1] - root.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.06) {
        if (!walking) {
          sailor.dutyTime = sailor.player.mixer.clipAction(sailor.player.clip(sailor.station.clip)).time;
          sailor.player.play(sailor.walkClip, { fade: 0.25 });
          sailor.mode = "walking";
        }
        // The chockmen's station yaws fit facing +Z at atan2(dx, dz); walk the same way.
        root.rotation.y = Math.atan2(dx, dz);
        const speed = (sailor.walkSpeed > 0 ? sailor.walkSpeed : FALLBACK_WALK_SPEED) * sailor.rate * (clearing ? CLEAR_URGENCY : 1);
        const step = Math.min(dist, Math.max(0, speed * dt));
        root.position.x += (dx / dist) * step;
        root.position.z += (dz / dist) * step;
      } else if (walking) {
        sailor.player.play(sailor.station.clip, { fade: 0.25 });
        sailor.player.mixer.clipAction(sailor.player.clip(sailor.station.clip)).time = sailor.dutyTime;
        root.rotation.y = sailor.station.yaw;
        sailor.mode = "duty";
        if (isPilot && clearing) root.visible = false;
      }
    }
  }

  dispose(): void {
    for (const sailor of this.sailors) sailor.player.dispose();
    this.sailors.length = 0;
    this.group.clear();
  }
}
