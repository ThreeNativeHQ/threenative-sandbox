# Visual judge, 2026-11-10

Fresh read-only Opus subagent. Images: `side-by-side-1.png` (left ThreeNative `?stress&freezeAt=10` on :5785, right Unreal 5.8.3 `stock`, both 1280x720 at orbit second 10), `tn-10s.png`, `unreal-10s.png`. Bar: CLOSE on geometry, materials, lights, fires and shadows.

- geometry: MATCH. The camera pose, house grid, tree positions and sizes, foreground cones, rocks and prop scatter line up almost one to one.
- materials: CLOSE. Roofs, walls, ground and props match. Unreal walls are slightly whiter and cooler, distant canopies slightly darker and more saturated.
- lights: CLOSE. Sun direction, exposure and point-light glows match. ThreeNative clouds are pinker and smaller with a hazier horizon band; Unreal clouds are whiter and larger.
- fires: MATCH. The four visible fires are in the same places at the same size and colour.
- shadows: CLOSE. Direction and coverage match. Unreal shadows are slightly darker, with crisper contact edges.
- **OVERALL: CLOSE**

Nits, largest first: physics-box piles differ in the centre streets (settle timing); sky cloud colour and horizon haze; distant canopy green; wall warmth near fires; foreground rocks (covered by the ThreeNative HUD).
