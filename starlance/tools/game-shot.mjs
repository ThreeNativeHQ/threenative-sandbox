// Usage: tools/capture-lock.sh node tools/game-shot.mjs <url> <out.png> [waitMs]  — console + one frame of the dev game.
import { chromium } from "playwright";
const [url, out, wait = "8000"] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: false,
  args: ["--enable-unsafe-webgpu", "--disable-gpu-sandbox", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
let budget = "";
let proj = "";
let warn = "";
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("TN_FRAME_BUDGET:")) budget = t;
  else if (t.includes("TN_PROJECTION:")) proj = t;
  else if (t.includes("TN_SCENE_WARNING")) warn = t.slice(0, 400);
  else if (/error|Error/.test(t)) console.log(`[${m.type()}] ${t.slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 400)}`));
await page.goto(url);
await page.waitForTimeout(Number(wait));
if (process.env.HOLD) {
  const [key, ms] = process.env.HOLD.split(":");
  await page.keyboard.down(key);
  await page.waitForTimeout(Number(ms));
  await page.keyboard.up(key);
  await page.waitForTimeout(500);
}
await page.screenshot({ path: out });
let b = {};
try {
  b = JSON.parse(budget.slice(budget.indexOf("{")));
} catch {}
const g = (o, ...ks) => ks.reduce((x, k) => (x === undefined ? x : x[k]), o);
console.log(
  `render p95 ${g(b, "phases", "render", "p95")} ms, frame p95 ${g(b, "frame", "p95")}, draws ${g(b, "passes", "main", "draws", "mean")}, tris ${Math.round(g(b, "passes", "main", "triangles", "mean"))}, gpu ${JSON.stringify(g(b, "gpu") ?? {}).slice(0, 220)}`,
);
if (warn) console.log(warn);
if (process.env.DUMP) console.log(proj);
await browser.close();
