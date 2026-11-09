import type { IThreeNativeConfig } from "@threenative/core";

const config: IThreeNativeConfig = {
  app: {
    id: "com.threenative.midwayopenpacific",
    name: "midway-open-pacific",
    version: "1.0.0",
    build: 1,
    icon: "public/icon.png",
    icons: { web: { favicon: "public/favicon.svg" } },
  },
  display: {
    orientation: "landscape",
    fullscreen: true,
    keepScreenOn: true,
    maxFps: 60,
  },
  window: {
    title: "MIDWAY — Open Pacific",
    width: 1280,
    height: 720,
    resizable: true,
  },
  bootSplash: { backgroundColor: "#102a37" },
  // The owned engine is the default on web, and its `clone()` refuses an InstancedMesh
  // (`TN_NATIVE_CLONE_UNSUPPORTED`). The compact pass turns a hull's repeated parts into one, and
  // every ship here is built by cloning its model, so the instance sub-pass stays off until the
  // clone path handles it — the other two compaction sub-passes still run. Measured, not taste:
  // with it on, `createCarrier` throws before the briefing draws.
  assets: { models: { compact: { instance: false } } },
  nativeEntry: "src/game.ts",
  renderer: {
    // WebGPU by default; the ocean, sky and combat particles are TSL node materials so the same
    // source runs on the WebGPU backend on web and native.
    resolutionScale: "auto",
    alphaAntialiasing: true,
    // The scene-render projection measured as a net loss here (P1: paid reconcile, no frame-time
    // win, multi-second engagement freeze, and a darker mirror image). Decline it: no mirror, no
    // scan, the authored scene every frame.
    projection: false,
    // The render-camera projected-size cull is engine-owned and on by default at 0.5 px. The game
    // used to hand-roll this at 2 px for aircraft (`MIN_AIRCRAFT_PIXELS`); 0.5 px is more
    // conservative, so this keeps the measured 2 px line. The engine applies it per render camera
    // and reports it in `TN_PROJECTION.cull`.
    minimumProjectedPixels: 2,
  },
  // Two surfaces, one game. The web build draws the full DOM HUD in index.html through
  // src/ui/dom.ts; a native target composites src/ui/main.tsx in the platform's own web view,
  // reading the state the scene publishes. Neither one runs inside the game bundle.
  ui: { renderer: "web" },
};

export default config;
