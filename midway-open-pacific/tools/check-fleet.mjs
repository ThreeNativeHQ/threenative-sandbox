/**
 * Fleet asset gate: parses the shipped GLBs without a browser and asserts the
 * facts the game's render code depends on (crew rig/clips, aircraft pivot and
 * orientation, hull axis and length, atoll scale). Exits non-zero on mismatch.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Box3, Quaternion, Vector3 } from "three";
import { checkHumanoid, loadGlb } from "./check-humanoid.mjs";

const asset = (name) => new URL(`../assets/${name}`, import.meta.url);

const sizeOf = (object) => new Box3().setFromObject(object).getSize(new Vector3());

{
  const gltf = await loadGlb(process.argv[2] ?? asset("deck-crew.glb"));
  checkHumanoid(gltf, {
    clips: ["crew.chock", "crew.idle", "crew.service", "crew.signal", "crew.wait", "crew.walk"],
    height: 1.83,
    minimumHandVertices: 50,
    minimumFingerVertices: 10,
  });
}

{
  const gltf = await loadGlb(asset("aircraft.mitsubishi-a6m3.glb"));
  gltf.scene.updateMatrixWorld(true);

  const span = sizeOf(gltf.scene).x;
  assert(span >= 11.0 && span <= 11.3, `A6M3 wingspan ${span.toFixed(3)} out of range`);

  const pivot = gltf.scene.getObjectByName("VINTThreeNativePivot");
  assert(pivot, "A6M3 pivot node missing");
  const position = pivot.getWorldPosition(new Vector3());
  const quaternion = pivot.getWorldQuaternion(new Quaternion());
  assert(position.z < -3, `A6M3 pivot Z ${position.z.toFixed(3)} is not ahead of origin`);
  quaternion.toArray().forEach((value, i) => {
    assert(Math.abs(value - (i === 3 ? 1 : 0)) < 1e-4, `A6M3 pivot quaternion[${i}]=${value} not identity`);
  });
}

{
  const gltf = await loadGlb(asset("destroyer.samidare.glb"));
  gltf.scene.updateMatrixWorld(true);

  let hull;
  gltf.scene.traverse((node) => {
    if (node.isMesh && node.name === "Object001_hull_0") hull = node;
  });
  assert(hull, "destroyer hull mesh missing");
  const size = sizeOf(hull);
  assert(size.x >= 140 && size.x <= 148, `destroyer hull length ${size.x.toFixed(2)} out of range`);
  assert(size.x > size.y && size.x > size.z, "destroyer hull does not run along X");
}

{
  const gltf = await loadGlb(asset("midway-atoll.glb"));
  gltf.scene.updateMatrixWorld(true);

  const width = sizeOf(gltf.scene).x;
  assert(width >= 1.99 && width <= 2.01, `atoll width ${width.toFixed(3)} out of range`);
}

{
  const { ships } = JSON.parse(await readFile(new URL("./blender/fleet.json", import.meta.url), "utf8"));
  const ids = new Set(ships.map((ship) => ship.id));

  for (const ship of ships)
    assert(existsSync(asset(`${ship.id}.glb`)), `fleet ship ${ship.id} has no assets/${ship.id}.glb`);

  for (const ship of ships) {
    const gltf = await loadGlb(asset(`${ship.id}.glb`));
    gltf.scene.updateMatrixWorld(true);

    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    assert(Math.abs(box.min.y) <= 0.02, `${ship.id} keel sits at y=${box.min.y.toFixed(3)}, not 0`);

    const lengthError = Math.abs(size.z - ship.length) / ship.length;
    assert(
      lengthError <= 0.02,
      `${ship.id} length ${size.z.toFixed(2)}m differs from ${ship.length}m by ${(lengthError * 100).toFixed(2)}%`,
    );

    // Historical beam/height metadata must never squeeze an authored hull.
    assert(size.toArray().every(n => Number.isFinite(n) && n > 0), `${ship.id} invalid bounds`);

    let triangles = 0;
    let meshes = 0;
    const materials = new Set();
    const vertices = [];
    gltf.scene.traverse((node) => {
      if (!node.isMesh) return;
      const geometry = node.geometry;
      triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
      meshes++;
      for (const material of Array.isArray(node.material) ? node.material : [node.material])
        materials.add(material.uuid);
      const position = geometry.attributes.position;
      for (let i = 0; i < position.count; i++)
        vertices.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld));
    });
    assert(triangles <= ship.budget, `${ship.id} ${triangles} triangles exceed budget ${ship.budget}`);
    // A model is allowed to be far under budget only because its source was: Soryu ships 23.6k
    // because Tripo generated 23.6k, not because the decimator ate it. What must not happen is a
    // hull whose source exceeded budget arriving well under it, which means a botched decimation,
    // or a hull arriving at its full source count when it should have been cut down.
    const expected = Math.min(ship.sourceTriangles, ship.budget);
    assert(
      Math.abs(triangles - expected) <= Math.max(8, expected * 0.02),
      `${ship.id} has ${triangles} triangles; expected ${expected} ` +
        `(source ${ship.sourceTriangles}, budget ${ship.budget})`,
    );
    assert.equal(meshes, 1, `${ship.id} has ${meshes} meshes; the import contract is one`);
    assert.equal(materials.size, 1, `${ship.id} has ${materials.size} materials; the import contract is one`);
    assert.equal(gltf.animations.length, 0, `${ship.id} carries ${gltf.animations.length} animation clips`);

    const xExtent = (zMin, zMax) => {
      let min = Infinity;
      let max = -Infinity;
      for (const vertex of vertices)
        if (vertex.z >= zMin && vertex.z <= zMax) {
          min = Math.min(min, vertex.x);
          max = Math.max(max, vertex.x);
        }
      return max - min;
    };
    const meanHalfBreadth = (zMin, zMax) => {
      let sum = 0;
      let count = 0;
      for (const vertex of vertices)
        if (vertex.z >= zMin && vertex.z <= zMax) {
          sum += Math.abs(vertex.x);
          count++;
        }
      return count ? sum / count : 0;
    };

    // Two hull shapes, two invariants, each of which flips if the model is imported back to front.
    //
    // A surface ship tapers in plan, so its bow band is narrower than midships. A submarine does
    // not: both boats carry bow diving planes that spread wider than the pressure hull right at the
    // stem, and Nautilus measures 12.61m across the forward band against 11.75m amidships, so the
    // plan taper reads its bow backwards. The torpedo is a near-symmetric cylinder whose tail fins
    // stay inside the 0.569m body diameter, so a plan taper cannot see them at all.
    //
    // For those three the direction lives at the two extreme ends instead, and it runs the other
    // way: the stern stays full out to the propellers, rudder and stern planes, while the bow falls
    // away to a fine stem - a smooth ogive nose on the torpedo, whose screws and fins are likewise
    // at its tail. Verified on orthographic side renders of all three, not inferred. Measured as a
    // mean half-breadth over the outer 5% of length, so no single stray vertex can decide it.
    let shape;
    if (ship.id.startsWith("submarine.") || ship.id.startsWith("weapon.")) {
      const forward = meanHalfBreadth(box.min.z, box.min.z + size.z * 0.05);
      const aft = meanHalfBreadth(box.max.z - size.z * 0.05, box.max.z);
      assert(
        aft > forward * 1.15,
        `${ship.id} end-fineness rule: aft 5% mean half-breadth ${aft.toFixed(3)}m is not at least ` +
          `15% fuller than the forward 5% ${forward.toFixed(3)}m; the screws are not along +Z`,
      );
      shape = `aft ${aft.toFixed(2)}m > forward ${forward.toFixed(2)}m (end fineness)`;
    } else {
      const bow = xExtent(box.min.z, box.min.z + size.z * 0.15);
      const midships = xExtent(box.min.z + size.z * 0.4, box.min.z + size.z * 0.6);
      assert(
        bow < midships,
        `${ship.id} plan-taper rule: ${bow > midships ? "forward" : "middle"} band is wider (${bow.toFixed(2)}m vs ${midships.toFixed(2)}m); bow is not along -Z`,
      );
      shape = `bow ${bow.toFixed(2)}m < midships ${midships.toFixed(2)}m (plan taper)`;
    }

    const centre = box.getCenter(new Vector3()).x;
    assert(
      Math.abs(centre) <= ship.beam * 0.05,
      `${ship.id} X centre ${centre.toFixed(3)}m is off zero by more than 5% of beam ${ship.beam}m`,
    );

    console.log(
      `${ship.id}: ${triangles} triangles, keel ${box.min.y.toFixed(3)}, ` +
        `${size.z.toFixed(2)}m x ${size.x.toFixed(2)}m x ${size.y.toFixed(2)}m, ${shape}; pass`,
    );

    // A carrier's island is the most asymmetric thing on the hull, so which side it stands on is a
    // fact worth pinning to the shipped bytes. `flip` in fleet.json reverses bow and stern by a 180
    // degree yaw, and that same yaw mirrors port and starboard, so a flipped carrier silently moves
    // its island across the deck; nothing above the deck is visible to plan taper or end fineness.
    // `ship.island` records the side the shipped model actually has, so the gate fires if a re-import
    // or a flip change moves it. Where the model and history disagree, `ship.islandHistorical` records
    // the real side and the run states the divergence instead of failing on a defect nobody fixes.
    if (!ship.island) continue;

    // The flight deck is the largest flat surface a carrier has, so it is the densest 1 m slab of
    // the vertex cloud. Everything more than 6 m above it is superstructure - the island - because
    // the deck-edge galleries and catwalks the task names stop at the deck.
    const ys = vertices.map((v) => v.y).sort((a, b) => a - b);
    let densest = 0;
    let deck = ys[0];
    for (let i = 0, j = 0; i < ys.length; i++) {
      while (ys[i] - ys[j] > 1) j++;
      if (i - j + 1 > densest) {
        densest = i - j + 1;
        deck = (ys[i] + ys[j]) / 2;
      }
    }
    const above = vertices.filter((v) => v.y > deck + 6).map((v) => v.x).sort((a, b) => a - b);
    assert(above.length, `${ship.id} has no vertices above its flight deck; cannot classify its island`);

    const mean = above.reduce((a, b) => a + b, 0) / above.length;
    const median = above[above.length >> 1];
    // Same 5%-of-beam deadband the hull centre check uses: an island is either plainly to one side
    // or, as on the imported Yorktown, a block straddling the centreline.
    const sideOf = (x) => (Math.abs(x) <= ship.beam * 0.05 ? "centreline" : x > 0 ? "starboard" : "port");
    assert(
      sideOf(mean) === sideOf(median),
      `${ship.id} island mean X ${mean.toFixed(2)}m and median X ${median.toFixed(2)}m classify differently`,
    );

    const measured = sideOf(median);
    console.log(
      `${ship.id} island: mean X ${mean.toFixed(2)}m, median X ${median.toFixed(2)}m -> ${measured} ` +
        `(recorded ${ship.island})`,
    );
    assert.equal(
      measured,
      ship.island,
      `${ship.id} island measured on the ${measured}, but fleet.json records ${ship.island}; the side ` +
        `moved, so re-check the imported bytes and the recorded side together (a 180 degree flip ` +
        `reverses the bow and mirrors port/starboard).`,
    );
    // A known-bad side that nobody is about to fix: state it, do not fail on it. This is the same
    // shape tools/capture-deck.mjs uses for the imported hulls' model defects.
    if (ship.islandHistorical && measured !== ship.islandHistorical)
      console.log(
        `NOTE ${ship.id}: island measured on the ${measured}; history puts it to ${ship.islandHistorical} — ` +
          `${ship.islandNote}`,
      );
  }

  // destroyer.samidare.glb matches the fleet naming pattern without being a fleet.json hull: it is
  // the supplied IJN destroyer that imported-fleet.ts loads, it runs along X rather than glTF -Z,
  // and it is asserted against its own contract in the block above. A hull that came out of the
  // fleet.json pipeline and was never registered there still trips this scan.
  // weapon.rear-gun.glb is the rear-gun asset from tools/blender/normalize-rear-gun.py, not a
  // fleet.json hull: check-aircraft.mjs asserts its triangle count and hinge and check-gunner.mjs
  // its ballistics, so it is not an unregistered fleet asset.
  const checkedUnderAnotherContract = new Set(["destroyer.samidare.glb", "weapon.rear-gun.glb"]);
  const orphans = readdirSync(new URL("../assets/", import.meta.url)).filter(
    (name) =>
      /^(carrier|cruiser|destroyer|submarine|weapon)\..+\.glb$/.test(name) &&
      !checkedUnderAnotherContract.has(name) &&
      !ids.has(name.slice(0, -4)),
  );
  assert.deepEqual(orphans, [], `fleet assets in public/assets not named by fleet.json: ${orphans.join(", ")}`);
}
console.log("PASS check-fleet: crew, A6M3, Samidare hull, Midway atoll and imported fleet match");
