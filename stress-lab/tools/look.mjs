// Look at the finished game with no dev server in the loop: build it, serve the
// production bundle from dist/, capture one screenshot per vantage into
// artifacts/look/, and print every console line per vantage. Exits non-zero when
// any console error or uncaught page exception occurred.
//
// Usage:
//   node tools/look.mjs                            # one screenshot at /
//   node tools/look.mjs --vantage spawn=/ --vantage menu=/?menu=1
//   node tools/look.mjs --webgpu                   # headed Chromium with WebGPU flags
//
// A vantage value is a path (or path + query) served by the built site — games use
// query entry selectors such as /?menu. If the page exposes window.__LOOK_VANTAGES__
// = { name() {...} }, a --vantage whose name matches calls that hook on the loaded
// page before the shot: move the camera there; the game owns what each vantage shows.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { build, preview } from "vite";

const WEBGPU_ARGS = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  // Without this Chromium never reaches the Linux Vulkan driver and silently serves WebGPU
  // from SwiftShader: no error, healthy-looking limits, software-rendered screenshots.
  "--enable-features=Vulkan",
];

/** Milliseconds between load and the shot; scenes animate in over their first seconds. */
const SETTLE_MS = 2500;

function usage() {
  console.log("usage: node tools/look.mjs [--webgpu] [--vantage name=path ...]");
  process.exit(0);
}

function parseVantage(spec) {
  const eq = spec === undefined ? -1 : spec.indexOf("=");
  if (eq <= 0) throw new Error(`--vantage expects name=path, got '${spec ?? ""}'`);
  return { name: spec.slice(0, eq), target: spec.slice(eq + 1) };
}

function parseArgs(argv) {
  const vantages = [];
  let webgpu = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") usage();
    else if (arg === "--webgpu") webgpu = true;
    else if (arg === "--vantage") vantages.push(parseVantage(argv[++i]));
    else throw new Error(`unknown argument '${arg}' — see node tools/look.mjs --help`);
  }
  if (vantages.length === 0) vantages.push({ name: "spawn", target: "/" });
  for (const { name } of vantages) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error(`bad vantage name '${name}'`);
  }
  return { webgpu, vantages };
}

const { webgpu, vantages } = parseArgs(process.argv.slice(2));
const root = path.resolve(import.meta.dirname, "..");

await build({ root });
const server = await preview({ root, logLevel: "warn" });
const base = server.resolvedUrls.local[0];
console.log(`look: serving dist/ at ${base}`);

const outDir = path.join(root, "artifacts", "look");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: !webgpu, args: webgpu ? WEBGPU_ARGS : [] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  for (const { name, target } of vantages) {
    const entries = [];
    const onConsole = (message) => entries.push({ type: message.type(), text: message.text() });
    const onPageError = (error) =>
      entries.push({ type: "error", text: `uncaught: ${error.message}` });
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    try {
      await page.goto(new URL(target, base).href, { waitUntil: "load" });
      await page.waitForTimeout(SETTLE_MS);
      const hasHook = await page.evaluate(
        (vantageName) => Boolean(globalThis.__LOOK_VANTAGES__?.[vantageName]),
        name,
      );
      if (hasHook) {
        await page.evaluate((vantageName) => globalThis.__LOOK_VANTAGES__[vantageName](), name);
        await page.waitForTimeout(SETTLE_MS);
      }
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(`\n== ${name} ${target} -> ${path.relative(root, file)}`);
      for (const entry of entries) console.log(`  [${entry.type}] ${entry.text}`);
      if (entries.some((entry) => entry.type === "error")) failed = true;
    } finally {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    }
  }
} finally {
  await browser.close();
  server.httpServer?.close();
}
process.exitCode = failed ? 1 : 0;
