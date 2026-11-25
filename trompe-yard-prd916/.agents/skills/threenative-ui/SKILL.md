---
name: threenative-ui
description: Build a native-safe ThreeNative React UI that communicates through state and intents. Use when adding or changing a HUD, menu, or any React UI that must also run on native, where the layout key set is fixed and CSS does not exist.
---

# ThreeNative UI

Use `View` and `Text` from `@threenative/core/react` for native UI; `react-dom` is web-only.
Native layout is pixel-based and absolute unless `direction` is `row` or `column`. Supported keys
are `left`, `right`, `top`, `bottom`, `centerX`, `centerY`, `width`, `height`, `padding`,
`direction`, `gap`, `align`, `background`, `color`, `opacity`, `fontSize`, `letterSpacing`,
`textAlign`, and `zIndex`; CSS, Tailwind, flex grow/wrap, borders, radius, transforms, images, SVG,
and events do not exist in the native renderer.

On native, game and UI are separate processes. The UI reads published JSON-safe state and sends
intents; `src/game.ts` decides their meaning. `useUiState<GameState>()` is undefined until the first
snapshot, and `useUiIntent()` sends commands. Mark every touch target `data-tn-interactive`; the
host routes marked pointer-down events to UI and unmarked touches to the game. Share state and
components, but keep appearance in `src/ui/`. The full state, hit-region, and renderer contract is
`node_modules/create-threenative/agent-docs/references/webview-ui.md`.
