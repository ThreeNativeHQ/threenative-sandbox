// Usage: tools/capture-lock.sh node tools/cockpit-shot.mjs <outPrefix> [waitMs]
// Cockpit frame (key C) at 1920x952 and 1280x720 from the dev server.
import { chromium } from "playwright";
const [prefix, wait = "9000"] = process.argv.slice(2);
const url = process.env.URL ?? "http://localhost:5433/";
const browser = await chromium.launch({
  headless: false,
  args: ["--enable-unsafe-webgpu", "--disable-gpu-sandbox", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
});
for (const [w, h] of [[1920, 952], [1280, 720]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.on("console", (m) => { if (/error|Error|TN_SCENE/.test(m.text())) console.log(`[${m.type()}] ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
  await page.goto(url);
  await page.waitForTimeout(Number(wait));
  await page.keyboard.down("KeyC");
  await page.waitForTimeout(120);
  await page.keyboard.up("KeyC");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${prefix}-${w}x${h}.png` });
  await page.close();
}
await browser.close();
