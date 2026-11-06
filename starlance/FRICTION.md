# Friction log

## 2026-11-05 — no per-material lights on the Wasm engine (cockpit interior)
- Wanted: light the cockpit interior with its own cabin light instead of the sun (the sun reaches the interior unshadowed, blowing near-black materials to cream at the metered exposure).
- Tried: `MeshStandardNodeMaterial.lightsNode = lights([cabin])` from `three/tsl`.
- Result: `TN_NATIVE_UNCATALOGUED_LIGHTS: lights is not available on the Wasm engine.` at `Object.update`, scene `enter` aborted (playtest `cockpit-look` runner failed).
- Workaround: metalness 1 with a 0.004-0.012 albedo and clamped roughness in `src/render/cockpitLook.ts` (evidence: `artifacts/s12` white vs `artifacts/s13` dark).
- Engine ask: a portable way to choose which lights a material sums, or per-object sun exclusion / shadowing for camera-parented interiors.
- 2026-11-05 follow-up (new Blender cockpit): `castShadow`/`receiveShadow` on the cockpit changed interior brightness by only 3-5%, and halving every interior `env` share in `cockpitLook.ts` gave no visible change. The metered auto exposure re-normalises the dark interior, so the cream rims survive both. Next lever: bake the Blender lighting into the cockpit textures.
