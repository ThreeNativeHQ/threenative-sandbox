import type { IFrameBudgetWindow } from "@threenative/core";

/** What the perf loop records (`pnpm stress:loop record` in the engine repo reads this shape). */
export interface IStressReport {
  schema: "stress-lab-report/1";
  commit: string;
  preset: string;
  layers: string[];
  adapter: string;
  viewport: string;
  seconds: number;
  windows: number;
  metrics: {
    presentedP50Ms: number;
    presentedP95Ms: number;
    fps: number;
    /** Share of loop frames the renderer declined to draw, in percent. `fps` already leaves them out. */
    renderSkipPct: number;
    gpuP50Ms: number | null;
    gpuP95Ms: number | null;
    /** Where the device spent the frame: the main scene pass, every shadow pass, and the rest (post chain). */
    gpuMainMs: number | null;
    gpuShadowMs: number | null;
    gpuOtherMs: number | null;
    renderP50Ms: number;
    updateP50Ms: number;
    frameP50Ms: number;
    frameP95Ms: number;
    /** The median window's p99, and the worst window's p95: the median alone hides one bad window. */
    frameP99Ms: number;
    frameWorstP95Ms: number;
    mainDraws: number;
    shadowDraws: number | null;
    mainTrianglesM: number;
    hitchesPerMin: number;
    longTasks: number | null;
    loadMs: number | null;
    /** JS->Wasm crossings per frame (p50); null when the back end does not count them. */
    bridgeCrossingsP50: number | null;
    /** Host (ABI) calls per frame (p50). */
    hostCallsP50: number | null;
    /** GPU upload KB per frame (p50). */
    gpuUploadKbP50: number | null;
    /** JS heap allocation KB per frame (p50); needs performance.memory. */
    jsAllocKbP50: number | null;
  };
  counts: Record<string, number>;
  /**
   * PRD-828 AC-1's measurement: `jsBefore`, `update`, `engineJs` and `residual` per stage, p50 across
   * windows. A stage no window measured is absent, never zero. Absent on a build without stages.
   */
  stages?: Record<string, number>;
}

/** Windows the report skips after the scene is ready: shader compiles and first uploads. */
const WARMUP_WINDOWS = 2;

const scaled = (bytes: number | undefined) => (bytes === undefined ? undefined : bytes / 1024);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Pools `TN_FRAME_BUDGET` windows into one report. Each metric is the median of the per-window
 * value, so one bad window cannot move the KPI; hitches and long tasks are summed. Absent
 * measurements stay `null`, never zero.
 */
export class StressReport {
  #windows: IFrameBudgetWindow[] = [];
  #ready = 0;
  #scene: Omit<IStressReport, "schema" | "seconds" | "windows" | "metrics"> | undefined;
  #loadMs: number | null = null;

  /** Called by the scene once its world is built; windows before this are startup, not stress. */
  begin(
    scene: Omit<IStressReport, "schema" | "seconds" | "windows" | "metrics">,
    loadMs: number | null,
  ): void {
    this.#scene = scene;
    this.#loadMs = loadMs;
    this.#windows = [];
    this.#ready = 0;
    (globalThis as { __tnGpuSegments?: number[][] }).__tnGpuSegments = [];
  }

  observe(window: IFrameBudgetWindow): IStressReport | undefined {
    if (this.#scene === undefined) return undefined;
    this.#ready += 1;
    if (this.#ready <= WARMUP_WINDOWS) return undefined;
    this.#windows.push(window);
    if (this.#windows.length > 60) this.#windows.shift();
    const report = this.report();
    // `pnpm stress:loop fair` reads the page's report from here, once the window has settled.
    if (report !== undefined)
      (globalThis as { __TN_STRESS__?: IStressReport }).__TN_STRESS__ = report;
    return report;
  }

  report(): IStressReport | undefined {
    const windows = this.#windows;
    if (this.#scene === undefined || windows.length === 0) return undefined;
    const pick = (read: (w: IFrameBudgetWindow) => number | undefined): number | null => {
      const values = windows
        .map(read)
        .filter((v): v is number => v !== undefined && Number.isFinite(v));
      return values.length === 0 ? null : round(median(values));
    };
    const required = (
      name: string,
      read: (w: IFrameBudgetWindow) => number | undefined,
    ): number => {
      const value = pick(read);
      if (value === null) throw new Error(`TN_STRESS_REPORT: no window measured ${name}`);
      return value;
    };
    // The owned engine's split of each resolved GPU sample: [frame, sun shadow, scene, other passes, output,
    // gather, lamp shadow] in ms (three-native `__tnGpuSegments`). Absent on another renderer: the split stays null.
    const samples = (globalThis as { __tnGpuSegments?: number[][] }).__tnGpuSegments ?? [];
    if (samples.length > 4000) samples.splice(0, samples.length - 4000);
    const segment = (read: (sample: number[]) => number | undefined): number | null => {
      const values = samples.map(read).filter((v): v is number => v !== undefined && Number.isFinite(v));
      return values.length === 0 ? null : round(median(values));
    };
    const seconds = windows.reduce((sum, w) => sum + w.frames * (w.presented.mean / 1000), 0);
    const hitches = windows.reduce((sum, w) => sum + w.hitches, 0);
    const frames = windows.reduce((sum, w) => sum + w.frames, 0);
    const skipped = windows.reduce((sum, w) => sum + (w.renderSkips ?? 0), 0);
    const longTasks = windows.every((w) => w.longTasks.available)
      ? windows.reduce((sum, w) => sum + (w.longTasks.available ? w.longTasks.count : 0), 0)
      : null;
    const stageNames = new Set<string>();
    for (const window of windows) for (const name of Object.keys(window.stages ?? {})) stageNames.add(name);
    const stages = Object.fromEntries(
      [...stageNames]
        .map((name) => [
          name,
          pick((w) => w.stages?.[name]?.p50),
        ] as const)
        .filter((entry): entry is readonly [string, number] => entry[1] !== null),
    );
    return {
      schema: "stress-lab-report/1",
      ...this.#scene,
      seconds: round(seconds),
      windows: windows.length,
      ...(stageNames.size === 0 ? {} : { stages }),
      metrics: {
        presentedP50Ms: required("presented.p50", (w) => w.presented.p50),
        presentedP95Ms: required("presented.p95", (w) => w.presented.p95),
        // Frames the renderer drew, not loop ticks: a frame the Wasm engine declines (its GPU queue is full)
        // costs near zero and shows the previous image, so counting it reads a GPU-bound host as fast.
        fps: required("fps", (w) => (w.fps * (w.frames - (w.renderSkips ?? 0))) / w.frames),
        renderSkipPct: round((100 * skipped) / Math.max(1, frames)),
        bridgeCrossingsP50: pick((w) => w.counters?.bridgeCrossings?.p50),
        hostCallsP50: pick((w) => w.counters?.hostCalls?.p50),
        gpuUploadKbP50: pick((w) => scaled(w.counters?.gpuBytes?.p50)),
        jsAllocKbP50: pick((w) => scaled(w.counters?.jsAllocBytes?.p50)),
        gpuP50Ms: pick((w) => w.gpu?.p50),
        gpuP95Ms: pick((w) => w.gpu?.p95),
        gpuMainMs: segment((g) => g[2]),
        gpuShadowMs: segment((g) => (g[1] ?? 0) + (g[6] ?? 0)),
        gpuOtherMs: segment((g) => (g[3] ?? 0) + (g[4] ?? 0) + (g[5] ?? 0)),
        renderP50Ms: required("phases.render.p50", (w) => w.phases.render.p50),
        updateP50Ms: required("phases.update.p50", (w) => w.phases.update.p50),
        frameP50Ms: required("frame.p50", (w) => w.frame.p50),
        frameP95Ms: required("frame.p95", (w) => w.frame.p95),
        frameP99Ms: required("frame.p99", (w) => w.frame.p99),
        frameWorstP95Ms: round(Math.max(...windows.map((w) => w.frame.p95))),
        mainDraws: required("passes.main.draws.p50", (w) => w.passes?.main?.draws.p50),
        shadowDraws: pick((w) => w.passes?.shadow?.draws.p50),
        mainTrianglesM: required("passes.main.triangles.p50", (w) =>
          w.passes?.main === undefined ? undefined : w.passes.main.triangles.p50 / 1e6,
        ),
        hitchesPerMin: seconds > 0 ? round((hitches / seconds) * 60) : 0,
        longTasks,
        loadMs: this.#loadMs,
      },
    };
  }
}

/** The one pool `game.ts` feeds and `Stress.ts` starts. */
export const stressReport = new StressReport();
