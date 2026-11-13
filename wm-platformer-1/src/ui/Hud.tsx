import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

function Heart({ full }: { full: boolean }) {
  return (
    <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24">
      <path
        d="M12 21s-8.5-5.4-8.5-11.2A4.8 4.8 0 0 1 12 7a4.8 4.8 0 0 1 8.5 2.8C20.5 15.6 12 21 12 21z"
        fill={full ? "var(--color-heart)" : "var(--color-line)"}
        stroke={full ? "#8f1f2a" : "var(--color-line)"}
        strokeWidth="1.6"
      />
    </svg>
  );
}

/** The collectible the route is paved with: one gold disc with a rim, at HUD scale. */
function Coin() {
  return (
    <svg aria-hidden="true" className="h-7 w-7" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" fill="var(--color-lume)" stroke="#a3691a" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4.6" fill="none" stroke="#a3691a" strokeWidth="1.6" />
    </svg>
  );
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const centis = Math.floor((seconds - whole) * 100);
  return `${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/**
 * The one HUD, and the same file on every target.
 *
 * It reads published state and nothing else: the simulation keeps its own numbers and this never
 * reaches into the scene. The bridge flushes about every 100 ms, so a number here is at most that
 * old — which is why the fox's per-frame feel is never read from this component.
 *
 * Two corners, as the reference frame has them: what the player has collected, and what the
 * player is being asked to do. The objective is the top-right line and it turns green when it is
 * met, because a HUD that only counts coins never tells a first-time player where to go.
 */
export function Hud() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  // Rendering zeroes instead would put wrong numbers on screen and then correct them.
  if (state === undefined) return null;
  return (
    <div className="pointer-events-none absolute inset-0 p-6 font-bold text-text">
      <div className="flex w-fit items-center gap-3 rounded-2xl border-2 border-line bg-panel/40 px-4 py-2.5 backdrop-blur-sm shadow-none">
        <span aria-label={`${state.hearts} of 3 hearts left`} className="flex gap-0.5">
          {[0, 1, 2].map((slot) => (
            <Heart full={slot < state.hearts} key={slot} />
          ))}
        </span>
        <span className="flex items-center gap-1.5 text-2xl leading-none">
          <Coin />×{" "}
          <b id="coins" className="text-lume">
            {state.coins}
          </b>
        </span>
      </div>

      <div className="absolute right-6 top-6 rounded-2xl border-2 border-line bg-panel/40 px-4 py-2.5 text-right backdrop-blur-sm shadow-none">
        <div className={`text-xl leading-tight ${state.finished ? "text-lume" : "text-text"}`}>
          {state.finished ? "GOAL!" : "reach the goal flag"}
        </div>
        <div className="mt-1 flex justify-end gap-4 text-sm text-dim">
          <span id="clock" className="tabular-nums">
            {clock(state.time)}
          </span>
          <span>
            gems{" "}
            <b id="gems" className="text-lume">
              {state.gems}/{state.gemTotal}
            </b>
          </span>
          <span>
            stars{" "}
            <b id="stars" className="text-lume">
              {state.stars}
            </b>
          </span>
        </div>
      </div>

      {state.toast !== "" ? (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 rounded-full border-2 border-line bg-panel/40 px-5 py-1 text-lg font-bold text-lume backdrop-blur-sm shadow-none">
          {state.toast}
        </div>
      ) : null}
    </div>
  );
}
