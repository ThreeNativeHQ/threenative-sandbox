/** SBD main-gear geometry shared with the imported Douglas (src/render/imported-aircraft.ts). */
import * as T from "three";
import { box, cylinder, mat, rod } from "./assets.js";

/** SBD main-gear geometry, as drawn under the imported Douglas. */
export function createDauntlessGear(under: T.Material = mat(0xb7beb9)) {
  const rubber = mat(0x192129, { roughness: 0.94, metalness: 0 });
  const steel = mat(0x84939b, { metalness: 0.85, roughness: 0.26 });
  const darkSteel = mat(0x26333c, { metalness: 0.7, roughness: 0.35 });
  const staticParts = new T.Group();
  const gear = new T.Group();
  gear.name = "Gear assembly";
  const gearLegs: any[] = [];
  for (const sign of [-1, 1]) {
    const leg = new T.Group();
    leg.name = "Gear leg";
    leg.position.set(sign * 1.51, -0.3, -0.65);
    rod(leg, [0, 0, 0], [0, -1.22, 0], 0.064, steel);
    rod(leg, [sign * 0.1, -0.1, 0.04], [sign * 0.16, -1.2, -0.06], 0.034, darkSteel);
    const braces = [
      rod(leg, [sign * 0.1, -0.45, 0], [sign * 0.36, -0.95, 0], 0.034, steel),
      rod(leg, [sign * 0.36, -0.95, 0], [sign * 0.12, -1.22, 0], 0.034, steel),
    ];
    const wheel = cylinder(leg, 0.35, 0.35, 0.22, sign * 0.1, -1.19, 0, rubber, 28);
    wheel.name = "Gear wheel";
    wheel.geometry.rotateZ(Math.PI / 2);
    wheel.rotation.set(0, 0, 0);
    const axle = cylinder(leg, 0.14, 0.14, 0.24, sign * 0.1, -1.19, 0, steel, 20);
    axle.rotation.z = Math.PI / 2;
    box(leg, 0.26, 0.62, 0.07, sign * 0.03, -0.54, -0.1, under);
    gear.add(leg);
    gearLegs.push({ group: leg, wheel, sign, braces });
    const well = new T.Mesh(new T.CircleGeometry(0.39, 24), rubber);
    well.rotation.x = Math.PI / 2;
    well.position.set(sign * 0.81, -0.47, -0.63);
    staticParts.add(well);
  }
  const tail = new T.Group();
  rod(tail, [0, -0.29, 4.19], [0, -0.52, 4.39], 0.043, steel);
  const tailwheel = cylinder(tail, 0.17, 0.17, 0.12, 0, -0.55, 4.45, rubber, 16);
  tailwheel.geometry.rotateZ(Math.PI / 2);
  tailwheel.rotation.set(0, 0, 0);

  gear.add(staticParts, tail);
  return { gear, gearLegs, tail };
}
