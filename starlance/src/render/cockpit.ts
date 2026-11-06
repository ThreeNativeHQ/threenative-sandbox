// Cockpit view: `assets/cockpit.glb` rides the camera. Its controls move with the real input (the
// yoke and its two grips follow the flown stick as one rigid piece, the pedals and throttle follow
// boost and brake, the triggers and lamps follow fire, charge, bomb and roll). Its five screens are
// cockpitScreens.ts.
import {
  Group,
  MathUtils,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  type Texture,
} from "three";
import { CRUISE_SPEED, WARNINGS } from "../entities/Ship.js";
import type { GameState } from "../state.js";
import type { World } from "../world.js";
import { createCockpitHud } from "./cockpitHud.js";
import { applyCockpitLook } from "./cockpitLook.js";
import { createCockpitScreens } from "./cockpitScreens.js";

// The model is 8.9 m wide; the hull is 4 m. Shrunk to a 0.9 m bubble round the eye, every ship effect
// (guns 1.1 m out, the charge orb, contrails) sits beyond the shell, so plain depth testing hides it
// behind the frame. railCamera pulls the near plane in to 0.02 m to match.
const SCALE = 0.1;
// rad: the source scene's "Pilot view" camera looks 2.05 deg down; pitching the cockpit up about the
// eye frames the dash as it does, while the world view stays level.
const TILT = MathUtils.degToRad(2.05);
// Pilot eye in the glb's own space (y up, nose -Z): the .blend's "Pilot view" camera, which frames the
// canopy arch, both hull wings and the five screens at railCamera's 41 deg.
const EYE_X = 0;
const EYE_Y = 2.55;
const EYE_Z = 6.7;
const BOOST_SPAN = 18; // speed above cruise at full boost
const BRAKE_SPAN = 12; // speed below cruise at full brake

// Control travel, radians (and glb units for the yoke's push).
const YOKE_MAX = 0.2; // rad, 11.5 deg of roll either way, about the handle's foot
// glb units the yoke sits below the model's pose: a rolled grip's cap stays under the centre screen.
const YOKE_DROP = 0;
const YOKE_PITCH = 0.2; // rad, 11 deg: the head stays in frame at full pull
const YOKE_LEAN = 0.5; // share of YOKE_MAX a barrel roll adds on top of the stick
const PEDAL_TRAVEL = 0.28;
const THROTTLE_TRAVEL = 0.2; // glb units the knob slides each way
const TRIGGER_TRAVEL = 0.035;
const PULSE = 0.14; // s a trigger or lamp stays lit after a shot
// Hit rattle and low-shield tremor: the rig shakes against the camera, so the dash visibly shudders
// (the camera's own shake only moves the world). Metres and radians at full strength 1.
const RATTLE_POS = 0.006;
const RATTLE_ROT = 0.012;
const RATTLE_DECAY = 7; // 1/s, how fast a hit's jolt dies
const TREMOR = [0.1, 0.25] as const; // steady shudder at the warning and critical shield levels

interface IScreen {
  /** Centre (glb space) and size of the glass; quads go `z` toward the pilot to clear it. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  /** In-plane tilt of the glass, radians. */
  roll?: number;
}

// Measured on the model's screen planes (Blender x, z, -y); each sits just behind its bezel lip. The
// side glasses lean 5 deg (upper) and 6.3 deg (lower) inboard-up, so their pictures lean with them.
const SIDE = MathUtils.degToRad(5);
const LOW = MathUtils.degToRad(6.3);
const CENTRE: IScreen = { x: 0, y: 1.69, z: 0.02, w: 2.04, h: 0.76 };
const COMMS: IScreen = { x: -2.365, y: 1.52, z: 0.155, w: 1.75, h: 0.76, roll: SIDE };
const MINIMAP: IScreen = { x: 2.365, y: 1.52, z: 0.155, w: 1.75, h: 0.76, roll: -SIDE };
const STORES: IScreen = { x: -2.48, y: 0.55, z: 0.145, w: 1.34, h: 0.62, roll: LOW };
const FIRING: IScreen = { x: 2.48, y: 0.55, z: 0.145, w: 1.34, h: 0.62, roll: -LOW };

export interface ICockpit {
  update(w: World, state: Readonly<GameState>, dt: number): void;
  dispose(): void;
}

export function createCockpit(
  model: Object3D,
  camera: PerspectiveCamera,
  crew: Readonly<Record<string, Texture>> = {},
): ICockpit {
  const root = new Group();
  root.name = "cockpit";
  root.scale.setScalar(SCALE);
  // The eye is the camera origin, and the camera looks down -Z like the model.
  root.position.set(-EYE_X * SCALE, -EYE_Y * SCALE, -EYE_Z * SCALE);
  model.traverse((object) => {
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = false;
  });
  root.add(model);
  const look = applyCockpitLook(model, {
    eye: [EYE_X, EYE_Y, EYE_Z],
    screens: [CENTRE, COMMS, MINIMAP, STORES, FIRING],
    screenReflect: 0.3,
  });
  const hud = createCockpitHud(camera, 1.5);
  const screens = createCockpitScreens(
    root,
    { centre: CENTRE, comms: COMMS, minimap: MINIMAP, stores: STORES, firing: FIRING },
    crew,
  );
  root.visible = false;
  // The cockpit is pitched about the eye (TILT) to place the dash in the frame.
  const rig = new Group();
  rig.rotation.x = TILT;
  rig.add(root);
  camera.add(rig);

  // ---- moving parts, found by the names tools/cockpit-build.py gives them ---------------------
  const part = (name: string): Object3D => {
    const found = model.getObjectByName(name);
    if (found === undefined) throw new Error(`cockpit.glb has no node named ${name}`);
    return found;
  };
  const yoke = part("yoke");
  yoke.position.y -= YOKE_DROP;
  const pedalL = part("pedal_L");
  const pedalR = part("pedal_R");
  const throttle = part("throttle");
  const throttleY = throttle.position.y;
  const triggerL = part("trigger_L");
  const triggerR = part("trigger_R");
  const triggerZ = triggerL.position.z;
  /** A glowing part: `level` 0..1 dims both its colour and its emission from what it shipped with. */
  const glow = (name: string) => {
    const material = (part(name) as Mesh).material as MeshStandardMaterial;
    const color = material.color.clone();
    const emissive = material.emissive.clone();
    return (level: number): void => {
      material.color.copy(color).multiplyScalar(0.08 + 0.92 * level);
      material.emissive.copy(emissive).multiplyScalar(level);
    };
  };
  const trigL = glow("trigger_L");
  const trigR = glow("trigger_R");
  // Left bank: fire, charge, bomb, roll. Right bank: boost, brake, lock, alert.
  const lamps = [
    "lamp_L0",
    "lamp_L1",
    "lamp_L2",
    "lamp_L3",
    "lamp_R0",
    "lamp_R1",
    "lamp_R2",
    "lamp_R3",
  ].map(glow);

  let clock = 0;
  let jolt = 0;
  let wasHit = false;
  let shots = 0;
  let bombs = 0;
  let fireT = 0;
  let bombT = 0;
  const blink = (hz: number): boolean => Math.sin(clock * hz * Math.PI * 2) > 0;
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

  // ---- the controls follow the real input ---------------------------------------------------------------
  const out: Record<string, number | boolean> = {};
  let fireCount = 0;
  let barrelSign = 0;
  const animate = (w: World, state: Readonly<GameState>, dt: number): void => {
    const { ship, weapons } = w;
    if (weapons.shotsFired !== shots) {
      fireT = PULSE;
      fireCount += 1;
    }
    if (weapons.bombsUsed !== bombs) bombT = 0.5;
    shots = weapons.shotsFired;
    bombs = weapons.bombsUsed;
    fireT = Math.max(0, fireT - dt);
    bombT = Math.max(0, bombT - dt);
    let contacts = 0;
    for (const t of w.enemies.targets) if (t.alive) contacts += 1;
    const sx = ship.stick.x;
    const sy = ship.stick.y;
    // The centre handle leans with the flown stick (pull back is nose up) and into a barrel roll.
    if (!ship.rolling) barrelSign = 0;
    else if (barrelSign === 0) barrelSign = Math.sign(sx);
    yoke.rotation.z = -MathUtils.clamp(sx + barrelSign * YOKE_LEAN, -1, 1) * YOKE_MAX;
    yoke.rotation.x = sy * YOKE_PITCH;
    const boost = clamp01((ship.speed - CRUISE_SPEED) / BOOST_SPAN);
    const brake = clamp01((CRUISE_SPEED - ship.speed) / BRAKE_SPAN);
    pedalR.rotation.x = -boost * PEDAL_TRAVEL; // toe down
    pedalL.rotation.x = -brake * PEDAL_TRAVEL;
    const lever = Math.max(-1, Math.min(1, (ship.speed - CRUISE_SPEED) / BOOST_SPAN));
    throttle.position.y = throttleY + lever * THROTTLE_TRAVEL; // up to boost, down to brake
    const firingNow = fireT > 0 ? 1 : 0;
    const charging = clamp01(weapons.charge * 4);
    triggerL.position.z = triggerZ - firingNow * TRIGGER_TRAVEL;
    triggerR.position.z = triggerZ - charging * TRIGGER_TRAVEL;
    trigL(firingNow);
    trigR(charging);
    const alert = ship.edgeWarning || state.shield <= 100;
    const lit = [
      firingNow,
      clamp01(weapons.charge),
      bombT > 0 ? 1 : 0,
      ship.rolling ? 1 : 0,
      boost > 0.05 ? 1 : 0,
      brake > 0.05 ? 1 : 0,
      state.locked ? 1 : 0,
      alert && blink(3) ? 1 : 0,
    ];
    for (const [i, level] of lit.entries()) (lamps[i] as (level: number) => void)(level);
    // Numbers for the playtest: what the parts are doing, and what the map shows.
    out.yokeRoll = -yoke.rotation.z / YOKE_MAX;
    const rollDeg = -MathUtils.radToDeg(yoke.rotation.z); // +right
    const pitchDeg = MathUtils.radToDeg(yoke.rotation.x); // +pulled back
    out.yokeRollDeg = rollDeg;
    out.yokePitchDeg = pitchDeg;
    out.throttle = lever;
    out.pedalBoost = boost;
    out.pedalBrake = brake;
    out.triggerFire = firingNow;
    out.triggerCharge = charging;
    out.lampsLit = lit.filter((v) => v > 0.5).length;
    out.mapContacts = contacts;
    // Booleans for `atSteps` assertions, which compare with equals.
    out.yokeRight = sx > 0.4;
    out.yokeBack = sy > 0.4;
    out.yokeLeansRight = rollDeg > 8;
    out.yokeLeansLeft = rollDeg < -8;
    out.yokePulledBack = pitchDeg > 5;
    out.yokePushedIn = pitchDeg < -5;
    out.throttleForward = lever > 0.4;
    out.pedalDown = boost > 0.4;
    out.triggerFired = fireCount > 0;
    out.charging = weapons.charge > 0.4;
    out.mapHasContacts = contacts > 0;
  };

  return {
    update(w, state, dt) {
      const on = w.cameraRig.cockpit;
      root.visible = on;
      w.ship.mesh.visible = !on; // the hull would clip into the eye
      hud.update(w, state, dt); // hides itself when the cockpit is off
      if (!on) return;
      look.update();
      clock += dt;
      const ship = w.ship;
      const low = ship.alive && state.shield < WARNINGS[0];
      const crit = ship.alive && state.shield < WARNINGS[1];
      if (ship.invulnerable && !wasHit) jolt = 1; // a hit (shot or scrape) just landed
      wasHit = ship.invulnerable;
      jolt *= Math.exp(-RATTLE_DECAY * dt);
      const k = jolt + (crit ? TREMOR[1] : low ? TREMOR[0] : 0);
      rig.position.set(
        Math.sin(clock * 47) * RATTLE_POS * k,
        Math.sin(clock * 61 + 1) * RATTLE_POS * k,
        0,
      );
      rig.rotation.set(
        TILT + Math.sin(clock * 39) * RATTLE_ROT * k,
        0,
        Math.sin(clock * 53) * RATTLE_ROT * k,
      );
      // Emergency lighting: the cabin light pulses red while the shield is low, and flashes on a hit.
      const pulse = 0.5 + 0.5 * Math.sin(clock * Math.PI * 2 * (crit ? 2.2 : 1.4));
      const emergency = crit ? 0.5 + 0.5 * pulse : low ? 0.2 + 0.4 * pulse : 0;
      look.alert(Math.max(jolt * 0.8, emergency));
      const peaks = w.cameraRig.cockpitState;
      peaks.rattlePeak = Math.max(Number(peaks.rattlePeak), k);
      peaks.alertPeak = Math.max(Number(peaks.alertPeak), emergency); // shield-driven only, not hit flashes
      animate(w, state, dt);
      Object.assign(w.cameraRig.cockpitState, out);
      screens.update(w, state, dt);
    },
    dispose() {
      rig.removeFromParent();
      look.dispose();
      screens.dispose();
      hud.dispose();
    },
  };
}
