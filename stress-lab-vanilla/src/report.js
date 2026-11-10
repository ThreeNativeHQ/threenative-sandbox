// The vanilla arm's stress report: the same schema `stress-lab` publishes in `globalThis.__TN_STRESS__`,
// measured from rAF alone, so `pnpm stress:loop fair` accepts both arms.
//
// Plain three.js has no FrameBudget, so a window here is 1 s of frames: percentiles over the frames of the
// window, the median across the last 60 windows. Absent measurements stay null, never zero.

/** Nearest rank: p95 of 10 frames is the 10th, so a window's tail is the tail it measured. */
const pct = (sorted, share) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (value) => Math.round(value * 100) / 100;

/** The frames of one window, pooled: p50/p95 of each metre, plus what the window cost in time. */
export function poolWindow(frames) {
  const of = (key) => {
    const sorted = frames.map((frame) => frame[key]).sort((a, b) => a - b);
    return { p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), p99: pct(sorted, 0.99) };
  };
  const span = (frames.at(-1).start - frames[0].start) / 1000;
  return {
    frames: frames.length,
    span,
    fps: span > 0 ? (frames.length - 1) / span : 0,
    presented: of("presented"),
    frame: of("frame"),
    update: of("update"),
    render: of("render"),
    draws: of("draws"),
    triangles: of("triangles"),
  };
}

export class StressReport {
  #scene;
  #loadMs;
  #windows = [];
  #frames = [];
  #ready = 0;
  #windowStart = 0;
  #lastStart;
  #hitches = 0;
  #longTasks = 0;
  #longTasksAvailable = false;

  /** `scene` is the report's identity: commit, preset, layers, adapter, viewport, counts. */
  begin(scene, loadMs) {
    this.#scene = scene;
    this.#loadMs = loadMs;
    this.#windows = [];
    this.#frames = [];
    this.#ready = 0;
    this.#windowStart = performance.now();
    this.#hitches = 0;
    new PerformanceObserver((list) => {
      this.#longTasksAvailable = true;
      this.#longTasks += list.getEntries().length;
    }).observe({ entryTypes: ["longtask"] });
  }

  /**
   * One frame, called from the rAF callback. `start` is the rAF timestamp, which bounds the frame interval;
   * `entry` is when the callback began, which is where the frame's own cost starts — the same definition
   * `FrameBudget` uses (its `frameStart`, with the host gap excluded). Measuring the cost from `start` would
   * bill the browser's pre-callback delay to the game and make the two arms' `frame` incomparable.
   */
  frame(start, { entry, update, render, draws, triangles, shadowTriangles, hitched }) {
    const presented = this.#lastStart === undefined ? 0 : start - this.#lastStart;
    this.#lastStart = start;
    if (hitched) this.#hitches += 1;
    this.#frames.push({
      start,
      frame: performance.now() - entry,
      update,
      render,
      draws,
      triangles: triangles - shadowTriangles,
      presented,
    });
    if (start - this.#windowStart < 1000) return undefined;
    const window = poolWindow(this.#frames);
    this.#frames = [];
    this.#windowStart = start;
    this.#ready += 1;
    // The first two windows are startup: shader compiles and the first uploads.
    if (this.#ready <= 2) return undefined;
    this.#windows.push({
      ...window,
      hitches: this.#hitches,
      longTasks: this.#longTasks,
      longTasksAvailable: this.#longTasksAvailable,
    });
    this.#hitches = 0;
    this.#longTasks = 0;
    if (this.#windows.length > 60) this.#windows.shift();
    return this.report();
  }

  report() {
    const windows = this.#windows;
    if (this.#scene === undefined || windows.length === 0) return undefined;
    const pick = (read) => {
      const values = windows.map(read).filter((v) => v !== undefined && Number.isFinite(v));
      return values.length === 0 ? null : round(median(values));
    };
    const required = (name, read) => {
      const value = pick(read);
      if (value === null) throw new Error(`TN_STRESS_REPORT: no window measured ${name}`);
      return value;
    };
    const seconds = windows.reduce((sum, w) => sum + w.span, 0);
    const hitches = windows.reduce((sum, w) => sum + w.hitches, 0);
    return {
      schema: "stress-lab-report/1",
      ...this.#scene,
      seconds: round(seconds),
      windows: windows.length,
      metrics: {
        presentedP50Ms: required("presented.p50", (w) => w.presented.p50),
        presentedP95Ms: required("presented.p95", (w) => w.presented.p95),
        fps: required("fps", (w) => w.fps),
        bridgeCrossingsP50: null,
        hostCallsP50: null,
        gpuUploadKbP50: null,
        jsAllocKbP50: null,
        gpuP50Ms: null,
        gpuP95Ms: null,
        renderP50Ms: required("phases.render.p50", (w) => w.render.p50),
        updateP50Ms: required("phases.update.p50", (w) => w.update.p50),
        frameP50Ms: required("frame.p50", (w) => w.frame.p50),
        frameP95Ms: required("frame.p95", (w) => w.frame.p95),
        // The median window's p99, and the worst window's p95: the median alone hides one bad window.
        frameP99Ms: required("frame.p99", (w) => w.frame.p99),
        frameWorstP95Ms: round(Math.max(...windows.map((w) => w.frame.p95))),
        mainDraws: required("passes.main.draws.p50", (w) => w.draws.p50),
        // WebGPURenderer counts its shadow pass inside the frame's draw calls; no split is published.
        shadowDraws: null,
        mainTrianglesM: required("passes.main.triangles.p50", (w) => w.triangles.p50 / 1e6),
        shadowTrianglesM: null,
        hitchesPerMin: seconds > 0 ? round((hitches / seconds) * 60) : 0,
        longTasks: windows.some((w) => w.longTasksAvailable)
          ? windows.reduce((sum, w) => sum + w.longTasks, 0)
          : null,
        loadMs: this.#loadMs,
      },
    };
  }
}

/** Publishes the report the fair tool reads; nothing on the page reads it back. */
export function publish(report) {
  if (report !== undefined) globalThis.__TN_STRESS__ = report;
}

/** Pooling is what turns frames into the numbers the window is judged on: the smallest check that fails if it breaks. */
export function demo() {
  if (pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5) !== 5) throw new Error("pct 0.5");
  if (pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95) !== 10) throw new Error("pct 0.95");
  if (median([3, 1, 2]) !== 2) throw new Error("median");
  const frames = [0, 10, 20, 30].map((start, i) => ({
    start,
    frame: 10 - i,
    update: 1,
    render: 5,
    draws: 100 + i,
    triangles: 1e6,
    presented: 10,
  }));
  const window = poolWindow(frames);
  if (Math.abs(window.fps - 100) > 1e-6) throw new Error(`fps ${window.fps}`);
  if (window.draws.p50 !== 101) throw new Error(`draws ${window.draws.p50}`);
  if (window.frame.p95 !== 10) throw new Error("frame.p95");
  if (window.frame.p99 !== 10) throw new Error("frame.p99");
  return "demo: ok";
}
