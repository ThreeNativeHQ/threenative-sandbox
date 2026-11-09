/**
 * Numeric model identity for the imported fleet. This is the one game-owned place where a shipped
 * GLB's measured size enters the simulation: `Battle.setupFleet` reads it before any render code
 * builds a mesh, so world dimensions never depend on a render-time bounding box. Pure data and
 * lookups only — no Three.js, no DOM, no other module, no runtime asset registry.
 */

export interface ShipClass {
  classId: string;
  displayName: string;
  /** Filename stem under /assets; also the `id` column of tools/blender/fleet.json. */
  modelId: string;
  /** m; class length reference, tools/blender/fleet.json. */
  hullLength: number;
  /** m; class waterline beam reference, tools/blender/fleet.json. */
  hullBeam: number;
  /** m; class draught reference, tools/blender/fleet.json. */
  draught: number;
  /** m; keel to masthead reference, tools/blender/fleet.json. */
  mastHeight: number;
  /** m; Z extent of the shipped GLB, tools/inspect-glb.mjs. */
  measuredLength: number;
  /** m; X extent of the shipped GLB, tools/inspect-glb.mjs. */
  measuredBeam: number;
  /** m; Y extent of the shipped GLB, tools/inspect-glb.mjs. */
  measuredHeight: number;
  /** count; tools/inspect-glb.mjs on the shipped GLB. */
  triangles: number;
  /** Supplied source file under the models directory. */
  source: string;
  /** One sentence naming the declared beam and height repair factors. */
  repair: string;
}

export const SHIP_CLASSES: Readonly<Record<string, ShipClass>> = Object.freeze({
  kaga: {
    classId: "kaga",
    displayName: "Kaga class",
    modelId: "carrier.kaga",
    hullLength: 247.65, // m; Kaga length reference, tools/blender/fleet.json
    hullBeam: 32.5, // m; Kaga waterline beam reference, tools/blender/fleet.json
    draught: 7.5, // m; Kaga draught reference, tools/blender/fleet.json
    mastHeight: 46.8, // m; Kaga keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 247.65, // m; Z extent of assets/carrier.kaga.glb, tools/inspect-glb.mjs
    measuredBeam: 53.93, // m; X extent of assets/carrier.kaga.glb, tools/inspect-glb.mjs
    measuredHeight: 46.80, // m; Y extent of assets/carrier.kaga.glb, tools/inspect-glb.mjs
    triangles: 45683, // count; assets/carrier.kaga.glb, tools/inspect-glb.mjs
    source: "carriers/japan-kaga.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.60 (32.50 m reference against the 53.93 m X extent); declared height repair x1.00 (46.80 m either side).",
  },
  soryu: {
    classId: "soryu",
    displayName: "Soryu class",
    modelId: "carrier.soryu",
    hullLength: 227.5, // m; Soryu length reference, tools/blender/fleet.json
    hullBeam: 21.3, // m; Soryu waterline beam reference, tools/blender/fleet.json
    draught: 7.6, // m; Soryu draught reference, tools/blender/fleet.json
    mastHeight: 40.0, // m; Soryu keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 227.50, // m; Z extent of assets/carrier.soryu.glb, tools/inspect-glb.mjs
    measuredBeam: 36.35, // m; X extent of assets/carrier.soryu.glb, tools/inspect-glb.mjs
    measuredHeight: 40.00, // m; Y extent of assets/carrier.soryu.glb, tools/inspect-glb.mjs
    triangles: 23605, // count; assets/carrier.soryu.glb, tools/inspect-glb.mjs
    source: "carriers/japan-soryu.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.59 (21.30 m reference against the 36.35 m X extent); declared height repair x1.00 (40.00 m either side).",
  },
  hiryu: {
    classId: "hiryu",
    displayName: "Hiryu class",
    modelId: "carrier.hiryu",
    hullLength: 227.4, // m; Hiryu length reference, tools/blender/fleet.json
    hullBeam: 22.3, // m; Hiryu waterline beam reference, tools/blender/fleet.json
    draught: 7.8, // m; Hiryu draught reference, tools/blender/fleet.json
    mastHeight: 40.0, // m; Hiryu keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 227.40, // m; Z extent of assets/carrier.hiryu.glb, tools/inspect-glb.mjs
    measuredBeam: 41.47, // m; X extent of assets/carrier.hiryu.glb, tools/inspect-glb.mjs
    measuredHeight: 40.00, // m; Y extent of assets/carrier.hiryu.glb, tools/inspect-glb.mjs
    triangles: 23421, // count; assets/carrier.hiryu.glb, tools/inspect-glb.mjs
    source: "carriers/japan-kyriu.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.54 (22.30 m reference against the 41.47 m X extent); declared height repair x1.00 (40.00 m either side).",
  },
  yorktown: {
    classId: "yorktown",
    displayName: "Yorktown class",
    modelId: "carrier.yorktown",
    hullLength: 246.74, // m; Yorktown CV-5 DANFS length reference, tools/blender/fleet.json
    hullBeam: 25.4, // m; Yorktown waterline beam reference, tools/blender/fleet.json
    draught: 7.9, // m; Yorktown draught reference, tools/blender/fleet.json
    mastHeight: 48.0, // m; Yorktown keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 246.79, // m; Z extent of assets/carrier.yorktown.glb, tools/inspect-glb.mjs
    measuredBeam: 32.79, // m; X extent of assets/carrier.yorktown.glb, tools/inspect-glb.mjs
    measuredHeight: 48.02, // m; Y extent of assets/carrier.yorktown.glb, tools/inspect-glb.mjs
    triangles: 199999, // count; assets/carrier.yorktown.glb, tools/inspect-glb.mjs
    source: "carriers/uss-yorktown.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.77 (25.40 m reference against the 32.79 m X extent); declared height repair x1.00 (48.00 m declared against 48.02 m measured).",
  },
  tone: {
    classId: "tone",
    displayName: "Tone class",
    modelId: "cruiser.tone",
    hullLength: 201.6, // m; Tone length reference, tools/blender/fleet.json
    hullBeam: 19.4, // m; Tone waterline beam reference, tools/blender/fleet.json
    draught: 6.5, // m; Tone draught reference, tools/blender/fleet.json
    mastHeight: 38.0, // m; Tone keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 201.60, // m; Z extent of assets/cruiser.tone.glb, tools/inspect-glb.mjs
    measuredBeam: 22.13, // m; X extent of assets/cruiser.tone.glb, tools/inspect-glb.mjs
    measuredHeight: 38.00, // m; Y extent of assets/cruiser.tone.glb, tools/inspect-glb.mjs
    triangles: 47991, // count; assets/cruiser.tone.glb, tools/inspect-glb.mjs
    source: "cruiser/tone-class-cruiser.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.88 (19.40 m reference against the 22.13 m X extent); declared height repair x1.00 (38.00 m either side).",
  },
  mogami: {
    classId: "mogami",
    displayName: "Mogami class",
    modelId: "cruiser.mogami",
    hullLength: 201.5, // m; Mogami length reference, tools/blender/fleet.json
    hullBeam: 20.6, // m; Mogami waterline beam reference, tools/blender/fleet.json
    draught: 6.1, // m; Mogami draught reference, tools/blender/fleet.json
    mastHeight: 38.0, // m; shares the Tone hull envelope it was derived from
    measuredLength: 201.60, // m; Z extent of assets/cruiser.mogami.glb, tools/inspect-glb.mjs
    measuredBeam: 22.13, // m; X extent of assets/cruiser.mogami.glb, tools/inspect-glb.mjs
    measuredHeight: 38.00, // m; Y extent of assets/cruiser.mogami.glb, tools/inspect-glb.mjs
    triangles: 51311, // count; assets/cruiser.mogami.glb, tools/inspect-glb.mjs
    source: "cruiser/tone-class-cruiser.glb", // the supplied mogami GLB is byte-identical to this
    repair: "Derived, not supplied: the supplied Mogami GLB is byte-identical to the Tone GLB and the geometry is a Tone. tools/blender/derive-mogami.py copies the after pair of forward turrets, mirrors them to face aft and sets them on the quarterdeck, so the class reads as a Mogami rather than a second Tone. Hull repairs are inherited from cruiser.tone.",
  },
  kagero: {
    classId: "kagero",
    displayName: "Kagero class",
    modelId: "destroyer.kagero",
    hullLength: 118.5, // m; Kagero length reference, tools/blender/fleet.json
    hullBeam: 10.8, // m; Kagero waterline beam reference, tools/blender/fleet.json
    draught: 3.8, // m; Kagero draught reference, tools/blender/fleet.json
    mastHeight: 28.0, // m; Kagero keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 118.50, // m; Z extent of assets/destroyer.kagero.glb, tools/inspect-glb.mjs
    measuredBeam: 12.43, // m; X extent of assets/destroyer.kagero.glb, tools/inspect-glb.mjs
    measuredHeight: 28.00, // m; Y extent of assets/destroyer.kagero.glb, tools/inspect-glb.mjs
    triangles: 22650, // count; assets/destroyer.kagero.glb, tools/inspect-glb.mjs
    source: "destroyers/japan-mikuma-and-mogami.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.87 (10.80 m reference against the 12.43 m X extent); declared height repair x1.00 (28.00 m either side).",
  },
  hammann: {
    classId: "hammann",
    displayName: "Hammann class",
    modelId: "destroyer.hammann",
    hullLength: 106.17, // m; Hammann DD-412 DANFS length reference, tools/blender/fleet.json
    hullBeam: 11.0, // m; Hammann waterline beam reference, tools/blender/fleet.json
    draught: 3.3, // m; Hammann draught reference, tools/blender/fleet.json
    mastHeight: 28.0, // m; Hammann keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 106.17, // m; Z extent of assets/destroyer.hammann.glb, tools/inspect-glb.mjs
    measuredBeam: 20.14, // m; X extent of assets/destroyer.hammann.glb, tools/inspect-glb.mjs
    measuredHeight: 28.00, // m; Y extent of assets/destroyer.hammann.glb, tools/inspect-glb.mjs
    triangles: 22887, // count; assets/destroyer.hammann.glb, tools/inspect-glb.mjs
    source: "destroyers/uss-harmann.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.55 (11.00 m reference against the 20.14 m X extent); declared height repair x1.00 (28.00 m either side).",
  },
  i168: {
    classId: "i168",
    displayName: "I-168 class",
    modelId: "submarine.i168",
    hullLength: 104.7, // m; I-168 Kaidai KD6A length reference, tools/blender/fleet.json
    hullBeam: 8.2, // m; I-168 waterline beam reference, tools/blender/fleet.json
    draught: 4.6, // m; I-168 draught reference, tools/blender/fleet.json
    mastHeight: 13.5, // m; I-168 keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 104.70, // m; Z extent of assets/submarine.i168.glb, tools/inspect-glb.mjs
    measuredBeam: 9.22, // m; X extent of assets/submarine.i168.glb, tools/inspect-glb.mjs
    measuredHeight: 13.50, // m; Y extent of assets/submarine.i168.glb, tools/inspect-glb.mjs
    triangles: 23243, // count; assets/submarine.i168.glb, tools/inspect-glb.mjs
    source: "submarines/japan-I168-submarine.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.89 (8.20 m reference against the 9.22 m X extent); declared height repair x1.00 (13.50 m either side).",
  },
  nautilus: {
    classId: "nautilus",
    displayName: "Nautilus class",
    modelId: "submarine.nautilus",
    hullLength: 113.08, // m; Nautilus SS-168 DANFS length reference, tools/blender/fleet.json
    hullBeam: 10.13, // m; Nautilus waterline beam reference, tools/blender/fleet.json
    draught: 4.9, // m; Nautilus draught reference, tools/blender/fleet.json
    mastHeight: 15.0, // m; Nautilus keel-to-masthead reference, tools/blender/fleet.json
    measuredLength: 113.08, // m; Z extent of assets/submarine.nautilus.glb, tools/inspect-glb.mjs
    measuredBeam: 12.61, // m; X extent of assets/submarine.nautilus.glb, tools/inspect-glb.mjs
    measuredHeight: 15.00, // m; Y extent of assets/submarine.nautilus.glb, tools/inspect-glb.mjs
    triangles: 22967, // count; assets/submarine.nautilus.glb, tools/inspect-glb.mjs
    source: "submarines/uss-nautilus.glb", // supplied model under the source directory
    repair: "Declared beam repair x0.80 (10.13 m reference against the 12.61 m X extent); declared height repair x1.00 (15.00 m either side).",
  },
});

export interface WeaponBody {
  weaponId: string;
  /** Filename stem under /assets; also the `id` column of tools/blender/fleet.json. */
  modelId: string;
  /** m; Mark 13 body length reference, tools/blender/fleet.json. */
  length: number;
  /** m; Mark 13 body diameter reference, tools/blender/fleet.json. */
  diameter: number;
  /** m; Z extent of the shipped GLB, tools/inspect-glb.mjs. */
  measuredLength: number;
  /** m; X extent of the shipped GLB, tools/inspect-glb.mjs. */
  measuredDiameter: number;
  /** count; tools/inspect-glb.mjs on the shipped GLB. */
  triangles: number;
  /** Supplied source file under the models directory. */
  source: string;
}

export const WEAPON_BODIES: Readonly<Record<string, WeaponBody>> = Object.freeze({
  torpedo: {
    weaponId: "torpedo",
    modelId: "weapon.torpedo",
    length: 4.089, // m; Mark 13 aerial torpedo body length reference, tools/blender/fleet.json
    diameter: 0.569, // m; Mark 13 body diameter reference, tools/blender/fleet.json
    measuredLength: 4.09, // m; Z extent of assets/weapon.torpedo.glb, tools/inspect-glb.mjs
    measuredDiameter: 0.642, // m; X extent of assets/weapon.torpedo.glb, tools/inspect-glb.mjs
    triangles: 24856, // count; assets/weapon.torpedo.glb, tools/inspect-glb.mjs
    source: "destroyers/torpedo+3d+model.glb", // supplied model under the source directory
  },
});

/** Named so an unknown id cannot decay into an invisible zero-length hull later. */
export class UnknownShipClassError extends Error {
  constructor(id: string) {
    super(`unknown ship class: ${id}`);
    this.name = "UnknownShipClassError";
  }
}

export function shipClass(classId: string): ShipClass {
  const found = SHIP_CLASSES[classId];
  if (!found) throw new UnknownShipClassError(classId);
  return found;
}

export function modelUrl(modelId: string): string {
  return `${modelId}.glb`;
}
