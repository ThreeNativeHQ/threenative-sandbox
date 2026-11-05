import { CatmullRomCurve3, MathUtils, Vector3 } from "three";

/** Path height over the ground (the ground plane is y = 0). */
export const COURSE_ALTITUDE = 12;
/** Section starts, metres along the course: dunes, canyon, open plain. */
export const SECTION = { dunes: 0, canyon: 1500, plain: 3200 } as const;
/** All-range arena radius around `Rail.arenaCenter`. */
export const ARENA_RADIUS = 300;

const UP = new Vector3(0, 1, 0);

export interface IRailFrame {
  readonly position: Vector3;
  readonly forward: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
}

export const railFrame = (): IRailFrame => ({
  position: new Vector3(),
  forward: new Vector3(),
  right: new Vector3(),
  up: new Vector3(),
});

/**
 * The course: a smooth curve heading -Z with gentle S-bends. `s` is metres travelled; the ship
 * flies as an offset in the frame at `s` (card rails-path-progress, fox_play.c:3466).
 */
export class Rail {
  readonly curve: CatmullRomCurve3;
  readonly length: number;
  readonly arenaCenter = new Vector3();
  s = 0;

  constructor() {
    const points: Vector3[] = [];
    for (let i = 0; i <= 24; i += 1) {
      const x = Math.sin(i * 0.55) * 45 + Math.sin(i * 0.21) * 30;
      const y = COURSE_ALTITUDE + Math.sin(i * 0.8) * 3;
      points.push(new Vector3(x, y, -i * 190));
    }
    this.curve = new CatmullRomCurve3(points, false, "centripetal");
    this.curve.arcLengthDivisions = 2000;
    this.length = this.curve.getLength();
    const end = this.frame(this.length, railFrame());
    this.arenaCenter.copy(end.position).addScaledVector(end.forward, ARENA_RADIUS);
  }

  /** Position and orthonormal basis at `s` metres (clamped to the course). */
  frame(s: number, out: IRailFrame): IRailFrame {
    const u = MathUtils.clamp(s / this.length, 0, 1);
    this.curve.getPointAt(u, out.position);
    this.curve.getTangentAt(u, out.forward);
    out.right.crossVectors(out.forward, UP).normalize();
    out.up.crossVectors(out.right, out.forward).normalize();
    return out;
  }

  get done(): boolean {
    return this.s >= this.length;
  }
}
