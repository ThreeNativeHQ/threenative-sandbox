/**
 * Measure a carrier's flight deck out of the shipped GLB, with no browser.
 *
 * `src/sim/battle.ts` needs three numbers per carrier that no class reference can supply: the deck
 * datum (the horizontal surface an aircraft's wheels sit on), and the launch/recovery corridor, a
 * rectangle centred on the ship's origin that an aircraft can actually roll down. Enterprise,
 * Hornet and Akagi were surveyed by raycasting their own decks in the running game
 * (tools/capture-deck.mjs), which is where their 220 x 20 m corridor came from. This does the same
 * survey for the imported hulls, in node, so a re-import can regenerate the table in seconds:
 *
 *   node tools/measure-decks.mjs                     # every imported carrier
 *   node tools/measure-decks.mjs assets/x.glb # one file
 *
 * Method, in order:
 *
 *  1. The deck plane is the elevation carrying the largest upward-facing triangle area. A flight
 *     deck is the biggest horizontal surface on a carrier by a wide margin, so this finds it
 *     without knowing anything about the ship, and it ignores the island roof, which is small.
 *  2. The profile is raycast down the centreline in 1 m steps, keeping only hits inside a band
 *     around that plane: a ray that lands on the island is not the deck, and neither is one that
 *     falls through to the hangar.
 *  3. The datum is the midpoint of the deck's own elevation range over the corridor, so a single
 *     static number sits centred in a deck that slopes rather than at one end of it, and the
 *     residual sheer is reported for the tolerance that a static datum can honestly hold.
 *  4. The corridor is the largest rectangle centred on the origin whose every 5 m station has
 *     unobstructed deck out to the half-width: walking outboard stops at the island, at a
 *     sponson step and at the deck edge alike, because an aircraft stops at all three.
 *
 * The keel is reported as measured: the imported hulls ship it at y = 0, and `src/render/world.ts`
 * sinks each one by its class draught so the waterline, not the keel, meets the sea.
 */
import { readdir } from "node:fs/promises";
import { Box3, Raycaster, Vector3 } from "three";
import { loadGlb } from "./check-humanoid.mjs";

/** Rays inside this much of the deck plane are the deck; beyond it they are island or hangar. */
const BAND = 3;
/** Centreline step for the profile, and station step for the corridor, in metres. */
const PROFILE_STEP = 1;
const STATION_STEP = 5;
/**
 * Half the narrowest rectangle still worth calling a corridor. A TBD-1 spans 15.24 m, so at 14 m a
 * wingtip already overhangs the corridor it is lined up in; a station with less deck than this ends
 * the corridor rather than narrowing it, and one with more only sets how wide the corridor can be.
 */
const MIN_HALF = 7;
/** A triangle this close to horizontal is deck rather than hull side or funnel. */
const FLAT = Math.cos((20 * Math.PI) / 180);

const DOWN = new Vector3(0, -1, 0);

/** The elevation carrying the most upward-facing triangle area, and that area, in 0.25 m bins. */
function deckPlane(root) {
  const bins = new Map();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const n = new Vector3();
  root.traverse((node) => {
    const geometry = node.isMesh ? node.geometry : null;
    if (!geometry?.attributes?.position) return;
    const position = geometry.attributes.position;
    const index = geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      const [i0, i1, i2] = index
        ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
        : [i, i + 1, i + 2];
      a.fromBufferAttribute(position, i0).applyMatrix4(node.matrixWorld);
      b.fromBufferAttribute(position, i1).applyMatrix4(node.matrixWorld);
      c.fromBufferAttribute(position, i2).applyMatrix4(node.matrixWorld);
      n.copy(ab.subVectors(b, a)).cross(ac.subVectors(c, a));
      const area = n.length() / 2;
      if (area <= 0) continue;
      n.divideScalar(area * 2);
      if (n.y < FLAT) continue;
      // Projected onto the horizontal, so a slightly tilted deck panel counts as the deck it is.
      const bin = Math.round(((a.y + b.y + c.y) / 3) * 4) / 4;
      bins.set(bin, (bins.get(bin) ?? 0) + area * n.y);
    }
  });
  let plane = null;
  let best = 0;
  for (const [y, area] of bins) if (area > best) [plane, best] = [y, area];
  return { plane, area: best };
}

export function measureDeck(root) {
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  const { plane, area } = deckPlane(root);
  if (plane === null) throw new Error("no upward-facing triangles: this is not a ship");
  const ceiling = box.max.y + 20;
  const rays = (x, z) => new Raycaster(new Vector3(x, ceiling, z), DOWN).intersectObject(root, true);

  /**
   * One square metre of deck: its elevation, and whether anything stands on it. The elevation is the
   * topmost surface inside the band around the deck plane whatever is above it, so the deck under an
   * island still measures as deck — that is the plan a bomb meets. `blocked` is the separate
   * question an aircraft asks, and the two answers differ on exactly the hulls this run reports.
   */
  const sample = (x, z) => {
    const hits = rays(x, z);
    const hit = hits.find((h) => Math.abs(h.point.y - plane) <= BAND);
    return { y: hit ? hit.point.y : null, blocked: hits.length > 0 && hits[0].point.y > plane + BAND };
  };

  /**
   * One athwartships station: the deck's own elevation there, how far out the deck reaches each side,
   * and how far out it is unobstructed. Taken across the whole beam rather than from a centreline ray,
   * because two of these imported islands stand over the centreline and a single ray there reports
   * the island roof or nothing at all.
   */
  const stationAt = (z) => {
    const reach = Math.ceil(box.max.x) + 1;
    const row = [];
    for (let x = -reach; x <= reach; x += PROFILE_STEP) row.push({ x, ...sample(x, z) });
    const ys = row.filter((c) => c.y !== null).map((c) => c.y).sort((a, b) => a - b);
    if (ys.length < 4) return { z, y: null, port: 0, starboard: 0, clearPort: 0, clearStarboard: 0 };
    const median = ys[Math.floor(ys.length / 2)];
    const deck = row.filter((c) => c.y !== null && Math.abs(c.y - median) <= 1);
    const side = (sign) => {
      const own = deck.filter((c) => Math.sign(c.x) === sign || c.x === 0);
      const edge = own.length ? Math.max(...own.map((c) => Math.abs(c.x))) : 0;
      // Unobstructed reach: outward from the centreline to the first square with something on it.
      let clear = 0;
      for (let x = 0; Math.abs(x) <= edge; x += sign * PROFILE_STEP) {
        const cell = row.find((c) => c.x === x);
        if (!cell || cell.blocked || cell.y === null || Math.abs(cell.y - median) > 1) break;
        clear = Math.abs(x);
      }
      return { edge, clear };
    };
    const port = side(-1);
    const starboard = side(1);
    return {
      z,
      y: +median.toFixed(3),
      port: port.edge,
      starboard: starboard.edge,
      clearPort: port.clear,
      clearStarboard: starboard.clear,
    };
  };

  // The corridor runs from amidships out to the last station on both sides that still has deck at
  // least MIN_HALF metres each side of the centreline, and is then as wide as the narrowest of those
  // stations. Length first, because a deck run is what a launch actually needs; the width follows
  // from the deck the run crosses. It is symmetric because `onDeck` measures it from the ship's centre.
  const stations = [];
  for (let z = 0; z <= box.max.z; z += STATION_STEP) stations.push(stationAt(z));
  for (let z = -STATION_STEP; z >= box.min.z; z -= STATION_STEP) stations.unshift(stationAt(z));
  const wide = (s) => s.y !== null && Math.min(s.port, s.starboard) >= MIN_HALF;
  const mid = stations.findIndex((s) => s.z === 0);
  if (!wide(stations[mid])) throw new Error(`no flight deck amidships: ${JSON.stringify(stations[mid])}`);
  let first = mid;
  let last = mid;
  while (first > 0 && wide(stations[first - 1])) first -= 1;
  while (last < stations.length - 1 && wide(stations[last + 1])) last += 1;
  const run = stations.slice(first, last + 1);
  const half = Math.min(Math.abs(run[0].z), Math.abs(run[run.length - 1].z));
  const inside = run.filter((s) => Math.abs(s.z) <= half);

  const low = Math.min(...inside.map((s) => s.y));
  const high = Math.max(...inside.map((s) => s.y));
  const halfWidth = Math.min(...inside.map((s) => Math.min(s.port, s.starboard)));
  const clearHalf = Math.min(...inside.map((s) => Math.min(s.clearPort, s.clearStarboard)));
  let plan = 0;
  for (const s of inside) plan = Math.max(plan, s.port, s.starboard);
  return {
    keel: +box.min.y.toFixed(3),
    deckPlane: plane,
    deckArea: Math.round(area),
    datum: +((low + high) / 2).toFixed(3),
    sheer: +(high - low).toFixed(3),
    low: +low.toFixed(3),
    high: +high.toFixed(3),
    runFrom: run[0].z,
    runTo: run[run.length - 1].z,
    corridorLength: 2 * half,
    corridorWidth: +(2 * halfWidth).toFixed(1),
    clearWidth: +(2 * clearHalf).toFixed(1),
    deckPlanBeam: +(2 * plan).toFixed(1),
    length: +(box.max.z - box.min.z).toFixed(2),
    beam: +(box.max.x - box.min.x).toFixed(2),
    corridorFrom: -half,
    corridorTo: half,
    stations,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/tools)/, ""))) {
  const dir = new URL("../assets/", import.meta.url);
  const files = process.argv.length > 2
    ? process.argv.slice(2)
    : (await readdir(dir))
        .filter((f) => f.startsWith("carrier.") && f.endsWith(".glb"))
        .map((f) => new URL(f, dir).pathname);
  for (const file of files) {
    const gltf = await loadGlb(file);
    const m = measureDeck(gltf.scene);
    console.log(`\n######## ${file}`);
    console.log(
      `keel ${m.keel} | deck plane ${m.deckPlane} (${m.deckArea} m² flat) | datum ${m.datum} ` +
        `(${m.low}..${m.high}, sheer ${m.sheer}) | hull ${m.length} x ${m.beam}`,
    );
    console.log(
      `deck run z ${m.runFrom}..${m.runTo} | corridor ${m.corridorLength} x ${m.corridorWidth} ` +
        `| unobstructed width ${m.clearWidth} | drawn deck plan beam ${m.deckPlanBeam}`,
    );
    console.log(
      m.stations
        .map((s) =>
          s.y === null
            ? `${s.z}:nodeck`
            : `${s.z <= m.corridorTo && s.z >= m.corridorFrom ? "*" : ""}${s.z}:${s.y.toFixed(2)}/${s.port}|${s.starboard}${
                s.clearPort < s.port || s.clearStarboard < s.starboard
                  ? ` (clear ${s.clearPort}|${s.clearStarboard})`
                  : ""
              }`,
        )
        .join("  "),
    );
  }
}
