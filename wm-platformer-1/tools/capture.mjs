/**
 * Screenshot harness — supplied to you. Do not edit it, and do not write your own.
 *
 * It boots nothing: point it at a dev server you already started. It opens headed Chromium
 * with the flags that reach the real Vulkan driver, names the WebGPU adapter it actually got,
 * refuses to save a frame drawn by SwiftShader, and writes a PNG.
 *
 *   node tools/capture.mjs --url http://127.0.0.1:5173 --out screenshots/iter-01.png
 *
 * Options:
 *   --url    <url>     page to open           (default http://127.0.0.1:5173)
 *   --out    <path>    PNG destination        (default screenshots/capture.png)
 *   --wait   <ms>      settle time after load (default 6000)
 *   --width  <px>      viewport width         (default 1536)
 *   --height <px>      viewport height        (default 1024)
 *   --allow-software   save the frame even if the adapter is SwiftShader
 *
 * Run it through tools/capture.sh so it gets a virtual display:
 *   sh tools/capture.sh node tools/capture.mjs --out screenshots/iter-01.png
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}.`);
  return value;
}

const url = flag("url", "http://127.0.0.1:5173");
const out = path.resolve(flag("out", "screenshots/capture.png"));
const settleMs = Number(flag("wait", "6000"));
const width = Number(flag("width", "1536"));
const height = Number(flag("height", "1024"));
const allowSoftware = process.argv.includes("--allow-software");

// Without --enable-features=Vulkan Chromium never reaches the Linux Vulkan driver and serves
// WebGPU from its CPU rasteriser instead — no error, healthy-looking limits, wrong results.
const browser = await chromium.launch({
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
    `--window-size=${width},${height}`,
  ],
});

const consoleErrors = [];
const pageErrors = [];
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(settleMs);

  // GPUAdapterInfo is not a plain object: JSON.stringify returns {}. Read it field by field.
  const adapter = await page.evaluate(async () => {
    if (navigator.gpu === undefined) return { error: "navigator.gpu is undefined" };
    const found = await navigator.gpu.requestAdapter();
    if (found === null) return { error: "requestAdapter returned null" };
    const info = found.info ?? (await found.requestAdapterInfo?.());
    if (info === undefined || info === null) return { error: "adapter exposed no info" };
    return {
      architecture: info.architecture,
      description: info.description,
      device: info.device,
      vendor: info.vendor,
    };
  });

  const fingerprint = Object.values(adapter).join(" ").toLowerCase();
  const software = fingerprint.includes("swiftshader") || fingerprint.includes("lavapipe");
  process.stdout.write(`${JSON.stringify({ adapter, consoleErrors, pageErrors, url }, null, 2)}\n`);
  if (adapter.error !== undefined) throw new Error(`No WebGPU adapter: ${adapter.error}`);
  if (software && !allowSoftware)
    throw new Error(
      `Adapter is a software rasteriser (${fingerprint.trim()}); the frame would not be evidence. Pass --allow-software to save it anyway.`,
    );

  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  process.stdout.write(`captured: ${out}\n`);
} finally {
  await browser.close();
}
