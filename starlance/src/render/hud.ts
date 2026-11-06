// In-scene HUD, attached to the camera (no DOM). The whole HUD is ONE InstancedMesh of unit quads:
// bars, brackets, reticles and a 3x5 pixel font are all rectangles written into its instance
// buffer each frame, so it costs a single draw call and runs on every target.
//
// Layout units are screen heights: y runs -0.5..0.5, x runs -aspect/2..aspect/2, so it scales with
// the viewport. The group sits 1 m in front of the camera and is scaled to fill the view.
import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  Vector3,
} from "three";
import type { GameState } from "../state.js";
import { createStatusStyle } from "./hudStyle.js";
import { lookbook } from "./lookbook.js";
import type { World } from "../world.js";

export interface IHud {
  update(w: World, state: Readonly<GameState>, dt: number): void;
  dispose(): void;
}

// Style guide: thin geometric lines; cyan primary, white values, amber warnings, violet frames.
export const CYAN = 0x5ff0ff;
export const WHITE = 0xf4fbff;
export const AMBER = 0xffb03a;
export const RED = 0xff5a3a;
export const VIOLET = 0x7a5cd6;
export const BACK = 0x0a0a1c;
export const DIM = 0x2a2658;

const CAPACITY = 2600;
const DISTANCE = 1;

// 3x5 pixel font. Each glyph is five rows of three bits.
const FONT: Record<string, string> = {
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "110101101101101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101110011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "110001010100111",
  "3": "110001010001110",
  "4": "101101111001001",
  "5": "111100110001110",
  "6": "011100111101111",
  "7": "111001010010010",
  "8": "111101111101111",
  "9": "111101111001110",
  "!": "010010010000010",
  "/": "001001010100100",
  ":": "000010000010000",
  "-": "000000111000000",
  "+": "000010111010000",
};

// Instance colours are linear; the palette above is sRGB, so convert or the HUD washes out.
const linear = (channel: number): number => (channel / 255) ** 2.2;
const rgb = (hex: number, out: number[]): void => {
  out[0] = linear((hex >> 16) & 255);
  out[1] = linear((hex >> 8) & 255);
  out[2] = linear(hex & 255);
};

type Anchor = "left" | "center" | "right";

export interface IPainter {
  readonly mesh: InstancedMesh;
  /** Where the next quads land: coordinates (x, y) become origin + (x, y) * scale turned by `rot`
   * (radians, about the origin), at depth `z`. */
  readonly at: { x: number; y: number; z: number; scale: number; rot: number };
  /** Skip the dark drop shadow `text` draws under each glyph. */
  noShadow: boolean;
  begin(): void;
  end(): void;
  quad(x: number, y: number, w: number, h: number, color: number, rot?: number): void;
  rect(x0: number, y0: number, x1: number, y1: number, color: number): void;
  textWidth(s: string, px: number): number;
  text(s: string, x: number, y: number, px: number, color: number, anchor?: Anchor): void;
  frame(x0: number, y0: number, x1: number, y1: number, t: number, color: number): void;
  brackets(x: number, y: number, h: number, len: number, t: number, color: number): void;
  dispose(): void;
}

/**
 * A batch of coloured quads, ONE InstancedMesh (one draw call) rewritten each frame: bars, brackets
 * and a 3x5 pixel font are all rectangles. The HUD and the cockpit panels both draw through it.
 */
export function createPainter(capacity: number, options: { depthTest: boolean }): IPainter {
  const geometry = new PlaneGeometry(1, 1);
  const material = new MeshBasicMaterial({
    side: DoubleSide,
    depthTest: options.depthTest,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const matrices = mesh.instanceMatrix.array as Float32Array;
  const colors = mesh.instanceColor.array as Float32Array;
  const c = [0, 0, 0];
  const at = { x: 0, y: 0, z: 0, scale: 1, rot: 0 };
  let n = 0;

  /** One quad: centre (x, y), size (w, h), optional rotation, colour. */
  const quad = (x: number, y: number, w: number, h: number, color: number, rot = 0): void => {
    if (n >= capacity) return;
    const o = n * 16;
    const cs = Math.cos(rot + at.rot);
    const sn = Math.sin(rot + at.rot);
    const ca = Math.cos(at.rot);
    const sa = Math.sin(at.rot);
    const k = at.scale;
    matrices[o] = cs * w * k;
    matrices[o + 1] = sn * w * k;
    matrices[o + 2] = 0;
    matrices[o + 3] = 0;
    matrices[o + 4] = -sn * h * k;
    matrices[o + 5] = cs * h * k;
    matrices[o + 6] = 0;
    matrices[o + 7] = 0;
    matrices[o + 8] = 0;
    matrices[o + 9] = 0;
    matrices[o + 10] = 1;
    matrices[o + 11] = 0;
    matrices[o + 12] = at.x + (x * ca - y * sa) * k;
    matrices[o + 13] = at.y + (x * sa + y * ca) * k;
    matrices[o + 14] = at.z;
    matrices[o + 15] = 1;
    rgb(color, c);
    colors[n * 3] = c[0] as number;
    colors[n * 3 + 1] = c[1] as number;
    colors[n * 3 + 2] = c[2] as number;
    n += 1;
  };
  /** Left, top, right, bottom to centre/size. */
  const rect = (x0: number, y0: number, x1: number, y1: number, color: number): void =>
    quad((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0), Math.abs(y1 - y0), color);

  const textWidth = (s: string, px: number): number => (s.length * 4 - 1) * px;

  /** Pixel text; (x, y) is the top edge, `anchor` says what x means. Rows merge into runs. */
  const glyphs = (s: string, x: number, y: number, px: number, color: number): void => {
    let cx = x;
    for (const ch of s) {
      const g = FONT[ch];
      if (g !== undefined) {
        for (let row = 0; row < 5; row += 1) {
          let col = 0;
          while (col < 3) {
            if (g[row * 3 + col] === "1") {
              let end = col;
              while (end + 1 < 3 && g[row * 3 + end + 1] === "1") end += 1;
              quad(
                cx + ((col + end + 1) / 2) * px,
                y - (row + 0.5) * px,
                (end - col + 1) * px,
                px,
                color,
              );
              col = end + 1;
            } else col += 1;
          }
        }
      }
      cx += 4 * px;
    }
  };
  const text = (
    s: string,
    x: number,
    y: number,
    px: number,
    color: number,
    anchor: Anchor = "left",
  ): void => {
    const w = textWidth(s, px);
    const x0 = anchor === "left" ? x : anchor === "center" ? x - w / 2 : x - w;
    if (!painter.noShadow) glyphs(s, x0 + px * 0.55, y - px * 0.55, px, BACK);
    glyphs(s, x0, y, px, color);
  };

  /** A thin rectangular outline. */
  const frame = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    t: number,
    color: number,
  ): void => {
    rect(x0, y0, x1, y0 - t, color);
    rect(x0, y1 + t, x1, y1, color);
    rect(x0, y0, x0 + t, y1, color);
    rect(x1 - t, y0, x1, y1, color);
  };

  /** Corner brackets of a box centred on (x, y) with half size `h`. */
  const brackets = (
    x: number,
    y: number,
    h: number,
    len: number,
    t: number,
    color: number,
  ): void => {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        quad(x + sx * h, y + sy * (h - len / 2), t, len, color);
        quad(x + sx * (h - len / 2), y + sy * h, len, t, color);
      }
    }
  };

  const painter: IPainter = {
    mesh,
    at,
    noShadow: false,
    begin() {
      n = 0;
    },
    end() {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    },
    quad,
    rect,
    textWidth,
    text,
    frame,
    brackets,
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
  return painter;
}

// ponytail: test-only URL seams (the playtest bridge cannot write state). `?skipTo=<m>` jumps
// along the course once; `?hud=clear|down|low|cap` forces HUD values so a capture can show them.
const query = String(globalThis.location?.search ?? "");
const SKIP = /[?&,]skipTo=(\d+)/.exec(query)?.[1];
const BOOK = Number(/[?&,]lookbook=(\d)/.exec(query)?.[1] ?? 0);
const DEMO = /[?&,]hud=(\w+)/.exec(query)?.[1];
const DEMOS: Record<string, Partial<GameState>> = {
  clear: { phase: "clear", hits: 37 },
  down: { phase: "down", shield: 0 },
  low: { shield: 62 },
  cap: { shield: 301, shieldMax: 383, bombs: 5, laserLevel: 2, charge: 0.62, boost: 0.6, hits: 12 },
};

export function createHud(camera: PerspectiveCamera): IHud {
  let skipped = SKIP === undefined;
  let book: ((dt: number) => void) | undefined;
  const painter = createPainter(CAPACITY, { depthTest: false });
  const mesh = painter.mesh;
  mesh.renderOrder = 1000;
  mesh.name = "hud";
  camera.add(mesh);
  mesh.position.set(0, 0, -DISTANCE);

  const { quad, rect, text, textWidth, brackets } = painter;
  let aspect = 16 / 9;
  let clock = 0;

  const v = new Vector3();
  /** Projects a world point; returns false when it is behind the camera. x, y in screen heights. */
  const project = (p: Vector3, out: { x: number; y: number; depth: number }): boolean => {
    v.copy(p).applyMatrix4(camera.matrixWorldInverse);
    out.depth = -v.z;
    if (v.z >= -0.05) {
      // Behind the eye: mirror so the caller can pin the marker to the edge in the right direction.
      out.x = -v.x * 1e3;
      out.y = -v.y * 1e3;
      return false;
    }
    v.applyMatrix4(camera.projectionMatrix);
    out.x = v.x * aspect * 0.5;
    out.y = v.y * 0.5;
    return true;
  };
  const s0 = { x: 0, y: 0, depth: 0 };
  const s1 = { x: 0, y: 0, depth: 0 };

  const status = createStatusStyle();
  let lockId = -1;
  let lockT = 0;
  const blink = (hz: number): boolean => Math.sin(clock * hz * Math.PI * 2) > 0;

  const update = (w: World, realState: Readonly<GameState>, dt: number): void => {
    if (!skipped) {
      skipped = true;
      w.rail.s = Number(SKIP);
    }
    const state =
      DEMO !== undefined && DEMOS[DEMO] !== undefined
        ? { ...realState, ...DEMOS[DEMO] }
        : realState;
    if (BOOK > 0) book ??= lookbook(w, camera, BOOK);
    book?.(dt);
    clock += dt;
    camera.updateMatrixWorld(true);
    aspect = camera.aspect;
    const h = 2 * DISTANCE * Math.tan((camera.fov * Math.PI) / 360);
    mesh.scale.setScalar(h);
    // Soft ground shadow under the ship (stage.ts); this is the one per-frame hook the stage gets.
    w.stage.trackShip(w.ship.position, camera, dt);

    painter.begin();
    const left = -aspect / 2 + 0.035;
    const right = aspect / 2 - 0.035;
    const top = 0.5 - 0.035;
    const bottom = -0.5 + 0.035;
    const ship = w.ship;
    const flying = state.phase === "flying" || state.phase === "arena";
    const px = 0.0052;

    const low = state.shield <= 100;
    const crit = state.shield <= 50;
    // The cockpit panels show these gauges, so the overlay drops them there.
    if (!w.cameraRig.cockpit) {
      status.draw(
        painter,
        {
          shield: state.shield,
          shieldMax: state.shieldMax,
          boost: state.boost,
          boostLatched: ship.boostLatched,
          hits: state.hits,
          bombs: state.bombs,
          laserLevel: state.laserLevel,
          wings: [ship.wings.left, ship.wings.right],
        },
        { left, right, top, bottom, px },
        dt,
        clock,
      );
    }

    // The cockpit's combiner (cockpitHud.ts) draws its own reticles and lock box.
    if (flying && !w.cameraRig.cockpit) {
      // ---- aim reticles along the nose: near (25 m) and far (60 m) ---------------------------
      v.copy(ship.position).addScaledVector(ship.forward, 25);
      const nearOk = project(v, s0);
      v.copy(ship.position).addScaledVector(ship.forward, 60);
      const farOk = project(v, s1);
      if (farOk) {
        brackets(s1.x, s1.y, 0.019, 0.007, 0.0022, WHITE);
        quad(s1.x, s1.y, 0.003, 0.003, WHITE);
      }
      if (nearOk) {
        const r = 0.03;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          quad(
            s0.x + dx * (r - 0.006),
            s0.y + dy * (r - 0.006),
            dx !== 0 ? 0.014 : 0.0026,
            dy !== 0 ? 0.014 : 0.0026,
            CYAN,
          );
        }
        quad(s0.x, s0.y, 0.0032, 0.0032, WHITE);
        // Charge ring: lit segments grow clockwise from the top; white-hot when full.
        if (state.charge > 0.02) {
          const segs = 32;
          const full = state.charge >= 0.999;
          for (let k = 0; k < segs; k += 1) {
            const a = Math.PI / 2 - ((k + 0.5) / segs) * Math.PI * 2;
            const lit = (k + 0.5) / segs <= state.charge;
            const rr = 0.052;
            quad(
              s0.x + Math.cos(a) * rr,
              s0.y + Math.sin(a) * rr,
              0.0034,
              0.0098,
              lit ? (full ? WHITE : CYAN) : DIM,
              a,
            );
          }
        }
      }

      // ---- lock box ---------------------------------------------------------------------------
      const target = w.weapons.lockedTarget;
      if (target !== null && target.alive) {
        if (target.id !== lockId) {
          lockId = target.id;
          lockT = 0;
        }
        lockT = Math.min(1, lockT + dt * 5);
        if (project(target.position, s0) && s0.depth > 0.5) {
          const fov = Math.tan((camera.fov * Math.PI) / 360);
          const half = Math.max(0.03, (target.radius / (s0.depth * fov)) * 0.5 * 1.5);
          const k = 1 + (1 - lockT) * 0.9;
          brackets(s0.x, s0.y, half * k, half * 0.45, 0.003, lockT >= 1 && blink(6) ? WHITE : CYAN);
          quad(s0.x, s0.y, 0.006, 0.006, CYAN, Math.PI / 4);
          text("LOCK", s0.x, s0.y - half - 0.01, px * 0.85, CYAN, "center");
        }
      } else lockId = -1;
    }

    if (flying) {
      // ---- help markers over chased wingmen --------------------------------------------------
      for (const m of w.wingmen.members) {
        if (!m.chased || !m.alive || !blink(2.5)) continue;
        const ok = project(m.position, s0);
        let x = s0.x;
        let y = s0.y + 0.055;
        const lim = aspect / 2 - 0.07;
        const limY = 0.5 - 0.09;
        const edge = !ok || Math.abs(x) > lim || Math.abs(y) > limY;
        if (edge) {
          const k = Math.max(Math.abs(x) / lim, Math.abs(y) / limY, 1e-6);
          x /= k;
          y /= k;
        }
        for (let row = 0; row < 5; row += 1)
          quad(x, y - 0.045 - row * 0.005, 0.034 - row * 0.0064, 0.0045, AMBER);
        text("HELP", x, y + 0.024, px, AMBER, "center");
      }
    }

    // ---- warnings and banners ----------------------------------------------------------------
    /** A dark plate with violet rules, so a banner reads over any terrain. */
    const plate = (cy: number, halfW: number, halfH: number): void => {
      rect(-halfW, cy + halfH, halfW, cy - halfH, BACK);
      rect(-halfW, cy + halfH, halfW, cy + halfH - 0.003, VIOLET);
      rect(-halfW, cy - halfH + 0.003, halfW, cy - halfH, VIOLET);
    };
    const banner = (s: string, color: number, big: number, y: number): void => {
      plate(y - 2.5 * big, textWidth(s, big) / 2 + 0.05, 3.6 * big);
      text(s, 0, y, big, color, "center");
    };
    if (state.phase === "clear") {
      banner("MISSION COMPLETE", CYAN, 0.0125, 0.1);
      text("HITS " + String(state.hits).padStart(3, "0"), 0, -0.03, px * 1.6, WHITE, "center");
      if (blink(1.2)) text("PRESS ENTER", 0, -0.09, px * 1.5, WHITE, "center");
    } else if (state.phase === "down") {
      banner("SHOT DOWN", RED, 0.0145, 0.1);
      if (blink(1.2)) text("PRESS ENTER", 0, -0.04, px * 1.5, WHITE, "center");
    } else if (low && state.shield > 0 && blink(crit ? 5 : 2.5)) {
      banner("SHIELD LOW", crit ? RED : AMBER, 0.0085, 0.34);
    }

    painter.end();
  };

  return {
    update,
    dispose: painter.dispose,
  };
}
