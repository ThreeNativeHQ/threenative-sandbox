# Friction log

## 2026-11-05 — no per-material lights on the Wasm engine (cockpit interior)
- Wanted: light the cockpit interior with its own cabin light instead of the sun (the sun reaches the interior unshadowed, blowing near-black materials to cream at the metered exposure).
- Tried: `MeshStandardNodeMaterial.lightsNode = lights([cabin])` from `three/tsl`.
- Result: `TN_NATIVE_UNCATALOGUED_LIGHTS: lights is not available on the Wasm engine.` at `Object.update`, scene `enter` aborted (playtest `cockpit-look` runner failed).
- Workaround: metalness 1 with a 0.004-0.012 albedo and clamped roughness in `src/render/cockpitLook.ts` (evidence: `artifacts/s12` white vs `artifacts/s13` dark).
- Engine ask: a portable way to choose which lights a material sums, or per-object sun exclusion / shadowing for camera-parented interiors.
- 2026-11-05 follow-up (new Blender cockpit): `castShadow`/`receiveShadow` on the cockpit changed interior brightness by only 3-5%, and halving every interior `env` share in `cockpitLook.ts` gave no visible change. The metered auto exposure re-normalises the dark interior, so the cream rims survive both. Next lever: bake the Blender lighting into the cockpit textures.
- 2026-11-05 root cause: the cream is specular Fresnel at the pilot's grazing view of up-facing faces under the open sky and sun, not albedo or the backlight emission. Swapping every finished interior material for a `MeshLambertMaterial` copy (diffuse only, albedo lifted to ~0.06) removes it (`artifacts/playtest/cockpit-final.png`, laptop Iris Xe, failures 0). The engine accepts Lambert with no warning. Cost: no metallic sheen on the interior until per-material lights or environment occlusion exist.

## 2026-11-05 — RigidBody3D has no damping, friction or angular-velocity setters (shot-down towers)
- Wanted: chunks of a broken rock tower that topple, roll, and stop on their own, so their bodies can sleep and be freed.
- Tried: `RigidBody3D` with a convex-hull `CollisionShape3D.fromMesh(..., "convexHull")` on a local `CollisionShape3D.heightfield` ground patch.
- Result: a drum-shaped hull rolled down a 1-4% dune slope for 10 s+ (`maxLiveSpeed` 3.35 m/s) because Rapier has no rolling resistance and the portable body exposes no `linearDamping`/`angularDamping`, no friction, and no angular-velocity read or write.
- Workaround: `src/entities/Towers.ts` applies a horizontal drag force (`applyForce`, 1.2/s) to any chunk touching the ground and freezes (disposes the body of) a chunk that drifts under 0.15 m/s for 1 s. Angular spin cannot be damped, only the translation that rolling needs.
- Engine ask: `RigidBody3D` options `linearDamping`, `angularDamping`, `friction`, `restitution`, plus a portable `angularVelocity` getter/setter and a `sleeping` flag, so a game never infers rest from mesh motion.
- Also: `applyForceAtPoint` for one tick is the only way to topple a body (no point-impulse); a one-tick force of `mass * 60 * dv` stands in for `apply_impulse_at_position`.
