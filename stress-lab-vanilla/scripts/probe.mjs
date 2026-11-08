// One arm, one browser: prints the page's `__TN_STRESS__` report, any page error, and the census lines.
//
//   node scripts/probe.mjs <url> [settleSeconds]
//
// The same launch the fair window uses (brave, WebGPU flags, 1280x720, DPR 1). A run that never publishes
// a report exits 1 with the console log, which is what a broken arm looks like.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(
  "/home/joao/projects/threenative/threenative-engine/node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core",
);

const [url, settle = "12"] = process.argv.slice(2);
if (!url) throw new Error("usage: node scripts/probe.mjs <url> [settleSeconds]");

const profile = mkdtempSync(join(tmpdir(), "tn-probe-"));
// Under this session Brave's own Wayland path never enables DevTools (`--ozone-platform=wayland`
// opens no CDP port); the x11 wrapper maps the window through Xwayland and works.
const brave = spawn(
  process.env.TN_BRAVE ?? process.env.HOME + "/.cache/tmp-tn/stress-loop/brave-x11",
  [
    "--enable-unsafe-webgpu",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,AcceptCHFrame,MediaRouter",
    "--force-device-scale-factor=1",
    // A benchmark page must keep its frame clock while the window is occluded or unfocused: the
    // default backgrounding throttle drops rAF to 1 Hz and every metric reads nonsense.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--window-size=1280,720",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: "ignore", detached: true },
);
const signal = (name) => {
  try {
    process.kill(-brave.pid, name);
  } catch {
    // already gone
  }
};
try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 60; i += 1) {
    try {
      const { existsSync, readFileSync } = await import("node:fs");
      if (existsSync(portFile)) {
        var port = readFileSync(portFile, "utf8").split("\n")[0];
        break;
      }
    } catch {
      // not yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!port) throw new Error("brave did not open a DevTools port");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const lines = [];
  page.on("console", (message) => lines.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => lines.push(`pageerror: ${error.message}`));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => {
    globalThis.__THREENATIVE_ENGINE_COST__ = true;
  });
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await page.bringToFront();
  console.log("visibility:", await page.evaluate(() => document.visibilityState));
  await page.waitForTimeout(Number(settle) * 1000);
  const report = await page.evaluate(() => globalThis.__TN_STRESS__ ?? null);
  const census = await page.evaluate(() => globalThis.__tnBridgeCensus ?? null);
  console.log(JSON.stringify({ report, census }, null, 1));
  for (const line of lines) console.log(line);
  if (!report?.metrics) {
    console.error(`no __TN_STRESS__ report on ${url}`);
    process.exitCode = 1;
  }
  await browser.close().catch(() => {});
} finally {
  signal("SIGTERM");
  await new Promise((done) => setTimeout(done, 500));
  signal("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
