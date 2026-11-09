import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { ACTION_BINDINGS, Midway, type GameState } from "./scenes/Midway.js";
import { createUiBridge } from "./ui/bridge.js";
import { setShell, type Intent } from "./ui/port.js";

const game = defineGame<GameState>({
  camera: { projection: "perspective", fov: 57, near: 0.6, far: 95000 },
  display: config.display,
  plugins: [playtest()],
  render: config.renderer,
  input: { ...ACTION_BINDINGS, aim: { pointerRelative: true, captureOnClick: false } },
  scenes: { midway: Midway },
  start: "midway",
  step: 1 / 60,
  autoBatch: false,
});

/**
 * The UI a native target draws is this game's own `index.html`, running in the platform's web
 * view. It cannot see the `Battle`, so the scene's shell calls are published as state and replayed
 * there against the real markup — which is also why the scene no longer starts the sortie by
 * itself on native: there is a briefing on screen now, with the aircraft chooser it was missing.
 */
const bridge = createUiBridge((patch) => game.state.set(patch));
setShell(bridge.shell);

/**
 * Prove the UI layer is really up, not merely that a state snapshot crossed the channel.
 *
 * On native the web view attaches, subscribes and stays blank until the page announces itself with
 * an intent; `ui.connected` is false until then. `src/ui/main.tsx` sends `ui-ready` once it has
 * mounted the markup and installed the shell, so `uiReady` records the UI actually being up rather
 * than the player happening to press something. Only `midway` carries a scene intent.
 */
game.ui.onIntent((intent, payload) => {
  game.state.set({ uiReady: game.ui.connected });
  game.state.flush();
  if (intent === "midway") bridge.emit(payload as Intent);
});

export default game;
