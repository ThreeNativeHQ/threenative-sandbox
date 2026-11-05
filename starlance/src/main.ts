import { acceptHotUpdate } from "@threenative/core/hot";
import game from "./game.js";
import "./style.css";

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("Missing #app element.");

// No DOM readout here: the first frame is the scene alone. A HUD you add belongs in one layer —
// drawn in the scene so it survives on native, never a DOM copy of the same numbers on top of it.

import.meta.hot?.accept();
acceptHotUpdate(game, import.meta.hot);
void game
  .start()
  .then(() => {
    const canvas = game.ctx?.renderer.domElement;
    if (canvas !== undefined) app.prepend(canvas);
  })
  .catch((error: unknown) => {
    const failure = document.createElement("div");
    failure.id = "threenative-canvas-error";
    failure.dataset.threenativeCanvasError = "true";
    failure.setAttribute("role", "alert");
    failure.textContent = error instanceof Error ? error.message : String(error);
    app.replaceChildren(failure);
  });
