/**
 * Frozen-frame look comparison for the render-cost work: the picture is the acceptance test.
 *
 * `capture <url> <outDir>` loads the game, resolves the briefing's warm-up, takes the deck start,
 * then FREEZES everything that could move between two runs:
 *
 *   - the fixed-step battle clock is stopped (`paused = true`, so `Midway.update` stops calling
 *     `battle.step`). The sea time is `battle.time` — the only value the ocean's `time` uniform is
 *     written from (`src/render/ocean.ts:225`, fed by `World.update`) — so freezing the clock pins
 *     the sea with it; no separate uniform write is needed.
 *   - the battle is stepped synchronously to a fixed tick before the engine can interleave, so two
 *     captures share the same seed, the same tick and the same ship/aircraft state.
 *   - `World.updateCamera` is replaced with a fixed per-view pose, and a fixed number of frames are
 *     rendered after each pose so the shadow and mirrored passes settle for the new eye.
 *   - the dt-driven animations `battle.time` does not pin — the parked and player propellers and the
 *     deck party's mixer — are frozen to a fixed phase and `World.update` is pinned to `dt = 0`, so
 *     a build that draws a frame faster does not freeze with its blades at a different angle. Without
 *     this, a 10x frame-cost difference between builds alone moved the deck diff past its floor.
 *
 * Then a PNG of the canvas is written per view. Views: `deck` (on the home carrier's deck, looking
 * at the island and the parked line), `chase` (400 m astern and above, looking past the home
 * carrier) and `reflection` (low over the water, a US carrier ~2 km off so its mirror shows).
 * The `elevator` view is impossible today: `src/render/world.ts:868` reads `mesh.userData.elevator`
 * but nothing in the game ever assigns one (the hornet.glb has no separate deck-lift node, and
 * `MOVING_NODE` names only the aircraft control surfaces), so there is no node to drive.
 *
 * `--mode us-carrier-shadows` is the negative control for the comparison: it switches `castShadow`
 * off on every mesh under the three US carriers, changing the picture on the deck and chase views.
 *
 * `diff <dirA> <dirB>` prints, per view, the mean absolute channel difference (0-255), the share of
 * pixels with any channel over 8, and the maximum channel difference. It exits non-zero when a view
 * exceeds `--max-mean` (default 0.002) or `--max-pct` (default 0.005%). Those defaults are the
 * measured stock-vs-stock noise floor on this host (RTX 2080, Chromium 151, 1280x720), rounded up:
 *
 *   view        floor mean / pct>8        no-shadow mean / pct>8     default limit
 *   deck        0.006 / 0.015%            1.155 / 2.466%             0.02 / 0.05%
 *   chase       0.001 / 0.003%            0.026 / 0.066%             0.02 / 0.05%
 *   reflection  0.000 / 0.000%            0.000 / 0.000%             0.02 / 0.05%
 *
 * So stock passes and the US-carrier shadow nerf fails on the deck and chase views — which is the
 * point of the tool. Raise the limits only with a fresh floor measured on the same host.
 *
 * 2026-09-23: with the dt-driven animators canonicalised the same-build floor is 0.000 on every
 * view, and the old 0.02 / 0.05% limits passed a build whose deck crew had vanished (mean 0.015).
 * The defaults are therefore 0.002 / 0.005%: above an exact floor, far below any missing object.
 *
 * PNGs are decoded in Chromium (createImageBitmap + canvas getImageData) — no new dependency.
 *
 *   bash tools/capture-lock.sh node tools/compare-frames.mjs capture http://127.0.0.1:5351 /tmp/frames-stock
 *   bash tools/capture-lock.sh node tools/compare-frames.mjs capture http://127.0.0.1:5351 /tmp/frames-noshadow --mode us-carrier-shadows
 *   bash tools/capture-lock.sh node tools/compare-frames.mjs diff /tmp/frames-stock /tmp/frames-noshadow
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { chromium } from "playwright";

const WIDTH = Number(process.env.MIDWAY_FRAME_WIDTH || 1280);
const HEIGHT = Number(process.env.MIDWAY_FRAME_HEIGHT || 720);
// Battle time at which every capture freezes. Whole fixed steps, so the tick is exact.
const FREEZE_TICKS = Number(process.env.MIDWAY_FREEZE_TICKS || 90);
const SETTLE_FRAMES = Number(process.env.MIDWAY_SETTLE_FRAMES || 24);

const WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--ozone-platform=x11",
  "--enable-dawn-features=allow_unsafe_apis",
];

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

/** The three fixed views, in the world frame of the home carrier. */
async function viewPoses(page) {
  return page.evaluate(() => {
    const s = window.midway;
    const b = s.battle;
    const shipPoint = (sh, right, y, fwd) => {
      const c = Math.cos(sh.heading);
      const sn = Math.sin(sh.heading);
      return { x: sh.x + right * c - fwd * sn, y: (sh.y || 0) + y, z: sh.z + right * sn + fwd * c };
    };
    const carriers = b.ships.filter((x) => x.team === "us" && x.kind === "carrier" && !x.sunk);
    // `battle.home` is the home ship record, not its id.
    const home = carriers.find((x) => x.id === (b.home?.id ?? b.home)) ?? carriers[0];
    const dh = home.deckHeight ?? 20;
    const other = carriers.find((x) => x.id !== home.id) ?? home;
    return {
      // On deck port side, slightly elevated, looking aft: the island to starboard and the parked
      // line ahead of it, their shadows raking across the planks.
      deck: { pos: shipPoint(home, -12, dh + 7, -20), look: shipPoint(home, -1, dh + 2, 85), fov: 78 },
      // 400 m astern and above the home carrier, looking past it toward the bow.
      chase: { pos: shipPoint(home, 0, 120, 400), look: shipPoint(home, 0, 0, -150), fov: 55 },
      // Low over the water 2 km astern of another US carrier, looking at the water below it so the
      // mirrored pass has the hull to draw in the surface between the eye and the ship.
      reflection: { pos: shipPoint(other, 0, 4, 2000), look: shipPoint(other, 0, 6, 0), fov: 30 },
    };
  });
}

/** Hide the DOM HUD so a PNG is the 3D frame and nothing else. */
async function hideUi(page) {
  await page.evaluate(() => {
    for (const sel of [
      "#grain", "#hud-canvas", "#damage", "#loading", "#briefing", "#flight-ui",
      "#renderer-note", ".overlay", "#radar-wrap", "#toast", "#center-tip", "#warning",
    ])
      for (const el of document.querySelectorAll(sel)) el.style.display = "none";
  });
}

async function canvasBox(page) {
  return page.evaluate(() => {
    const r = window.midway.world.renderer.domElement.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

async function settle(page, frames) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let i = 0;
        const tick = () => (++i >= n ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

async function capture(url, outDir, mode) {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: false, args: WEBGPU_ARGS });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(url);
    await page.waitForSelector("#loading.hidden", { state: "attached", timeout: 180000 });
    await page.waitForSelector("#briefing:not(.hidden)");
    // The scene publishes itself on entry in a dev build, so nothing has to re-import
    // `/src/game.ts` and walk the resource timeline to find a second copy of the module.
    await page.evaluate(() => {
      window.midway = window.__THREENATIVE__?.debug?.scene;
      if (!window.midway?.battle) throw new Error("no scene under window.__THREENATIVE__.debug.scene");
    });

    const adapter = await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter();
      return { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device, description: a.info.description };
    });
    if (/swiftshader|lavapipe|llvmpipe/i.test(JSON.stringify(adapter)))
      throw new Error(`software adapter, the frame would be meaningless: ${JSON.stringify(adapter)}`);

    // The briefing's compile is unawaited by the game; wait for it when the build publishes
    // `warmUpDone` (this lane's change). An older build never defines the property, and its
    // compiled views are not the ones captured here, so there is nothing to wait for.
    await page.evaluate(async () => {
      const w = window.midway.world;
      if (w.warmUpDone === undefined) return;
      const started = performance.now();
      while (w.warmUpDone === null && performance.now() - started < 180000) await new Promise((r) => setTimeout(r, 20));
      if (w.warmUpDone) await w.warmUpDone;
    });

    // Deck start AND freeze in one synchronous turn: `begin` runs, the pause is set before the
    // engine gets another frame, then the battle is stepped by hand to the fixed tick. Nothing the
    // engine does can slip between them, so two captures share the exact same state.
    const frozen = await page.evaluate(({ ticks }) => {
      const s = window.midway;
      s.begin(false);
      s.paused = true;
      const b = s.battle;
      for (let i = 0; i < ticks; i += 1) b.step(1 / 60, {});
      b.time = ticks / 60;
      const w = s.world;
      window.__framePose = null;
      const camera = w.camera;
      w.updateCamera = function () {
        const pose = window.__framePose;
        if (!pose) return;
        camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
        camera.up.set(0, 1, 0);
        camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
        camera.fov = pose.fov ?? 55;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld();
      };
      // `battle.time` pins everything the simulation drives, but the parked propellers wind and the
      // deck party walks off `World.update`'s own frame `dt`, so two builds of different frame cost
      // reach this freeze with that animation at a different phase (`wallTime` differs), and the
      // windmilling blades alone pushed the deck diff over its floor. Canonicalise every dt-driven
      // visible animator to a fixed phase and pin `World.update` to `dt = 0`: a diff then sees how
      // the two builds draw the one frozen battle, not how fast each got here. The canonical step
      // runs after every `update`, because the airframe mixers write their propeller nodes each
      // frame whether or not `dt` is zero.
      const canonical = () => {
        const airframes = [w.playerMesh];
        for (const mesh of w.meshes.values()) airframes.push(...(mesh.userData.parked ?? []));
        for (const airframe of airframes) {
          airframe.userData.propAngle = 0;
          const prop = airframe.userData.propeller;
          if (prop)
            prop.traverse((node) => {
              node.quaternion.identity();
              node.updateMatrix();
              node.matrixAutoUpdate = false;
            });
        }
        for (const sailor of w.crew.sailors) sailor.player.mixer.setTime(0);
      };
      const advance = w.update.bind(w);
      w.update = () => {
        advance(0, 0);
        canonical();
      };
      advance(0, 0);
      canonical();
      return { time: b.time, seed: b.seed, home: b.home?.id ?? b.home };
    }, { ticks: FREEZE_TICKS });

    // The negative control: US carriers keep drawing but stop casting. Re-applied after every
    // `World.update`, which rewrites the shadow flags with the rest of the ship.
    if (mode === "us-carrier-shadows")
      await page.evaluate(() => {
        const w = window.midway.world;
        const roots = w.battle.ships
          .filter((s) => s.team === "us" && s.kind === "carrier")
          .map((s) => w.meshes.get(s.id))
          .filter(Boolean);
        const apply = () => {
          for (const root of roots) root.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        };
        const orig = w.update;
        w.update = function (...args) {
          orig.apply(this, args);
          apply();
        };
        apply();
      });

    await hideUi(page);
    const poses = await viewPoses(page);
    const box = await canvasBox(page);
    // Diagnostic: what the home carrier's deck actually has on it, so a view that claims to show
    // the park can be checked against the park the game built.
    const park = await page.evaluate(() => {
      const w = window.midway.world;
      const b = window.midway.battle;
      const homeId = b.home?.id ?? b.home;
      const root = w.meshes.get(homeId);
      return {
        home: homeId,
        parked: (root?.userData?.parked ?? []).map((p) => ({ type: p.userData.simAirframe, visible: p.visible })),
      };
    });
    const views = [];
    for (const [view, pose] of Object.entries(poses)) {
      await page.evaluate((p) => { window.__framePose = p; }, pose);
      await settle(page, SETTLE_FRAMES);
      await page.screenshot({ path: join(outDir, `${view}.png`), clip: box });
      views.push(view);
    }
    await writeFile(
      join(outDir, "meta.json"),
      JSON.stringify({ tool: "compare-frames", url, mode: mode ?? null, width: WIDTH, height: HEIGHT, freezeTicks: FREEZE_TICKS, settleFrames: SETTLE_FRAMES, adapter, frozen, park, views }, null, 2),
    );
    console.log(`adapter ${JSON.stringify(adapter)}`);
    console.log(`home-carrier park: ${JSON.stringify(park)}`);
    console.log(
      "elevator view skipped: no carrier publishes `userData.elevator` (src/render/world.ts:868 reads it; nothing assigns it) " +
        "and hornet.glb ships no separate deck-lift node, so there is no object to drive to mid-travel",
    );
    console.log(`captured ${views.join(", ")} at ${WIDTH}x${HEIGHT} (tick ${frozen.time}, seed ${frozen.seed}) into ${outDir}`);
    if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(" | ")}`);
  } finally {
    await browser.close();
  }
}

/** Decode two PNG byte strings in Chromium and diff them pixel by pixel. */
async function diffPair(page, bytesA, bytesB) {
  return page.evaluate(
    async ({ a, b }) => {
      const decode = async (b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const [x, y] = await Promise.all([decode(a), decode(b)]);
      if (x.w !== y.w || x.h !== y.h) return { sizeMismatch: `${x.w}x${x.h} vs ${y.w}x${y.h}` };
      const n = x.data.length;
      let sum = 0;
      let count = 0;
      let max = 0;
      for (let i = 0; i < n; i += 4)
        for (let c = 0; c < 3; c += 1) {
          const d = Math.abs(x.data[i + c] - y.data[i + c]);
          sum += d;
          if (d > 8) count += 1;
          if (d > max) max = d;
        }
      const pixels = n / 4;
      return {
        mean: sum / (pixels * 3),
        pct: (100 * count) / (pixels * 3),
        max,
        width: x.w,
        height: x.h,
      };
    },
    { a: bytesA.toString("base64"), b: bytesB.toString("base64") },
  );
}

async function diff(dirA, dirB, maxMean, maxPct) {
  const filesA = (await readdir(dirA)).filter((f) => f.endsWith(".png")).sort();
  const filesB = new Set((await readdir(dirB)).filter((f) => f.endsWith(".png")).sort());
  const views = filesA.filter((f) => filesB.has(f));
  if (!views.length) throw new Error(`no shared views between ${dirA} and ${dirB}`);
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const lines = [];
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><meta charset=utf-8><body></body>");
    for (const file of views) {
      const view = basename(file, ".png");
      const [a, b] = await Promise.all([readFile(join(dirA, file)), readFile(join(dirB, file))]);
      const r = await diffPair(page, a, b);
      if (r.sizeMismatch) {
        lines.push(`${view.padEnd(12)} size mismatch: ${r.sizeMismatch}`);
        failures.push(`${view}: size mismatch ${r.sizeMismatch}`);
        continue;
      }
      const overMean = r.mean > maxMean;
      const overPct = r.pct > maxPct;
      lines.push(
        `${view.padEnd(12)} mean ${r.mean.toFixed(3)} (limit ${maxMean})${overMean ? " FAIL" : ""}  ` +
          `pct>8 ${r.pct.toFixed(3)}% (limit ${maxPct}%)${overPct ? " FAIL" : ""}  max ${r.max}`,
      );
      if (overMean) failures.push(`${view}: mean ${r.mean.toFixed(3)} > ${maxMean}`);
      if (overPct) failures.push(`${view}: ${r.pct.toFixed(3)}% of channels > 8, limit ${maxPct}%`);
    }
  } finally {
    await browser.close();
  }
  console.log(lines.join("\n"));
  if (failures.length) {
    console.log(`FRAME DIFF FAIL:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("FRAME DIFF PASS: every view is within the noise floor");
  }
}

if (command === "capture") {
  const url = argv[1];
  const outDir = argv[2];
  if (!url || !outDir) throw new Error("usage: compare-frames.mjs capture <url> <outDir> [--mode us-carrier-shadows]");
  const mode = flag("--mode", null);
  if (mode && mode !== "us-carrier-shadows") throw new Error(`unknown --mode ${JSON.stringify(mode)}`);
  await capture(url, outDir, mode);
} else if (command === "diff") {
  const dirA = argv[1];
  const dirB = argv[2];
  if (!dirA || !dirB) throw new Error("usage: compare-frames.mjs diff <dirA> <dirB> [--max-mean N] [--max-pct N]");
  await diff(dirA, dirB, Number(flag("--max-mean", 0.002)), Number(flag("--max-pct", 0.005)));
} else {
  throw new Error("usage: compare-frames.mjs <capture|diff> ... (see the file header)");
}
