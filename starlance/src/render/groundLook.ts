// Desert ground colour, all in world space so nothing repeats: broad patches of packed sand, loose
// pale sand and exposed red slab; mud-crack plates (dark crack lines, domed plates) near the camera
// that melt into larger polygons and then into plain patches with distance; dark pebbles in the
// loose sand. `luma` is the grain texture's brightness and only modulates the result.
import {
  cameraPosition,
  float,
  length,
  mix,
  mx_worley_noise_vec2,
  positionWorld,
  sin,
  smoothstep,
  vec2,
  vec3,
} from "three/tsl";
import { Color } from "three";
import type { Node } from "three/webgpu";

const rgb = (hex: number) => {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
};

/** Every control says which way to move it. */
export const GROUND = {
  packed: 0xb4603a,
  loose: 0xc98550,
  slab: 0x8a4630,
  ochre: 0xc07c44,
  pale: 0xd29a62,
  crack: 0x3c1a12,
  /** Metres per crack plate. Up: bigger plates. */
  plate: 1.0,
  /** Distance (m) where the fine plates start and finish fading into the big polygons. */
  plateFade: [35, 150] as const,
  /** Grain contrast: `luma` arrives as a deviation from the mean (about +-0.06). Up: rougher ground. */
  grain: 5,
  /** Crack line width in cell units (0.02 thin .. 0.12 thick). */
  crackWidth: 0.085,
};

export function desertGround(luma: Node<"float">): Node<"vec3"> {
  const p = positionWorld.xz;
  const dist = length(positionWorld.sub(cameraPosition));
  // Broad material patches (hundreds of metres) and finer drift (tens of metres).
  // Sums of slow sines, not Perlin: the noise primitive reads strongly biased this far from the origin.
  const x = p.x;
  const z = p.y;
  const big = sin(x.mul(0.013).add(z.mul(0.007)).add(1.3)).mul(0.5);
  const mid = sin(z.mul(0.021).sub(x.mul(0.011)).add(4.1))
    .mul(0.35)
    .add(sin(x.mul(0.043).add(z.mul(0.037))).mul(0.25));
  const n = big.add(mid);
  const slabMask = smoothstep(-0.06, -0.3, n);
  const looseMask = smoothstep(0.1, 0.8, n);
  let col = mix(rgb(GROUND.packed), rgb(GROUND.loose), looseMask);
  col = mix(col, rgb(GROUND.slab), slabMask);
  // Colour drift over tens of metres: red -> ochre -> pale, so no stretch of ground repeats a hue.
  const tone = sin(x.mul(0.061).add(z.mul(0.047)).add(0.8))
    .mul(0.5)
    .add(sin(z.mul(0.083).sub(x.mul(0.029))).mul(0.5));
  // Macro patches 200-500 m across on top of the tens-of-metres drift.
  const macro = sin(x.mul(0.0173).add(z.mul(0.0097)).add(0.4))
    .mul(0.5)
    .add(sin(z.mul(0.0139).sub(x.mul(0.0061)).add(2.2)).mul(0.5));
  col = mix(col, rgb(GROUND.ochre), smoothstep(0.1, 0.8, tone.add(macro.mul(0.8))).mul(0.6));
  col = mix(col, rgb(GROUND.pale), smoothstep(0.55, 1, tone.add(macro.mul(0.8)).mul(-1)).mul(0.3));
  // Dark wind-eroded patches inside every zone.
  const wind = smoothstep(
    0.3,
    0.85,
    sin(x.mul(0.11).add(z.mul(0.07)))
      .mul(sin(z.mul(0.093).sub(x.mul(0.05))))
      .add(0.25),
  );
  col = col.mul(float(1).sub(wind.mul(0.28)));
  col = col.mul(float(1).add(luma.mul(GROUND.grain)).max(0.45));

  // Mud-crack plates: Worley edges are the cracks, the distance to a plate's centre domes it.
  // Warp the cell lattice so the plates are irregular polygons, not a hexagon grid.
  const q = p.div(GROUND.plate);
  const warped = vec2(
    q.x.add(sin(q.y.mul(1.9).add(q.x.mul(0.7))).mul(0.28)),
    q.y.add(sin(q.x.mul(1.7).sub(q.y.mul(0.9)).add(2)).mul(0.28)),
  );
  const fine = mx_worley_noise_vec2(warped);
  const coarse = mx_worley_noise_vec2(p.div(GROUND.plate * 9).add(7));
  const fineEdge = fine.y.sub(fine.x);
  const coarseEdge = coarse.y.sub(coarse.x);
  const near = float(1).sub(smoothstep(GROUND.plateFade[0], GROUND.plateFade[1], dist));
  const crackAmount = float(1).sub(looseMask.mul(0.5)); // loose sand buries the cracks
  const fineCrack = float(1)
    .sub(smoothstep(0.03, GROUND.crackWidth, fineEdge))
    .mul(near)
    .mul(crackAmount);
  // Two more scales: 0.42 m crazing right under the ship and 3.3 m plates out to ~150 m.
  const tinyEdge = mx_worley_noise_vec2(p.div(0.42).add(3.3));
  const midEdge = mx_worley_noise_vec2(p.div(3.3).add(13));
  const tinyCrack = float(1)
    .sub(smoothstep(0.02, 0.07, tinyEdge.y.sub(tinyEdge.x)))
    .mul(float(1).sub(smoothstep(6, 28, dist)))
    .mul(crackAmount)
    .mul(0.75);
  const midCrack = float(1)
    .sub(smoothstep(0.012, 0.075, midEdge.y.sub(midEdge.x)))
    .mul(float(1).sub(smoothstep(30, 160, dist)))
    .mul(crackAmount)
    .mul(0.85);
  const coarseCrack = float(1)
    .sub(smoothstep(0.01, GROUND.crackWidth * 0.8, coarseEdge))
    .mul(0.3)
    .mul(crackAmount);
  const dome = float(1.12).sub(fine.x.mul(0.55)); // plate centres lighter, rims darker
  col = col.mul(mix(float(1), dome, near.mul(crackAmount)));
  const halo = float(1)
    .sub(smoothstep(0.03, GROUND.crackWidth * 3.2, fineEdge))
    .mul(near)
    .mul(crackAmount);
  col = mix(col, col.mul(0.6), halo.mul(0.7)); // a darker band along every crack: the crack interior reads lower
  col = mix(
    col,
    rgb(GROUND.crack),
    fineCrack.max(coarseCrack).max(tinyCrack).max(midCrack).mul(0.95),
  );

  // Pebbles: dark specks in the sand near the camera.
  const dots = mx_worley_noise_vec2(p.mul(3.7).add(11));
  const scatter = smoothstep(
    0.1,
    0.7,
    sin(x.mul(0.31))
      .mul(sin(z.mul(0.27)))
      .add(0.45),
  );
  const pebble = float(1)
    .sub(smoothstep(0.05, 0.15, dots.x))
    .mul(scatter)
    .mul(near)
    .mul(float(0.35).add(looseMask.mul(0.5)));
  col = mix(col, col.mul(vec3(0.45, 0.4, 0.38)), pebble);
  return col;
}
