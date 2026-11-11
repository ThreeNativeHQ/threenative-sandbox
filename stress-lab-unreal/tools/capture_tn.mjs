// The ThreeNative side of the judge pair: the stress lab at orbit second 10, 1280x720 at DPR 1, in the
// same Chromium and flags as `stress-loop.mjs fair`. Usage:
//   node tools/capture_tn.mjs <out.png> [url] [chrome]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const [out, url = "http://127.0.0.1:5785/main.html?stress&freezeAt=10", chrome = join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome")] = process.argv.slice(2);
if (!out) throw new Error("usage: capture_tn.mjs <out.png> [url] [chrome]");
const engine = join(homedir(), "projects/threenative/threenative-engine");
const { chromium } = createRequire(realpathSync(join(engine, "node_modules/@playwright/test/package.json")))("playwright-core");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const profile = mkdtempSync(join(tmpdir(), "tn-capture-"));
const child = spawn(chrome, ["--enable-unsafe-webgpu", "--disable-gpu-sandbox", "--ignore-gpu-blocklist",
  "--enable-features=Vulkan", "--no-first-run", "--no-default-browser-check", "--force-device-scale-factor=1",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", detached: true });
const kill = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 60 && !existsSync(portFile); i += 1) await sleep(500);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}`);
  const page = await browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(url);
  // The report appears once the scene runs; the camera holds at orbit second 10, then the image settles.
  await page.waitForFunction(() => globalThis.__TN_STRESS__ !== undefined, null, { timeout: 120_000 });
  await sleep(12_000);
  console.log("adapter", await page.evaluate(async () => JSON.stringify((await navigator.gpu?.requestAdapter())?.info ?? null)));
  await page.screenshot({ path: out });
  console.log(`wrote ${out}`);
  await browser.close();
} finally {
  kill("SIGTERM");
  await sleep(1000);
  kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
