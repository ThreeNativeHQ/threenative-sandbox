/**
 * Offline Midway audio generation.
 *
 * Reads the exact prompts from `tools/audio-catalog.mjs`, calls the ElevenLabs API, converts the
 * returned MP3 to Ogg Vorbis with ffmpeg, and records every request, voice ID and content hash in
 * one machine-consumed manifest at `content/audio/midway-audio.json`. The shipped game never calls
 * this API; the key is only read here, from the environment or `sandbox/.env`.
 *
 * Usage:
 *   node tools/audio-generate.mjs --audition         # the PRD's first audition set
 *   node tools/audio-generate.mjs --only sbd-engine-exterior-cruise-01,general-alarm
 *   node tools/audio-generate.mjs --voices           # design + persist the four voice roles
 *   node tools/audio-generate.mjs --speech           # generate every concrete speech clip
 *   node tools/audio-generate.mjs                    # every SFX in the catalog
 *
 * Nothing is regenerated once a generation record and its file exist, unless `--force` is passed.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OUTPUT_FORMAT,
  PROMPT_INFLUENCE,
  SFX_MODEL,
  TTS_MODEL,
  VOICE_DESIGN_MODEL,
  VOICES,
  sfxCatalog,
  speechCatalog,
} from "./audio-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = resolve(root, "content/audio/midway-audio.json");
const AUDIO_DIR = resolve(root, "assets/audio");
const MP3_DIR = resolve(root, "content/audio/mp3");
const BASE = "https://api.elevenlabs.io/v1";

/**
 * How hard a line is delivered, by how urgent it is.
 *
 * One flat setting for every line is what made the cast sound like a reader rather than a crew:
 * `stability: 0.6, style: 0.15` is the setting you choose when you want a narrator to sound the
 * same in every take, and it holds a man watching torpedo planes come in at exactly the same
 * temperature as a man announcing flight quarters. Stability is how much the model smooths the
 * reading toward neutral, so urgency comes from lowering it and letting style carry the delivery.
 *
 * Priority 1 is the immediate call — enemy overhead, lead going down. 2 is tactical. 3 is routine
 * shipboard traffic, which should still sound like a person and not a machine.
 */
function deliveryFor(row) {
  const similarity_boost = 0.75;
  const use_speaker_boost = true;
  if (row.priority === 1) return { stability: 0.28, similarity_boost, style: 0.75, use_speaker_boost };
  if (row.priority === 2) return { stability: 0.4, similarity_boost, style: 0.55, use_speaker_boost };
  return { stability: 0.5, similarity_boost, style: 0.35, use_speaker_boost };
}

/** Ambient beds keep their stereo width; every positional emitter is downmixed to mono. */
const STEREO_BEDS = new Set(["ocean-wind"]);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  for (const candidate of [resolve(root, "../.env"), resolve(root, ".env")]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, "utf8").split("\n")) {
      const match = /^\s*ELEVENLABS_API_KEY\s*=\s*(.+)\s*$/.exec(line);
      if (match) return match[1].replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("ELEVENLABS_API_KEY is not set and was not found in the environment or .env");
}

const KEY = apiKey();

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return { json: await res.json(), requestId: res.headers.get("request-id") };
  return { bytes: Buffer.from(await res.arrayBuffer()), requestId: res.headers.get("request-id") };
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const date = () => new Date().toISOString().slice(0, 10);

function toOgg(mp3Path, oggPath, { mono }) {
  // No fades: a loop with a fade-in/out has a guaranteed dip at the seam. The build's audio pass
  // measures the seam and cross-fades it; trimming here would hide the real defect.
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", mp3Path, "-c:a", "libvorbis", "-q:a", "6"];
  if (mono) args.push("-ac", "1");
  args.push(oggPath);
  execFileSync("ffmpeg", args);
}

function loadManifest() {
  if (existsSync(MANIFEST)) return JSON.parse(readFileSync(MANIFEST, "utf8"));
  return { version: 1, models: { sfx: SFX_MODEL, tts: TTS_MODEL, voiceDesign: VOICE_DESIGN_MODEL }, voices: {}, sfx: [], speech: [] };
}

function saveManifest(manifest) {
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}

function mergeVoices(manifest) {
  for (const [role, description] of Object.entries(VOICES)) {
    const prior = manifest.voices[role] ?? {};
    manifest.voices[role] = { role, voiceDescription: description, voiceId: prior.voiceId ?? null, generatedVoiceId: prior.generatedVoiceId ?? null, generations: prior.generations ?? [] };
  }
}

function mergeSfx(manifest) {
  const prior = new Map(manifest.sfx.map((r) => [r.id, r]));
  manifest.sfx = sfxCatalog().map((row) => ({ ...row, request: { text: row.prompt, model_id: SFX_MODEL, duration_seconds: row.seconds, prompt_influence: PROMPT_INFLUENCE, loop: row.loop }, generations: prior.get(row.id)?.generations ?? [] }));
}

function mergeSpeech(manifest) {
  const prior = new Map(manifest.speech.map((r) => [r.id + (r.slug ?? ""), r]));
  manifest.speech = speechCatalog().map((row) => ({ ...row, file: `audio/voice/${row.slug}.ogg`, generations: prior.get(row.id + row.slug)?.generations ?? [] }));
}

async function designVoices(manifest, roles) {
  for (const [role, entry] of Object.entries(manifest.voices)) {
    if (roles && !roles.has(role)) continue;
    if (entry.voiceId) continue;
    const { json } = await post("/text-to-voice/design", { voice_description: entry.voiceDescription, model_id: VOICE_DESIGN_MODEL, auto_generate_text: true });
    const preview = json.previews?.[0];
    if (!preview?.generated_voice_id) throw new Error(`voice design for ${role} returned no preview`);
    entry.generatedVoiceId = preview.generated_voice_id;
    const created = await post("/text-to-voice", { voice_name: `Midway ${role}`, voice_description: entry.voiceDescription, generated_voice_id: preview.generated_voice_id });
    entry.voiceId = created.json.voice_id;
    entry.generations.push({ date: date(), generatedVoiceId: entry.generatedVoiceId, voiceId: entry.voiceId });
    console.log(`voice ${role} -> ${entry.voiceId}`);
    saveManifest(manifest);
  }
}

async function generateSfx(manifest, only) {
  mkdirSync(AUDIO_DIR, { recursive: true });
  mkdirSync(MP3_DIR, { recursive: true });
  for (const row of manifest.sfx) {
    if (only && !only.has(row.id)) continue;
    // A conditional cue without a real consumer is left ungenerated and recorded as such.
    // A conditional cue without a real consumer is left ungenerated; naming it explicitly with
    // `--only` asserts that this worktree has connected its listed consumer.
    if (row.conditional && !flag("--all") && !(only && only.has(row.id))) continue;
    if (!flag("--force") && row.generations.length && existsSync(resolve(root, "public/assets", row.file))) continue;
    if (row.request.text.length > 450) throw new Error(`${row.id}: prompt is ${row.request.text.length} chars; the API caps text at 450`);
    const { bytes, requestId } = await post(`/sound-generation?output_format=${OUTPUT_FORMAT}`, row.request);
    if (bytes.length < 2000) throw new Error(`${row.id}: response was ${bytes.length} bytes, not audio`);
    const mp3Path = resolve(MP3_DIR, `${row.id}.mp3`);
    writeFileSync(mp3Path, bytes);
    const oggPath = resolve(AUDIO_DIR, `${row.id}.ogg`);
    toOgg(mp3Path, oggPath, { mono: !STEREO_BEDS.has(row.id) });
    const ogg = readFileSync(oggPath);
    row.generations.push({ date: date(), requestId: requestId ?? null, sourceHash: sha(bytes), outputHash: sha(ogg), bytes: ogg.length });
    console.log(`sfx ${row.id} -> ${row.file} (${ogg.length} B)`);
    saveManifest(manifest);
  }
}

async function generateSpeech(manifest, only) {
  const voiceDir = resolve(AUDIO_DIR, "voice");
  mkdirSync(voiceDir, { recursive: true });
  mkdirSync(MP3_DIR, { recursive: true });
  for (const row of manifest.speech) {
    if (only && !only.has(row.slug)) continue;
    const voiceId = manifest.voices[row.voice]?.voiceId;
    if (!voiceId) throw new Error(`speech ${row.id} needs voice ${row.voice}; run --voices first`);
    if (!flag("--force") && row.generations.length && existsSync(resolve(root, "public/assets", row.file))) continue;
    const { bytes, requestId } = await post(`/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`, {
      text: row.text,
      model_id: TTS_MODEL,
      voice_settings: deliveryFor(row),
    });
    if (bytes.length < 1000) throw new Error(`${row.slug}: response was ${bytes.length} bytes, not audio`);
    const mp3Path = resolve(MP3_DIR, `${row.slug}.mp3`);
    writeFileSync(mp3Path, bytes);
    const oggPath = resolve(root, "public/assets", row.file);
    toOgg(mp3Path, oggPath, { loop: false, mono: true });
    const ogg = readFileSync(oggPath);
    row.generations.push({ date: date(), requestId: requestId ?? null, voiceId, sourceHash: sha(bytes), outputHash: sha(ogg), bytes: ogg.length });
    console.log(`speech ${row.slug} -> ${row.file}`);
    saveManifest(manifest);
  }
}

const AUDITION = new Set(["sbd-engine-exterior-cruise-01", "sbd-engine-interior-cruise-01", "general-alarm"]);
const onlyArg = value("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const only = onlyArg?.length ? new Set(onlyArg) : flag("--audition") ? AUDITION : null;

const manifest = loadManifest();
mergeVoices(manifest);
mergeSfx(manifest);
mergeSpeech(manifest);
saveManifest(manifest);

const wantVoices = flag("--voices") || flag("--audition");
const wantSpeech = flag("--speech") || flag("--audition");
const wantSfx = !flag("--voices") && !flag("--speech");

if (wantVoices) await designVoices(manifest, flag("--audition") ? new Set(["control"]) : null);
if (wantSfx) await generateSfx(manifest, only);
if (wantSpeech) await generateSpeech(manifest, flag("--audition") ? new Set(["r06"]) : only);
rmSync(MP3_DIR, { recursive: true, force: true });
console.log(`manifest: ${MANIFEST}`);
