import { GroundSnap, normaliseToMetres } from "@threenative/core";
import type { Object3D } from "three";

export interface IMinimalConventions {
  readonly applyGrounding: (surfaceY: number, dt: number) => void;
  readonly groundSnap: GroundSnap;
  readonly normaliseFactor: number;
}

export function preparePlayerConventions(model: Object3D): IMinimalConventions {
  // A skinned figure is measured from its origin to its crown joint, and on this Unreal-style
  // skeleton that is `Head` — the base of the skull, not its top. 1.545 m at that joint puts the
  // top of the head at 1.8 m, the height the capsule in `Player.ts` is built for.
  const normaliseFactor = normaliseToMetres(model, { axis: "height", metres: 1.545 });
  const groundSnap = new GroundSnap(model, { enabled: false });
  return {
    applyGrounding: (surfaceY, dt) => groundSnap.apply(model, surfaceY, dt),
    groundSnap,
    normaliseFactor,
  };
}
