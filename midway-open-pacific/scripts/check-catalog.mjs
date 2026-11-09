/**
 * Catalog/manifest consistency check (PRD AC-1). Proves the packaged file the game actually names is
 * the bytes the manifest recorded: every cue in `CUE_FILES` and every speech slug resolves to a
 * generated manifest row whose recorded SHA-256 equals the shipped Ogg. It also reports packaged
 * cues that no code path consumes yet, so an unconsumed cue cannot pass silently as shipped.
 *
 * Run: node scripts/check-catalog.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = await build({
  stdin: { contents: 'export * from "./src/audio.ts"; export * from "./src/speech.ts";', loader: "ts", resolveDir: root },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  logLevel: "silent",
});
const { CUE_FILES, speechSlugList } = await import(`data:text/javascript,${encodeURIComponent(built.outputFiles[0].text)}`);

const manifest = JSON.parse(readFileSync(resolve(root, "content/audio/midway-audio.json"), "utf8"));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sfxById = new Map(manifest.sfx.map((row) => [row.id, row]));
const speechBySlug = new Map(manifest.speech.map((row) => [row.slug, row]));

let checked = 0;
const consumed = new Set();

// 1 — every SFX the code names is packaged, generated and hash-identical to its manifest record.
for (const [key, path] of Object.entries(CUE_FILES)) {
  const id = path.replace(/^audio\//, "").replace(/\.ogg$/, "");
  const row = sfxById.get(id);
  assert.ok(row, `cue ${key} -> ${path} has no manifest row`);
  assert.ok(row.generations.length > 0, `cue ${key} (${id}) has no generation record`);
  const file = resolve(root, "public/assets", path);
  assert.ok(existsSync(file), `cue ${key} is not packaged at ${path}`);
  assert.equal(sha(file), row.generations.at(-1).outputHash, `cue ${key} bytes do not match its manifest hash`);
  consumed.add(id);
  checked += 1;
}

// 2 — every speech slug the script can request is packaged, generated and hash-identical.
for (const slug of speechSlugList()) {
  const row = speechBySlug.get(slug);
  assert.ok(row, `speech ${slug} has no manifest row`);
  assert.ok(row.generations.length > 0, `speech ${slug} has no generation record`);
  const file = resolve(root, "assets/audio/voice", `${slug}.ogg`);
  assert.ok(existsSync(file), `speech ${slug} is not packaged`);
  assert.equal(sha(file), row.generations.at(-1).outputHash, `speech ${slug} bytes do not match its manifest hash`);
  checked += 1;
}

// 3 — report packaged SFX no code path consumes yet; the PRD expects these to shrink, not vanish.
const packaged = readdirSync(resolve(root, "assets/audio")).filter((f) => f.endsWith(".ogg")).map((f) => f.replace(/\.ogg$/, ""));
const unconsumed = packaged.filter((id) => !consumed.has(id) && !id.startsWith("r") && !id.startsWith("p"));
assert.ok(checked > 100, `expected the full cue+speech catalog, checked only ${checked}`);
console.log(
  `check-catalog: ${checked} consumed cues verified (hash-matched); ${unconsumed.length} packaged sfx not yet wired: ${unconsumed.join(", ")}`,
);
