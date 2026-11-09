/**
 * Catalog/GLB consistency check (PRD-midway-asset-battle-integration AC-2). Proves src/sim/catalog.ts
 * still matches the bytes under assets/: every measured dimension is re-read from the shipped
 * GLB, every keel sits on the waterline datum and every reference length is within 2%. A catalog that
 * has drifted from the shipped models fails here instead of becoming a wrong-size hull in play.
 *
 * Run: node tools/check-catalog.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Box3, Vector3 } from "three";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = await build({
  stdin: { contents: 'export * from "./src/sim/catalog.ts";', loader: "ts", resolveDir: root },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  logLevel: "silent",
});
const { SHIP_CLASSES, WEAPON_BODIES, UnknownShipClassError, shipClass, modelUrl } = await import(
  `data:text/javascript,${encodeURIComponent(built.outputFiles[0].text)}`
);

const fleet = JSON.parse(readFileSync(resolve(root, "tools/blender/fleet.json"), "utf8"));
const budget = new Map(fleet.ships.map((ship) => [ship.id, ship.budget]));

/** Dimension agreement between catalog and GLB, in metres. */
const DIM_TOLERANCE = 0.01;
/** Length agreement between the shipped GLB and the class reference. */
const LENGTH_TOLERANCE_PCT = 2;
/** The keel datum tolerance. */
const KEEL_TOLERANCE = 0.01;
/**
 * The importer re-drops the keel after decimation, so every hull sits exactly on the datum and
 * no model needs an allowance. The map is kept so a future exception has to be named here
 * rather than hidden by loosening the shared tolerance.
 */
const KEEL_ALLOWANCE = {};

// three's FileLoader emits ProgressEvent even for a data: URI; node 20 has no such global.
globalThis.ProgressEvent ??= class ProgressEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    Object.assign(this, init);
  }
};
const loader = new GLTFLoader();

/** Same parse inspect-glb.mjs performs: strip textures, then read the axis extents and triangles. */
async function measure(file) {
  const bytes = await readFile(file);
  const headerLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + headerLength).toString());
  for (const material of json.materials ?? []) {
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
    if (material.pbrMetallicRoughness) {
      delete material.pbrMetallicRoughness.baseColorTexture;
      delete material.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    for (const ext of Object.values(material.extensions ?? {})) {
      if (ext && typeof ext === "object")
        for (const k of Object.keys(ext)) if (k.endsWith("Texture")) delete ext[k];
    }
  }
  delete json.textures;
  delete json.images;
  json.buffers[0].uri =
    "data:application/octet-stream;base64," + bytes.subarray(28 + headerLength).toString("base64");
  const gltf = await loader.parseAsync(JSON.stringify(json), "");
  const box = new Box3().setFromObject(gltf.scene);
  const size = box.getSize(new Vector3());
  let tris = 0;
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    const geometry = node.geometry;
    tris += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  });
  // The importer bakes length along glTF -Z, beam along X and the mast along +Y.
  return { length: size.z, beam: size.x, height: size.y, minY: box.min.y, triangles: Math.round(tris) };
}

const fileFor = (modelId) => resolve(root, "public", modelUrl(modelId).replace(/^\//, ""));
const rows = [];

for (const cls of Object.values(SHIP_CLASSES)) {
  const url = modelUrl(cls.modelId);
  const file = fileFor(cls.modelId);
  assert.ok(existsSync(file), `${cls.classId}: modelUrl ${url} does not exist on disk`);
  const m = await measure(file);
  assert.ok(
    Math.abs(cls.measuredLength - m.length) <= DIM_TOLERANCE,
    `${cls.classId}: measuredLength ${cls.measuredLength} m vs GLB ${m.length.toFixed(4)} m`,
  );
  assert.ok(
    Math.abs(cls.measuredBeam - m.beam) <= DIM_TOLERANCE,
    `${cls.classId}: measuredBeam ${cls.measuredBeam} m vs GLB ${m.beam.toFixed(4)} m`,
  );
  assert.ok(
    Math.abs(cls.measuredHeight - m.height) <= DIM_TOLERANCE,
    `${cls.classId}: measuredHeight ${cls.measuredHeight} m vs GLB ${m.height.toFixed(4)} m`,
  );
  assert.equal(cls.triangles, m.triangles, `${cls.classId}: triangles ${cls.triangles} vs GLB ${m.triangles}`);

  const keelTolerance = KEEL_ALLOWANCE[cls.modelId] ?? KEEL_TOLERANCE;
  assert.ok(
    Math.abs(m.minY) <= keelTolerance,
    `${cls.classId}: keel min.y=${m.minY.toFixed(4)} m is outside +/-${keelTolerance} m`,
  );

  const errorPct = (Math.abs(cls.measuredLength - cls.hullLength) / cls.hullLength) * 100;
  assert.ok(
    errorPct <= LENGTH_TOLERANCE_PCT,
    `${cls.classId}: measured length ${cls.measuredLength} m is ${errorPct.toFixed(2)}% from reference ${cls.hullLength} m (limit ${LENGTH_TOLERANCE_PCT}%)`,
  );

  const cap = budget.get(cls.modelId);
  assert.ok(cap !== undefined, `${cls.classId}: no triangle budget for ${cls.modelId} in tools/blender/fleet.json`);
  assert.ok(cls.triangles <= cap, `${cls.classId}: ${cls.triangles} triangles over the ${cap} budget`);

  rows.push({ classId: cls.classId, reference: cls.hullLength, measured: cls.measuredLength, errorPct });
}

for (const weapon of Object.values(WEAPON_BODIES)) {
  const file = fileFor(weapon.modelId);
  assert.ok(existsSync(file), `${weapon.weaponId}: model ${weapon.modelId} missing on disk`);
  const m = await measure(file);
  assert.ok(
    Math.abs(weapon.measuredLength - m.length) <= DIM_TOLERANCE,
    `${weapon.weaponId}: measuredLength ${weapon.measuredLength} m vs GLB ${m.length.toFixed(4)} m`,
  );
  assert.ok(
    Math.abs(weapon.measuredDiameter - m.beam) <= DIM_TOLERANCE,
    `${weapon.weaponId}: measuredDiameter ${weapon.measuredDiameter} m vs GLB ${m.beam.toFixed(4)} m`,
  );
  assert.equal(weapon.triangles, m.triangles, `${weapon.weaponId}: triangles ${weapon.triangles} vs GLB ${m.triangles}`);
  assert.ok(
    Math.abs(m.minY) <= KEEL_TOLERANCE,
    `${weapon.weaponId}: keel min.y=${m.minY.toFixed(4)} m is outside +/-${KEEL_TOLERANCE} m`,
  );
  const cap = budget.get(weapon.modelId);
  assert.ok(cap !== undefined, `${weapon.weaponId}: no triangle budget for ${weapon.modelId} in tools/blender/fleet.json`);
  assert.ok(weapon.triangles <= cap, `${weapon.weaponId}: ${weapon.triangles} triangles over the ${cap} budget`);
}

// Lookups: the URL shape, a real record's identity and a named throw for an unknown id.
assert.equal(modelUrl("destroyer.kagero"), "destroyer.kagero.glb", "modelUrl does not compose the asset path");
assert.equal(shipClass("kagero"), SHIP_CLASSES.kagero, "shipClass returned the wrong record");
assert.throws(
  () => shipClass("nope"),
  (error) => {
    assert.ok(error instanceof UnknownShipClassError, `unknown id threw ${error?.name ?? error}, not a named error`);
    assert.equal(error.name, "UnknownShipClassError");
    return true;
  },
);

console.log("check-catalog: classId            reference m   measured m   error %");
for (const row of rows) {
  console.log(
    `check-catalog: ${row.classId.padEnd(18)} ${row.reference.toFixed(2).padStart(11)} ` +
      `${row.measured.toFixed(2).padStart(12)} ${row.errorPct.toFixed(3).padStart(9)}`,
  );
}
const worst = rows.reduce((a, b) => (b.errorPct > a.errorPct ? b : a));
console.log(
  `check-catalog: ${rows.length} hulls and ${Object.keys(WEAPON_BODIES).length} weapon body match the shipped GLBs; ` +
    `worst length error ${worst.classId} ${worst.errorPct.toFixed(3)}%`,
);
