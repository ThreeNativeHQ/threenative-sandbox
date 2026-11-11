# stress-lab-unreal — the Unreal Engine 5.8.3 arm of the stress lab

This folder rebuilds the ThreeNative stress lab (`../stress-lab/src/scenes/Stress.ts`, `?stress`, the `real` preset) in stock Unreal Engine 5.8.3. The engine repo's PRD-770 Phase 3 uses it. Its rows go to `docs/stress-loop/ledger.json` in the engine repo.

The project is content-only. UBT cannot build a C++ module in `~/UnrealEngine-5.8.3`, so Unreal Python does all the work:

| File | What it does |
| --- | --- |
| `tools/export_meshes.mjs` | Writes `meshes/stress-meshes.gltf` from the three.js primitives in `stress-lab/src/render/stress.ts`, so both engines draw the same triangles. |
| `build_level.py` | Editor script. It imports the meshes and `stress-lab/assets/mannequin.glb`, makes the materials, and builds `/Game/Stress` from the stock default level. It uses the same seeded random, call order, counts, sizes and colours as `Stress.ts`. |
| `runtime.py` | `-game` driver: the orbit camera and the body re-drop every 8 s. In `measure` mode it runs `csvprofile start/stop` and quits. In `capture` mode it takes the judge shot. |
| `tools/run.py` | Gated launcher, CSV to fair-run JSON, mean of runs, `selftest`. |
| `tools/capture_tn.mjs`, `tools/side_by_side.py` | The ThreeNative half of the judge pair, and the side-by-side sheet. |

## Mapping

- Coordinates: three.js (x, y, z) in metres maps to Unreal (x, z, y) x 100 cm. A rotation keeps its angle, and its axis maps to minus the swapped axis.
- Colours: three.js reads hex and HSL as sRGB and stores linear values. The builder converts once to linear for the material parameters. The old builder converted twice, which oversaturated the props.
- Trees and rocks use instanced static meshes. Houses (walls plus roof), props and bodies are one actor each. The 600 props have 600 material instances, as in `Stress.ts`.
- Walkers: 120 skeletal-mesh actors that play `Walk_Loop`. A `RotatingMovementComponent` moves each one on its circle at `speed / radius`.
- Fires: 12 x 1500 sprites, one instanced quad each. The material `M_Fire` billboards and moves each sprite with the same curves as `fireMaterial` and `firePositions`.
- Lights: 16 point lights (30 cd, 14 m radius, `#ff9a4a`, no shadows), plus the default level's sun aimed along `SUN_DIRECTION`.
- Physics: 300 simulated boxes of 4 kg. The physics floor is a hidden cube, 360 x 360 x 1 m.
- Importer defaults stay: Nanite is on for every imported mesh except the fire quad, which uses world position offset.

Setups: `stock` uses `Config/DefaultEngine.ini`, the values that the 5.8.3 project generator writes for a Blank project (Lumen GI and reflections, virtual shadow maps, ray tracing). `tnmatched` adds `r.DynamicGlobalIlluminationMethod 0` and `r.ReflectionMethod 2`. The uncapped pass adds `t.MaxFPS 0` and `r.VSync 0`.

## Rebuild

```sh
cd ~/projects/threenative/sandbox/stress-lab-unreal
node tools/export_meshes.mjs
~/UnrealEngine-5.8.3/Engine/Binaries/Linux/UnrealEditor $PWD/StressLab.uproject -RenderOffscreen -unattended \
  -nosplash -nosound -stdout -FullStdOutLogOutput -ExecutePythonScript=$PWD/build_level.py > Saved/build.log 2>&1
cat Saved/build.exit   # 0 = built; the editor exit status says nothing about the script
```

The build takes about 5 minutes with a warm shader cache. Most of that time saves the 600 material instances.

## Judge pair

```sh
python3 tools/run.py capture judge/unreal-10s.png --setup stock
node tools/capture_tn.mjs judge/tn-10s.png "http://127.0.0.1:5785/main.html?stress&freezeAt=10"
python3 tools/side_by_side.py judge/tn-10s.png judge/unreal-10s.png judge/side-by-side-1.png
```

The verdict is in `judge/verdict.md`.

## Measure and record

Run the runs in ABBA order. Each run waits for a quiet host and holds `~/.cache/tmp-tn/stress-loop/measure.lock`. The gate requires no `stress-loop.mjs fair` process, a 1-minute load under 12 for 60 s, 3 GB VRAM free, and GPU use under 10 % for 5 s.

```sh
python3 tools/run.py measure --setup stock --run 1
python3 tools/run.py measure --setup tnmatched --run 1
python3 tools/run.py measure --setup tnmatched --run 2
python3 tools/run.py measure --setup stock --run 2
python3 tools/run.py mean rows/stock-uncapped-1.json rows/stock-uncapped-2.json --out rows/stock-uncapped-mean.json
python3 tools/run.py mean rows/tnmatched-uncapped-1.json rows/tnmatched-uncapped-2.json --out rows/tnmatched-uncapped-mean.json
cd ~/projects/threenative/threenative-engine   # or the worktree that owns the ledger
for s in stock tnmatched; do f=~/projects/threenative/sandbox/stress-lab-unreal/rows/$s-uncapped-mean.json
  node scripts/stress-loop.mjs record $f --engine unreal --variant "$s&uncapped" --decision measure \
    --label "UNREAL refresh window ($s&uncapped)" --notes "$(node -p "require('$f').notes")"; done
```

The CSV route: `runtime.py` runs `csvprofile start` after a 60 s settle and `csvprofile stop` 15 s later. Unreal writes `Saved/Profiling/CSV/Profile(...).csv`, and `run.py` moves it to `rows/<setup>-uncapped-<n>.csv` (gitignored). It keeps only the run's own new file: the editor writes no other CSV in `-game`. Metrics use the stress report's definitions, with 120-frame windows and the median of the per-window p50 and p95:

| Field | Unreal source |
| --- | --- |
| `presentedP50Ms`, `presentedP95Ms`, `fps` | `FrameTime` |
| `frameP50Ms`, `frameP95Ms` (CPU) | per frame max(`GameThreadTime`, `RenderThreadTime`, `RHIThreadTime`) |
| `updateP50Ms`, `renderP50Ms` | `GameThreadTime`, `RenderThreadTime` |
| `gpuP50Ms`, `gpuP95Ms` | `GPUTime` |
| `hitchesPerMin` | frames of 2000 ms or more (`@threenative/core` default) |
| draws, triangles, JS and Wasm fields, `loadMs` | `null`: not measured |

`build.sha256` is the first 12 hex digits of the sha256 of `libUnrealEditor-Engine.so`.
