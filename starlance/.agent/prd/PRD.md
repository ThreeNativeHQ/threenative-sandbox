# PRD-001 — Starlance: on-rails starfighter core loop

**Status:** PROPOSED
**Priority:** P2 — new sample game; every AC below is open.
**Complexity:** 6 (MEDIUM) — 6–10 implementation files (2) + new game systems (2) + ship/shot/enemy state machines (2); risk override: none.
**Owner:** João (approval), coding agent (execution)
**Depends on:** None

## Context

João asked for a "Star Fox 64 clone" on the latest released ThreeNative, with the player ship from
`/home/joao/Downloads/starfighter.glb`. We build an **original** rail shooter in that genre. The feel
comes from the reverse-engineered Star Fox 64 mechanic cards. No names, characters, level layouts,
music, art or HUD art come from that game. Game: **Starlance**. Stage: **Ember Rift** (original).

Fantasy to preserve: a fast starfighter that streams down a fixed course, weaves inside a corridor,
rolls through incoming fire, boosts and brakes against the pace of the course, snipes fighters with
lasers and locks heavy targets with a charged homing shot, then fights a boss at the end.

## Kit

- Command: `npx create-threenative@0.2.15 starlance --template minimal` (latest on npm, 2026-11-05).
  Installed `@threenative/core`, `physics`, `playtest`, `runtime-native` 0.3.11, `assets` 0.3.12,
  `three` 0.187.0.
- Choice: `minimal`. No kit in 0.2.15 is a rail shooter: `runner` is three-lane ground running,
  `racing`/`kart` are ground vehicles, `shooter` is first-person. `minimal` is the documented fallback.
- Kept from the kit: boot, sky/lighting/post stack in `src/render/`, playtest bridge, `pnpm test`.
- Removed: mannequin `Player`, prototype arena, wall-probe follow camera, touch controls, the
  template playtests (they assert the mannequin).

## Mechanics

Built-in capability pass: `engine_search_capabilities` with `scope: "request"` for the full request,
then `scope: "mechanic"` per mechanic; hits read with `engine_capability_detail`.

| Mechanic | Installed capability (score) | Decision and binding constraint |
|---|---|---|
| Rail course / enemy fly-in paths | `PathFollow3D` from `@threenative/core` (0.61) | Use for enemy fly-in curves. The player rail is a `CatmullRomCurve3` sampled by the game, because the ship is an offset from the path, not a follower. |
| Wave timeline | `Scheduler` / `ctx.tween` (1.4) | Use. Constraint: dispose handles when the scene exits. |
| Hit shake | `CameraShake` (0.6) | Use. Constraint: game supplies amplitude, rotationAmplitude, frequency, decay, curve; it returns an offset and never writes the camera. |
| Explosions, sparks | `GPUParticles3D` (0.91) | Use. Constraint: geometry, colour, timing come from the game; spawn emitters are world space. |
| Sound effects | `AudioBus` (0.98) | Use. Constraint: create buses before playing clips; dispose with the game. |
| Laser bolts | `TracerPool3D` (0.56) | Not used: it draws hitscan streaks. Our bolts travel and collide. Pooled plain meshes in `src/entities/`. |
| Homing shot / lock-on | none — best hit `runAndroidPlaytest` (0.27), unrelated | Game-owned in `src/entities/Weapons.ts`. |
| Bolt-vs-enemy hits | `rapier`, `RigidBody3D` (0.52) | Not used: sphere-distance checks are cheaper and portable. Rapier plugin is removed if nothing else needs it. |
| HUD bars | `publishUiState` (0.37) | Not used: the kit has no React UI (`ui.renderer: "native"`). HUD is camera-attached meshes in `src/render/hud.ts`. |

## References

Reverse-engineer pass: `engine_search_references` ("star fox 64 rail shooter", "barrel roll deflect",
"boost brake meter on rails", "charged lock-on homing shot"), then `engine_reference_detail` per card.
Game `star-fox-64`, repo `https://github.com/sonicdcer/sf64`, pinned SHA
`4235c59f00b04440e3fd5fec49f0bc80e48cf212`. Tier-1 cards; no Tier-2 repo walk was needed, so no
`engine_save_reference` call.

Conversion: **1 source unit = 0.02 m**. Source values are per 30 Hz update: × 30 gives per second,
and a per-update smoothing fraction `f` becomes `1 - (1 - f)^(30·dt)`.

| Card | Feel rule we keep | Starlance value (source) |
|---|---|---|
| `rails-path-progress` | Path coordinate advances by forward speed; ship is an offset from the path; hard corridor clamp with an early edge warning | half width 14 m (`src/engine/fox_play.c:4468`), headroom 13.6 m (`:4469`), floor 0.8 m over ground (`:4470`), warning 2 m inside edge (`:3963`), path lean × 0.54 (`:3496`) |
| `pitch-yaw` | Stick × 0.75, rotated by bank, × 0.68 into yaw/pitch targets; banked past 10° doubles the turn rate; rails widen turns × 1.4; roll target = stick X × 0.6 | 69°/s base rate (`fox_play.c:3580-3613`), × 1.4 (`:3928`), 0.6 (`:3669`) |
| `banking` | Shoulder holds a ±90° bank target that the hull chases | smoothing 0.2/upd, limit 300°/s (`fox_play.c:3368-3395`) |
| `barrel-roll` | Two shoulder presses inside 0.33 s spin the hull at a fixed rate, then decay; lateral velocity × 1.5 while rolling | 900°/s for 0.33 s, decay 5°/upd (`fox_play.c:3401-3405, 4853-4857`) |
| `arwing-boost` | Boost adds speed up to a ceiling while a 0–90 gauge fills; full gauge latches a cooldown; camera pulls back | +18 m/s, 1 s to fill, 6 s to recover (`fox_play.c:4962-5061`) |
| `arwing-brake` | Brake slows below cruise on the same gauge; camera pulls in | −12 m/s floor (`fox_play.c:5093-5168`) |
| `camera-rails` | Eye 8 m behind; ship offset × 0.78 drives the eye so the ship stays near centre; camera takes 0.3 of ship roll | `fox_play.c:6080-6137` |
| `laser-fire` | Fresh press fires at once; hold repeats every 4 updates | 7.5 shots/s, bolt ≈ 320 m/s, life ≈ 0.29 s (`fox_play.c:3044, 3315-3319`, `fox_beam.c:2356`) |
| `charge-lock-on` | Holding fire charges; a full charge sends search probes; release past the threshold fires a homing shot | full at 0.7 s, release threshold 0.33 s (`fox_play.c:3192-3243`) |
| `lock-on-tracking` | Probe claims the nearest target inside a box; homing shot re-aims every update with a ramping turn rate | 6 m half box (`fox_beam.c:1759`), ~55 m/s tracking (`:2226-2242`) |
| `shield-damage` | Pool drains gradually after a hit; invulnerable window and knockback after each hit; low-shield warnings | pool 255, 60/s drain, 0.67 s invulnerable, 0.4 m knockback, warnings at 100 and 50 (`fox_play.c:858-900, 4414, 5465-5482`) |

Cards read and not used in v1: `somersault-loop`, `smart-bomb`, `wing-damage`, `terrain-collision`,
`camera-all-range`. Game-owned rules (no card): cruise speed 30 m/s; a barrel roll deflects enemy
shots; the charged shot explodes with a 6 m damage radius; heal rings give +64 shield; hit counter;
all enemy behaviour; the boss.

## Solution

One scene, `Play`, runs this order every fixed step:

```
input → Ship (stick, bank, roll, boost/brake, corridor clamp)
      → Rail (coordinate += speed·dt; path frame at coordinate)
      → Weapons (lasers, charge, probes, homing)
      → Enemies (timeline by coordinate; fighters, turrets, obstacles, rings, boss)
      → Hits (spheres: bolts↔enemies, enemy shots↔ship, ship↔obstacles/rings)
      → Camera (rail chase) → HUD → state.set(...)
```

- **Controls:** WASD/arrows = stick (W climbs; named override `invertY`). Space or J = fire, hold to
  charge. Q/E = bank; double-tap = barrel roll. Shift or K = boost. C or L = brake. Enter = restart.
  Gamepad: left stick, A fire, LB/RB bank, RT boost, LT brake, Start restart.
- **Camera:** rail chase per `camera-rails`; `CameraShake` on hits and big explosions.
- **Game state:** `shield` (0–255), `boost` (0–1), `hits`, `distance`, `phase`
  (`flying | boss | clear | down`), `charge` (0–1), `locked` (target id or null).
- **Win / loss:** destroy the boss core → `clear`. Shield reaches 0 → `down`. Both show a banner;
  Enter restarts the stage.
- **Progression:** one stage, about 150 s. Section A: dunes and rock spires, fighter waves. Section B:
  canyon with stone arches, wall turrets, heal rings. Section C: open plain, then the boss — a
  hovering carrier with three weak-point turrets that shield a core.
- **Visual direction:** red-ochre desert planet at low sun under the kit's atmosphere sky and height
  fog. The ship keeps its own textures. Enemies are original low-poly shapes built in
  `src/render/`: dark violet hulls with cyan emissive panels. Player bolts cyan-white, enemy shots
  orange. Stock kit post (filmic, bloom, vignette); any override is reported.
- **Audio direction:** four CC0 one-shots on one `AudioBus`: laser, explosion, hull hit, lock tone.
  No music in v1.
- **HUD (native-safe, in scene):** shield bar, boost gauge, hit counter (segment digits), two aim
  reticles ahead of the nose, lock box on the marked target, result banner.
- **Playtest surface:** `ctx.entities.add(name, { debug })` for `ship`, `weapons`, `enemies`,
  `camera`. `?autopilot=1` is a test-only hook for the full-run proof; it is off by default.

### Asset needs and licences (selected in step 5, after approval)

| Need | Source | Licence |
|---|---|---|
| Player ship | `starfighter.glb` supplied by João | João's asset — João confirms the licence |
| Ground texture set (albedo, normal, roughness) | Poly Haven via `threenative-assets` | CC0 |
| 4 sound effects | Kenney or another CC0 source via `threenative-assets` | CC0 |
| Enemies, rocks, arches, boss | Procedural geometry in `src/render/` | ours |

### Target platforms

- Web, Chromium WebGPU (headed, under the capture lock): required, all ACs.
- Desktop (`pnpm build:desktop`): not in scope for v1 proof; reported as unverified.

### Performance risks

- The ship has 30 materials → up to 30 draws for the hull alone. Budget from the kit's play check:
  ≤ 128 draws, ≤ 80k triangles. Merge ship materials only if the budget fails.
- Rocks and spires: one `InstancedMesh` per shape, `markStatic` on scenery.
- Bolts, enemy shots, particles: fixed pools, no per-shot allocation.

### Non-goals (v1)

Bombs, somersault loop, wing damage, all-range mode, wingmen and radio, music, menus, multiple
stages, touch controls, Android/iOS.

### Prerequisites

- MCP: `threenative-engine` (verified working through `call.mjs`), `threenative-assets` (verify in
  task 1). No service accounts, no secrets, no env variables.
- Capture lock: copy `../caravel/tools/capture-lock.sh` into `tools/`.

### Files and owner lanes

| Path | Purpose | Lane |
|---|---|---|
| `src/game.ts`, `src/state.ts`, `src/scenes/Play.ts` | input map, state, loop order, hit pass, phases | coordinator |
| `src/entities/Rail.ts`, `src/entities/Ship.ts`, `src/render/railCamera.ts` | course, flight model, chase camera | flight |
| `src/entities/Weapons.ts`, `src/entities/Enemies.ts` | lasers, charge, homing, enemies, boss | combat |
| `src/render/stage.ts`, `src/render/hud.ts`, `src/render/enemyLook.ts` | ground, rocks, arches, HUD, enemy meshes | look |

## Acceptance Criteria

Proof runner: `pnpm build:web`, then each scenario with
`tools/capture-lock.sh pnpm exec threenative-playtest --scenario playtests/<name>.playtest.json --browser-recipe webgpu --headed --server-command "pnpm exec vite preview --host 127.0.0.1 --port \$PORT --strictPort"`.

- [ ] AC-1 [local]: Holding right then up moves the ship right and up from the path and stops at the corridor edge (|x| ≤ 14 m, edge warning raised). proof: `playtests/steer.playtest.json` — Evidence: pending.
- [ ] AC-2 [local]: Double-tapping E inside 0.33 s starts a barrel roll (`rolls` ≥ 1); one tap only banks (`rolls` stays 0). proof: `playtests/barrel-roll.playtest.json` — Evidence: pending.
- [ ] AC-3 [local]: Holding boost raises speed above cruise and fills the gauge to the latch; braking alone drops speed below cruise. proof: `playtests/boost-brake.playtest.json` — Evidence: pending.
- [ ] AC-4 [local]: Laser fire destroys fighters of the first wave and raises `hits`. proof: `playtests/laser.playtest.json` — Evidence: pending.
- [ ] AC-5 [local]: Holding fire 0.7 s locks a target off the nose line, and the released homing shot destroys it. proof: `playtests/lock-on.playtest.json` — Evidence: pending.
- [ ] AC-6 [local]: With no input, enemy shots and obstacles drain the shield to 0 and the phase becomes `down`; a barrel roll through a shot takes no damage. proof: `playtests/damage.playtest.json` — Evidence: pending.
- [ ] AC-7 [local]: A full run with `?autopilot=1` reaches the boss, destroys its core and sets phase `clear`. proof: `playtests/stage-clear.playtest.json` — Evidence: pending.
- [ ] AC-8 [local]: Typecheck, lint, format and web build pass. proof: `pnpm check && pnpm build:web` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Rail flight | `pnpm dev` → `src/main.ts` → `Play.enter` frame loop → `Ship.update` | Template `Player` + arena deleted | AC-1..3 |
| Combat | Same loop → `Weapons.update`, `Enemies.update`, hit pass in `Play` | new | AC-4..6 |
| Stage, boss, HUD | Same loop → `stage.ts`, `hud.ts`, phase machine in `Play` | Template arena deleted | AC-7 |

## Decisions

- 2026-11-05 (agent): Original game in the genre, not a recreation. No Star Fox names, characters, stage layouts, music or HUD art. Required by the engine MCP reference rules.
- 2026-11-05 (agent): `minimal` kit, because create-threenative 0.2.15 has no rail-shooter kit.
- 2026-11-05 (agent): Sphere-distance hits instead of Rapier bodies.
- 2026-11-05 (João): Step 8 visual reference = gameplay of a modern rail shooter at about 20:00 of
  https://www.youtube.com/watch?v=CXsPTgrxs2I. Frames are kept local in `~/Downloads/starlance-reference/`
  (target frame `frames/f_13.jpg`, 20:12) and are not committed. They are judged for quality (framing, terrain relief, depth,
  light, HUD cleanliness), not copied.
- 2026-11-05 (agent): Course altitude lowered from 12 m to 8 m to match the reference's low flight.
- 2026-11-05 (agent): Playtest `setup.resources` cannot write state (read-only provider), so `?skipTo=` and
  `?autopilot=` are read from the page URL.

## Execution Phases

#### Phase 1: Flight core
**Status:** NOT STARTED
**Files:** coordinator: `src/game.ts`, `src/state.ts`, `src/scenes/Play.ts`, template deletions. flight: `src/entities/Rail.ts`, `src/entities/Ship.ts`, `src/render/railCamera.ts`.
**Implementation:** Tasks 1–5 in `.agent/tasks.json`. Commit and push as soon as the ship flies.
**Verification:** AC-1, AC-2, AC-3 + a chase-camera capture.

#### Phase 2: Combat ∥ stage look and HUD
**Status:** NOT STARTED
**Files:** combat: `src/entities/Weapons.ts`, `src/entities/Enemies.ts`. look: `src/render/stage.ts`, `src/render/hud.ts`, `src/render/enemyLook.ts`.
**Implementation:** Tasks 6–12. Coordinator integrates both lanes into `Play.ts`.
**Verification:** AC-4, AC-5, AC-6 + stage and HUD captures.

#### Phase 3: Boss, result states, full run
**Status:** NOT STARTED
**Files:** `src/entities/Enemies.ts`, `src/scenes/Play.ts`, `playtests/stage-clear.playtest.json`.
**Implementation:** Tasks 13–14.
**Verification:** AC-7, AC-8, final capture set, commit and push.
