/** Supplied and imported carrier hulls: metres, bow -Z. Their decks are measured in src/sim/battle.ts. */
import type { ICtx } from "@threenative/core";
import * as T from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { shipClass, UnknownShipClassError } from "../sim/catalog.js";
import {
  applyAnisotropy,
  createHammann,
  createHiryu,
  createI168,
  createKaga,
  createKageroDestroyer,
  createMogamiCruiser,
  createNautilus,
  createSoryu,
  createToneCruiser,
  ModelPendingError,
} from "./imported-fleet.js";

let hornet: GLTF;
let mitchell: GLTF;
let akagi: GLTF;

export async function loadImportedShips(ctx: Pick<ICtx, "assets" | "renderer">): Promise<void> {
  [hornet, mitchell] = await Promise.all([
    ctx.assets.model<GLTF>("hornet.glb"),
    ctx.assets.model<GLTF>("b25-mitchell.glb"),
  ]);
  applyAnisotropy(ctx, [hornet, mitchell]);
}

/** Akagi sails with the Japanese fleet, so she loads after the reveal with it. */
export async function loadAkagi(ctx: Pick<ICtx, "assets" | "renderer">): Promise<void> {
  akagi = await ctx.assets.model<GLTF>("akagi.glb");
  applyAnisotropy(ctx, [akagi]);
}

function cloneModel(source: GLTF | undefined): T.Group {
  if (!source) throw new ModelPendingError("An imported ship has not loaded yet.");
  // Static hierarchy clones share geometry, materials and textures owned by ctx.assets.
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
 * The Japanese carriers, at the size each ship actually measured.
 *
 * All four now have their own hull: Akagi was supplied with the project, and Kaga, Soryu and Hiryu
 * were imported from their own models, so nothing here stands in for anything. Akagi keeps its
 * literal because it is the supplied model and has no class record; the other three read their
 * length and beam from src/sim/catalog.ts rather than restating it.
 */
const ijnCarrier = (classId: string) => {
  const cls = shipClass(classId);
  return { length: cls.hullLength, beam: cls.hullBeam };
};

export const IJN_CARRIERS: Record<string, { length: number; beam: number }> = {
  Akagi: { length: 260.67, beam: 31.3 },
  Kaga: ijnCarrier("kaga"),
  Soryu: ijnCarrier("soryu"),
  Hiryu: ijnCarrier("hiryu"),
};

/** One supplied hull, cloned and named. */
function supplied(source: GLTF | undefined, name: string): T.Group {
  const model = cloneModel(source);
  model.name = name;
  model.userData.importedShip = true;
  return model;
}

/**
 * The seven carrier models, by id. There is no deck table here any more: the corridor, the deck
 * datum and the deck plan are one measurement, they live on the ship record that `Battle` resolves
 * through `shipGeometry` before any mesh exists, and src/render/world.ts reads them from there. This
 * file used to carry a second copy of all three, with a comment in each file saying they had to stay
 * equal — which is how a measurement drifts.
 */
const CARRIER_MODELS = {
  // The supplied Hornet contains the detailed Enterprise-1944 hull. Use that WWII
  // sister-ship geometry for CV-6; the CVN-80's single 1K atlas fails close deck views.
  enterprise: () => supplied(hornet, "USS Enterprise"),
  hornet: () => supplied(hornet, "USS Hornet"),
  akagi: () => supplied(akagi, "IJN Akagi"),
  kaga: createKaga,
  soryu: createSoryu,
  hiryu: createHiryu,
  // CV-5 is drawn from the same sister-ship hull as CV-6 and CV-8, and for the same reason: all
  // three were Yorktown class. The imported `carrier.yorktown.glb` is measured correctly — length
  // within 0.05%, keel on the datum — but it is not a carrier above the deck. Its superstructure is
  // a 16 m wide block standing symmetrically on the centreline for 80 m of the deck and rising 27 m
  // above it (measured in Blender: mean X of every above-deck slice within 0.3 m of zero), which is
  // a battleship arrangement, not an island. It leaves no clear corridor on either side — `clear
  // 0|0` for 95 m in `tools/measure-decks.mjs` — so an aircraft rolling down that deck flies through
  // it. `hornet.glb`'s above-deck mass sits at mean X +12 to +15, entirely to starboard, where a
  // Yorktown-class island belongs. The file stays in the repository and in `docs/asset-provenance.md`
  // as the measured source it is; it is simply not what CV-5 is drawn from.
  yorktown: () => supplied(hornet, "USS Yorktown"),
} as const;

/** One of the seven carriers this game draws. */
export type CarrierModelId = keyof typeof CARRIER_MODELS;

/** An IJN carrier by ship name. Anything but the four named ships falls back to the Akagi hull. */
export function createIjnCarrier(name: string): T.Group {
  const own = { Kaga: createKaga, Soryu: createSoryu, Hiryu: createHiryu }[name];
  return own ? own() : supplied(akagi, `IJN ${name}`);
}

export function createCarrier(id: CarrierModelId): T.Group {
  return CARRIER_MODELS[id]();
}

/**
 * The one place a catalog classId becomes a model. Where a class covered more than one ship at
 * Midway the creator takes a name, and this dispatch passes the lead ship: a caller that knows it
 * is building Chikuma, Mikuma or Nowaki should call that class's creator with the real name.
 */
const SHIP_MODELS: Record<string, () => T.Group> = {
  kaga: createKaga,
  soryu: createSoryu,
  hiryu: createHiryu,
  tone: () => createToneCruiser("Tone"),
  mogami: () => createMogamiCruiser("Mogami"),
  kagero: () => createKageroDestroyer("Kagero"),
  hammann: createHammann,
  i168: createI168,
  nautilus: createNautilus,
};

export function shipModelFor(classId: string): T.Group {
  const create = SHIP_MODELS[classId];
  if (!create) throw new UnknownShipClassError(classId);
  return create();
}

/** One B-25 detached from the nine identical aircraft on Hornet; original detail retained. */
export function createMitchell(): T.Group {
  const model = cloneModel(mitchell);
  model.name = "B-25 Mitchell";
  model.position.y = -new T.Box3().setFromObject(model).min.y;
  model.userData.importedAircraft = true;
  return model;
}
