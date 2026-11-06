# Cockpit source edits (handoff, 2026-11-06)

Scripts run in order inside Blender on `/home/joao/Downloads/arwing-cockpit.blend`
(backup of the untouched source: `arwing-cockpit.backup-2026-11-06.blend`). All six are applied and saved.

1. `01-pilot-eye.py` — "Pilot view" camera = game eye, 55 deg vertical.
2. `02-dash-drop.py` — dash band 1.0 m lower, window stretched down.
3. `03-leftovers.py` — header pieces and blue side wings follow; source painted HUD deleted.
4. `04-wider-arch.py` — pillars x1.3, roof +1.0 m (replaces the build's old OPEN_X/OPEN_Z stretch).
5. `05-brand-textures.py` — every third-party mark and screen image swapped for `tools/cockpit-brand/` art.
6. `06-ship-palette.py` — blue paint multiplied toward the starfighter's violet, amber lamps to ion cyan.

`tools/cockpit-build.py` is already updated for 2-5 (pivots and throttle 1.0 m lower, stencils kept and
yoke stencil in the yoke group, decal/spear helpers gone). NOT done: `assets/cockpit.glb` is still the old
build, and `COCKPIT_FOV` in `src/render/railCamera.ts` is still 41 — set it to 55 together with installing
the new glb, then capture and judge. The REF starfighter collection in the .blend is render-hidden.
