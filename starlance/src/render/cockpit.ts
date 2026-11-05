// Cockpit view: `assets/cockpit.glb` rides the camera. Its controls move with the real input (the
// sticks and yoke follow the flown stick, the pedals and throttle follow boost and brake, the
// triggers and lamps follow fire, charge, bomb and roll), and its five screens show live game data.
// The glb carries no screen artwork, only dark glass, so every gauge below is a quad drawn through the
// HUD's painter (one draw call, no canvas, no DOM) on the glass.
import {
  Group,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
} from "three";
import { ARENA_RADIUS, railFrame } from "../entities/Rail.js";
import { CORRIDOR, CRUISE_SPEED } from "../entities/Ship.js";
import type { GameState } from "../state.js";
import type { World } from "../world.js";
import { AMBER, BACK, CYAN, DIM, RED, VIOLET, WHITE, createPainter } from "./hud.js";

// The model is 8.9 m wide; the hull is 5 m. Scaled down, the screens sit about 1 m from the eye and
// nothing in the world can get nearer than the glass.
const SCALE = 0.2;
const TILT = 0.11; // rad
// Pilot eye in the glb's own space (y up, nose -Z).
const EYE_X = 0;
const EYE_Y = 2.55;
const EYE_Z = 5.2;
const GREEN = 0x57ff9a;
const SCREEN = 0x04101c;
const MAP_RANGE = 250; // m from the ship to the minimap rim
const SPEED_MIN = 18; // brake floor
const SPEED_SPAN = 30; // brake floor to boost ceiling
const BOOST_SPAN = 18; // speed above cruise at full boost
const BRAKE_SPAN = 12; // speed below cruise at full brake
const WING_MAX = 60;
const SHIELD_WING = 255; // wingman shield at full

const GLASS = "Display deep glass";
// Linear colour multiplied over each textured material's maps (read from the source model).
const TINT: Record<string, readonly [number, number, number]> = {
  "Worn blue graphite | microtexture": [0.2, 0.3, 0.5],
  "Cobalt painted armor": [0.03, 0.1, 0.4],
  "Frame | scratched gunmetal PBR": [0.14, 0.16, 0.21],
  "Controls | black worn leather PBR": [0.65, 0.68, 0.72],
};

// Control travel, radians (and glb units for the yoke's push).
const STICK_ROLL = 0.38;
const STICK_PITCH = 0.3;
const YOKE_ROLL = 0.6;
const YOKE_PUSH = 0.14;
const PEDAL_TRAVEL = 0.28;
const THROTTLE_TRAVEL = 0.2; // glb units the knob slides each way
const TRIGGER_TRAVEL = 0.035;
const PULSE = 0.14; // s a trigger or lamp stays lit after a shot

interface IScreen {
  /** Centre (glb space) and size of the glass; quads go `z` toward the pilot to clear it. */
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
}

// Measured on the model's screen planes (Blender x, z, -y).
const CENTRE: IScreen = { x: 0, y: 2.09, z: 0.04, w: 2.04, h: 0.76 };
const COMMS: IScreen = { x: -2.325, y: 1.87, z: 0.17, w: 1.73, h: 0.74 };
const MINIMAP: IScreen = { x: 2.325, y: 1.87, z: 0.17, w: 1.73, h: 0.74 };
const STORES: IScreen = { x: -2.48, y: 0.95, z: 0.16, w: 1.34, h: 0.62 };
const FIRING: IScreen = { x: 2.48, y: 0.95, z: 0.16, w: 1.34, h: 0.62 };

// The crew on the comms screen: our own callsigns, each with a helmet colour and crest.
const CREW = [
  { call: "LANCER", color: CYAN, crest: 0 },
  { call: "KESTREL", color: AMBER, crest: 1 },
  { call: "VEGA", color: GREEN, crest: 2 },
] as const;

export interface ICockpit {
  update(w: World, state: Readonly<GameState>, dt: number): void;
  dispose(): void;
}

export function createCockpit(model: Object3D, camera: PerspectiveCamera): ICockpit {
  const root = new Group();
  root.name = "cockpit";
  root.scale.setScalar(SCALE);
  // The eye is the camera origin, and the camera looks down -Z like the model.
  root.position.set(-EYE_X * SCALE, -EYE_Y * SCALE, -EYE_Z * SCALE);
  model.traverse((object) => {
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = false;
    const material = (object as Mesh).material as MeshStandardMaterial | undefined;
    if (material === undefined) return;
    // The glb keeps each texture but not the tint Blender multiplied over it. `setRGB` is idempotent,
    // so clones that share a material do not tint twice.
    const tint = TINT[material.name];
    if (tint !== undefined) material.color.setRGB(tint[0], tint[1], tint[2]);
    if (material.name === GLASS) {
      material.roughness = 0.85; // a mirror would print the yoke over the gauges
      material.metalness = 0;
    }
  });
  root.add(model);
  const painter = createPainter(4000, { depthTest: true });
  painter.noShadow = true;
  painter.mesh.name = "cockpit-panels";
  root.add(painter.mesh);
  root.visible = false;
  // The cockpit is pitched up about the eye so the pedals and stick bases clear the bottom edge.
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
  const stickL = part("stick_L");
  const stickR = part("stick_R");
  const yoke = part("yoke");
  const yokeZ = yoke.position.z;
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

  const { at, quad, rect, text, frame, textWidth } = painter;
  let clock = 0;
  let shots = 0;
  let bombs = 0;
  let fireT = 0;
  let bombT = 0;
  const blink = (hz: number): boolean => Math.sin(clock * hz * Math.PI * 2) > 0;
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

  /** Points the painter at a screen; coordinates are then screen heights, centred. */
  const open = (s: IScreen): number => {
    at.x = s.x;
    at.y = s.y;
    at.z = s.z;
    at.scale = s.h;
    const half = s.w / s.h / 2;
    rect(-half, 0.5, half, -0.5, SCREEN);
    frame(-half, 0.5, half, -0.5, 0.012, DIM);
    return half;
  };
  const bar = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    ratio: number,
    color: number,
  ): void => {
    rect(x0, y0, x1, y1, BACK);
    rect(x0 + 0.008, y0 - 0.008, x0 + 0.008 + (x1 - x0 - 0.016) * ratio, y1 + 0.008, color);
    frame(x0, y0, x1, y1, 0.008, VIOLET);
  };
  /** A labelled gauge row: label, bar, value; `y` is the row's top edge. */
  const row = (
    label: string,
    value: string,
    ratio: number,
    color: number,
    x0: number,
    x1: number,
    y: number,
    px: number,
  ): void => {
    text(label, x0, y, px, CYAN);
    bar(x0 + 0.55, x1 - 0.3, y - px * 0.5, y - px * 4.5, ratio, color);
    text(value, x1, y, px, WHITE, "right");
  };
  const pips = (n: number, lit: number, x: number, y: number, step: number, size: number): void => {
    for (let k = 0; k < n; k += 1)
      quad(x + k * step, y, size, size, k < lit ? CYAN : DIM, Math.PI / 4);
  };

  // ---- centre: ship status ----------------------------------------------------------------------
  const centre = (w: World, state: Readonly<GameState>): void => {
    const half = open(CENTRE);
    const ship = w.ship;
    const l = -half + 0.1;
    const r = half - 0.1;
    const px = 0.021;
    text("STARLANCE", l, 0.47, 0.016, WHITE);
    text("LANCER 7X", r, 0.47, 0.016, CYAN, "right");
    const low = state.shield <= 100;
    const crit = state.shield <= 50;
    row(
      "SHIELD",
      String(Math.ceil(state.shield)),
      clamp01(state.shield / state.shieldMax),
      crit ? (blink(4) ? RED : AMBER) : low ? AMBER : CYAN,
      l,
      r,
      0.33,
      px,
    );
    row(
      ship.boostLatched ? "WAIT" : "BOOST",
      String(Math.round(clamp01(state.boost) * 100)),
      clamp01(state.boost),
      ship.boostLatched ? AMBER : CYAN,
      l,
      r,
      0.11,
      px,
    );
    row(
      "SPEED",
      String(Math.round(ship.speed)),
      clamp01((ship.speed - SPEED_MIN) / SPEED_SPAN),
      CYAN,
      l,
      r,
      -0.11,
      px,
    );
    text("WING", l, -0.33, px, CYAN);
    for (const [k, hp] of [ship.wings.left, ship.wings.right].entries()) {
      const frac = clamp01(hp / WING_MAX);
      const x0 = l + 0.55 + k * 0.6;
      bar(
        x0,
        x0 + 0.5,
        -0.33 - px * 0.5,
        -0.33 - px * 4.5,
        frac,
        hp <= 0 ? RED : frac < 0.5 ? AMBER : CYAN,
      );
    }
    text("L   R", r, -0.33, px, WHITE, "right");
  };

  // ---- upper left: the crew's comms (originals: helmet icons and callsigns) ------------------------
  const helmet = (x: number, y: number, color: number, crest: number, alive: boolean): void => {
    const c = alive ? color : DIM;
    rect(x - 0.17, y - 0.1, x + 0.17, y - 0.2, DIM); // shoulders
    rect(x - 0.12, y + 0.14, x + 0.12, y - 0.1, 0x1a2a44); // helmet
    rect(x - 0.12, y + 0.02, x + 0.12, y - 0.05, c); // visor
    if (crest === 0) {
      quad(x - 0.04, y + 0.11, 0.1, 0.014, c, 0.7);
      quad(x + 0.04, y + 0.11, 0.1, 0.014, c, -0.7);
    } else if (crest === 1) {
      rect(x - 0.1, y + 0.1, x + 0.1, y + 0.085, c);
      rect(x - 0.1, y + 0.065, x + 0.1, y + 0.05, c);
    } else quad(x, y + 0.095, 0.035, 0.035, c, Math.PI / 4);
    rect(x - 0.03, y - 0.1, x + 0.03, y - 0.14, c); // chin plate
  };
  const comms = (w: World, state: Readonly<GameState>): void => {
    const half = open(COMMS);
    const px = 0.02;
    const cardW = 0.66;
    const gap = 0.07;
    const x0 = -half + 0.1;
    for (const [k, crew] of CREW.entries()) {
      const mate = k === 0 ? undefined : w.wingmen.members[k - 1];
      const alive = k === 0 ? w.ship.alive : mate !== undefined && mate.alive;
      const hp =
        k === 0
          ? state.shield / state.shieldMax
          : mate === undefined
            ? 0
            : mate.shield / SHIELD_WING;
      const call = k === 0 || mate === undefined || !mate.chased ? false : blink(3);
      const left = x0 + k * (cardW + gap);
      const mid = left + cardW / 2;
      rect(left, 0.45, left + cardW, -0.22, SCREEN);
      frame(left, 0.45, left + cardW, -0.22, 0.01, call ? AMBER : alive ? crew.color : DIM);
      helmet(mid, 0.28, crew.color, crew.crest, alive);
      text(crew.call, mid, 0.02, px, alive ? WHITE : DIM, "center");
      bar(
        left + 0.06,
        left + cardW - 0.06,
        -0.08,
        -0.14,
        clamp01(hp),
        hp < 0.3 ? AMBER : crew.color,
      );
      if (mate !== undefined && mate.chased)
        text("HELP", mid, -0.16 + 0.0, px * 0.75, AMBER, "center");
      else if (mate !== undefined && mate.retreating)
        text("RTB", mid, -0.16, px * 0.75, DIM, "center");
    }
    text("HITS", -half + 0.1, -0.3, px, CYAN);
    text(
      String(state.hits).padStart(3, "0"),
      -half + 0.1 + textWidth("HITS ", px),
      -0.3,
      px,
      WHITE,
    );
    text(`DIST ${Math.round(state.distance)}M`, half - 0.1, -0.3, px, WHITE, "right");
    text(w.rail.done ? "ARENA" : "RAIL", half - 0.1, -0.41, px, CYAN, "right");
  };

  // ---- upper right: minimap, ship at the centre, heading up -----------------------------------------
  const hr = { x: 1, z: 0 }; // horizontal right and forward (flattened ship basis)
  const hf = { x: 0, z: -1 };
  const mapPoints = { contacts: 0 };
  const _frame = railFrame();
  const minimap = (w: World, state: Readonly<GameState>): void => {
    const half = open(MINIMAP);
    const ship = w.ship;
    const cx = -half + 0.52;
    const rad = 0.43;
    const px = 0.026;
    // The map's up is where the nose points over the ground: a loop must not flip it.
    const len = Math.hypot(ship.forward.x, ship.forward.z);
    if (len > 0.05) {
      hf.x = ship.forward.x / len;
      hf.z = ship.forward.z / len;
      hr.x = -hf.z;
      hr.z = hf.x;
    }
    // World offset from the ship -> map units (1 = rim). Returns false past the rim.
    let mx = 0;
    let my = 0;
    const toMap = (dx: number, dz: number): boolean => {
      mx = (dx * hr.x + dz * hr.z) / MAP_RANGE;
      my = (dx * hf.x + dz * hf.z) / MAP_RANGE;
      return Math.hypot(mx, my) <= 1;
    };
    // Rim, half-range ring, cross hairs.
    for (const [rr, n] of [
      [rad, 48],
      [rad * 0.5, 28],
    ] as const)
      for (let k = 0; k < n; k += 1) {
        const a = (k / n) * Math.PI * 2;
        quad(cx + Math.cos(a) * rr, Math.sin(a) * rr, 0.014, 0.014, rr === rad ? CYAN : DIM, a);
      }
    rect(cx - rad, 0.003, cx + rad, -0.003, DIM);
    rect(cx - 0.003, rad, cx + 0.003, -rad, DIM);
    // North marker on the rim: it swings as the ship turns.
    const heading = Math.atan2(hf.x, -hf.z);
    text(
      "N",
      cx - Math.sin(heading) * (rad + 0.06),
      0.012 + Math.cos(heading) * (rad + 0.06),
      px * 0.8,
      WHITE,
      "center",
    );
    // Course: the rail corridor's two edges, or the arena boundary.
    const dot = (color: number): void => {
      if (Math.hypot(mx, my) <= 1) quad(cx + mx * rad, my * rad, 0.016, 0.016, color);
    };
    if (w.rail.done) {
      const cxw = w.rail.arenaCenter.x - ship.position.x;
      const czw = w.rail.arenaCenter.z - ship.position.z;
      for (let k = 0; k < 90; k += 1) {
        const a = (k / 90) * Math.PI * 2;
        toMap(cxw + Math.cos(a) * ARENA_RADIUS, czw + Math.sin(a) * ARENA_RADIUS);
        dot(AMBER);
      }
    } else {
      const f = w.rail.frame(w.rail.s, _frame);
      for (const side of [-1, 1]) {
        const lateral = side * CORRIDOR.halfWidth - ship.offset.x;
        for (let t = -MAP_RANGE; t <= MAP_RANGE; t += 15) {
          toMap(f.right.x * lateral + f.forward.x * t, f.right.z * lateral + f.forward.z * t);
          dot(w.ship.edgeWarning ? (blink(4) ? RED : AMBER) : VIOLET);
        }
      }
    }
    // Contacts. A foe past the rim sits on it, dimmer.
    const place = (p: { x: number; z: number }, color: number, size: number): void => {
      const inside = toMap(p.x - ship.position.x, p.z - ship.position.z);
      const k = inside ? 1 : 1 / Math.hypot(mx, my);
      quad(cx + mx * k * rad, my * k * rad, size, size, inside ? color : DIM, Math.PI / 4);
    };
    for (const m of w.wingmen.members) if (m.alive) place(m.position, GREEN, 0.034);
    let contacts = 0;
    for (const t of w.enemies.targets) {
      if (!t.alive) continue;
      contacts += 1;
      const locked = w.weapons.lockedTarget === t;
      place(
        t.position,
        locked ? (blink(6) ? WHITE : RED) : t.lockable ? RED : AMBER,
        locked ? 0.05 : 0.034,
      );
    }
    mapPoints.contacts = contacts;
    quad(cx, 0, 0.028, 0.05, WHITE); // own ship
    // Readout column.
    const x = cx + rad + 0.2;
    const r = half - 0.1;
    text("MINIMAP", x, 0.42, px, CYAN);
    text("CONTACTS", x, 0.24, px * 0.85, CYAN);
    text(String(contacts).padStart(2, "0"), r, 0.26, px * 1.3, WHITE, "right");
    text("HDG", x, 0.04, px * 0.85, CYAN);
    text(String(Math.round(ship.heading)).padStart(3, "0"), r, 0.06, px * 1.3, WHITE, "right");
    text("RANGE", x, -0.16, px * 0.85, CYAN);
    text(`${MAP_RANGE}M`, r, -0.14, px * 1.3, WHITE, "right");
    const warn = ship.edgeWarning;
    text(
      state.locked ? "LOCKED" : warn ? "EDGE" : "SCAN",
      x,
      -0.36,
      px,
      state.locked ? (blink(6) ? WHITE : RED) : warn ? (blink(4) ? AMBER : RED) : GREEN,
    );
  };

  // ---- lower consoles ---------------------------------------------------------------------------------
  const stores = (state: Readonly<GameState>): void => {
    const half = open(STORES);
    const l = -half + 0.32; // the console strut hides the glass's left edge
    const px = 0.045;
    text("BOMB", l, 0.34, px, CYAN);
    text(String(state.bombs), half - 0.1, 0.34, px, WHITE, "right");
    pips(9, state.bombs, l + 0.04, 0.06, 0.13, 0.07);
    text("LASER", l, -0.12, px, CYAN);
    text(`LV ${state.laserLevel + 1}`, half - 0.1, -0.12, px, WHITE, "right");
    pips(3, state.laserLevel + 1, l + 0.04, -0.4, 0.13, 0.07);
  };

  const firing = (state: Readonly<GameState>): void => {
    const half = open(FIRING);
    const l = -half + 0.1;
    const r = half - 0.3; // the armrest hides the glass's right edge
    const px = 0.045;
    text("CHARGE", l, 0.34, px, CYAN);
    bar(l, r, 0.06, -0.1, clamp01(state.charge), state.charge >= 0.999 ? WHITE : CYAN);
    text("LOCK", l, -0.18, px, CYAN);
    text(
      state.locked ? "ON" : "---",
      r,
      -0.18,
      px * 1.4,
      state.locked ? (blink(6) ? WHITE : RED) : DIM,
      "right",
    );
  };

  // ---- the controls follow the real input ---------------------------------------------------------------
  const out: Record<string, number | boolean> = {};
  let fireCount = 0;
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
    const sx = ship.stick.x;
    const sy = ship.stick.y;
    for (const s of [stickL, stickR]) {
      s.rotation.z = -sx * STICK_ROLL; // top of the stick swings the way the pilot steers
      s.rotation.x = sy * STICK_PITCH; // pull back to climb
    }
    yoke.rotation.z = -sx * YOKE_ROLL;
    yoke.position.z = yokeZ + sy * YOKE_PUSH;
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
    out.stickRoll = -stickL.rotation.z / STICK_ROLL;
    out.stickPitch = stickL.rotation.x / STICK_PITCH;
    out.yokeRoll = -yoke.rotation.z / YOKE_ROLL;
    out.throttle = lever;
    out.pedalBoost = boost;
    out.pedalBrake = brake;
    out.triggerFire = firingNow;
    out.triggerCharge = charging;
    out.lampsLit = lit.filter((v) => v > 0.5).length;
    out.mapContacts = mapPoints.contacts;
    // Booleans for `atSteps` assertions, which compare with equals.
    out.yokeRight = sx > 0.4;
    out.yokeBack = sy > 0.4;
    out.throttleForward = lever > 0.4;
    out.pedalDown = boost > 0.4;
    out.triggerFired = fireCount > 0;
    out.charging = weapons.charge > 0.4;
    out.mapHasContacts = mapPoints.contacts > 0;
  };

  return {
    update(w, state, dt) {
      const on = w.cameraRig.cockpit;
      root.visible = on;
      w.ship.mesh.visible = !on; // the hull would clip into the eye
      if (!on) return;
      clock += dt;
      animate(w, state, dt);
      Object.assign(w.cameraRig.cockpitState, out);
      painter.begin();
      centre(w, state);
      comms(w, state);
      minimap(w, state);
      stores(state);
      firing(state);
      painter.end();
    },
    dispose() {
      rig.removeFromParent();
      painter.dispose();
    },
  };
}
