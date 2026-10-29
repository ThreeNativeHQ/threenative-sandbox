import { useUiState } from "@threenative/ui";
import { useEffect } from "react";
import type { GameState } from "../state.js";

/**
 * The stress lab's live KPIs, read from the pooled `TN_FRAME_BUDGET` report the game publishes.
 * The same report is on `window.__TN_STRESS__` for DevTools and capture scripts.
 */
export function StressPanel() {
  const state = useUiState<GameState>();
  const report = state?.stress ?? null;
  useEffect(() => {
    (globalThis as { __TN_STRESS__?: unknown }).__TN_STRESS__ = report;
  }, [report]);
  if (state === undefined || state.mode !== "stress") return null;
  if (report === null)
    return (
      <div className="pointer-events-none absolute left-4 top-4 rounded bg-panel p-3 text-xs text-dim">
        stress lab: warming up…
      </div>
    );
  const m = report.metrics;
  const ms = (value: number | null) => (value === null ? "—" : value.toFixed(2));
  const rows: [string, string][] = [
    ["fps", m.fps.toFixed(1)],
    ["presented p50 / p95", `${ms(m.presentedP50Ms)} / ${ms(m.presentedP95Ms)} ms`],
    ["gpu p50 / p95", `${ms(m.gpuP50Ms)} / ${ms(m.gpuP95Ms)} ms`],
    ["render / update p50", `${ms(m.renderP50Ms)} / ${ms(m.updateP50Ms)} ms`],
    ["cpu frame p50 / p95", `${ms(m.frameP50Ms)} / ${ms(m.frameP95Ms)} ms`],
    ["draws main / shadow", `${m.mainDraws} / ${m.shadowDraws ?? "—"}`],
    ["main triangles", `${m.mainTrianglesM.toFixed(2)} M`],
    ["hitches / min", String(m.hitchesPerMin)],
  ];
  return (
    <div className="pointer-events-none absolute left-4 top-4 rounded bg-panel p-3 font-mono text-[11px] leading-5 text-lume">
      <div className="mb-1 uppercase tracking-[0.14em] text-dim">
        stress lab · {report.preset} · {report.adapter} · {report.viewport}
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-6">
          <span className="text-dim">{label}</span>
          <span className="tabular-nums">{value}</span>
        </div>
      ))}
      <div className="mt-1 text-dim">
        {report.windows} windows · {report.seconds}s pooled
      </div>
    </div>
  );
}
