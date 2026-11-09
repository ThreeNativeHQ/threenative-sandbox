/**
 * Imported aircraft, escorts and geography that were supplied with the project but never wired in.
 *
 * Every model here is measured, not guessed: orientation and scale come from Blender renders and
 * per-node world bounds (tools/probe-glb.mjs, tools/blender/preview.py), and each constant below
 * records what was measured. The game's convention is metres, nose and bow along -Z.
 */
import type { ICtx } from "@threenative/core";
import * as T from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import type { WebGPURenderer } from "three/webgpu";
import { cylinder, mat, rod } from "./assets.js";

/** Measured A6M3 wingspan in the supplied file; the real aircraft spans 11.0m, so it ships to scale. */
const ZERO_SPAN = 11.13;

/**
 * Samidare is a Shiratsuyu-class destroyer. Arashi and Nowaki were Kagero-class, so this is a
 * class substitution, not those ships: a comparable IJN destroyer silhouette at the ranges the
 * player ever sees one. The supplied hull measures 143.92m bow to stern and its bow is +X.
 */
const SAMIDARE_HULL = 143.92;
const SAMIDARE_LENGTH = 111;
/** The model floats about a metre and a half high; measured against its own boot topping. */
const SAMIDARE_DRAUGHT = -1.35;

/**
 * The supplied atoll is a flat photogrammetry disc two units across, with Midway's islands,
 * lagoon and 1942 runways in its texture rather than its geometry. Nothing in the file states a
 * metre scale, so the horizontal scale is set from the real barrier reef, about 8km across, and
 * the vertical is set separately so Sand Island's high dune lands near its real 12m rather than
 * the 200m a uniform scale would give. The disc is then sunk until the painted lagoon sits level
 * with the sea and only the islands stand proud.
 */
const ATOLL_WIDTH = 8000;
const ATOLL_RELIEF = 12;
/**
 * Sea-level datum for the disc. Sunk far (-3) the whole reef went under and Midway read as two
 * unrelated islands in open ocean; at the surface it fought the ocean plane. It now sits at zero
 * and everything genuinely below the waterline is trimmed away instead, so the reef ring shows
 * as the shallow shelf it is and nothing is drawn where the sea already covers it.
 */
const ATOLL_DATUM = 0;

let zero: GLTF;
let samidare: GLTF;
let atoll: GLTF;
let garrison: GLTF;
let radar: GLTF;

/** Give every texture the renderer's full anisotropy; grazing deck and sea views need it. */
export function applyAnisotropy(
  ctx: Pick<ICtx, "renderer">,
  sources: readonly GLTF[],
): void {
  const anisotropy = (ctx.renderer.raw as WebGPURenderer).getMaxAnisotropy();
  for (const source of sources) {
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

export async function loadImportedFleet(ctx: Pick<ICtx, "assets" | "renderer">): Promise<void> {
  [zero, samidare, atoll, garrison, radar] = await Promise.all([
    ctx.assets.model<GLTF>("aircraft.mitsubishi-a6m3.glb"),
    ctx.assets.model<GLTF>("destroyer.samidare.glb"),
    ctx.assets.model<GLTF>("midway-atoll.glb"),
    ctx.assets.model<GLTF>("structures.garrison-camp.glb"),
    ctx.assets.model<GLTF>("structures.radar-station.glb"),
  ]);
  applyAnisotropy(ctx, [zero, samidare, atoll, garrison, radar]);
}

function clone(source: GLTF | undefined, what: string): T.Group {
  if (!source) throw new Error(`Load the imported fleet before constructing ${what}.`);
  // Static hierarchies share geometry, materials and textures owned by ctx.assets.
  const model = source.scene.clone(true);
  model.traverse((node) => {
    if (node instanceof T.Mesh) {
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  return model;
}

/**
 * A Mitsubishi A6M3. Supplies the prop, gear and stores handles the world view animates on every
 * aircraft, so an imported Zero drops straight into the generic aircraft path.
 */
export function createZero(): T.Group {
  const root = new T.Group();
  root.name = "Mitsubishi A6M3";
  const model = clone(zero, "the Zero");
  const span = new T.Box3().setFromObject(model).getSize(new T.Vector3()).x;
  if (!Number.isFinite(span) || span <= 0) throw new Error("The Zero has no measurable wingspan.");
  model.scale.multiplyScalar(ZERO_SPAN / span);
  root.add(model);

  // `flight.cruise` turns this pivot; the world view spins it directly, like every other aircraft.
  const prop = model.getObjectByName("VINTThreeNativePivot");
  if (!prop) throw new Error("The Zero is missing its propeller pivot.");

  // The supplied model is clean in flight, with no undercarriage. The A6M retracted its mains
  // inboard into the wing centre section and had a retractable tailwheel.
  const metal = mat(0x7c8481, { metalness: 0.72, roughness: 0.34 });
  const tyre = mat(0x23282a, { roughness: 0.82, metalness: 0.04 });
  const gear = new T.Group();
  for (const x of [-1.65, 1.65]) {
    rod(gear, [x, -0.32, -0.55], [x * 1.04, -1.42, -0.62], 0.072, metal);
    const wheel = cylinder(gear, 0.32, 0.32, 0.2, x * 1.04, -1.55, -0.62, tyre, 14);
    wheel.rotation.z = Math.PI / 2;
    const hub = cylinder(gear, 0.13, 0.13, 0.22, x * 1.04, -1.55, -0.62, metal, 10);
    hub.rotation.z = Math.PI / 2;
  }
  const tail = cylinder(gear, 0.13, 0.13, 0.1, 0, -0.78, 3.62, tyre, 10);
  tail.rotation.z = Math.PI / 2;
  rod(gear, [0, -0.3, 3.62], [0, -0.72, 3.62], 0.045, metal);
  gear.traverse((node) => {
    if (node instanceof T.Mesh) node.castShadow = true;
  });
  root.add(gear);

  // A fighter carries no bombs in this battle, but the world view always toggles a stores group.
  const load = new T.Group();
  root.add(load);
  // The airframe's geometry is shared with every other Zero; only the gear was built for this one.
  root.userData = { prop, gear, load, owned: [gear], importedAircraft: true, airframe: "zero" };
  return root;
}

/** An IJN destroyer, bow -Z, scaled to a real hull length. */
export function createSamidare(): T.Group {
  const root = new T.Group();
  root.name = "IJN destroyer";
  const model = clone(samidare, "the destroyer");
  model.scale.multiplyScalar(SAMIDARE_LENGTH / SAMIDARE_HULL);
  // The supplied hull runs bow-first along +X; the game sails every ship bow-first along -Z.
  model.rotation.y = Math.PI / 2;
  model.position.y = SAMIDARE_DRAUGHT;
  root.add(model);
  root.userData.importedShip = true;
  return root;
}

/**
 * Drop every triangle that lies wholly under the sea.
 *
 * The atoll is a nearly flat disc, so its submerged reef and lagoon floor sit within a metre of
 * the ocean plane over a wide area and the two surfaces interleave — the jagged cyan and white
 * speckle that made Midway look broken from the air. There is nothing to be gained by drawing
 * geometry the opaque ocean covers anyway, so it is removed and the fight goes with it. The
 * shoreline band is kept: a triangle that breaks the surface at any corner still draws.
 */
function trimBelowSea(model: T.Object3D, cutWorldY: number, scaleY: number, offsetY: number): void {
  const cut = (cutWorldY - offsetY) / scaleY;
  model.traverse((node) => {
    if (!(node instanceof T.Mesh)) return;
    const geometry = node.geometry as T.BufferGeometry;
    const position = geometry.getAttribute("position");
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    const at = (i: number) => (index ? index.getX(i) : i);
    const kept: number[] = [];
    for (let i = 0; i < count; i += 3) {
      const a = at(i);
      const b = at(i + 1);
      const c = at(i + 2);
      if (Math.max(position.getY(a), position.getY(b), position.getY(c)) > cut)
        kept.push(a, b, c);
    }
    geometry.setIndex(kept);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
  });
}

/**
 * Midway Atoll, with the garrison and the radar mast standing on Eastern Island, whose triangle
 * of 1942 runways is already in the atoll's own texture.
 */
export function createMidwayAtoll(): T.Group {
  const root = new T.Group();
  root.name = "Midway Atoll";
  // There is one Midway, so this instance owns its geometry outright and may reshape it.
  const model = clone(atoll, "Midway Atoll");
  const size = new T.Box3().setFromObject(model).getSize(new T.Vector3());
  const horizontal = ATOLL_WIDTH / size.x;
  const vertical = ATOLL_RELIEF / (size.y / 2);
  model.scale.set(horizontal, vertical, horizontal);
  model.position.y = ATOLL_DATUM;
  // Clone before reshaping: the loader's geometry is shared and must survive a scene restart.
  model.traverse((child) => {
    if (child instanceof T.Mesh) child.geometry = child.geometry.clone();
  });
  trimBelowSea(model, 0.35, vertical, ATOLL_DATUM);
  root.add(model);

  // Eastern Island's centre, read off the top-down render in model units and carried to metres.
  const eastern = new T.Vector3(0.36 * ATOLL_WIDTH, 0, -0.05 * ATOLL_WIDTH);
  const camp = clone(garrison, "the garrison camp");
  camp.position.set(eastern.x - 210, 4, eastern.z + 190);
  camp.rotation.y = 0.42;
  camp.scale.setScalar(1.6);
  root.add(camp);
  const mast = clone(radar, "the radar station");
  mast.position.set(eastern.x + 260, 4, eastern.z - 240);
  mast.rotation.y = -0.8;
  mast.scale.setScalar(1.4);
  root.add(mast);
  return root;
}

/**
 * The hulls imported by tools/import-fleet.sh from the table in tools/blender/fleet.json.
 *
 * The importer bakes the contract into the bytes — metres, bow along -Z, keel on y = 0, one mesh,
 * one material — and tools/check-catalog.mjs re-reads every one of those numbers out of the shipped
 * GLB on each run. So nothing below scales, rotates or sinks a hull: a creator clones what shipped
 * and names it. The sizes these models answer to live in src/sim/catalog.ts, never here.
 *
 * cruiser.mogami is the one derived model. The supplied Mogami GLB was byte-identical to the Tone,
 * so tools/blender/derive-mogami.py moved the after pair of Tone's forward turrets onto the
 * quarterdeck; it is the only Mogami geometry that exists.
 */
const HULL_URLS = {
  "carrier.kaga": "carrier.kaga.glb",
  "carrier.soryu": "carrier.soryu.glb",
  "carrier.hiryu": "carrier.hiryu.glb",
  "carrier.yorktown": "carrier.yorktown.glb",
  "cruiser.tone": "cruiser.tone.glb",
  "cruiser.mogami": "cruiser.mogami.glb",
  "destroyer.kagero": "destroyer.kagero.glb",
  "destroyer.hammann": "destroyer.hammann.glb",
  "submarine.i168": "submarine.i168.glb",
  "submarine.nautilus": "submarine.nautilus.glb",
  "weapon.torpedo": "weapon.torpedo.glb",
} as const;

type HullId = keyof typeof HULL_URLS;

const hulls = new Map<HullId, GLTF>();

/**
 * Load every imported hull. Idempotent: ctx.assets owns the cache, so a second call re-reads the
 * same models it already handed out and leaves the same state behind.
 */
export async function loadImportedHulls(ctx: Pick<ICtx, "assets" | "renderer">): Promise<void> {
  const ids = Object.keys(HULL_URLS) as HullId[];
  const loaded = await Promise.all(ids.map((id) => ctx.assets.model<GLTF>(HULL_URLS[id])));
  ids.forEach((id, i) => hulls.set(id, loaded[i]));
  applyAnisotropy(ctx, loaded);
}

/** One imported hull, at the size it shipped. */
function hull(id: HullId, name: string, mark = "importedShip"): T.Group {
  const model = clone(hulls.get(id), name);
  model.name = name;
  model.userData[mark] = true;
  return model;
}

export function createKaga(): T.Group {
  return hull("carrier.kaga", "IJN Kaga");
}

export function createSoryu(): T.Group {
  return hull("carrier.soryu", "IJN Soryu");
}

export function createHiryu(): T.Group {
  return hull("carrier.hiryu", "IJN Hiryu");
}

export function createYorktown(): T.Group {
  return hull("carrier.yorktown", "USS Yorktown");
}

/** Tone or Chikuma; the class's two ships were near-identical at Midway. */
export function createToneCruiser(name: string): T.Group {
  return hull("cruiser.tone", `IJN ${name}`);
}

/** Mogami or Mikuma, on the derived Mogami hull. */
export function createMogamiCruiser(name: string): T.Group {
  return hull("cruiser.mogami", `IJN ${name}`);
}

/** Arashi or Nowaki, both Kagero class. */
export function createKageroDestroyer(name: string): T.Group {
  return hull("destroyer.kagero", `IJN ${name}`);
}

export function createHammann(): T.Group {
  return hull("destroyer.hammann", "USS Hammann");
}

export function createI168(): T.Group {
  return hull("submarine.i168", "IJN I-168");
}

export function createNautilus(): T.Group {
  return hull("submarine.nautilus", "USS Nautilus");
}

/** The Mark 13 body a Devastator drops; a weapon, not a ship. */
export function createTorpedoBody(): T.Group {
  return hull("weapon.torpedo", "Mark 13 torpedo", "importedWeapon");
}
