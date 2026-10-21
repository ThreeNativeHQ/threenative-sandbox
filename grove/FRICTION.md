# FRICTION — grove

1. **No vegetation capability.** `engine_search_capabilities("foliage vegetation trees wind sway")`
   returns `verdict: none`. Tree generation and wind were copied from the engine repo's
   `examples/integrations/vegetation/src/`, which an installed game cannot see.
2. **`ez-tree-source` exports only its prebuilt bundle**, which eagerly loads textures. The pinned
   source entry is reached through a `vite.config.ts` alias plus `src/vegetation/ez-tree.d.ts`.
3. **The template's atmosphere sky is dark and faceted at midday** (0.2.6 `minimal`, identical on
   engine develop). At 13.5 h, with the sun 60° up, `atmosphere.radiance(view) * 8` renders a
   ~100/255 grey vault with visible arcs. The arcs stay at 96×48 dome segments and vanish when the
   dome ignores `radiance`, so they come from the radiance lookup, not the mesh. Replaced here with
   a game-owned gradient dome + `Fog`; the atmosphere still aims and colours the sun.
4. **Held state needs `allowTrivial`.** Values set once (`treeCount`, sun angles) are rejected as
   trivial unless every comparator carries a written reason.
5. **Leaf and bark winds must share one setting.** With a shared height envelope, different
   amplitudes slide each leaf off its twig; the first pass used 0.35/0.15 m.
6. **The LOD bake refuses the trees' own `_wind` attribute.** `assets.lod: {}` runs, and every build
   prints `lod trees/tree-<seed>.glb: no primitive was eligible (2 skipped: unsupported-attributes)`.
   `packages/assets/src/lod/eligibility.ts` allows only `POSITION NORMAL TANGENT TEXCOORD_0/1
   COLOR_0`, and `TN_discrete_lod` levels are index-only, so the simplifier never rewrites a custom
   attribute and the refusal is stricter than the bake needs. Consequence: no chain exists, so
   `lodBarkCoarse` is 0 at every distance and `playtests/grove-lod.playtest.json` asserts the truth
   with the intended `gte: 1` written down. The one-line engine change is to let a primitive through
   whose only unsupported semantics are carried through unchanged. **Fixed in the engine** (ThreeNative PR #333,
   `c735685be`): `_`-prefixed application attributes are shared by every level; bark now bakes
   2-3 levels per variant and `grove-lod` asserts all 14 bark geometries are drawn.
7. **The cook's `prune` pass deletes `TEXCOORD_0`,** because a tree's glTF materials are the
   exporter's neutral placeholders and declare no texture, while the game's procedural leaf cut-out
   reads `uv()`. With the UV gone every leaf quad is `length(uv()-0.5) == 0.5`, so `maskNode`
   discards the whole canopy — and no automated gate notices, because trunks and sky keep the frame
   non-blank. Declined with `assets.models.passes.prune: false`.
8. **A cooked one-component attribute reaches three's WebGPU path as an integer.** `quantize` turns
   `_WIND` into a normalized USHORT, and three's `WebGPUAttributeUtils._getVertexFormat` picks the
   vertex format for `itemSize === 1` from the array type alone, ignoring `normalized` — so the
   buffer stays `uint16` where the TSL `attribute("_wind", "float")` node declares a float and Dawn
   fails the pipeline: `renderPipeline_ShadowMaterial_106: Attribute base type (Uint for
   VertexFormat::Uint32) does not match the shader's base type (Float) in location (2)`. **Fixed in the engine** (PR #333,
   `5f0abb927`): the model loader widens normalized one-component attributes; the game-side widen
   was deleted.
9. **The far (LOD) framing stood past the scene's own fog and ground.** `Fog(45, 170)` and a 400 m
   ground plane put the proof camera at z=170 inside the fog and looking over the floor's edge, so
   the view existed to prove a grove and showed a white smear. Far plane to 600, ground to 1200; the
   near framing never sees past 60 m of either.
10. **Native LOD state reads lag the rendered frame.** On desktop and the Android emulator the
    engine's own triangle meter reaches the same fully-coarse chain as web (shadow triangles
    216,172 -> 117,128), yet the game's `mesh.geometry !== baseGeometryOf(mesh)` count ends at 6 of
    22 where web reads 22 of 22. Native scenarios therefore assert only `lodBarkCoarse >= 1` and
    `lodLeafCoarse == 0`; the strict 14-geometry assertion stays on web. Cause not yet isolated.
11. **Engine fixes arrive as private tarballs** (`.packages/grove/*-veg-*.tgz`) until the next
    release; repoint `@threenative/core` and `@threenative/assets` to npm once it ships.

12. **0.3.6 attempt, 2026-10-21 (PRD-637): the tarball stays.** Registry 0.3.6 installs once the old local
    `three@0.185.1` patch is dropped (core 0.3.6 applies its own), but `pnpm test` fails: the scene
    throws `TN_NATIVE_UNCATALOGUED_MODELWORLDMATRIX: modelWorldMatrix is not available on the Wasm
    engine`, so the playtest bridge never starts (`TN_PLAYTEST_BRIDGE_MISSING`, 0 frames). The game
    reads `modelWorldMatrix` in its vegetation TSL. Repoint to npm after the native engine catalogues
    it, or after the game stops reading it. The package.json, lockfile and workspace file are back on
    the committed lane tarball pins.
