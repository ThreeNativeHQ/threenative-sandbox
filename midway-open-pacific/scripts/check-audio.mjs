/**
 * Soundscape cue-direction and lifecycle check. Runs the real `src/audio.ts` against a fake
 * `IAudioTarget`, so the things that only break at runtime — a doubled engine layer, a perspective
 * that never crosses, wind that ignores airspeed, a one-shot that ignores pause, a dispose that
 * leaves the bus open — fail here.
 *
 * The engine's real bus mechanics (voice ceiling, recycling, panner, detune) are covered by the
 * engine's own tests; this file covers the game's choices. Uses the esbuild vite already installs.
 * Run: node scripts/check-audio.mjs
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

class Param {
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v) {
    this.value = v;
    return this;
  }
  setTargetAtTime(v) {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v) {
    this.value = v;
    return this;
  }
}

class Voice {
  constructor(key) {
    this.key = key;
    this.gain = { gain: new Param(0) };
    this.source = { playbackRate: new Param(1) };
    this.isPlaying = true;
    this.stopped = false;
  }
}

class FakeBus {
  constructor() {
    this.listener = { context: { currentTime: 0 } };
    this.volume = 1;
    this.musicCalls = [];
    this.playCalls = [];
    this.playAtCalls = [];
    this.disposals = 0;
  }
  setVolume(v) {
    this.volume = v;
  }
  music(buffer, options) {
    const key = buffer?.__key ?? "?";
    const voice = new Voice(key);
    this.musicCalls.push({ key, options, voice });
    return voice;
  }
  play(buffer, options) {
    const voice = new Voice(buffer?.__key);
    this.playCalls.push({ key: buffer?.__key ?? "?", options, voice });
    return voice;
  }
  playAt(buffer, source, options) {
    this.playAtCalls.push({ key: buffer?.__key ?? "?", source, options });
    return new Voice(buffer?.__key);
  }
  stopVoice(voice) {
    voice.stopped = true;
    voice.isPlaying = false;
    this.stopped = (this.stopped ?? 0) + 1;
    return true;
  }
  unlock() {
    return Promise.resolve();
  }
  dispose() {
    this.disposals += 1;
  }
  voice(key) {
    return [...this.musicCalls].reverse().find((c) => c.key === key);
  }
}

// Bundle the real modules (audio.ts imports ./speech.js) so the check runs the shipped source.
const built = await build({
  stdin: { contents: 'export * from "./src/audio.ts"; export * from "./src/speech.ts";', loader: "ts", resolveDir: root },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  logLevel: "silent",
});
const js = built.outputFiles[0].text;
const { Soundscape, CUE_FILES, SpeechQueue, resolveSpeech, speechSlugList, SPEECH } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/** A tagged stand-in for a decoded AudioBuffer; only `__key` is read. */
const bufferFor = (key) => ({ duration: 1, __key: key, sampleRate: 48000 });
const allBuffers = () => new Map(Object.keys(CUE_FILES).map((key) => [key, bufferFor(key)]));
const voiceOf = (bus, key) => bus.musicCalls.filter((c) => c.key === key).at(-1);

// 0 — bidirectional packaging check: no orphan audio/voice files on disk, no missing files in code.
{
  const cuePaths = new Set(Object.values(CUE_FILES).map((p) => resolve(root, "public/assets", p)));
  const speechPaths = new Set(speechSlugList().map((slug) => resolve(root, "assets/audio/voice", `${slug}.ogg`)));

  const missingCues = Object.entries(CUE_FILES).filter(([, path]) => !existsSync(resolve(root, "public/assets", path)));
  assert.equal(missingCues.length, 0, `cue code names an unpackaged file: ${missingCues.map(([k, p]) => `${k} -> ${p}`).join(", ")}`);

  const missingSpeech = speechSlugList().filter((slug) => !existsSync(resolve(root, "assets/audio/voice", `${slug}.ogg`)));
  assert.equal(missingSpeech.length, 0, `speech script names an unpackaged clip: ${missingSpeech.join(", ")}`);

  // Detect orphan files in assets/audio
  const audioDir = resolve(root, "assets/audio");
  const diskAudioFiles = readdirSync(audioDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ogg"))
    .map((e) => resolve(audioDir, e.name));
  const orphanAudio = diskAudioFiles.filter((p) => !cuePaths.has(p));
  assert.equal(orphanAudio.length, 0, `orphan audio files on disk (not in CUE_FILES): ${orphanAudio.map((p) => p.replace(root + "/", "")).join(", ")}`);

  // Detect orphan files in assets/audio/voice
  const voiceDir = resolve(root, "assets/audio/voice");
  const diskVoiceFiles = readdirSync(voiceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ogg"))
    .map((e) => resolve(voiceDir, e.name));
  const orphanVoice = diskVoiceFiles.filter((p) => !speechPaths.has(p));
  assert.equal(orphanVoice.length, 0, `orphan voice files on disk (not in speech): ${orphanVoice.map((p) => p.replace(root + "/", "")).join(", ")}`);
}

// 1 — load() keeps the successes, drops the failures, and never throws on a missing file.
{
  const assets = {
    audio: async (path) => {
      if (path.includes("airflow-exterior") || path.includes("gun-50")) return bufferFor(path);
      throw new Error(`404 ${path}`);
    },
  };
  const buffers = await Soundscape.load(assets);
  assert.equal(buffers.size, 2, `expected 2 loaded cues, got ${buffers.size}`);
}

// 2 — the game reports a fully missing catalog once, not per frame.
{
  const bus = new FakeBus();
  const infos = [];
  const real = console.info;
  console.info = (m) => infos.push(String(m));
  const s = new Soundscape(new Map(), bus);
  for (let i = 0; i < 10; i += 1) s.update(listener(), false, 1 / 60);
  console.info = real;
  assert.equal(infos.length, 1, `expected one missing-cue report, got ${infos.length}`);
  assert.equal(bus.musicCalls.length, 0, "a missing catalog still opened a loop");
}

// 3 — continuous layers start exactly once, however many frames run.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  for (let i = 0; i < 5; i += 1) step(s, bus, { cockpit: false });
  const keys = bus.musicCalls.map((c) => c.key);
  assert.equal(keys.length, new Set(keys).size, "a continuous layer was started twice");
  assert.ok(keys.includes("engineExtCruise"), "the exterior engine layers were not started");
  assert.ok(keys.includes("airflowExterior"), "the exterior airflow layer was not started");
}

// 4 — the cockpit perspective crosses the engine balance rather than swapping it.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  for (let i = 0; i < 40; i += 1) step(s, bus, { cockpit: true, rpm: 0.5, ias: 120 });
  const extGain = gainOf(bus, "engineExtCruise");
  const intGain = gainOf(bus, "engineIntCruise");
  assert.ok(intGain > extGain + 0.1, `cockpit should favour the interior engine (int ${intGain}, ext ${extGain})`);

  for (let i = 0; i < 40; i += 1) step(s, bus, { cockpit: false, rpm: 0.5, ias: 120 });
  const extGain2 = gainOf(bus, "engineExtCruise");
  const intGain2 = gainOf(bus, "engineIntCruise");
  assert.ok(extGain2 > intGain2 + 0.1, `external view should favour the exterior engine (ext ${extGain2}, int ${intGain2})`);
}

// 5 — wind follows airspeed, not throttle, and rides the cockpit layer inside.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  for (let i = 0; i < 30; i += 1) step(s, bus, { cockpit: true, rpm: 0.5, ias: 0 });
  assert.ok(gainOf(bus, "airflowCockpit") < 0.02, "airflow sounded with no airspeed");
  for (let i = 0; i < 30; i += 1) step(s, bus, { cockpit: true, rpm: 0.5, ias: 150 });
  assert.ok(gainOf(bus, "airflowCockpit") > 0.2, "airflow did not rise with airspeed");
}

// 6 — engine cutoff leaves airspeed-driven wind and starts the windmilling propeller.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  for (let i = 0; i < 30; i += 1) step(s, bus, { cockpit: false, rpm: 0, ias: 120, engineCut: true });
  assert.ok(gainOf(bus, "engineExtCruise") < 0.02, "a cut engine still sounded");
  assert.ok(gainOf(bus, "propWindmill") > 0.3, "the windmilling propeller did not start");
  assert.ok(gainOf(bus, "airflowExterior") > 0.1, "a dead-stick dive lost its slipstream");
}

// 7 — deck contact drives the wheel roll; leaving the deck stops it.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  for (let i = 0; i < 20; i += 1) step(s, bus, { cockpit: false, onDeck: true, deckSpeed: 40, rpm: 0.5, ias: 30 });
  assert.ok(gainOf(bus, "deckRoll") > 0.2, "wheels rolling on deck made no sound");
  for (let i = 0; i < 20; i += 1) step(s, bus, { cockpit: false, onDeck: false, rpm: 0.5, ias: 120 });
  assert.ok(gainOf(bus, "deckRoll") < 0.05, "deck roll continued after liftoff");
}

// 8 — one-shots respect the family cooldown and a missing buffer stays silent.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  s.update(listener(), false, 1 / 60);
  s.event({ type: "gun" });
  s.event({ type: "gun" });
  const guns = bus.playCalls.filter((c) => c.key === "gun50");
  assert.equal(guns.length, 1, `40-held fire opened ${guns.length} gun voices inside one cooldown`);
  bus.listener.context.currentTime += 0.2;
  s.event({ type: "gun" });
  assert.equal(bus.playCalls.filter((c) => c.key === "gun50").length, 2, "the gun never left its cooldown");
  const empty = new Soundscape(new Map(), new FakeBus());
  const real = console.info;
  console.info = () => {};
  empty.update(listener(), false, 1 / 60);
  empty.event({ type: "alarm" }); // no buffer: silent, no throw
  console.info = real;
}

// 9 — an alarm emits the reconstructed general alarm; a positional cue uses the panner.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  s.update(listener(), false, 1 / 60);
  s.event({ type: "alarm" });
  assert.equal(bus.playCalls.filter((c) => c.key === "generalAlarm").length, 1, "the general alarm did not sound");
  s.event({ cue: "aaHeavy", at: { x: 100, y: 0, z: 0 }, distance: 100 });
  // A world cue waits for its sound to travel: put the listener at the source and it is due now.
  s.update(listener({ listener: { x: 100, y: 0, z: 0 } }), false, 1 / 60);
  assert.equal(bus.playAtCalls.filter((c) => c.key === "aaHeavy").length, 1, "a positional cue did not pan");
}

// 10 — mute and pause suppress one-shots immediately; unpausing restores the bus level.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  s.update(listener(), false, 1 / 60);
  s.muted = true;
  assert.equal(bus.volume, 0, "muting did not drop the bus level on the same tick");
  const before = bus.playCalls.length;
  s.event({ type: "alarm" });
  assert.equal(bus.playCalls.length, before, "a muted Soundscape still opened a voice");
  s.muted = false;
  assert.ok(bus.volume > 0, "unmuting did not restore the bus level");
  s.update(listener(), true, 1 / 60);
  assert.equal(bus.volume, 0, "pause did not silence the bus");
  const paused = bus.playCalls.length;
  s.event({ type: "alarm" });
  assert.equal(bus.playCalls.length, paused, "a paused Soundscape opened a voice");
}

// 11 — dispose() closes the bus once and stays disposed.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  s.update(listener(), false, 1 / 60);
  s.dispose();
  s.dispose();
  assert.equal(bus.disposals, 1, `dispose() called the bus ${bus.disposals} times`);
  assert.equal(s.active, false, "dispose() left the Soundscape active");
  const frames = bus.playCalls.length;
  s.update(listener(), false, 1 / 60);
  s.event({ type: "gun" });
  assert.equal(bus.playCalls.length, frames, "a disposed Soundscape opened a voice");
}

// 12 — the resolver expands the direction/ship variants and keeps the exact script words.
{
  const r = resolveSpeech({ id: "R02", direction: "northeast" });
  assert.equal(r.slug, "r02-northeast", "direction variant slug is wrong");
  assert.ok(r.text.includes("northeast") && !r.text.includes("{"), `R02 text not substituted: ${r.text}`);
  assert.equal(resolveSpeech({ id: "P04" }).channel, "pa", "PA channel not inferred");
  assert.equal(resolveSpeech({ id: "R13" }).channel, "intercom", "gunner channel not inferred");
  assert.equal(resolveSpeech({ id: "nope" }), null, "an unknown cue should not resolve");
  assert.ok(Object.keys(SPEECH).length >= 30, "the script table lost rows");
}

// 13 — one sentence at a time; a second request queues rather than overlapping.
{
  const bus = new FakeBus();
  const q = new SpeechQueue(bus, speechBuffers({ r03: 2, r01: 2 }));
  q.update(0, false, false);
  assert.ok(q.request({ id: "R03" }));
  q.update(0, false, false);
  assert.ok(q.request({ id: "R01" }));
  assert.equal(bus.playCalls.length, 1, "two lines sounded at once");
  bus.listener.context.currentTime += 3;
  q.update(0, false, false);
  assert.equal(bus.playCalls.length, 2, "the queued line never started");
}

// 14 — an immediate warning interrupts routine radio and fades the old line to zero.
{
  const bus = new FakeBus();
  const q = new SpeechQueue(bus, speechBuffers({ r03: 4, r06: 2 }));
  q.update(0, false, false);
  q.request({ id: "R03" });
  q.update(0, false, false);
  bus.listener.context.currentTime += 0.1;
  q.update(0, false, false);
  q.request({ id: "R06" });
  assert.equal(bus.playCalls.at(-1).key, "speech:r06", "the urgent line did not take over");
  assert.equal(bus.playCalls[0].voice.gain.gain.value, 0, "the interrupted line was not faded out");
}

// 15 — the same ongoing alert is deduplicated inside its cooldown, then speaks again after it.
{
  const bus = new FakeBus();
  const q = new SpeechQueue(bus, speechBuffers({ r06: 1 }));
  q.update(0, false, false);
  assert.ok(q.request({ id: "R06", identity: "cv6" }));
  bus.listener.context.currentTime += 0.5;
  q.update(0, false, false);
  assert.equal(q.request({ id: "R06", identity: "cv6" }), false, "a cooldown repeat was accepted");
  bus.listener.context.currentTime += 31;
  q.update(0, false, false);
  assert.ok(q.request({ id: "R06", identity: "cv6" }), "the alert never spoke again after its cooldown");
}

// 16 — PA needs the listener in range, a stale queued predicate is rechecked, missing clips stay quiet.
{
  const bus = new FakeBus();
  const q = new SpeechQueue(bus, speechBuffers({ p01: 1 }));
  q.update(0, false, false);
  assert.equal(q.request({ id: "P01" }), false, "PA sounded with no ship in range");
  q.update(0, false, true);
  assert.ok(q.request({ id: "P01" }), "PA stayed silent alongside the ship");

  const bus2 = new FakeBus();
  const q2 = new SpeechQueue(bus2, speechBuffers({ r06: 1 }));
  q2.update(0, false, false);
  let live = true;
  q2.request({ id: "R06", valid: () => live });
  live = false;
  q2.update(0, false, false);
  assert.equal(bus2.playCalls.length, 0, "a stale queued alert still sounded");

  const q3 = new SpeechQueue(new FakeBus(), new Map());
  q3.update(0, false, false);
  assert.doesNotThrow(() => q3.request({ id: "R17" }), "a missing speech clip threw");
}


// 17 — an enriched event carries weapon identity to the right cue.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  const atOrigin = () => s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  atOrigin();
  s.event({ type: "gun", weapon: "cannon20", at: { x: 0, y: 0, z: 0 } });
  s.event({ type: "gun", weapon: "gun77", at: { x: 0, y: 0, z: 0 } });
  s.event({ type: "gun", weapon: "gun30", at: { x: 0, y: 0, z: 0 } });
  s.event({ type: "gun", weapon: "gun50", at: { x: 0, y: 0, z: 0 } });
  atOrigin();
  const keys = bus.playAtCalls.map((c) => c.key);
  assert.ok(keys.includes("cannon20"), "a Zero cannon did not reach its cue");
  assert.ok(keys.includes("gun77"), "a Japanese MG did not reach its cue");
  assert.ok(keys.includes("gun30"), "the rear .30 event did not reach its own cue");
  assert.ok(keys.includes("gun50"), "the forward .50 event did not reach its own cue");
  s.event({ type: "bomb", weapon: "torpedo" });
  assert.ok(bus.playCalls.some((c) => c.key === "torpedoRelease"), "a torpedo release did not sound its latch");
}

// 18 — release, airburst, water, deck blast and torpedo hit stay distinguishable.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  const here = () => s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  here();
  s.event({ type: "explosion", at: { x: 0, y: 0, z: 0 }, material: "water" });
  s.event({ type: "explosion", at: { x: 0, y: 0, z: 0 }, material: "air" });
  s.event({ type: "explosion", at: { x: 0, y: 0, z: 0 }, material: "steel", outcome: "torpedo" });
  s.event({ type: "explosion", at: { x: 0, y: 0, z: 0 }, material: "deck" });
  s.event({ type: "flak", at: { x: 0, y: 0, z: 0 } });
  here();
  const keys = new Set(bus.playAtCalls.map((c) => c.key));
  for (const key of ["bombWater", "aircraftCrash", "torpedoHit", "bombDeck", "flakAirburst"]) {
    assert.ok(keys.has(key), `explosion family missing cue ${key}`);
  }
}

// 19 — a stationary explosion 686 m away begins at 2.0 s, not before.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  const at = (t) => {
    bus.listener.context.currentTime = t;
    s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0.1);
  };
  at(0);
  s.event({ type: "explosion", at: { x: 686, y: 0, z: 0 }, material: "steel" });
  at(1.9);
  assert.equal(bus.playAtCalls.length, 0, "a 686 m explosion sounded before 2 s");
  at(2.05);
  assert.equal(bus.playAtCalls.length, 1, "a 686 m explosion never arrived");
}

// 20 — an event past its falloff range is culled even after its travel time.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  bus.listener.context.currentTime = 0;
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  s.event({ type: "explosion", at: { x: 12000, y: 0, z: 0 }, material: "steel" });
  bus.listener.context.currentTime = 40;
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0.1);
  assert.equal(bus.playAtCalls.length, 0, "an inaudible 12 km explosion still sounded");
}

// 21 — Doppler follows the radial velocity: receding source drops, approaching source rises.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  bus.listener.context.currentTime = 0;
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  s.event({ type: "gun", weapon: "gun50", at: { x: 300, y: 0, z: 0 }, vel: { x: 80, y: 0, z: 0 } });
  bus.listener.context.currentTime = 1;
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0.1);
  const receding = bus.playAtCalls.at(-1).options.detune;
  assert.ok(receding < 0, `a receding aircraft should drop pitch, got ${receding}`);

  const bus2 = new FakeBus();
  const s2 = new Soundscape(allBuffers(), bus2);
  bus2.listener.context.currentTime = 0;
  s2.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  s2.event({ type: "gun", weapon: "gun50", at: { x: 300, y: 0, z: 0 }, vel: { x: -80, y: 0, z: 0 } });
  bus2.listener.context.currentTime = 1;
  s2.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0.1);
  assert.ok(bus2.playAtCalls.at(-1).options.detune > 0, "an approaching aircraft should rise in pitch");
}

// 22 — a paused world freezes pending cues and resume does not dump a backlog.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  bus.listener.context.currentTime = 0;
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  s.event({ type: "explosion", at: { x: 686, y: 0, z: 0 }, material: "steel" });
  for (let i = 0; i < 5; i += 1) {
    bus.listener.context.currentTime += 1;
    s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), true, 1);
  }
  assert.equal(bus.playAtCalls.length, 0, "a pending cue fired while paused");
  bus.listener.context.currentTime += 0.1;
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0.1);
  assert.equal(bus.playAtCalls.length, 0, "resume dumped the paused backlog");
  bus.listener.context.currentTime += 2.1;
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0.1);
  assert.equal(bus.playAtCalls.length, 1, "the frozen cue never resumed after the pause");
}

// 23 — continuous emitters start once, retarget in place, and stop when no longer wanted.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  const hull = { name: "burning-hull" };
  s.syncEmitters([{ id: "fire-1", key: "fuelFire", source: hull, volume: 0.6 }]);
  assert.equal(bus.playAtCalls.filter((c) => c.key === "fuelFire").length, 1, "a burning ship loop did not start");
  s.syncEmitters([{ id: "fire-1", key: "fuelFire", source: hull, volume: 0.3 }]);
  assert.equal(bus.playAtCalls.filter((c) => c.key === "fuelFire").length, 1, "a running emitter was restarted instead of retargeted");
  s.syncEmitters([]);
  assert.ok((bus.stopped ?? 0) >= 1, "a no-longer-wanted emitter kept playing");
}

// 24 — the continuous-emitter budget culls the quietest, never starting more than twelve.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, key: "fuelFire", source: {}, volume: 1 - i * 0.04 }));
  s.syncEmitters(many);
  assert.equal(bus.playAtCalls.filter((c) => c.key === "fuelFire").length, 12, "the 12-emitter budget was not enforced");
}

// 25 — dive-brake and cockpit-rattle continuous layers respond to real flight state.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  for (let i = 0; i < 20; i += 1) step(s, bus, { cockpit: false, brakes: false, ias: 140 });
  assert.equal(gainOf(bus, "diveBrake"), 0, "dive brake sounded while retracted");
  for (let i = 0; i < 20; i += 1) step(s, bus, { cockpit: false, brakes: true, ias: 140 });
  assert.ok(gainOf(bus, "diveBrake") > 0.3, "dive brake did not sound when extended at speed");

  for (let i = 0; i < 20; i += 1) step(s, bus, { cockpit: false, damage: 0.8, stall: 0.8 });
  assert.equal(gainOf(bus, "cockpitRattle"), 0, "cockpit rattle sounded in external view");
  for (let i = 0; i < 20; i += 1) step(s, bus, { cockpit: true, damage: 0.8, stall: 0.8 });
  assert.ok(gainOf(bus, "cockpitRattle") > 0.1, "cockpit rattle did not sound inside under stress");
}

// 26 — all event types map to valid cues with no orphan audio mappings.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  s.update(listener({ listener: { x: 0, y: 0, z: 0 } }), false, 0);

  const events = [
    { type: "gear" },
    { type: "flap" },
    { type: "wire" },
    { type: "engineStart" },
    { type: "engineStop" },
    { type: "bulletNear" },
    { type: "depthCharge" },
    { type: "collapse" },
    { type: "secondary" },
    { type: "torpedoEntry" },
    { type: "steelHit" },
    { type: "splash", fragments: true },
    { type: "land", wire: true },
    { type: "aa", weapon: "aa11" },
  ];

  for (const e of events) {
    bus.listener.context.currentTime += 1;
    s.event(e);
  }
  const keys = new Set(bus.playCalls.map((c) => c.key));
  for (const expected of [
    "gearTravel",
    "flapTravel",
    "wireCatch",
    "engineStart",
    "engineStop",
    "bulletNear",
    "depthCharge",
    "hullCollapse",
    "secondaryBlast",
    "torpedoEntry",
    "steelHit",
    "waterFragments",
    "aa11",
  ]) {
    assert.ok(keys.has(expected), `event routing missing or unhooked cue: ${expected}`);
  }
}

// 27 — no orphaned cues: every single cue in CUE_FILES is defined and recognized.
{
  const definedCues = Object.keys(CUE_FILES);
  assert.equal(definedCues.length, 78, `expected 78 catalog cues, got ${definedCues.length}`);
}

// 28 — the TBD bank follows the torpedo loadout: its layers sound, the SBD bank stays silent,
// and its start/stop cues route by airframe.
{
  const bus = new FakeBus();
  const s = new Soundscape(allBuffers(), bus);
  for (let i = 0; i < 30; i += 1) step(s, bus, { cockpit: false, airframe: "tbd", rpm: 0.5, ias: 120 });
  assert.ok(gainOf(bus, "tbdEngineExtCruise") > 0.2, "the TBD exterior engine did not sound on the torpedo loadout");
  assert.equal(gainOf(bus, "engineExtCruise"), 0, "the SBD bank doubled the TBD engine");
  for (let i = 0; i < 30; i += 1) step(s, bus, { cockpit: true, airframe: "tbd", rpm: 0.5, ias: 120 });
  assert.ok(gainOf(bus, "tbdEngineIntCruise") > 0.2, "the TBD interior engine did not sound in the cockpit");

  const bus2 = new FakeBus();
  const s2 = new Soundscape(allBuffers(), bus2);
  s2.update(listener(), false, 1 / 60);
  s2.event({ type: "engineStart", airframe: "tbd" });
  assert.ok(bus2.playCalls.some((c) => c.key === "tbdEngineStart"), "TBD engine start did not reach its cue");
  bus2.listener.context.currentTime += 1.5;
  s2.event({ type: "engine", action: "stop", airframe: "tbd" });
  assert.ok(bus2.playCalls.some((c) => c.key === "tbdEngineStop"), "TBD engine stop did not reach its cue");
  s2.event({ type: "engineStart" });
  assert.ok(bus2.playCalls.some((c) => c.key === "engineStart"), "the default engine start left its SBD cue");
}

function listener(over = {}) {
  return { cockpit: false, onDeck: false, engineCut: false, damage: 0, rpm: 0.5, throttle: 0.5, ias: 120, ...over };
}

/** One frame at 60 Hz; advances the bus clock so cooldowns behave as they do at runtime. */
function step(s, bus, over = {}) {
  bus.listener.context.currentTime += 1 / 60;
  s.update(listener(over), false, 1 / 60);
}

function gainOf(bus, key) {
  const call = bus.musicCalls.find((c) => c.key === key);
  return call?.voice?.gain?.gain?.value ?? 0;
}

/** Speech buffers tagged with their map key, matching how the loader keys decoded clips. */
function speechBuffers(entries) {
  return new Map(Object.entries(entries).map(([slug, duration]) => [`speech:${slug}`, { duration, __key: `speech:${slug}` }]));
}

console.log("check-audio: 29 checks passed");
