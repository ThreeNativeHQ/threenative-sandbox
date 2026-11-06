// The cockpit's five screens, drawn on the glass of `assets/cockpit.glb` (one painter draw call plus
// three textured crew cards). Thin vector type (`strokeFont.ts`), a wireframe of our own ship on a
// grid, a sweeping radar, system and weapon lists, all driven by live game data and tinted so the
// bloom catches them. Layout units are screen heights, centred, per `ICockpitScreen`.
import { DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Texture } from "three";
import { ARENA_RADIUS, railFrame } from "../entities/Rail.js";
import type { GameState } from "../state.js";
import type { World } from "../world.js";
import type { ICockpitScreen } from "./cockpitLook.js";
import { type IPainter, createPainter } from "./hud.js";
import { STYLE } from "./hudStyle.js";
import { segment, strokeText } from "./strokeFont.js";

const C = {
  bg: 0x041424,
  bg2: 0x030c18,
  scan: 0x020a14,
  grid: 0x0d3556,
  rule: 0x1d6f96,
  cyan: 0x56e4ff,
  ice: STYLE.ice,
  mint: STYLE.mint,
  amber: STYLE.amber,
  red: STYLE.red,
  dim: 0x1b4a6a,
  bar: 0x08233b,
} as const;

/** The painter's colour multiplier: above 1 so the glow catches the bloom. */
const GLOW = 1.7;
const MAP_RANGE = 250; // m from the ship to the radar rim
const WING_MAX = 60;
const SHIELD_WING = 255;
const PULSE = 0.35; // s a weapon row stays lit after use
const T = 0.0045; // thin rule, screen heights

export interface ICockpitScreens {
  /** Screen glass layout: centre, comms (crew), minimap, stores (systems), firing (weapons). */
  update(w: World, state: Readonly<GameState>, dt: number): void;
  dispose(): void;
}

export interface IScreenLayout {
  centre: ICockpitScreen;
  comms: ICockpitScreen;
  minimap: ICockpitScreen;
  stores: ICockpitScreen;
  firing: ICockpitScreen;
}

// Our ship seen from above: x right, y forward, nose at +0.5. Mirrored about the spine.
const BODY: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5],
  [0.05, 0.26],
  [0.07, -0.18],
  [0.045, -0.38],
  [0, -0.42],
];
const WING: ReadonlyArray<readonly [number, number]> = [
  [0.07, 0.1],
  [0.48, -0.3],
  [0.48, -0.38],
  [0.1, -0.27],
];
const STRUTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [
    [0.07, -0.04],
    [0.3, -0.25],
  ],
  [
    [0.08, -0.15],
    [0.4, -0.33],
  ],
];
const FIN: ReadonlyArray<readonly [number, number]> = [
  [0.05, -0.1],
  [0.14, -0.42],
  [0.1, -0.45],
  [0.06, -0.38],
];
const CANOPY: ReadonlyArray<readonly [number, number]> = [
  [0, 0.3],
  [0.035, 0.12],
  [0, -0.02],
  [-0.035, 0.12],
  [0, 0.3],
];

const CREW = ["crew/lancer.png", "crew/kestrel.png", "crew/vega.png"] as const;
const CREW_NAMES = ["LANCER", "KESTREL", "VEGA"] as const;
const CREW_COLORS = [C.cyan, C.amber, C.mint] as const;
export const CREW_TEXTURES = CREW;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/**
 * `textures` holds the three crew cards by the paths in `CREW_TEXTURES` (load them with
 * `ctx.assets.texture`); without them the cards are plain frames.
 */
export function createCockpitScreens(
  parent: Group,
  layout: IScreenLayout,
  textures: Readonly<Record<string, Texture>> = {},
): ICockpitScreens {
  const painter: IPainter = createPainter(9000, { depthTest: true });
  painter.noShadow = true;
  painter.mesh.name = "cockpit-screens";
  painter.mesh.renderOrder = 4;
  (painter.mesh.material as MeshBasicMaterial).color.setScalar(GLOW);
  parent.add(painter.mesh);
  const { at, quad, rect, frame } = painter;

  // ---- crew cards: textured quads on the comms glass ---------------------------------------------
  const cardGeometry = new PlaneGeometry(1, 1);
  const cardMaterials: MeshBasicMaterial[] = [];
  const cards = CREW.map((path, i) => {
    const map = textures[path];
    if (map !== undefined) map.anisotropy = 8; // keeps the portraits sharp at an angle
    const material = new MeshBasicMaterial({
      map: map ?? null,
      color: map === undefined ? 0x0a2236 : 0xffffff,
      toneMapped: false,
      side: DoubleSide,
    });
    cardMaterials.push(material);
    const mesh = new Mesh(cardGeometry, material);
    mesh.name = `crew-card-${i}`;
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    parent.add(mesh);
    return mesh;
  });

  let clock = 0;
  let shots = 0;
  let bombs = 0;
  let fireT = 0;
  let bombT = 0;
  const blink = (hz: number): boolean => Math.sin(clock * hz * Math.PI * 2) > 0;
  const hr = { x: 1, z: 0 };
  const hf = { x: 0, z: -1 };
  const _frame = railFrame();

  const text = (
    s: string,
    x: number,
    y: number,
    size: number,
    color: number,
    anchor: "left" | "center" | "right" = "left",
  ): void => strokeText(painter, s, x, y, size, color, anchor);
  const line = (x0: number, y0: number, x1: number, y1: number, color: number, t = T): void =>
    segment(painter, x0, y0, x1, y1, t, color);

  /** Aims the painter at a screen and draws its backing: gradient, scanlines, inset bezel. */
  const open = (s: ICockpitScreen): number => {
    at.x = s.x;
    at.y = s.y;
    at.z = s.z;
    at.scale = s.h;
    at.rot = s.roll ?? 0;
    const half = s.w / s.h / 2;
    // Deep blue, lighter toward the top, as if lit from within.
    const bands = 6;
    for (let k = 0; k < bands; k += 1) {
      const y1 = 0.5 - k / bands;
      rect(-half, y1, half, y1 - 1 / bands, k < 2 ? C.bg : k < 4 ? 0x04101e : C.bg2);
    }
    for (let y = 0.47; y > -0.5; y -= 0.028) rect(-half, y, half, y - 0.006, C.scan);
    frame(-half, 0.5, half, -0.5, 0.014, C.rule);
    frame(-half + 0.02, 0.48, half - 0.02, -0.48, 0.005, C.dim);
    return half;
  };
  const bar = (
    x0: number,
    x1: number,
    y: number,
    h: number,
    ratio: number,
    color: number,
  ): void => {
    rect(x0, y + h / 2, x1, y - h / 2, C.bar);
    const n = Math.round(clamp01(ratio) * 20);
    const step = (x1 - x0 - 0.01) / 20;
    for (let k = 0; k < n; k += 1)
      rect(
        x0 + 0.005 + k * step,
        y + h / 2 - 0.006,
        x0 + 0.005 + (k + 0.82) * step,
        y - h / 2 + 0.006,
        color,
      );
    frame(x0, y + h / 2, x1, y - h / 2, 0.004, C.dim);
  };
  const poly = (
    pts: ReadonlyArray<readonly [number, number]>,
    ox: number,
    oy: number,
    k: number,
    xs: number,
    mirror: boolean,
    color: number,
    t: number,
  ): void => {
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1] as readonly [number, number];
      const b = pts[i] as readonly [number, number];
      line(
        ox + (mirror ? -1 : 1) * a[0] * k * xs,
        oy + a[1] * k,
        ox + (mirror ? -1 : 1) * b[0] * k * xs,
        oy + b[1] * k,
        color,
        t,
      );
    }
  };

  // ---- centre: our ship in wireframe on a grid, status bars -------------------------------------
  const centre = (w: World, state: Readonly<GameState>): void => {
    const s = layout.centre;
    const half = open(s);
    const ship = w.ship;
    text("STARLANCE", -half + 0.09, 0.39, 0.1, C.ice);
    text("LANCER 7X", -half + 0.09, 0.27, 0.06, C.cyan);
    // Grid panel.
    const gx0 = -half + 0.08;
    const gx1 = 0.3;
    const gy0 = -0.4;
    const gy1 = 0.2;
    for (let x = gx0; x <= gx1 + 0.001; x += (gx1 - gx0) / 14)
      rect(x - 0.0015, gy1, x + 0.0015, gy0, C.grid);
    for (let y = gy0; y <= gy1 + 0.001; y += (gy1 - gy0) / 6)
      rect(gx0, y + 0.0015, gx1, y - 0.0015, C.grid);
    frame(gx0, gy1, gx1, gy0, 0.004, C.rule);
    const cx = (gx0 + gx1) / 2;
    const cy = (gy0 + gy1) / 2;
    const bank = Math.cos(ship.bankRadians);
    const xs = 0.35 + 0.65 * Math.abs(bank); // wings foreshorten as the ship banks
    const k = 0.46;
    const lw = ship.wings.left / WING_MAX;
    const rw = ship.wings.right / WING_MAX;
    const wingColor = (hp: number): number => (hp <= 0 ? C.red : hp < 0.5 ? C.amber : C.cyan);
    for (const m of [false, true]) {
      const hp = m ? lw : rw;
      poly(BODY, cx, cy, k, xs, m, C.cyan, 0.006);
      poly(WING, cx, cy, k, xs, m, wingColor(hp), 0.006);
      for (const st of STRUTS) poly(st, cx, cy, k, xs, m, C.dim, 0.004);
      poly(FIN, cx, cy, k, xs, m, C.cyan, 0.005);
    }
    poly(CANOPY, cx, cy, k, xs, false, C.ice, 0.005);
    line(cx, cy + 0.5 * k, cx, cy - 0.42 * k, C.dim, 0.004);
    // Scan line sweeping down the ship.
    const scan = gy1 - ((clock * 0.35) % 1) * (gy1 - gy0);
    rect(gx0 + 0.01, scan + 0.004, gx1 - 0.01, scan - 0.004, 0x1f8aa8);
    // Bars.
    const x0 = 0.4;
    const x1 = half - 0.27;
    const rows: ReadonlyArray<readonly [string, number, number, string]> = [
      [
        "SHLD",
        clamp01(state.shield / state.shieldMax),
        state.shield <= 50 ? (blink(4) ? C.red : C.amber) : state.shield <= 100 ? C.amber : C.mint,
        String(Math.ceil(state.shield)),
      ],
      [
        ship.boostLatched ? "WAIT" : "BOOST",
        clamp01(state.boost),
        ship.boostLatched ? C.amber : C.cyan,
        String(Math.round(clamp01(state.boost) * 100)),
      ],
      ["SPD", clamp01((ship.speed - 18) / 30), C.cyan, String(Math.round(ship.speed))],
    ];
    for (const [k2, [label, ratio, color, value]] of rows.entries()) {
      const y = 0.32 - k2 * 0.19;
      text(label, x0 - 0.03, y, 0.075, C.ice);
      bar(x0 + 0.31, x1, y, 0.09, ratio, color);
      text(value, half - 0.07, y, 0.075, C.ice, "right");
    }
    text("WING", x0 - 0.03, -0.25, 0.075, C.ice);
    for (const [k2, hp] of [lw, rw].entries()) {
      const bx0 = x0 + 0.31 + k2 * 0.25;
      bar(bx0, bx0 + 0.21, -0.25, 0.09, clamp01(hp), hp <= 0 ? C.red : hp < 0.5 ? C.amber : C.mint);
    }
    text("L", x0 + 0.31, -0.35, 0.045, C.cyan);
    text("R", x0 + 0.56, -0.35, 0.045, C.cyan);
    text(
      ship.alive ? "SYSTEMS NOMINAL" : "SYSTEMS DOWN",
      x0 - 0.03,
      -0.46,
      0.05,
      ship.alive ? C.mint : C.red,
    );
  };

  // ---- upper left: the crew ----------------------------------------------------------------------
  const comms = (w: World, state: Readonly<GameState>): void => {
    const s = layout.comms;
    const half = open(s);
    const size = 0.6;
    const gap = 0.07;
    const x0 = -half + 0.14 + size / 2;
    for (const [i, card] of cards.entries()) {
      const mate = i === 0 ? undefined : w.wingmen.members[i - 1];
      const alive = i === 0 ? w.ship.alive : mate !== undefined && mate.alive;
      const hp =
        i === 0
          ? state.shield / state.shieldMax
          : mate === undefined
            ? 0
            : mate.shield / SHIELD_WING;
      const cxp = x0 + i * (size + gap);
      const cyp = 0.1;
      const roll = s.roll ?? 0;
      card.position.set(
        s.x + (cxp * Math.cos(roll) - cyp * Math.sin(roll)) * s.h,
        s.y + (cxp * Math.sin(roll) + cyp * Math.cos(roll)) * s.h,
        s.z + 0.012,
      );
      card.rotation.z = roll;
      card.scale.set(size * s.h, size * s.h, 1);
      (card.material as MeshBasicMaterial).color.setScalar(alive ? 1.25 : 0.22);
      at.z = s.z + 0.016; // above the card
      const call = i > 0 && mate !== undefined && mate.chased && blink(3);
      const accent = CREW_COLORS[i] as number;
      const f = size / 2 + 0.005;
      frame(
        cxp - f,
        cyp + f,
        cxp + f,
        cyp - f,
        0.012,
        call ? C.amber : alive ? (i === 0 ? C.mint : accent) : C.dim,
      );
      if (!alive) {
        for (let n = 0; n < 40; n += 1) {
          const nx = cxp + (((Math.sin(n * 91.7 + clock * 40) * 43758) % 1) - 0.5) * size;
          const ny = cyp + (((Math.sin(n * 17.3 + clock * 31) * 24634) % 1) - 0.5) * size;
          rect(nx, ny + 0.012, nx + 0.06, ny, n % 3 === 0 ? C.ice : C.dim);
        }
      }
      bar(cxp - size / 2, cxp + size / 2, -0.27, 0.04, clamp01(hp), hp < 0.3 ? C.amber : C.mint);
      if (mate !== undefined && mate.chased)
        text("HELP", cxp, cyp + size / 2 - 0.05, 0.06, call ? C.amber : C.ice, "center");
      else if (mate !== undefined && mate.retreating)
        text("RTB", cxp, cyp + size / 2 - 0.05, 0.06, C.dim, "center");
      text(CREW_NAMES[i] as string, cxp, -0.37, 0.045, alive ? C.ice : C.dim, "center");
    }
    at.z = s.z;
    text(`HITS ${String(state.hits).padStart(3, "0")}`, -half + 0.14, -0.455, 0.04, C.cyan);
    text(`DIST ${Math.round(state.distance)} M`, half - 0.14, -0.455, 0.04, C.cyan, "right");
  };

  // ---- upper right: radar --------------------------------------------------------------------------
  const minimap = (w: World, state: Readonly<GameState>): void => {
    const s = layout.minimap;
    const half = open(s);
    const ship = w.ship;
    const cx = -half + 0.56;
    const rad = 0.38;
    const len = Math.hypot(ship.forward.x, ship.forward.z);
    if (len > 0.05) {
      hf.x = ship.forward.x / len;
      hf.z = ship.forward.z / len;
      hr.x = -hf.z;
      hr.z = hf.x;
    }
    let mx = 0;
    let my = 0;
    const toMap = (dx: number, dz: number): boolean => {
      mx = (dx * hr.x + dz * hr.z) / MAP_RANGE;
      my = (dx * hf.x + dz * hf.z) / MAP_RANGE;
      return Math.hypot(mx, my) <= 1;
    };
    // Terrain hint: faint contour lines, drifting with the ship's distance along the course.
    const drift = (state.distance * 0.002) % 1;
    for (let c = 0; c < 4; c += 1) {
      let px = 0;
      let py = 0;
      for (let k = 0; k <= 24; k += 1) {
        const x = cx - rad + (k / 24) * rad * 2;
        const y = -0.34 + c * 0.2 + Math.sin(k * 0.5 + c * 1.7 + drift * 6.28) * 0.05;
        if (k > 0 && Math.hypot(x - cx, y) < rad - 0.01 && Math.hypot(px - cx, py) < rad - 0.01)
          line(px, py, x, y, 0x0c3a52, 0.004);
        px = x;
        py = y;
      }
    }
    // Rings, crosshair, ticks.
    for (const [r, n] of [
      [rad, 56],
      [rad * 0.66, 40],
      [rad * 0.33, 24],
    ] as const)
      for (let k = 0; k < n; k += 1) {
        const a0 = (k / n) * Math.PI * 2;
        const a1 = ((k + 0.6) / n) * Math.PI * 2;
        line(
          cx + Math.cos(a0) * r,
          Math.sin(a0) * r,
          cx + Math.cos(a1) * r,
          Math.sin(a1) * r,
          r === rad ? C.cyan : C.rule,
          r === rad ? 0.007 : 0.004,
        );
      }
    rect(cx - rad, 0.002, cx + rad, -0.002, C.rule);
    rect(cx - 0.002, rad, cx + 0.002, -rad, C.rule);
    // Sweep: a bright arm with a fading trail.
    const sweep = clock * 1.6;
    for (let k = 0; k < 14; k += 1) {
      const a = sweep - k * 0.07;
      const fade = 1 - k / 14;
      line(
        cx,
        0,
        cx + Math.cos(a) * rad,
        Math.sin(a) * rad,
        fade > 0.7 ? C.cyan : fade > 0.4 ? 0x1d7f9c : 0x0d4056,
        0.007,
      );
    }
    const heading = Math.atan2(hf.x, -hf.z);
    text(
      "N",
      cx - Math.sin(heading) * (rad + 0.075),
      Math.cos(heading) * (rad + 0.075),
      0.06,
      C.ice,
      "center",
    );
    const dot = (color: number): void => {
      if (Math.hypot(mx, my) <= 1) quad(cx + mx * rad, my * rad, 0.016, 0.016, color);
    };
    if (w.rail.done) {
      const cxw = w.rail.arenaCenter.x - ship.position.x;
      const czw = w.rail.arenaCenter.z - ship.position.z;
      for (let k = 0; k < 90; k += 1) {
        const a = (k / 90) * Math.PI * 2;
        toMap(cxw + Math.cos(a) * ARENA_RADIUS, czw + Math.sin(a) * ARENA_RADIUS);
        dot(C.amber);
      }
    } else {
      const f = w.rail.frame(w.rail.s, _frame);
      for (const side of [-1, 1]) {
        const lateral = side * ship.halfWidth - ship.offset.x;
        for (let t = -MAP_RANGE; t <= MAP_RANGE; t += 15) {
          toMap(f.right.x * lateral + f.forward.x * t, f.right.z * lateral + f.forward.z * t);
          dot(ship.edgeWarning ? (blink(4) ? C.red : C.amber) : 0x7a5cd6);
        }
      }
    }
    // Contacts as triangles; a foe past the rim sits on it, dim.
    const tri = (x: number, y: number, r: number, color: number): void => {
      line(x, y + r, x - r * 0.85, y - r * 0.6, color, 0.007);
      line(x - r * 0.85, y - r * 0.6, x + r * 0.85, y - r * 0.6, color, 0.007);
      line(x + r * 0.85, y - r * 0.6, x, y + r, color, 0.007);
    };
    const place = (p: { x: number; z: number }, color: number, r: number): void => {
      const inside = toMap(p.x - ship.position.x, p.z - ship.position.z);
      const k = inside ? 1 : 1 / Math.hypot(mx, my);
      tri(cx + mx * k * rad, my * k * rad, r, inside ? color : C.dim);
    };
    for (const m of w.wingmen.members) if (m.alive) place(m.position, C.mint, 0.025);
    let contacts = 0;
    for (const t of w.enemies.targets) {
      if (!t.alive) continue;
      contacts += 1;
      const locked = w.weapons.lockedTarget === t;
      place(
        t.position,
        locked ? (blink(6) ? C.ice : C.red) : t.lockable ? C.red : C.amber,
        locked ? 0.04 : 0.028,
      );
    }
    tri(cx, 0, 0.03, C.mint); // own ship
    const x = cx + rad + 0.2;
    text("RADAR", x, 0.4, 0.06, C.cyan);
    text("CONTACTS", x, 0.2, 0.04, C.ice);
    text(String(contacts).padStart(2, "0"), x, 0.07, 0.09, C.ice);
    text(`HDG ${String(Math.round(ship.heading)).padStart(3, "0")}`, x, -0.1, 0.045, C.ice);
    text(`RNG ${MAP_RANGE} M`, x, -0.22, 0.04, C.cyan);
    text(
      state.locked ? "LOCKED" : ship.edgeWarning ? "EDGE" : "SCAN",
      x,
      -0.37,
      0.05,
      state.locked
        ? blink(6)
          ? C.ice
          : C.red
        : ship.edgeWarning
          ? blink(4)
            ? C.amber
            : C.red
          : C.mint,
    );
  };

  // ---- lower left: systems --------------------------------------------------------------------------
  const stores = (w: World, state: Readonly<GameState>): void => {
    const s = layout.stores;
    const half = open(s);
    const ship = w.ship;
    const l = -half + 0.5; // the console strut hides the glass's left edge
    const wingsOk = ship.wings.left > 0 && ship.wings.right > 0;
    const rows: ReadonlyArray<readonly [string, number, boolean]> = [
      [
        "COMMS",
        w.wingmen.members.some((m) => m.alive) ? C.mint : C.amber,
        w.wingmen.members.some((m) => m.alive),
      ],
      ["SHLD", state.shield > 100 ? C.mint : state.shield > 50 ? C.amber : C.red, true],
      ["WING", wingsOk ? C.mint : C.amber, wingsOk],
      ["NAV", ship.edgeWarning ? (blink(4) ? C.red : C.amber) : C.mint, !ship.edgeWarning],
    ];
    for (const [i, [label, color, ok]] of rows.entries()) {
      const y = 0.2 - i * 0.17;
      rect(l, y + 0.045, l + 0.09, y - 0.045, C.bar);
      frame(l, y + 0.045, l + 0.09, y - 0.045, 0.006, color);
      if (ok) rect(l + 0.02, y + 0.025, l + 0.07, y - 0.025, color);
      text(label, l + 0.17, y, 0.09, ok ? C.ice : color);
    }
  };

  // ---- lower right: weapons ---------------------------------------------------------------------------
  const firing = (state: Readonly<GameState>): void => {
    const s = layout.firing;
    const half = open(s);
    const l = -half + 0.12;
    const r = half - 0.3; // the armrest hides the glass's right edge
    const charging = state.charge > 0.02;
    const rows: ReadonlyArray<readonly [string, boolean]> = [
      ["LASER", fireT > 0],
      ["CHARGE", charging],
      ["BOMB", bombT > 0],
      ["LOCK", state.locked],
    ];
    for (const [i, [label, active]] of rows.entries()) {
      const y = 0.31 - i * 0.2;
      if (active) rect(l - 0.04, y + 0.085, r, y - 0.085, 0x0b4a36);
      if (active) frame(l - 0.04, y + 0.085, r, y - 0.085, 0.006, C.mint);
      text(label, l, y, 0.09, active ? C.mint : C.ice);
      if (label === "LASER")
        for (let k = 0; k < 3; k += 1)
          quad(
            r - 0.1 - k * 0.1,
            y,
            0.06,
            0.06,
            k <= state.laserLevel ? C.cyan : C.dim,
            Math.PI / 4,
          );
      else if (label === "CHARGE")
        bar(
          l + 0.62,
          r - 0.04,
          y,
          0.07,
          clamp01(state.charge),
          state.charge >= 0.999 ? C.ice : C.cyan,
        );
      else if (label === "BOMB") text(String(state.bombs), r - 0.06, y, 0.09, C.ice, "right");
      else
        text(
          state.locked ? "ON" : "---",
          r - 0.06,
          y,
          0.09,
          state.locked ? (blink(6) ? C.ice : C.red) : C.dim,
          "right",
        );
    }
  };

  return {
    update(w, state, dt) {
      clock += dt;
      const { weapons } = w;
      if (weapons.shotsFired !== shots) fireT = PULSE;
      if (weapons.bombsUsed !== bombs) bombT = PULSE * 2;
      shots = weapons.shotsFired;
      bombs = weapons.bombsUsed;
      fireT = Math.max(0, fireT - dt);
      bombT = Math.max(0, bombT - dt);
      painter.begin();
      centre(w, state);
      comms(w, state);
      minimap(w, state);
      stores(w, state);
      firing(state);
      painter.end();
    },
    dispose() {
      painter.dispose();
      cardGeometry.dispose();
      for (const card of cards) card.removeFromParent();
      for (const material of cardMaterials) material.dispose();
    },
  };
}
