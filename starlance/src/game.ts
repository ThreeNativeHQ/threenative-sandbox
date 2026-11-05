import { defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import config from "../threenative.config.js";
import { Play } from "./scenes/Play.js";
import type { GameState } from "./state.js";

const game = defineGame<GameState>({
  input: {
    // Keyboard stick; W climbs. `vector("move").y` is +up.
    move: {
      down: ["ArrowDown", "KeyS"],
      left: ["ArrowLeft", "KeyA"],
      right: ["ArrowRight", "KeyD"],
      up: ["ArrowUp", "KeyW"],
    },
    // Gamepad left stick, read with `axis()`; added to `move` by the ship.
    stickX: { gamepadAxes: [0] },
    stickY: { gamepadAxes: [1] },
    // Left mouse fires (hold repeats); right mouse holds the charge-lock shot, released to fire.
    fire: { keys: ["Space", "KeyJ"], buttons: [0], mouseButtons: [0] },
    charge: { keys: ["KeyF", "KeyH"], buttons: [2], mouseButtons: [2] },
    bomb: { keys: ["KeyB", "KeyU"], buttons: [1] },
    bankLeft: { keys: ["KeyQ"], buttons: [4] },
    bankRight: { keys: ["KeyE"], buttons: [5] },
    boost: { keys: ["ShiftLeft", "ShiftRight", "KeyK"], buttons: [7] },
    brake: { keys: ["KeyL"], buttons: [6] },
    cockpit: { keys: ["KeyC"], buttons: [3] }, // toggles chase/cockpit view
    restart: { keys: ["Enter"], buttons: [9] },
  },
  plugins: [playtest()],
  display: config.display,
  render: config.renderer,
  scenes: { play: Play },
  start: "play",
});

export default game;
