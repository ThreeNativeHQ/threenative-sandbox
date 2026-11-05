# Starlance — shared brief for every lane

Game: `/home/joao/projects/threenative/sandbox/starlance` — an original on-rails starfighter game on
ThreeNative 0.3.11 (Wasm engine on web). Plans: `.agent/prd/PRD.md` (core loop) and
`.agent/prd/PRD-002.md` (full mechanic set). Mechanic values and their `file:line` sources are in the
References tables of both PRDs — use them, converted as stated there (1 source unit = 0.02 m;
per-update × 30 = per second; smoothing fraction f per update → `1 - (1 - f) ** (30 * dt)`).
Cite the card id and source line in a short comment where a constant lands.

## Hard rules

1. **Own only your files.** Other lanes edit the rest of `src/` at the same time. Never edit
   `src/scenes/Play.ts`, `src/world.ts`, `src/game.ts`, `src/state.ts` (coordinator). If you need a
   change there, put the exact request in your final report.
2. **Keep the public fields and method signatures of the stubs.** Other lanes code against them.
   You may add fields and methods to your own classes.
3. Original game: no Star Fox names, characters, level layouts, music or art. Mechanics only.
4. Plain Three.js + `@threenative/core`. No DOM globals (`document`, `window`), no dynamic `import()`,
   no new npm dependencies. Search capabilities before writing a system:
   `node node_modules/@threenative/core/mcp/call.mjs threenative-engine engine_search_capabilities '{"situation":"<words>","scope":"mechanic"}'`
   then `engine_capability_detail '{"symbol":"<Name>"}'`.
5. Pools, not allocation, for anything spawned per shot/frame. Reuse scratch `Vector3`s.
6. Every moving object you add: `ctx.interpolate(object)` once; after a teleport (pool respawn),
   `ctx.resetInterpolation(object)`.
7. Expose observable state through your class's `debug()` (entities `ship`, `weapons`, `enemies`,
   `wingmen`, `camera` are registered by Play). Playtests assert on these keys.
8. Do not commit or push. The coordinator integrates and commits.

## Style guide (one look for the whole game)

Taken from `assets/starfighter.glb` materials. Hard-surface, faceted, crisp; mid-poly; PBR
`MeshStandardMaterial` (metalness 0.25–0.7, roughness 0.3–0.6) with emissive accents.
Nothing cartoon-flat, nothing photo-noisy.

| Role | Colours |
|---|---|
| Player + allies | violet armour `#3d2f8a`/`#46337a`, pink-silver hull, warm silver edges `#9c8c91`, graphite darks `#141214`, **cyan ion glow `#1fd9ff`** (emissive), pale-gold trim `#8c7545` |
| Allies' accent | same model; swap the cyan ion emissive for pale gold `#ffc65a` (clone the materials first) |
| Enemies | same hard-surface language, opposite hue: gunmetal `#2a2328`, crimson armour `#7a1626`, **amber emissive `#ff7a1a`** on vents/eyes/guns |
| Player shots / locks | cyan-white `#9ff6ff` core, cyan `#1fd9ff` glow |
| Enemy shots | amber `#ff9a3a` core, orange `#ff5a10` glow |
| Pickups | silver ring `#dfe6f0`, gold ring `#ffc65a`, items: cyan-glow crystals in a violet frame |
| Terrain (Ember Rift) | warm terracotta / ochre / rust desert; no green. Tint the Poly Haven textures warm. Rock is faceted (low-poly silhouettes with the rock texture), not round blobs |
| HUD | thin geometric lines; cyan `#5ff0ff` primary, white values, amber `#ffb03a` warnings, violet `#7a5cd6` frames |
| FX | additive glow; explosions amber→white core with dark smoke; player hits cyan sparks |

## Running and seeing it

- Typecheck/lint/format: `pnpm typecheck && pnpm lint && pnpm exec biome format --write <your files>`.
- Playtest (always through the capture lock, against the dev server, into **your own** artifacts dir):

  ```sh
  tools/capture-lock.sh pnpm exec threenative-playtest --scenario playtests/<name>.playtest.json \
    --browser-recipe webgpu --headed --artifacts artifacts/<lane> \
    --server-command "pnpm exec vite --host 127.0.0.1 --port \$PORT --strictPort"
  ```

  Exit code 0 = pass. Screenshots land in `artifacts/<lane>/<label>.png`; open them with the Read tool
  and look — every automated gate passes on grey boxes. Console in `artifacts/<lane>/console.json`.
- Scenario rules: real input (`"press": "KeyE"`, `holdTicks`/`waitTicks`, never `holdFrames`), at
  least one assertion on observable state, `"diagnostics": { "noConsoleErrors": true, "runtimeReady": true }`.
  Schema and assertion kinds: `node_modules/create-threenative/agent-docs/references/assertion-reference.md`.
  Example: `playtests/smoke.playtest.json`. Playtest `setup.resources` CANNOT write state (the
  bridge's state provider is read-only). Test seams come from the page URL instead: `?skipTo=N`
  (metres along the course; 4800 = arena) and `?autopilot=1`. Pass them with
  `--url "http://127.0.0.1:<port>/?skipTo=4800" --server-command "pnpm exec vite --host 127.0.0.1 --port <port> --strictPort"`,
  lane ports: flight 5191, enemies 5192, look 5193, weapons 5194.
- João watches `http://127.0.0.1:5180/` live (vite HMR). Never leave the game broken for more than a
  few minutes: keep your file compiling.

## The contract (read these files first)

`src/world.ts` (World, ITarget, IObstacle, SfxName), `src/scenes/Play.ts` (loop order: ship →
weapons → enemies → wingmen → fx → camera → phases → HUD), `src/entities/Rail.ts` (course,
`SECTION`, `ARENA_RADIUS`, `arenaCenter`), and the stub you own.

Controls (from `src/game.ts`): `move` vector (W climbs) + gamepad `stickX`/`stickY` axes; `fire`
Space/J; `bomb` B/U; `bankLeft` Q, `bankRight` E (double-tap = barrel roll); `boost` Shift/K;
`brake` C/L; `restart` Enter. Somersault = hold climb + press boost. U-turn (arena only) = hold
climb + press brake.

## Final report (under 300 words)

What works (with the playtest names and their exit codes), screenshots you looked at, debug keys you
expose, any request for coordinator files, and known gaps. No essays.
