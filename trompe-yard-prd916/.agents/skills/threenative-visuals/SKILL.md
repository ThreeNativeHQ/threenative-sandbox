---
name: threenative-visuals
description: Capture, inspect, and budget the player-visible look of a ThreeNative game. Use when a player-visible feature needs a real capture before it is called done, when matching a reference image, or when tuning lighting, probe volumes, or resolution scale.
---

# Budget real time for the look

`typecheck`, `lint`, tests, and playtests can all pass on grey boxes and a black screen. A
player-visible feature is done only after opening a real capture and checking silhouettes, depth,
contact shadows, rim light, motion, and the HUD. Spend roughly as much effort on presentation as
mechanics.

Use browser automation on the user's real Chrome when available; otherwise run
`npx @threenative/playtest <scenario> --browser-recipe webgpu --headed`. The recipe includes
`--enable-features=Vulkan`; without it Chromium may use SwiftShader and the runner reports
`TN_PLAYTEST_SOFTWARE_ADAPTER`. **Do not use `xvfb-run`**: its cleanup can replace the real exit
status. A black headless capture is a capture failure until proven otherwise.

For reference matching, solve lighting first: search `engine_search_capabilities` before adding
effects, read `TN_RENDER_CHAIN`, and use `node_modules/create-threenative/agent-docs/references/visual-baseline.md` and
`node_modules/create-threenative/agent-docs/references/capture-the-frame.md` for the per-file baseline and capture recipe.

For a supplied or explicitly generated target, read `node_modules/create-threenative/agent-docs/references/dream-loop.md`. It is the shared
workflow for locking the target, preserving its hash, obtaining a fresh gameplay capture, and
asking the read-only verifier for an independent `PASS`, `REQUEST_CHANGES`, or `NOT_OBSERVED`.
Run `node scripts/visual-loop.mjs --record <run>/run.json` before and after each round; read its
JSON `decision` instead of treating exit 0 as acceptance. If a target must be generated or edited,
use `node scripts/reference.mjs` with a unique `--request-id`, the exact prompt file, and the
user-selected model. A supplied target works without credentials; missing evidence or a provider
failure remains unavailable and never becomes a visual pass.

For off-screen diffuse light, add `ProbeVolume` after static geometry/lights, bake on demand, and
sample it into a game-owned material before screen-space GI. It owns no look; moving lights need a
new bake. Keep `TN_PROBE_VOLUME`'s stale state, probe count, atlas bytes, progress, and bake cost
visible while tuning bounds, density, and `bakeBudgetMs`.

`renderer.resolutionScale: "auto"` scales only the 3D drawing buffer to hold `display.maxFps`;
never hand-author a device constant. A `(0, 1]` value pins it; invalid values fail at config load.
Both modes report `TN_FRAME_BUDGET.surface` (`resolutionScale`, `scaleSource`, sample count, and
buffer size), and `display: config.display` must reach `defineGame`. See the pixel-budget details
in `node_modules/create-threenative/agent-docs/references/visual-baseline.md` and the engine's measurement skill.
