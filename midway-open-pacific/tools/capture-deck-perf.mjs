/**
 * Deck-start per-pass cost, read from the engine's own `TN_FRAME_BUDGET` window.
 *
 * Promoted from `docs/perf/deck-probe-20260922.mjs`, which read `renderer.info.render` and so could
 * only ever report main plus every nested pass summed. `info` is reset once per frame and shared by
 * the nested shadow and reflection `render()` calls, so it cannot say which pass a change moved.
 * The frame budget's `passes` block is the split — main, shadow, reflection, nested, by draws and
 * triangles — and the same window carries the GPU and render-phase p50/p95, so the whole report is
 * one instrument's numbers.
 *
 * Sampling starts only after the briefing's `warmUpViews()` resolves, so the compile's texture
 * uploads are not in the window. `MIDWAY_HIDE` names a layer to switch off for attribution; the
 * hide is re-applied after every `World.update`, which otherwise rewrites `visible` each frame.
 * `us-carrier-shadows` is the AC-3/AC-4 negative control: it switches `castShadow` off on every
 * mesh under the three US carriers, which changes the picture (a nerf the look comparison must
 * catch) and nothing else.
 *
 * Per-carrier, per-pass SUBMISSION counts are taken at the renderer's per-object submit, so a mesh
 * cast into the shadow map is charged to the shadow pass and not to main. They are reported per
 * engine window beside the `TN_FRAME_BUDGET` split, home carrier flagged, and each shadow submission
 * is tagged `part` (the carrier's own static geometry), `proxy` (the single shadow-only merge that
 * replaces it) or `moving` (the deck crew and the player aircraft that ride it and must keep
 * casting). AC-4 ("US carrier shadow-pass draws <= 12") counts `part + proxy`; the movers are
 * unchanged by design. AC-5 ("home-carrier main-pass draws <= 80") is judged from the same report.
 *
 *   MIDWAY_URL=http://localhost:5341 node tools/capture-deck-perf.mjs
 *   MIDWAY_HIDE=us-carriers MIDWAY_URL=http://localhost:5341 node tools/capture-deck-perf.mjs
 *   MIDWAY_HIDE=us-carrier-shadows MIDWAY_URL=http://localhost:5341 node tools/capture-deck-perf.mjs
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const URL = process.env.MIDWAY_URL || "http://localhost:5341";
const WIDTH = Number(process.env.MIDWAY_WIDTH || 1920);
const HEIGHT = Number(process.env.MIDWAY_HEIGHT || 1080);
const WARMUP = Number(process.env.MIDWAY_WARMUP || 8);
// The marker the engine prints once per report window (default every 300 presented frames).
const MARKER = "TN_FRAME_BUDGET:";
const HIDDEN = process.env.MIDWAY_HIDE || null;

const budgetWindows = [];
let budgetCursor = 0;

const browser = await chromium.launch({
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
    "--ozone-platform=x11",
    // Timestamp queries are behind Dawn's unsafe-API flag; without them there is no GPU series.
    "--enable-dawn-features=allow_unsafe_apis",
  ],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    const text = m.text();
    if (text.startsWith(MARKER)) {
      try {
        budgetWindows.push(JSON.parse(text.slice(MARKER.length)));
      } catch {
        errors.push(`unparseable ${MARKER} line: ${text.slice(0, 200)}`);
      }
      return;
    }
    if (m.type() === "error") errors.push(text);
  });
  await page.goto(URL);
  await page.waitForSelector("#loading.hidden", { state: "attached", timeout: 180000 });
  await page.waitForSelector("#briefing:not(.hidden)");
  // The scene publishes itself on entry in a dev build, so nothing has to re-import `/src/game.ts`
  // and walk the resource timeline to find a second copy of the module.
  await page.evaluate(() => {
    window.midway = window.__THREENATIVE__?.debug?.scene;
    if (!window.midway?.battle) throw new Error("no scene under window.__THREENATIVE__.debug.scene");
  });

  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    return {
      vendor: a.info.vendor,
      architecture: a.info.architecture,
      device: a.info.device,
      description: a.info.description,
    };
  });
  if (/swiftshader|lavapipe|llvmpipe/i.test(JSON.stringify(adapter)))
    throw new Error(`software adapter, the figure would be meaningless: ${JSON.stringify(adapter)}`);

  // The briefing's compile is unawaited by the game; sample only once it has settled. A build that
  // predates the `warmUpDone` promise has nothing to await, and its compile is long finished by the
  // fixed warm-up wait below, so the sampling window is still honest against it.
  const warmUp = await page.evaluate(async () => {
    const w = window.midway.world;
    if (w.warmUpDone === undefined) return { resolvedAt: null, waitedMs: 0 };
    const started = performance.now();
    while (w.warmUpDone === null) await new Promise((r) => setTimeout(r, 20));
    const resolvedAt = await w.warmUpDone;
    return { resolvedAt, waitedMs: performance.now() - started };
  });
  console.log(
    warmUp.resolvedAt === null
      ? "warm-up marker unavailable in this build (pre-dates warmUpDone); the fixed wait stands in for it"
      : `warm-up resolved at ${warmUp.resolvedAt.toFixed(1)} ms (page clock); the wait began ${warmUp.waitedMs.toFixed(1)} ms before it`,
  );

  // The engine's adaptive scaler walks the drawing buffer down on a contended host, and the game's
  // canvas is a direct child of `body` (src/ui/dom.ts) with no CSS size, so the next resize reads
  // the buffer back through `clientWidth` and the surface collapses to 3x3 — a window that reports
  // almost every draw culled. Pin the scale at the baseline's 1.0 for the measurement; it changes
  // nothing the game ships and is reported in each window's `surface.resolutionScale`.
  await page.evaluate(() => {
    const renderer = window.midway.world.host?.renderer;
    if (typeof renderer?.setResolutionScale !== "function") return;
    const original = renderer.setResolutionScale.bind(renderer);
    renderer.setResolutionScale = (scale, source) => original(1, "pinned");
    original(1, "pinned");
  });

  // The deck start: the player aboard the home carrier, its full park and crew on screen.
  await page.evaluate(() => window.midway.begin(false));

  // Attribution hide. `World.update` rewrites `visible` on every ship every frame, so re-hide the
  // chosen ids after each update rather than letting the hide be undone.
  if (HIDDEN)
    await page.evaluate((what) => {
      const w = window.midway.world;
      const hidden = new Set();
      const noShadow = new Set();
      if (what === "sea") w.sea.visible = false;
      if (what === "ships") for (const id of w.meshes.keys()) if (!id.startsWith("air-")) hidden.add(id);
      // The three Yorktown-class US carriers are the ships drawn from `hornet.glb`.
      if (what === "us-carriers")
        for (const s of w.battle.ships) if (s.team === "us" && s.kind === "carrier") hidden.add(s.id);
      // The AC-4 negative control: the same three carriers keep drawing, but stop casting. Every
      // mesh under the root, so the hull, the park, the decor and the crew all go dark at once.
      if (what === "us-carrier-shadows")
        for (const s of w.battle.ships) if (s.team === "us" && s.kind === "carrier") noShadow.add(s.id);
      if (what === "crew") w.crew.group.visible = false;
      if (what === "sky") w.scene.background = null;
      if (hidden.size || noShadow.size) {
        const apply = () => {
          for (const id of hidden) {
            const m = w.meshes.get(id);
            if (m) m.visible = false;
          }
          for (const id of noShadow) {
            const m = w.meshes.get(id);
            if (m) m.traverse((o) => { if (o.isMesh) o.castShadow = false; });
          }
        };
        const orig = w.update;
        w.update = function (...args) {
          orig.apply(this, args);
          apply();
        };
        apply();
      }
    }, HIDDEN);

  // Per-carrier, per-pass submissions, counted at the two places three actually submits. The shadow
  // pass has its own render-object function and calls `renderer.renderObject` directly, so that is
  // wrapped for shadow; the main and mirrored passes walk their render lists through
  // `_renderObjects`, so that is wrapped for everything else (skipping the shadow list). The two are
  // mutually exclusive, so nothing is counted twice. The pass comes from the scene name, the same
  // signal the engine's own budget uses: ShadowNode renames the scene `Shadow Map [...]` and
  // ReflectorNode appends `[ Reflector ]`. Window boundaries come from the `TN_FRAME_BUDGET` marker
  // itself, so they line up with the engine's split.
  const countersInstalled = await page.evaluate((marker) => {
    const w = window.midway.world;
    const raw = w.renderer;
    const homeId = w.battle.home?.id ?? w.battle.home;
    const carriers = w.battle.ships
      .filter((s) => s.team === "us" && s.kind === "carrier")
      .map((s) => ({ id: s.id, name: s.name, home: homeId === s.id }));
    const roots = carriers.map((c) => ({ c, root: w.meshes.get(c.id) })).filter((x) => x.root);
    if (!roots.length || typeof raw.renderObject !== "function") return null;
    const st = { carriers, frames: 0, sums: new Map(), windows: [] };
    window.__deckCount = st;
    const isShadow = (scene) => !!scene && typeof scene.name === "string" && /^Shadow Map/.test(scene.name);
    const passOf = (scene) => {
      const name = scene && typeof scene.name === "string" ? scene.name : "";
      if (/^Shadow Map/.test(name)) return "shadow";
      if (/reflect/i.test(name)) return "reflection";
      return "main";
    };
    const carrierOf = (object) => {
      for (let o = object; o; o = o.parent)
        for (const x of roots) if (o === x.root) return x.c.id;
      return null;
    };
    const count = (object, scene) => {
      const id = carrierOf(object);
      if (!id) return;
      // Tag each submission: the carrier's own static parts, its shadow-only proxy, or a mover that
      // rides it (the skinned deck party, the player's aircraft while wheels-down). The proxy is
      // found by its root, not its layer, because the hull body also carries the reflection bit.
      // AC-4 counts own = parts + proxy; the movers are unchanged by design.
      let tag = "part";
      for (let o = object; o && tag === "part"; o = o.parent)
        for (const x of roots) if (x.root?.userData?.shadowProxy && o === x.root.userData.shadowProxy) tag = "proxy";
      if (tag === "part") {
        if (object.isSkinnedMesh) tag = "moving";
        else if (object.userData.shadowMover) tag = "moving";
        else
          for (let o = object; o; o = o.parent)
            if (o === w.crew?.group || o === w.playerMesh) { tag = "moving"; break; }
      }
      const key = `${id}|${passOf(scene)}|${tag}`;
      st.sums.set(key, (st.sums.get(key) ?? 0) + 1);
    };
    const origRenderObject = raw.renderObject;
    raw.renderObject = function (...args) {
      if (isShadow(args[1])) count(args[0], args[1]);
      return origRenderObject.apply(this, args);
    };
    const proto = Object.getPrototypeOf(raw);
    const origRenderObjects = proto._renderObjects;
    const useRenderObjects = typeof origRenderObjects === "function";
    if (useRenderObjects)
      proto._renderObjects = function (list, camera, scene, ...rest) {
        if (!isShadow(scene)) for (let i = 0; i < list.length; i += 1) count(list[i].object, scene);
        return origRenderObjects.call(this, list, camera, scene, ...rest);
      };
    else if (typeof raw.setRenderObjectFunction === "function") {
      const origFn = typeof raw.getRenderObjectFunction === "function" ? raw.getRenderObjectFunction() : null;
      raw.setRenderObjectFunction((...args) => {
        if (!isShadow(args[1])) count(args[0], args[1]);
        return origFn ? origFn.apply(raw, args) : origRenderObject.apply(raw, args);
      });
    }
    const origRender = raw.render;
    let depth = 0;
    raw.render = function (...args) {
      depth += 1;
      try {
        return origRender.apply(this, args);
      } finally {
        depth -= 1;
        if (depth === 0) st.frames += 1;
      }
    };
    const origLog = console.log;
    console.log = function (...args) {
      if (typeof args[0] === "string" && args[0].startsWith(marker)) {
        st.windows.push({ frames: st.frames, sums: [...st.sums] });
        st.frames = 0;
        st.sums = new Map();
      }
      return origLog.apply(console, args);
    };
    return { carriers: carriers.map((c) => ({ id: c.id, name: c.name, home: c.home })), useRenderObjects };
  }, MARKER);
  // The marker hook starts now, so drop the windows recorded before it: both arrays then begin at
  // the same window and index `i` means the same thing in each.
  if (countersInstalled) {
    budgetWindows.length = 0;
    budgetCursor = 0;
  }

  // Warm-up, then four complete windows. The first windows after the cursor can straddle setup or
  // the tail of the compile, so the last two are taken and both are reported.
  await page.waitForTimeout(WARMUP * 1000);

  // The static predicate's own proof: every mesh the proxy and the main-pass merge consumed must
  // hold its pose relative to its aircraft/hull root. The world rebuilds each one's relative matrix
  // from the parent that stays in the graph, so any animator write on a mesh the merge baked shows
  // up here. Sixty frames is about a second — long enough for a settled animator to drift.
  const drift = await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        const w = window.midway.world;
        if (typeof w.sampleStaticDrift !== "function") {
          resolve({ available: false });
          return;
        }
        let worst = 0;
        let last = 0;
        let samples = 0;
        const step = () => {
          last = w.sampleStaticDrift();
          if (last > worst) worst = last;
          samples += 1;
          if (samples < frames) requestAnimationFrame(step);
          else resolve({ available: true, worst, last, samples, total: w.staticSources.length });
        };
        requestAnimationFrame(step);
      }),
    60,
  );
  if (drift.available) {
    console.log(
      `static-source drift over ${drift.samples} frames: ${drift.worst} of ${drift.total} consumed meshes changed (must be 0)`,
    );
    if (drift.worst !== 0)
      throw new Error(
        `static-source drift: ${drift.worst} of ${drift.total} meshes the merge consumed moved — a mover was baked as static`,
      );
  }

  const wanted = 4;
  const needed = budgetCursor + wanted;
  const deadline = Date.now() + 240000;
  while (budgetWindows.length < needed) {
    if (Date.now() > deadline)
      throw new Error(
        `no ${MARKER} window in 240 s (have ${budgetWindows.length - budgetCursor} of ${wanted}) — is the frame budget installed?`,
      );
    await page.waitForTimeout(100);
  }
  const measured = budgetWindows.slice(needed - 2, needed);
  budgetCursor = needed;

  const PASS_KINDS = ["main", "shadow", "reflection", "nested"];
  const summarize = (w) => {
    const passes = {};
    let totalDraws = 0;
    let totalTriangles = 0;
    for (const kind of PASS_KINDS) {
      const p = w.passes?.[kind];
      if (!p) continue;
      passes[kind] = {
        frames: p.frames,
        drawsMean: +p.draws.mean.toFixed(1),
        drawsP50: p.draws.p50,
        trianglesMean: Math.round(p.triangles.mean),
      };
      totalDraws += p.draws.mean;
      totalTriangles += p.triangles.mean;
    }
    return {
      frames: w.frames,
      fps: w.fps,
      surface: w.surface
        ? { width: w.surface.drawingBufferWidth, height: w.surface.drawingBufferHeight, scale: w.surface.resolutionScale }
        : null,
      passes,
      totalDrawsMean: +totalDraws.toFixed(1),
      totalTrianglesMean: Math.round(totalTriangles),
      gpuP50: w.gpu?.p50 ?? null,
      gpuP95: w.gpu?.p95 ?? null,
      renderCpuP50: w.phases.render.p50,
      renderCpuP95: w.phases.render.p95,
    };
  };
  const windows = measured.map(summarize);

  const record = {
    tool: "capture-deck-perf",
    schema: 1,
    at: new Date().toISOString(),
    adapter,
    url: URL,
    viewport: { width: WIDTH, height: HEIGHT },
    hidden: HIDDEN,
    warmUpResolvedAtMs: warmUp.resolvedAt === null ? null : +warmUp.resolvedAt.toFixed(1),
    windows,
  };

  console.log(`adapter ${JSON.stringify(adapter)}`);
  console.log(`viewport ${WIDTH}x${HEIGHT}, MIDWAY_HIDE=${HIDDEN ?? "none"}`);
  for (const [i, w] of windows.entries()) {
    const pass = PASS_KINDS.filter((k) => w.passes[k])
      .map((k) => `${k} ${w.passes[k].drawsMean}d/${w.passes[k].trianglesMean}t`)
      .join("  ");
    console.log(
      `window ${i + 1}: ${w.frames} frames, ${w.fps} fps, surface ${w.surface ? `${w.surface.width}x${w.surface.height} scale ${w.surface.scale}` : "unavailable"}\n` +
        `  passes ${pass || "unavailable: no pass recorder"}\n` +
        `  total ${w.totalDrawsMean} draws, ${w.totalTrianglesMean} triangles\n` +
        `  gpu p50/p95 ${w.gpuP50 ?? "n/a"}/${w.gpuP95 ?? "n/a"} ms, render cpu p50/p95 ${w.renderCpuP50}/${w.renderCpuP95} ms`,
    );
  }
  if (!windows.some((w) => Object.keys(w.passes).length))
    throw new Error("the frame budget reported no per-pass split; nothing to attribute");

  // Per-carrier submissions for the same two measured windows, and the subtree census they are
  // judged against. `visible` follows the ancestors, so a mesh under a hidden LOD level is not
  // counted as drawn.
  const deckCount = countersInstalled
    ? await page.evaluate((upto) => {
        const st = window.__deckCount;
        if (!st) return null;
        const world = window.midway.world;
        const census = st.carriers.map((c) => {
          const root = world.meshes.get(c.id);
          const materials = new Set();
          let visibleMeshes = 0;
          let shadowMeshes = 0;
          const walk = (o) => {
            if (!o.visible) return;
            if (o.isMesh) {
              visibleMeshes += 1;
              if (o.castShadow) shadowMeshes += 1;
              for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) materials.add(m.uuid);
            }
            for (const child of o.children) walk(child);
          };
          if (root) walk(root);
          return { ...c, visibleMeshes, shadowMeshes, materials: materials.size };
        });
        return { carriers: census, windows: st.windows.slice(Math.max(0, upto - 2), upto).map((x) => ({ frames: x.frames, sums: x.sums })) };
      }, needed)
    : null;
  if (deckCount) {
    console.log("per-carrier submissions (mean per frame; home flagged)");
    deckCount.windows.forEach((win, i) => {
      const frames = Math.max(1, win.frames);
      const sums = new Map(win.sums);
      console.log(`  submissions window ${i + 1}: ${win.frames} frames counted`);
      for (const c of deckCount.carriers) {
        const at = (pass, tag) => (sums.get(`${c.id}|${pass}|${tag}`) ?? 0) / frames;
        const shadow = at("shadow", "part") + at("shadow", "proxy") + at("shadow", "moving");
        const own = at("shadow", "part") + at("shadow", "proxy");
        const pass = (p) => at(p, "part") + at(p, "proxy") + at(p, "moving");
        console.log(
          `    ${c.name}${c.home ? " (home)" : ""}: shadow ${shadow.toFixed(1)} ` +
            `(own ${own.toFixed(1)} = parts ${at("shadow", "part").toFixed(1)} + proxy ${at("shadow", "proxy").toFixed(1)}; movers ${at("shadow", "moving").toFixed(1)})  ` +
            `reflection ${pass("reflection").toFixed(1)}  main ${pass("main").toFixed(1)} ` +
            `(own ${(at("main", "part") + at("main", "proxy")).toFixed(1)}; movers ${at("main", "moving").toFixed(1)})`,
        );
      }
    });
    // The AC-4 line: the US carriers' own static shadow submissions, and proof the proxy submits
    // only in the shadow pass.
    const ownSum = deckCount.windows.map((win) => {
      const frames = Math.max(1, win.frames);
      const sums = new Map(win.sums);
      return deckCount.carriers.reduce(
        (a, c) => a + ((sums.get(`${c.id}|shadow|part`) ?? 0) + (sums.get(`${c.id}|shadow|proxy`) ?? 0)) / frames,
        0,
      );
    });
    const last = deckCount.windows.at(-1);
    const lastFrames = Math.max(1, last.frames);
    const lastSums = new Map(last.sums);
    const proxyPass = (p) =>
      deckCount.carriers.reduce((a, c) => a + ((lastSums.get(`${c.id}|${p}|proxy`) ?? 0) / lastFrames), 0);
    console.log(`AC-4 US-carrier own shadow submissions (parts + proxy): ${ownSum.map((v) => v.toFixed(1)).join(" / ")}`);
    // The AC-5 line: the home carrier's own static main submissions, apart from the player aircraft
    // and crew that ride it. The merge is judged on the geometry it merged.
    const mainOwnSum = deckCount.windows.map((win) => {
      const frames = Math.max(1, win.frames);
      const sums = new Map(win.sums);
      return deckCount.carriers.reduce(
        (a, c) => a + ((sums.get(`${c.id}|main|part`) ?? 0) + (sums.get(`${c.id}|main|proxy`) ?? 0)) / frames,
        0,
      );
    });
    const mainTotalSum = deckCount.windows.map((win) => {
      const frames = Math.max(1, win.frames);
      const sums = new Map(win.sums);
      return deckCount.carriers.reduce(
        (a, c) =>
          a + ((sums.get(`${c.id}|main|part`) ?? 0) + (sums.get(`${c.id}|main|proxy`) ?? 0) + (sums.get(`${c.id}|main|moving`) ?? 0)) / frames,
        0,
      );
    });
    console.log(`AC-5 US-carrier own main submissions (parts + proxy): ${mainOwnSum.map((v) => v.toFixed(1)).join(" / ")}`);
    console.log(`AC-5 US-carrier total main submissions (own + movers): ${mainTotalSum.map((v) => v.toFixed(1)).join(" / ")}`);
    console.log(
      `proxy submissions by pass (last window): shadow ${proxyPass("shadow").toFixed(1)}, ` +
        `main ${proxyPass("main").toFixed(1)}, reflection ${proxyPass("reflection").toFixed(1)}`,
    );
    console.log("per-carrier census (visible meshes / castShadow meshes / distinct materials)");
    for (const c of deckCount.carriers)
      console.log(`  ${c.name}${c.home ? " (home)" : ""}: ${c.visibleMeshes} / ${c.shadowMeshes} / ${c.materials}`);
  }

  // The stock baseline, written where AC-2 records it. A hidden run is attribution, never a baseline.
  const baselineOut = process.env.MIDWAY_DECK_BASELINE_OUT || (!HIDDEN ? join(import.meta.dirname, "..", "docs/perf/deck-baseline-20260922.json") : null);
  if (baselineOut) {
    await writeFile(baselineOut, JSON.stringify(record, null, 2));
    console.log(`baseline written to ${baselineOut}`);
  }
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(" | ")}`);
} finally {
  await browser.close();
}
