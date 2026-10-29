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
    gpuP50Ms: number | null;
    gpuP95Ms: number | null;
    renderP50Ms: number;
    updateP50Ms: number;
    frameP50Ms: number;
    frameP95Ms: number;
    mainDraws: number;
    shadowDraws: number | null;
    mainTrianglesM: number;
    hitchesPerMin: number;
    longTasks: number | null;
    loadMs: number | null;
  };
  counts: Record<string, number>;
}

/** Windows the report skips after the scene is ready: shader compiles and first uploads. */
const WARMUP_WINDOWS = 2;

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
  }

  observe(window: IFrameBudgetWindow): IStressReport | undefined {
    if (this.#scene === undefined) return undefined;
    this.#ready += 1;
    if (this.#ready <= WARMUP_WINDOWS) return undefined;
    this.#windows.push(window);
    if (this.#windows.length > 60) this.#windows.shift();
    return this.report();
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
    const seconds = windows.reduce((sum, w) => sum + w.frames * (w.presented.mean / 1000), 0);
    const hitches = windows.reduce((sum, w) => sum + w.hitches, 0);
    const longTasks = windows.every((w) => w.longTasks.available)
      ? windows.reduce((sum, w) => sum + (w.longTasks.available ? w.longTasks.count : 0), 0)
      : null;
    return {
      schema: "stress-lab-report/1",
      ...this.#scene,
      seconds: round(seconds),
      windows: windows.length,
      metrics: {
        presentedP50Ms: required("presented.p50", (w) => w.presented.p50),
        presentedP95Ms: required("presented.p95", (w) => w.presented.p95),
        fps: required("fps", (w) => w.fps),
        gpuP50Ms: pick((w) => w.gpu?.p50),
        gpuP95Ms: pick((w) => w.gpu?.p95),
        renderP50Ms: required("phases.render.p50", (w) => w.phases.render.p50),
        updateP50Ms: required("phases.update.p50", (w) => w.phases.update.p50),
        frameP50Ms: required("frame.p50", (w) => w.frame.p50),
        frameP95Ms: required("frame.p95", (w) => w.frame.p95),
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
