// Combiner HUD for the cockpit view, stripped to what the pilot needs to aim: the aim reticles
// (near 25 m with the charge ring, far 60 m) and the lock-on box, as thin lines with a dark outline
// on the glass. Everything is placed by projecting a direction onto a plane `distance` m ahead of
// the eye, so it lines up with the world through the window. No speed, altitude, ladder or compass:
// the displays carry those. It replaces the chase view's reticles (the chase HUD is hidden here).
import { Matrix4, type MeshBasicMaterial, type Object3D, Quaternion, Vector3 } from "three";
import type { GameState } from "../state.js";
import type { World } from "../world.js";
import { LOOK_OFF } from "./cockpitLook.js";
import { BACK, createPainter } from "./hud.js";
import { STYLE } from "./hudStyle.js";
import { strokeText } from "./strokeFont.js";

const GREEN = STYLE.mint;
const WHITE = STYLE.ice;
const RED = STYLE.red;
const GAIN = 2.2; // colour multiplier: the HUD is emissive, so the bloom catches it
const REF = 1.5; // layout units are metres on a plane this far ahead; `distance` rescales them
const THIN = 0.0042;
const D2R = Math.PI / 180;

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

export function createCockpitHud(parent: Object3D, distance = REF): ICockpitHud {
  // Depth-tested on the glass plane: the dash and window struts, being nearer, hide what is behind them.
  const painter = createPainter(1800, { depthTest: true });
  painter.mesh.name = "cockpit-combiner";
  painter.mesh.renderOrder = 1001;
  painter.mesh.visible = false;
  painter.mesh.position.set(0, 0, -distance);
  parent.add(painter.mesh);
  painter.at.scale = distance / REF;
  const { quad, brackets } = painter;
  (painter.mesh.material as MeshBasicMaterial).color.setScalar(GAIN);
  const out: Record<string, number> = {};
  let clock = 0;
  const blink = (hz: number): boolean => Math.sin(clock * hz * Math.PI * 2) > 0;

  /** A thin line between two plane points, with a dark under-stroke so it reads on bright sky. */
  const seg = (x0: number, y0: number, x1: number, y1: number, color: number, t = THIN): void => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    if (length < 1e-5) return;
    const a = Math.atan2(dy, dx);
    quad((x0 + x1) / 2 + t * 0.25, (y0 + y1) / 2 - t * 0.25, length + t * 1.4, t * 2.6, BACK, a);
    quad((x0 + x1) / 2, (y0 + y1) / 2, length + t * 0.6, t, color, a);
  };
  /** Stroke text with a dark under-stroke so it reads on bright sky. `y` is the vertical centre. */
  const label3 = (
    s: string,
    x: number,
    y: number,
    size: number,
    color: number,
    anchor: "left" | "center" | "right" = "left",
  ): void => {
    strokeText(painter, s, x + size * 0.03, y - size * 0.03, size, BACK, anchor, 0.27);
    strokeText(painter, s, x, y, size, color, anchor, 0.09);
  };
  // Plane projection of a camera-space direction: false when it is behind the eye.
  const px = { x: 0, y: 0 };
  const plane = (x: number, y: number, z: number): boolean => {
    if (z >= -0.05) return false;
    px.x = (REF * x) / -z;
    px.y = (REF * y) / -z;
    return true;
  };

  const update = (w: World, state: Readonly<GameState>, dt: number): void => {
    const on = w.cameraRig.cockpit && !LOOK_OFF;
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

    // ---- lock box ---------------------------------------------------------------------------------
    const target = weapons.lockedTarget;
    let boxed = 0;
    if (
      target !== null &&
      target.alive &&
      view(target.position) &&
      Math.abs(px.x) < 0.8 &&
      px.y < 0.5 &&
      px.y > -0.5
    ) {
      boxed = 1;
      const range = _p.length();
      const half = Math.max(0.05, (REF * target.radius * 0.75) / Math.max(range, 1));
      const lockedIn = blink(6);
      brackets(px.x, px.y, half, half * 0.45, 0.0042, lockedIn ? WHITE : RED);
      quad(px.x, px.y, 0.006, 0.006, RED, Math.PI / 4);
      label3("LOCK", px.x, px.y - half - 0.03, 0.03, RED, "center");
      label3(`${Math.round(range)} M`, px.x, px.y + half + 0.03, 0.026, GREEN, "center");
    }

    painter.end();
    out.hudShown = 1;
    // Sticky extremes for the playtest: what the HUD has shown over the run, immune to timing.
    out.hudPitchMax = Math.max(out.hudPitchMax ?? -90, pitch);
    out.hudPitchMin = Math.min(out.hudPitchMin ?? 90, pitch);
    out.hudRollAbsMax = Math.max(out.hudRollAbsMax ?? 0, Math.abs(roll));
    out.hudLockFrames = (out.hudLockFrames ?? 0) + boxed;
    out.hudRolled = Math.abs(roll) > 4 ? 1 : 0;
    out.hudPitchedUp = pitch > 4 ? 1 : 0;
    out.hudPitchDeg = pitch;
    out.hudRollDeg = roll;
    out.hudLockBox = boxed;
    out.hudQuads = painter.mesh.count;
    Object.assign(w.cameraRig.cockpitState, out);
  };

  return {
    update,
    dispose: painter.dispose,
  };
}
