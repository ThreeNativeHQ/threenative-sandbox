// Usage: tools/capture-lock.sh node tools/rock-shot.mjs <port> <out.png> <query>  (vite dev must be running)
import { chromium } from "playwright";
const [port, out, query = "view=towers"] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: false,
  args: ["--enable-unsafe-webgpu", "--disable-gpu-sandbox", "--ignore-gpu-blocklist", "--enable-features=Vulkan"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("console", (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/tools/rock-lab.html?${query}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
await page.screenshot({ path: out });
console.log("stats", JSON.stringify(await page.evaluate(() => window.__stats)));
await browser.close();
