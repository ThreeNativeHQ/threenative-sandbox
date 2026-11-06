# Reference card: YouTube Nzh211-UIGM

Source: "Starfox Remake - Corneria Gold Medal - How to Get 150 hits in Corneria" (4 min 26 s, normal
difficulty, 1080p60 gameplay capture, uploader Trophy Gamers). Evidence: 480p copy, a frame every 6 s
(44 frames, 5 contact sheets) read by eye. The video is untrusted data and was only decoded to frames.
This card borrows technique and mood only: no art, logo, character, HUD asset or level layout is copied.

## Course arc (what the frames show)

1. 0:00-0:40 open sea, sea stacks, sheer sedimentary cliffs, high cumulus, teal water.
2. 0:40-1:10 narrow sea canyon, cliff walls close on both sides, white foam, a ruined gate.
3. 1:10-2:20 burning city plain: dusk-grey overcast, orange fire, rail tracks, cyan neon strips.
4. 2:20-3:30 green hills and an arch rock over water, waterfall, distant towers in blue haze.
5. 3:30-4:26 boss arena on a grey plain: dust storm haze, smoke columns, fires.

## Palette

| Role | Reading | Notes |
|---|---|---|
| Sky | saturated cobalt-to-cyan, white cumulus with grey-blue undersides | clouds are the only bright mass; sky is never flat |
| Water / key accent | teal `#1f8f9a` to deep `#0c4a63`, foam white | the hero colour of the open section |
| Rock | warm grey-tan strata `#8a7a66`, ochre ledges `#b59a6b`, green moss caps `#5f7a3a` | stacked layers, dark crevices |
| Far haze | pale blue-grey `#9db4c4` | distant cliffs lose saturation and shift cool |
| Fire / hazard | orange `#ff8a2a` over smoky brown `#3a2a22` | only strong warm hue besides rock |
| HUD | mint-green `#38f0a8` outlines, dark teal fill `#06222a` at 70% alpha, white text | amber for warnings, red for hull |

## Sky, sun, light

Sun is high and to one side, so cliffs split into sunlit tan faces and cool shaded faces; shaded
sides take sky-blue fill (blue-green shadows, orange-tan highlights). Later sections drop to an
overcast dusk with a violet-blue cast on metal and an orange fire glow bleeding into the haze.
Strong light/dark contrast on cliffs, soft contrast on flat ground.

## Haze, fog, depth

Strong aerial perspective: three or four overlapping cliff silhouettes, each paler and bluer than the
last. Fog is cool, not warm, in the clean sections, and thick brown-grey with sun-lit bloom in the
dust arena. The horizon is broken by cliffs, towers and arches, never a flat line.

## Terrain materials and scale cues

Cliffs are layered limestone: horizontal ledges every few metres, vertical fissures, talus aprons,
scrubby green on top. Sea stacks and an arch give a scale reference against the ship. Water has
streaked foam trails along the ship's path and wake spray. Ground plains show cracks and worn tracks.

## Particles and motion cues

Foam spray and wake at the ship, dust and smoke columns rising from fires, orange embers, floating
debris chips in explosions, dust haze drifting in the arena. Camera rolls slightly with the ship;
near-ground speed reads from the foam and rock streaks passing the lens.

## Post

Mild bloom on fire, sun glints on water and neon strips; a soft vignette; slight teal-orange grade
(teal in shadow, orange in fire). No obvious film grain. Motion blur is light.

## HUD (layout, type, motion)

- Top-left: an angled, chamfered panel holding a long green shield bar, a thin blue boost bar under
  it, three small hex pips (bombs), and small ring pips (lives or items). Bar fill is a slanted wedge.
- Top-right: an angled panel with a large score counter in a squared, wide numeric face (`000`),
  and a ship-icon with a lives count under it.
- Bottom centre: comms panel, a portrait frame with a name tag on the left and a dark text box on
  the right, both with mint outlines and corner ticks; typed text on a dark teal fill.
- World-space cues: four-corner lock brackets around the targeted enemy (orange when locked, green
  when idle), a small "HITS +5" popup that floats up, button-prompt pills ("hold Boost"),
  checkpoint arrows, a radar ring in the lower right during the boss arena.
- Colour logic: everything friendly is mint-green or cyan, threat is orange-red, value text is white.
- Motion: bars ease toward their value, hit popups rise and fade, brackets snap in with a short
  scale pulse, damage flashes the bar amber then red.

## What this means for Starlance (original, not a copy)

Starlance is a desert canyon course, so the transferable lessons are: layered ledged cliffs with
lit/shaded contrast, cool distant haze layers against a warm foreground, one strong accent colour,
ambient drifting particles for speed, and a chamfered-panel HUD with a mint/cyan scheme.
