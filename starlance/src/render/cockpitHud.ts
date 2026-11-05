// Combiner HUD for the cockpit view: thin green lines floating on the canopy glass, drawn through
// the HUD's painter (one draw call). Everything is placed by projecting a direction onto a plane
// `distance` m ahead of the eye, so the pitch ladder, horizon, roll scale, heading tape, flight-path
// marker, aim reticles and lock box line up with the world the pilot sees through the glass.
// It reads only public ship and weapons fields, and it is the cockpit's replacement for the chase
// view's reticles (the chase HUD does not draw in cockpit view).
import { Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import type { GameState } from "../state.js";
import type { World } from "../world.js";
import { AMBER, BACK, RED, WHITE, createPainter } from "./hud.js";

const GREEN = 0x6dffb0;
const REF = 1.5; // layout units are metres on a plane this far ahead; `distance` rescales them
const WINDOW_X = 0.46; // ladder window half width, REF metres
const WINDOW_Y = 0.27;
const LADDER_HALF = 0.1; // half length of a pitch rung
const LADDER_GAP = 0.04; // empty centre of a rung
const THIN = 0.0026;
const D2R = Math.PI / 180;
const TAPE_SPEED = 0.011; // m per speed unit
const TAPE_ALT = 0.004; // m per metre of altitude
const HEADING_SPAN = 17; // degrees shown either side

export interface ICockpitHud {
  update(w: World, state: Readonly<GameState>, dt: number): void;
  dispose(): void;
}

const _q = new Quaternion();
const _inv = new Matrix4();
const _up = new Vector3();
const _h = new Vector3();
const _r = new Vector3();
const _d = new Vector3();
const _p = new Vector3();
const _prev = new Vector3();
const _vel = new Vector3();

export function createCockpitHud(parent: Object3D, distance = REF): ICockpitHud {
  const painter = createPainter(1800, { depthTest: false });
  painter.mesh.name = "cockpit-combiner";
  painter.mesh.renderOrder = 1001;
  painter.mesh.visible = false;
  painter.mesh.position.set(0, 0, -distance);
  parent.add(painter.mesh);
  painter.at.scale = distance / REF;
  const { quad, rect, text, textWidth, brackets } = painter;
  const out: Record<string, number> = {};
  let clock = 0;
  let velTime = 0;
  let hasPrev = false;
  const blink = (hz: number): boolean => Math.sin(clock * hz * Math.PI * 2) > 0;

  /** A thin line between two plane points, with a dark under-stroke so it reads on bright sky. */
  const seg = (x0: number, y0: number, x1: number, y1: number, color: number, t = THIN): void => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length < 1e-5) return;
    const a = Math.atan2(dy, dx);
    quad((x0 + x1) / 2 + t * 0.4, (y0 + y1) / 2 - t * 0.4, length + t, t * 1.7, BACK, a);
    quad((x0 + x1) / 2, (y0 + y1) / 2, length + t * 0.6, t, color, a);
  };
  const inside = (x: number, y: number): boolean =>
    Math.abs(x) <= WINDOW_X && Math.abs(y) <= WINDOW_Y;

  // Plane projection of a camera-space direction: false when it is behind the eye.
  const px = { x: 0, y: 0 };
  const plane = (x: number, y: number, z: number): boolean => {
    if (z >= -0.05) return false;
    px.x = (REF * x) / -z;
    px.y = (REF * y) / -z;
    return true;
  };

  const update = (w: World, state: Readonly<GameState>, dt: number): void => {
    const on = w.cameraRig.cockpit;
    painter.mesh.visible = on;
    if (!on) return;
    clock += dt;
    const { ship, weapons } = w;
    parent.updateWorldMatrix(true, false);
    _inv.copy(parent.matrixWorld).invert();
    parent.getWorldQuaternion(_q).invert();
    // World up and the horizontal forward, in eye space (the eye looks down -Z).
    _up.set(0, 1, 0).applyQuaternion(_q);
    const level = Math.max(0, 1 - _up.z * _up.z);
    _h.set(_up.z * _up.x, _up.z * _up.y, -1 + _up.z * _up.z);
    if (level > 1e-4) _h.divideScalar(Math.sqrt(level));
    _r.crossVectors(_h, _up);
    const pitch = Math.asin(Math.max(-1, Math.min(1, -_up.z))) / D2R;
    const roll = Math.atan2(_up.x, _up.y) / D2R; // zenith's clockwise angle on screen
    painter.begin();

    // ---- pitch ladder and horizon ----------------------------------------------------------
    let rungs = 0;
    if (level > 1e-4) {
      const rung = (deg: number, half: number, gap: number, dashed: boolean): void => {
        const e = deg * D2R;
        const cosE = Math.cos(e);
        const sinE = Math.sin(e);
        // Rung ends sit `half` along the horizon's tangent, so the rung follows the roll.
        for (const side of [-1, 1] as const) {
          const ends: Array<[number, number]> = [];
          for (const along of [gap, half]) {
            const s = (side * along) / REF;
            _d.set(
              cosE * _h.x + sinE * _up.x + s * _r.x,
              cosE * _h.y + sinE * _up.y + s * _r.y,
              cosE * _h.z + sinE * _up.z + s * _r.z,
            );
            if (!plane(_d.x, _d.y, _d.z) || !inside(px.x, px.y)) return;
            ends.push([px.x, px.y]);
          }
          const [a, b] = ends as [[number, number], [number, number]];
          if (dashed) {
            const mx = (a[0] + b[0]) / 2;
            const my = (a[1] + b[1]) / 2;
            seg(a[0], a[1], (a[0] + mx) / 2, (a[1] + my) / 2, GREEN);
            seg((mx + b[0]) / 2, (my + b[1]) / 2, b[0], b[1], GREEN);
          } else seg(a[0], a[1], b[0], b[1], GREEN);
          if (deg !== 0) {
            // End tick toward the horizon, and the angle beside the far end.
            const tick = (Math.sign(-deg) * 0.012) / Math.hypot(_up.x, _up.y);
            seg(b[0], b[1], b[0] + _up.x * tick, b[1] + _up.y * tick, GREEN);
            if (side === 1) text(String(Math.abs(deg)), b[0] + 0.012, b[1] + 0.009, 0.0045, GREEN);
          }
        }
        rungs += 1;
      };
      const base = Math.round(pitch / 5) * 5;
      for (let k = -3; k <= 3; k += 1) {
        const deg = base + k * 5;
        if (deg === 0) rung(0, 0.38, 0.05, false);
        else if (Math.abs(deg) <= 85) rung(deg, LADDER_HALF, LADDER_GAP, deg < 0);
      }
    }

    // ---- boresight: fixed to the airframe, the "where the nose points" mark ------------------
    seg(-0.028, 0, -0.012, 0, GREEN);
    seg(0.012, 0, 0.028, 0, GREEN);
    seg(0, 0.012, 0, 0.026, GREEN);

    // ---- aim reticles along the nose (near 25 m, far 60 m), charge ring --------------------------
    const view = (point: Vector3): boolean => {
      _p.copy(point).applyMatrix4(_inv);
      return plane(_p.x, _p.y, _p.z);
    };
    _d.copy(ship.position).addScaledVector(ship.forward, 60);
    if (view(_d) && Math.abs(px.x) < 0.8 && Math.abs(px.y) < 0.45) {
      brackets(px.x, px.y, 0.016, 0.006, THIN, WHITE);
      quad(px.x, px.y, 0.003, 0.003, WHITE);
    }
    _d.copy(ship.position).addScaledVector(ship.forward, 25);
    if (view(_d) && Math.abs(px.x) < 0.8 && Math.abs(px.y) < 0.45) {
      const cx = px.x;
      const cy = px.y;
      const r = 0.036;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        seg(cx + dx * r * 0.62, cy + dy * r * 0.62, cx + dx * r, cy + dy * r, GREEN);
      }
      quad(cx, cy, 0.0034, 0.0034, WHITE);
      if (state.charge > 0.02) {
        const full = state.charge >= 0.999;
        const segs = 32;
        for (let k = 0; k < segs; k += 1) {
          const a = Math.PI / 2 - ((k + 0.5) / segs) * Math.PI * 2;
          const lit = (k + 0.5) / segs <= state.charge;
          quad(
            cx + Math.cos(a) * 0.058,
            cy + Math.sin(a) * 0.058,
            0.0034,
            0.0098,
            lit ? (full ? WHITE : GREEN) : BACK,
            a,
          );
        }
      }
    }

    // ---- flight-path marker: where the ship is actually going --------------------------------
    if (!hasPrev) _prev.copy(ship.position);
    hasPrev = true;
    velTime += dt;
    if (!_prev.equals(ship.position)) {
      _vel.lerp(_p.copy(ship.position).sub(_prev).divideScalar(velTime), 0.5);
      _prev.copy(ship.position);
      velTime = 0;
    }
    if (_vel.lengthSq() > 1) {
      _d.copy(ship.position).addScaledVector(_vel, (1 / Math.max(_vel.length(), 1)) * 60);
      if (view(_d) && inside(px.x, px.y)) {
        const fx = px.x;
        const fy = px.y;
        for (let k = 0; k < 16; k += 1) {
          const a = (k / 16) * Math.PI * 2;
          quad(fx + Math.cos(a) * 0.014, fy + Math.sin(a) * 0.014, 0.0026, 0.0026, GREEN);
        }
        seg(fx - 0.03, fy, fx - 0.015, fy, GREEN);
        seg(fx + 0.015, fy, fx + 0.03, fy, GREEN);
        seg(fx, fy + 0.015, fx, fy + 0.026, GREEN);
      }
    }

    // ---- roll scale (top arc), pointer follows the zenith -------------------------------------
    const arc = 0.3;
    for (const deg of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const a = deg * D2R;
      const long = deg % 30 === 0 ? 0.02 : 0.011;
      seg(
        Math.sin(a) * arc,
        Math.cos(a) * arc,
        Math.sin(a) * (arc + long),
        Math.cos(a) * (arc + long),
        GREEN,
      );
    }
    const clamped = Math.max(-75, Math.min(75, roll)) * D2R;
    const ax = Math.sin(clamped) * (arc - 0.012);
    const ay = Math.cos(clamped) * (arc - 0.012);
    quad(ax, ay, 0.012, 0.012, Math.abs(roll) > 70 ? AMBER : WHITE, Math.PI / 4 - clamped);

    // ---- heading tape (bottom): ticks every 5 deg, numbers every 10 -----------------------------
    const heading = ship.heading;
    const ty = -0.3;
    const unit = 0.0262; // m per degree at REF
    seg(-0.45, ty, 0.45, ty, GREEN, 0.0016);
    const first = Math.ceil((heading - HEADING_SPAN) / 5) * 5;
    for (let deg = first; deg <= heading + HEADING_SPAN; deg += 5) {
      const x = (deg - heading) * unit;
      const major = deg % 10 === 0;
      seg(x, ty, x, ty + (major ? 0.02 : 0.011), GREEN);
      if (major) {
        const wrapped = ((deg % 360) + 360) % 360;
        const name = ({ 0: "N", 90: "E", 180: "S", 270: "W" } as Record<number, string>)[wrapped];
        const label = name ?? String(wrapped / 10).padStart(2, "0");
        text(label, x, ty - 0.008, 0.0048, name === undefined ? GREEN : WHITE, "center");
      }
    }
    seg(0, ty + 0.034, -0.012, ty + 0.05, WHITE);
    seg(0, ty + 0.034, 0.012, ty + 0.05, WHITE);

    // ---- speed (left) and altitude (right) tapes ------------------------------------------------
    const tape = (
      x: number,
      value: number,
      scale: number,
      step: number,
      label: (v: number) => string,
      long: number,
      side: 1 | -1,
    ): void => {
      const span = WINDOW_Y / scale;
      for (let v = Math.ceil((value - span) / step) * step; v <= value + span; v += step) {
        const y = (v - value) * scale;
        const major = v % long === 0;
        seg(x, y, x - side * (major ? 0.024 : 0.013), y, GREEN);
        if (major)
          text(label(v), x - side * 0.03, y + 0.008, 0.0045, GREEN, side === 1 ? "right" : "left");
      }
      seg(x, -WINDOW_Y, x, WINDOW_Y, GREEN, 0.0016);
      // The value, boxed at the centre line.
      const s = label(value);
      const bw = textWidth(s, 0.0055) + 0.02;
      const bx = x + side * 0.012;
      rect(bx, 0.016, bx + side * bw, -0.016, BACK);
      text(s, bx + side * (bw / 2), 0.0138, 0.0055, WHITE, "center");
    };
    tape(-0.5, ship.speed, TAPE_SPEED, 2, (v) => String(Math.round(v)), 10, 1);
    tape(0.5, ship.position.y, TAPE_ALT, 10, (v) => String(Math.round(v)), 50, -1);
    text("SPD", -0.5, WINDOW_Y + 0.03, 0.0045, GREEN, "center");
    text("ALT", 0.5, WINDOW_Y + 0.03, 0.0045, GREEN, "center");

    // ---- lock box ---------------------------------------------------------------------------------
    const target = weapons.lockedTarget;
    let boxed = 0;
    if (
      target !== null &&
      target.alive &&
      view(target.position) &&
      Math.abs(px.x) < 0.8 &&
      px.y < 0.45 &&
      px.y > -0.25
    ) {
      boxed = 1;
      const range = _p.length();
      const half = Math.max(0.035, (REF * target.radius * 0.75) / Math.max(range, 1));
      const lockedIn = blink(6);
      brackets(px.x, px.y, half, half * 0.45, 0.0032, lockedIn ? WHITE : RED);
      quad(px.x, px.y, 0.006, 0.006, RED, Math.PI / 4);
      text("LOCK", px.x, px.y - half - 0.012, 0.0048, RED, "center");
      text(String(Math.round(range)), px.x, px.y + half + 0.03, 0.0045, GREEN, "center");
    }

    painter.end();
    out.hudShown = 1;
    out.hudRolled = Math.abs(roll) > 4 ? 1 : 0;
    out.hudPitchedUp = pitch > 4 ? 1 : 0;
    out.hudPitchedDown = pitch < -4 ? 1 : 0;
    out.hudPitchDeg = pitch;
    out.hudRollDeg = roll;
    out.hudLadder = rungs;
    out.hudLockBox = boxed;
    out.hudHeading = heading;
    out.hudQuads = painter.mesh.count;
    Object.assign(w.cameraRig.cockpitState, out);
  };

  return {
    update,
    dispose: painter.dispose,
  };
}
