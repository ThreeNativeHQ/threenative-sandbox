// CPU check: real GLB geometry and tracks; texture decoding is covered by the browser playtest.
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "esbuild";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Box3, Raycaster, Vector3, Texture } from "three";

const bytes = await readFile(
  new URL("../assets/aircraft.douglas-sbd3.glb", import.meta.url),
);
const length = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + length));
assert.equal(gltf.animations.length, 12);
assert.equal(gltf.images.length, 61);
for (const mesh of gltf.meshes)
  for (const primitive of mesh.primitives) {
    for (const index of Object.values(primitive.attributes)) {
      const accessor = gltf.accessors[index];
      const view = gltf.bufferViews[accessor.bufferView];
      const components = { VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
      const componentBytes = { 5126: 4, 5123: 2, 5121: 1 }[accessor.componentType];
      assert.ok(
        !view.byteStride || view.byteStride === components * componentBytes,
        "attributes must not interleave",
      );
    }
  }
for (const material of gltf.materials) {
  delete material.normalTexture;
  delete material.occlusionTexture;
  delete material.emissiveTexture;
  delete material.pbrMetallicRoughness.baseColorTexture;
  delete material.pbrMetallicRoughness.metallicRoughnessTexture;
}
delete gltf.textures;
delete gltf.images;
gltf.buffers[0].uri =
  "data:application/octet-stream;base64," + bytes.subarray(28 + length).toString("base64");
globalThis.ProgressEvent = class {};
const loaded = await new GLTFLoader().parseAsync(JSON.stringify(gltf), "");

/** Parse another shipped GLB the same texture-less way, for the imported-airframe animations. */
const stripGlb = async (asset) => {
  const raw = await readFile(new URL(asset, import.meta.url));
  const header = raw.readUInt32LE(12);
  const model = JSON.parse(raw.subarray(20, 20 + header));
  for (const material of model.materials) {
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
    if (material.pbrMetallicRoughness) {
      delete material.pbrMetallicRoughness.baseColorTexture;
      delete material.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  delete model.textures;
  delete model.images;
  model.buffers[0].uri =
    "data:application/octet-stream;base64," + raw.subarray(28 + header).toString("base64");
  return new GLTFLoader().parseAsync(JSON.stringify(model), "");
};
const tbdSource = await stripGlb("../assets/aircraft.tbd-devastator.glb");
assert.equal(tbdSource.animations.length, 9, "the TBD ships one clip per moving part");
const tbdParts = ["aileronleft", "aileronright", "elevator", "flapleft", "flapright", "gearleft", "gearright", "propeller", "rudder"];
for (const name of tbdParts) assert.ok(tbdSource.scene.getObjectByName(name), `TBD ships a separated ${name}`);
// The deck crew's pilot rig, which the Douglas also seats in its rear cockpit.
const pilotSource = await stripGlb("../assets/carrier-aircraft-pilot.glb");
assert.ok(
  pilotSource.animations.some((clip) => clip.name === "sit"),
  "the pilot rig ships the seated clip the rear gunner plays",
);
// The approved twin rear gun, shared by both airframes' rear stations.
const gunSource = await stripGlb("../assets/weapon.rear-gun.glb");
const gunTriangles = gunSource.scene
  .getObjectByProperty("isMesh", true)
  ?.geometry.index.count / 3;
assert.equal(gunTriangles, 4764, "the shipped rear gun keeps every supplied triangle");
await mkdir("node_modules/.cache", { recursive: true });
const temporary = await mkdtemp(resolve("node_modules/.cache/aircraft-check-"));
try {
  const output = await build({
    entryPoints: ["src/render/imported-aircraft.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
  });
  const modulePath = resolve(temporary, "aircraft.mjs");
  await writeFile(modulePath, output.outputFiles[0].text);
  const { loadImportedAircraft, createDouglas, animateDouglas, disposeDouglas, createAirframe, animateDevastator, disposeAirframe } = await import(
    pathToFileURL(modulePath).href
  );
  const lodOutput = await build({
    entryPoints: ["src/render/airframe-lod.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
  });
  const lodPath = resolve(temporary, "airframe-lod.mjs");
  await writeFile(lodPath, lodOutput.outputFiles[0].text);
  const { airframeLod } = await import(pathToFileURL(lodPath).href);
  const mountOutput = await build({
    entryPoints: ["src/sim/gun-mount.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
  });
  const mountPath = resolve(temporary, "gun-mount.mjs");
  await writeFile(mountPath, mountOutput.outputFiles[0].text);
  const { REAR_GUN_MOUNTS, REAR_GUN_TAIL, rearGunMuzzle } = await import(pathToFileURL(mountPath).href);
  const testTexture = new Texture();
  const sourceMesh = loaded.scene.getObjectByName("defaultMaterial_node_18");
  sourceMesh.material.map = testTexture;
  await loadImportedAircraft({
    assets: { model: async (url) => (/tbd-devastator/.test(String(url)) ? tbdSource : /carrier-aircraft-pilot/.test(String(url)) ? pilotSource : /rear-gun/.test(String(url)) ? gunSource : loaded) },
    renderer: { raw: { getMaxAnisotropy: () => 8 } },
  });
  assert.equal(
    testTexture.anisotropy,
    8,
    "aircraft textures use the running adapter's supported anisotropy",
  );
  const pixels = new Uint8ClampedArray(1024 * 512 * 4);
  const context = new Proxy(
    { getImageData: () => ({ data: pixels }) },
    { get: (target, key) => target[key] ?? (() => {}) },
  );
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
  const airplane = createDouglas(true);
  const parked = createDouglas();
  // The two-man cockpit: the forward pilot is `userData.crew[0]`, the hook the cockpit view hides
  // with the player's own aircraft; the gunner is published separately behind that camera.
  const pilot = airplane.getObjectByName("Douglas front pilot crew");
  const gunner = airplane.getObjectByName("Douglas rear gunner crew");
  assert.ok(pilot && gunner, "the Douglas carries both cockpit stations");
  assert.deepEqual(airplane.userData.crew, [pilot], "the forward pilot is the cockpit-view crew hook");
  assert.equal(airplane.userData.pilotRig.current, "sit", "the forward pilot holds the seated clip");
  assert.equal(airplane.userData.gunnerRig.current, "gunner-grip", "the gunner holds the baked grip clip");
  // The published gunner is the man's own rig, NOT the whole station: a first-person station hides
  // him without taking his seat, the fittings or the gun with him.
  assert.equal(
    airplane.userData.gunner,
    gunner.getObjectByName("Douglas rear gunner"),
    "the gunner rig is published, not the station",
  );
  assert.equal(airplane.userData.gunner.parent, gunner, "the published gunner sits inside his station");
  const gunPivot = airplane.userData.rearGun;
  const gunFittings = airplane.getObjectByName("Douglas rear gunner cockpit fittings");
  assert.ok(gunPivot?.isObject3D, "the rear gun pivot is published");
  assert.ok(
    !airplane.userData.gunner.getObjectByName(gunPivot.name),
    "the gun pivot is separate from the rig the station hides",
  );
  // The gun itself: the shipped asset is parented under the pivot, keeps its triangles, and the
  // built pivot is exactly the shared measurement the sim fires from.
  const gunMesh = gunPivot.getObjectByProperty("isMesh", true);
  assert.ok(gunMesh, "the approved gun model hangs under the pivot");
  assert.equal(
    gunMesh.geometry.index.count / 3,
    4764,
    "the drawn gun keeps every supplied triangle",
  );
  // Orientation is the export contract: the hinge is the origin, the muzzles run aft (+Z) and the
  // receiver sits forward (-Z) toward the gunner. A 180-degree mistake would put the barrels in the
  // man's face, which this catches without a browser.
  gunMesh.geometry.computeBoundingBox();
  assert.ok(
    gunMesh.geometry.boundingBox.max.z > 0.4 && gunMesh.geometry.boundingBox.min.z < -0.4,
    `the gun barrels point aft from its hinge: ${JSON.stringify(gunMesh.geometry.boundingBox)}`,
  );
  airplane.updateMatrixWorld(true);
  const pivotWorld = gunPivot.getWorldPosition(new Vector3());
  const mount = REAR_GUN_MOUNTS.sbd;
  assert.ok(
    Math.hypot(pivotWorld.x - mount.pivot[0], pivotWorld.y - mount.pivot[1], pivotWorld.z - mount.pivot[2]) <
      1e-6,
    `the drawn SBD gun pivot equals the fired mount: ${pivotWorld.toArray()}`,
  );
  // The fin guard is measured, not convenient. Re-read the SBD's vertical-tail meshes and assert the
  // sim box's real bottom/top/thickness and z-span against them, so a box drawn above the barrel line
  // to let level shots through can never come back without failing here.
  const finBox = new Box3();
  for (const finMesh of ["defaultMaterial_node_11", "defaultMaterial_node_10", "defaultMaterial_node_9"]) {
    const node = airplane.getObjectByName(finMesh);
    if (node) finBox.expandByObject(node);
  }
  const tail = REAR_GUN_TAIL.sbd;
  const finChecks = [
    ["halfWidth", finBox.max.x, tail.halfWidth],
    ["base", finBox.min.y, tail.base],
    ["top", finBox.max.y, tail.top],
    ["z", finBox.min.z, tail.z],
    ["z+reach", finBox.max.z, tail.z + tail.reach],
  ];
  for (const [label, measured, declared] of finChecks)
    assert.ok(
      Math.abs(measured - declared) < 0.03,
      `the SBD fin guard ${label} is the measured geometry: ${measured.toFixed(3)} vs ${declared}`,
    );
  // The baked grip must actually hold the grips, not merely sit "near the hinge": both wrist bones
  // are measured in the gunner rig's own local frame against the accepted grip targets at several
  // phases of the seated clip. A rest-space drift in the graft moves the hands off the grips and this
  // fails, where the old 60 cm hinge proximity would still pass. Targets come from the approved bake
  // (`tools/extract-gunner-grip.mjs`), in metres of the rig root frame.
  const GRIP_TARGETS = { hand_l: [0.28, 1.02, 0.12], hand_r: [-0.18, 1.02, 0.1] };
  const gripRoot = airplane.userData.gunnerRig.root;
  const gunnerRig = airplane.userData.gunnerRig;
  const sitClip = pilotSource.animations.find((clip) => clip.name === "sit");
  assert.ok(sitClip, "the pilot rig ships the sit clip the grip is grafted onto");
  for (const phase of [0, 0.45, 0.9]) {
    gunnerRig.mixer.setTime(sitClip.duration * phase);
    gunnerRig.update(0);
    airplane.updateMatrixWorld(true);
    for (const [bone, target] of Object.entries(GRIP_TARGETS)) {
      const hand = gripRoot.getObjectByName(bone);
      assert.ok(hand, `the gunner rig has its ${bone}`);
      const local = gripRoot.worldToLocal(hand.getWorldPosition(new Vector3()));
      const d = local.distanceTo(new Vector3(...target));
      assert.ok(
        d < 0.08,
        `${bone} holds its grip at sit phase ${phase}: ${local.toArray().map((v) => v.toFixed(3))} is ${d.toFixed(3)} m off ${target}`,
      );
    }
  }
  airplane.userData.gunner.visible = false;
  assert.equal(gunFittings.visible, true, "hiding the gunner leaves the seat and fittings");
  assert.equal(gunPivot.visible, true, "hiding the gunner leaves the gun");
  airplane.userData.gunner.visible = true;
  assert.ok(airplane.userData.gunnerEye instanceof Vector3, "the gunner eye is a published Vector3");
  assert.ok(
    airplane.userData.gunnerEye.y > 0.6 && airplane.userData.gunnerEye.y < 1.184,
    `the gunner eye stays under the 1.184 m canopy roof: ${airplane.userData.gunnerEye.y.toFixed(3)}`,
  );
  assert.ok(
    airplane.userData.gunnerEye.z > airplane.userData.pilotEye.z,
    "the gunner eye is aft of the pilot eye",
  );
  for (const [label, station] of [["pilot", pilot], ["gunner", gunner]]) {
    let skinned = 0;
    station.traverse((node) => {
      if (node.isSkinnedMesh) skinned += 1;
    });
    assert.equal(skinned, 1, `the ${label} is exactly one skinned rig`);
  }
  assert.ok(parked.getObjectByName("Douglas front pilot crew"), "every Douglas seats its own pilot");
  assert.ok(parked.getObjectByName("Douglas rear gunner crew"), "every Douglas seats its own gunner");
  const pilotHead = pilot.getObjectByName("Head");
  const gunnerHead = gunner.getObjectByName("Head");
  assert.ok(pilotHead && gunnerHead, "both crew rigs carry their Head bone");
  const pilotEye = pilotHead.getWorldPosition(new Vector3());
  const gunnerEye = gunnerHead.getWorldPosition(new Vector3());
  // Forward is -Z: the pilot sits ahead of the gunner and faces the nose, the gunner aft of him.
  assert.ok(pilotEye.z < gunnerEye.z, `the pilot sits ahead of the gunner: ${pilotEye.z.toFixed(3)} < ${gunnerEye.z.toFixed(3)}`);
  assert.ok(pilotEye.z < -1.5 && pilotEye.z > -1.75, `the pilot head is at the cockpit eye z: ${pilotEye.z.toFixed(3)}`);
  assert.ok(pilotEye.y > gunnerEye.y, "the pilot sits higher than the gunner behind him");
  assert.ok(
    pilotEye.y > 0.6 && pilotEye.y < 1.207,
    `the forward head stays under the 1.207 m canopy glass: ${pilotEye.y.toFixed(3)}`,
  );
  assert.ok(
    gunnerEye.y > 0.6 && gunnerEye.y < 1.184,
    `the seated head stays under the 1.184 m canopy roof: ${gunnerEye.y.toFixed(3)}`,
  );
  const { gearClearance } = await import("@threenative/core");
  airplane.rotation.set(0.22, 0, 0, "YXZ");
  airplane.position.set(0, 20.06 + gearClearance({ pitch: 0.22 }), 15);
  airplane.updateMatrixWorld(true);
  const contacts = [];
  airplane.children[1].traverse((node) => {
    if (
      !node.isMesh ||
      node.geometry.type !== "CylinderGeometry" ||
      ![0.35, 0.17].includes(node.geometry.parameters.radiusTop)
    )
      return;
    const positions = node.geometry.getAttribute("position");
    let bottom = Infinity;
    for (let i = 0; i < positions.count; i++)
      bottom = Math.min(
        bottom,
        new Vector3().fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld).y,
      );
    contacts.push(bottom - 20.06);
  });
  assert.equal(contacts.length, 3, "measure both main wheels and the fixed tailwheel");
  assert.ok(
    contacts.every((gap) => Math.abs(gap) <= 0.05),
    `wheel/deck gaps must stay within 5cm: ${contacts}`,
  );
  console.log("Measured wheel/deck gaps (metres):", contacts);
  airplane.position.set(0, 0, 0);
  airplane.rotation.set(0, 0, 0);
  airplane.updateMatrixWorld(true);
  const panelRoot = airplane.getObjectByName("Douglas live cockpit instruments");
  assert.ok(panelRoot.children.length > 0, "player receives the detailed live cockpit");
  assert.equal(
    parked.getObjectByName(panelRoot.name).children.length,
    0,
    "parked planes need no cockpit interior",
  );
  const interior = panelRoot.getObjectByName("Cockpit interior");
  assert.ok(interior, "detailed cockpit interior is mounted on the player");
  let interiorMeshes = 0;
  interior.traverse((node) => {
    if (node.isMesh) interiorMeshes += 1;
  });
  assert.ok(interiorMeshes > 40, `cockpit interior carries real geometry: ${interiorMeshes} meshes`);
  const rig = airplane.userData.cockpitRig;
  assert.equal(typeof rig?.update, "function", "cockpit rig is live");
  const stick = airplane.getObjectByName("Control stick");
  const lever = airplane.getObjectByName("Throttle lever 1");
  const needles = [];
  airplane.traverse((node) => {
    if (node.name === "Gauge needle") needles.push(node);
  });
  assert.ok(stick && lever && needles.length >= 8, "stick, throttle and gauges are rigged");
  const rigNeutral = { stick: stick.rotation.x, lever: lever.rotation.x };
  const needlesBefore = needles.map((needle) => needle.rotation.z);
  animateDouglas(airplane, { rpm: 0.9, elevator: 0.8, aileron: 0.6, rudder: 0.5, flapPos: 1 }, 0.05);
  const needlesAfter = needles.map((needle) => needle.rotation.z);
  assert.ok(Math.abs(stick.rotation.x - rigNeutral.stick) > 0.1, "stick follows the elevator");
  assert.ok(Math.abs(stick.rotation.z) > 0.05, "stick rolls with the ailerons");
  assert.ok(Math.abs(lever.rotation.x - rigNeutral.lever) > 0.02, "throttle lever follows power");
  assert.ok(
    needlesAfter.some((angle, i) => Math.abs(angle - needlesBefore[i]) > 0.001),
    "gauge needles move with flight state",
  );
  animateDouglas(airplane, {}, 0);
  // The cockpit view hides the forward pilot with the player's own aircraft; hide him here too, or
  // his head is the first thing ahead of the eye instead of the panel.
  airplane.userData.crew[0].visible = false;
  airplane.updateMatrixWorld(true);
  const eye = airplane.userData.cockpit;
  const panelPoint = interior.localToWorld(new Vector3(0, 0.66, -0.455));
  // Raycaster ignores an ancestor's `visible`, so exclude the hidden forward pilot explicitly.
  const hidden = airplane.userData.crew[0];
  const inCrew = (node) => {
    for (let n = node; n; n = n.parent) if (n === hidden) return true;
    return false;
  };
  const forward = new Raycaster(eye, panelPoint.clone().sub(eye).normalize(), 0.045, eye.distanceTo(panelPoint) + 0.02)
    .intersectObject(airplane, true)
    .filter((hit) => hit.object.visible && !hit.object.material.transparent && !inCrew(hit.object));
  assert.ok(forward.length > 0, "the detailed panel is ahead of the pilot");
  let onInterior = false;
  for (let node = forward[0].object; node; node = node.parent) if (node === panelRoot) onInterior = true;
  assert.ok(onInterior, "the first thing ahead of the pilot is the cockpit interior");
  airplane.userData.crew[0].visible = true;
  assert.ok(Math.abs(new Box3().setFromObject(airplane).getSize(new Vector3()).x - 12.66) < 0.001);
  const glass = airplane.getObjectByName("defaultMaterial_node_7");
  const frames = airplane.getObjectByName("defaultMaterial_node_8");
  assert.ok(
    glass.material.transparent && glass.material.opacity <= 0.15,
    "canopy panes must transmit the cockpit view",
  );
  assert.equal(glass.material.depthWrite, false);
  assert.equal(glass.castShadow, false);
  assert.equal(frames.material.transparent, false, "canopy frames remain opaque");
  assert.equal(frames.visible, true);
  airplane.updateMatrixWorld(true);
  const sightline = new Raycaster(
    airplane.userData.cockpit,
    new Vector3(0, 0, -1),
    0.045,
    10,
  ).intersectObject(airplane, true);
  assert.ok(sightline.length > 0, "check the canopy from inside its actual cockpit mount");
  assert.ok(
    sightline.some((hit) => hit.object === glass),
    "the canopy glass is still on the forward sightline",
  );
  const propeller = airplane.getObjectByName("Circle008_Circle031ThreeNativePivot");
  const elevator = airplane.getObjectByName("defaultMaterial_node_1ThreeNativePivot");
  const aileron = airplane.getObjectByName("aileronpositive-xThreeNativePivot");
  const rudder = airplane.getObjectByName("Circle004_Circle026ThreeNativePivot");
  const flap = airplane.getObjectByName("Plane003_Plane004ThreeNativePivot");
  const neutral = [propeller, elevator, aileron, rudder, flap].map((node) =>
    node.quaternion.clone(),
  );
  animateDouglas(
    airplane,
    { rpm: 0.73, elevator: 0.8, aileron: 0.6, rudder: 0.5, flapPos: 1 },
    0.017,
  );
  assert.equal(
    airplane.getObjectByName("defaultMaterial_node_15").visible,
    false,
    "running blades cannot strobe across the cockpit view",
  );
  assert.equal(airplane.getObjectByName("defaultMaterial_node_16").visible, false);
  assert.equal(airplane.getObjectByName("Propeller motion blur").visible, true);
  for (const [i, node] of [propeller, elevator, aileron, rudder, flap].entries())
    assert.ok(node.quaternion.angleTo(neutral[i]) > 0.05, `${node.name} must move`);
  assert.ok(
    parked.getObjectByName(elevator.name).quaternion.angleTo(neutral[1]) < 0.00001,
    "instances animate independently",
  );
  animateDouglas(airplane, { rpm: 0 }, 0);
  for (const [i, node] of [propeller, elevator, aileron, rudder, flap].entries())
    if (i > 0)
      assert.ok(
        node.quaternion.angleTo(neutral[i]) < 0.00001,
        `${node.name} must return to neutral`,
      );
  assert.equal(
    airplane.getObjectByName("defaultMaterial_node_15").visible,
    true,
    "stopped blades remain visible",
  );
  assert.equal(airplane.getObjectByName("Propeller motion blur").visible, false);
  const stopped = propeller.quaternion.clone();
  animateDouglas(airplane, { rpm: 0 }, 0.1);
  assert.ok(propeller.quaternion.equals(stopped), "a stopped propeller does not advance");
  // The sit idle is a real clip on the gunner's own skeleton, not a frozen bind pose.
  const headBefore = gunnerHead.getWorldPosition(new Vector3()).clone();
  for (let i = 0; i < 24; i++) animateDouglas(airplane, {}, 1 / 60);
  assert.ok(
    gunnerHead.getWorldPosition(new Vector3()).distanceTo(headBefore) > 0.0005,
    "the sit idle animates the gunner skeleton",
  );
  disposeDouglas(airplane);
  disposeDouglas(parked);

  // The player TBD: the ported standalone airframe, driven by the game's own control values, as its
  // own instance. The supplied GLB is no longer the Devastator the game draws.
  const tbd = createAirframe("tbd1", "hero", true);
  const parkedTbd = createAirframe("tbd1", "ai");
  // The player-only first-person rear station: the supplied shell and twin gun. It is built from
  // the published eye and must never be allocated by an AI instance, so it is absent from the
  // parked builds above and present only when `createRearStation` is called. Its visible muzzles
  // must coincide with the sim's fired mouths at neutral and angled aim on both airframes.
  {
    const stationOutput = await build({
      entryPoints: ["src/render/rear-station.ts"],
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      write: false,
    });
    const stationPath = resolve(temporary, "rear-station.mjs");
    await writeFile(stationPath, stationOutput.outputFiles[0].text);
    const { createRearStation, placardAirframeLine } = await import(pathToFileURL(stationPath).href);
    assert.equal(placardAirframeLine("sbd"), "SBD-3", "the SBD rear placard names its own airframe");
    assert.equal(placardAirframeLine("tbd"), "TBD-1", "the TBD rear placard names its own airframe");
    assert.equal(
      placardAirframeLine("sbd").length,
      placardAirframeLine("tbd").length,
      "both placard lines are the same length, so the label wear seed is unchanged",
    );
    for (const [name, mesh, id, mount] of [
      ["SBD", airplane, "sbd", REAR_GUN_MOUNTS.sbd],
      ["TBD", tbd, "tbd", REAR_GUN_MOUNTS.tbd],
    ]) {
      const eye = mesh.userData.gunnerEye;
      assert.ok(eye instanceof Vector3, `the ${name} publishes its gunner eye for the station`);
      const station = createRearStation(id, [eye.x, eye.y, eye.z]);
      assert.ok(station, `the ${name} builds a rear station`);
      assert.equal(station.shell.visible, false, "the FPP shell starts hidden (rear-only)");
      assert.equal(station.pivot.visible, false, "the FPP gun starts hidden (rear-only)");
      assert.ok(station.muzzleError < 0.02, `${name} FPP mouths fit the supplied gun: ${station.muzzleError.toFixed(4)} m`);
      for (const [yaw, pitch] of [[0, 0], [0.5, 0.2], [-0.35, -0.1]]) {
        station.pivot.rotation.set(-pitch, yaw, 0, "YXZ");
        station.pivot.updateMatrixWorld(true);
        // The π yaw swaps the supplied gun's left/right barrel labels; the two measured mouths are
        // symmetric to 8 mm, so what must hold is that every visible muzzle sits on a fired mouth.
        const wanted = [0, 1].map((barrel) => {
          const m = rearGunMuzzle(mount, barrel, yaw, pitch);
          return new Vector3(mount.pivot[0] + m[0], mount.pivot[1] + m[1], mount.pivot[2] + m[2]);
        });
        for (const [i, node] of station.muzzles.entries()) {
          const got = node.getWorldPosition(new Vector3());
          const nearest = Math.min(...wanted.map((w) => got.distanceTo(w)));
          assert.ok(
            nearest < 0.02,
            `${name} FPP muzzle ${i} at yaw ${yaw} pitch ${pitch}: ${nearest.toFixed(4)} m to a fired mouth`,
          );
        }
      }
      station.dispose();
    }
    // The AI builds above never carry an FPP station.
    assert.equal(parkedTbd.userData.rearStation, undefined, "a parked TBD allocates no first-person station");
  }
  assert.equal(tbd.name, "Douglas TBD-1 Devastator", "the player TBD is the ported airframe");
  assert.ok(tbd.userData.devastator, "the player TBD is the ported Devastator");
  const tbdSpan = new Box3().setFromObject(tbd).getSize(new Vector3()).x;
  assert.ok(Math.abs(tbdSpan - 15.24) < 0.05, `TBD span stays measured: ${tbdSpan}`);
  tbd.updateMatrixWorld(true);
  assert.ok(
    Math.abs(new Box3().setFromObject(tbd).min.y + 1.82) < 0.02,
    "the Devastator rests on the 1.82 m gear datum the flight model and the deck park both use",
  );
  // The TBD's own two-man cockpit: the same shared rig, seated on the ported airframe's own seats,
  // published with the same freeze/LOD contract as the Douglas.
  const tbdPilot = tbd.getObjectByName("TBD front pilot crew");
  const tbdGunner = tbd.getObjectByName("TBD rear gunner crew");
  assert.ok(tbdPilot && tbdGunner, "every TBD seats a visible two-man crew");
  assert.deepEqual(tbd.userData.crew, [tbdPilot], "the TBD forward pilot is the cockpit-view crew hook");
  assert.equal(tbd.userData.pilotRig.current, "sit", "the TBD pilot holds the seated clip");
  assert.equal(tbd.userData.gunnerRig.current, "gunner-grip", "the TBD gunner holds the baked grip clip");
  assert.ok(tbd.userData.gunnerEye instanceof Vector3, "the TBD gunner eye is a published Vector3");
  assert.ok(
    tbd.userData.gunnerEye.z > tbd.userData.pilotEye.z + 2.5,
    `the TBD gunner sits on the rearmost seat, not the middle one: ${tbd.userData.gunnerEye.z.toFixed(3)}`,
  );
  assert.ok(tbd.userData.rearGun?.isObject3D, "the TBD rear gun pivot is published");
  tbd.updateMatrixWorld(true);
  const tbdPivot = tbd.userData.rearGun.getWorldPosition(new Vector3());
  const tbdMount = REAR_GUN_MOUNTS.tbd;
  assert.ok(
    Math.hypot(tbdPivot.x - tbdMount.pivot[0], tbdPivot.y - tbdMount.pivot[1], tbdPivot.z - tbdMount.pivot[2]) <
      1e-6,
    `the drawn TBD gun pivot equals the fired mount: ${tbdPivot.toArray()}`,
  );
  for (const [label, station] of [["pilot", tbdPilot], ["gunner", tbdGunner]]) {
    let skinned = 0;
    station.traverse((node) => {
      if (node.isSkinnedMesh) skinned += 1;
    });
    assert.equal(skinned, 1, `the TBD ${label} is exactly one skinned rig`);
  }
  // Both station roots carry a MOVING_NODE token, so `freezeNode` stops before baking the skinned
  // children and the sit idle keeps playing on a frozen aircraft.
  for (const name of ["TBD front pilot crew", "TBD rear gunner crew"])
    assert.match(name, /crew|gunner/i, `${name} stays out of the static freeze`);
  // The merged stand-in must skip the skinned crew: its vertices are bind-pose and would bake a
  // T-pose into the distant silhouette.
  const lod = airframeLod(tbd);
  assert.ok(lod, "the TBD builds a merged stand-in");
  const countTriangles = (node) =>
    node.geometry.index ? node.geometry.index.count / 3 : node.geometry.attributes.position.count / 3;
  let fullTriangles = 0;
  let skinnedTriangles = 0;
  tbd.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    fullTriangles += countTriangles(node);
    if (node.isSkinnedMesh) skinnedTriangles += countTriangles(node);
  });
  assert.ok(skinnedTriangles > 0, "the crew really is skinned geometry");
  assert.ok(
    lod.geometry.getAttribute("position").count / 3 <= fullTriangles - skinnedTriangles,
    "the merged stand-in leaves the skinned crew out",
  );
  const tbdGunnerHead = tbdGunner.getObjectByName("Head");
  const tbdHeadBefore = tbdGunnerHead.getWorldPosition(new Vector3()).clone();
  for (let i = 0; i < 24; i++) animateDevastator(tbd, {}, 1 / 60);
  assert.ok(
    tbdGunnerHead.getWorldPosition(new Vector3()).distanceTo(tbdHeadBefore) > 0.0005,
    "the sit idle animates the TBD gunner's own skeleton",
  );
  const part = (name) => tbd.getObjectByName(name);
  const moved = ["aileronleft", "elevator", "flapleft", "gearleft", "rudder"].map(part);
  assert.ok(moved.every(Boolean), "every Devastator flight part is addressable");
  assert.ok(tbd.getObjectByName("airframebody"), "the fuselage is named for the asset contract");
  const tbdNeutral = moved.map((node) => node.quaternion.clone());
  const parkedNeutral = ["aileronleft", "elevator", "flapleft", "gearleft", "rudder"].map((name) =>
    parkedTbd.getObjectByName(name).quaternion.clone(),
  );
  // The model eases toward its targets, so the control values are held until it settles.
  const settle = (values, steps = 60) => {
    for (let i = 0; i < steps; i += 1) animateDevastator(tbd, values, 0.05);
  };
  settle({ rpm: 0.9, elevator: 1, controlAileron: 1, rudder: -1, flapPos: 1, gearPos: 0, torpedo: 1 });
  for (const [i, node] of moved.entries())
    assert.ok(
      node.quaternion.angleTo(tbdNeutral[i]) > 0.05,
      `${node.name} follows its control: ${node.quaternion.angleTo(tbdNeutral[i])}`,
    );
  // The blades are hidden, not the wrapper: `propeller_blades` is what actually turns, and the
  // blur rides the same pivot as a sibling, so hiding the wrapper would take the blur with it.
  assert.equal(part("propeller_blades").visible, false, "the running blades hand off to their blur");
  assert.equal(part("propeller").visible, true, "the propeller pivot itself stays on the aircraft");
  assert.equal(tbd.getObjectByName("Propeller motion blur").visible, true);
  assert.ok(tbd.userData.torpedoLoad, "the Devastator carries its own store");
  for (const [i, name] of ["aileronleft", "elevator", "flapleft", "gearleft", "rudder"].entries())
    assert.ok(
      parkedTbd.getObjectByName(name).quaternion.angleTo(parkedNeutral[i]) < 1e-6,
      `${name} on a second instance is untouched`,
    );
  settle({ rpm: 0, torpedo: 0, flapPos: 0, gearPos: 1 }, 120);
  for (const [i, node] of moved.entries())
    assert.ok(node.quaternion.angleTo(tbdNeutral[i]) < 0.01, `${node.name} returns to neutral`);
  assert.equal(tbd.userData.torpedoLoad.visible, false, "releasing the store hides it once");
  assert.ok(tbd.userData.arrestingHook, "the Devastator carries its hook");
  assert.ok(tbd.userData.cockpit, "the Devastator publishes the pilot eye");
  // Midway-era US star-in-circle on both builds: upper outer wings plus aft fuselage sides.
  for (const [label, group] of [["hero", tbd], ["parked", parkedTbd]]) {
    const marks = [];
    group.traverse((node) => {
      if (node.isMesh && /us-insignia/.test(node.name)) marks.push(node);
    });
    assert.equal(marks.length, 4, `${label} TBD carries four US marks: ${marks.map((m) => m.name)}`);
    for (const mark of marks) {
      assert.ok(mark.material.map, `${label} ${mark.name} has its star texture`);
      assert.equal(mark.castShadow, false, `${label} ${mark.name} casts no shadow`);
    }
  }
  const count = (group) => {
    let triangles = 0;
    group.traverse((node) => {
      if (node.isMesh && node.geometry)
        triangles += node.geometry.index
          ? node.geometry.index.count / 3
          : node.geometry.attributes.position.count / 3;
    });
    return Math.round(triangles);
  };
  assert.ok(
    count(parkedTbd) < count(tbd) * 0.6,
    `the deck-park Devastator is the cheap build: hero ${count(tbd)} vs parked ${count(parkedTbd)}`,
  );
  disposeAirframe(tbd);
  disposeAirframe(parkedTbd);
  console.log(
    "Aircraft check passed: 12 clips, 12.66m span, independent controls and clones, neutral release, throttle stop, separate vertex layout; the ported player TBD drives its own split surfaces, store and hook with independent instance state.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
