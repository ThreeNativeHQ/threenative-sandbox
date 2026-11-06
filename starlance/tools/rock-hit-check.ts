// Compares each hoodoo's real horizontal extent against the hit sphere radius the scatter uses.
// Run: npx esbuild tools/rock-hit-check.ts --bundle --platform=node --format=esm --outfile=/tmp/rock-hit.mjs && node /tmp/rock-hit.mjs
import { hoodooAxis, hoodooKit, hoodooReach } from "../src/render/rockForms";

for (const kit of hoodooKit()) {
  const P = kit.geo.getAttribute("position");
  const rows: string[] = [];
  for (let tt = 0.06; tt < 0.95; tt += Math.max(0.1, (kit.radius * 0.9) / kit.height)) {
    const y = -1.5 + tt * (kit.height + 1.5);
    const [ax, az] = hoodooAxis(kit.radius, kit.seed, tt);
    let max = 0;
    let n = 0;
    for (let i = 0; i < P.count; i += 1) {
      if (Math.abs(P.getY(i) - y) > 0.8) continue;
      max = Math.max(max, Math.hypot(P.getX(i) - ax, P.getZ(i) - az));
      n += 1;
    }
    const sphere = Math.max(1.3, hoodooReach(kit.geo, tt) * 0.9 + 0.35);
    rows.push(`t=${tt.toFixed(2)} y=${y.toFixed(1)} mesh ${max.toFixed(2)} sphere ${sphere.toFixed(2)} ${max > sphere + 0.3 ? "UNDER" : "ok"}`);
  }
  console.log(`hoodoo h=${kit.height} r=${kit.radius}\n  ${rows.join("\n  ")}`);
}
