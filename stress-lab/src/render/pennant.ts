// Generated for you. This is ordinary Three.js geometry — edit or delete it freely.
import { BufferGeometry, Float32BufferAttribute, Vector2, Vector3 } from "three";

const DIVISIONS = 8;

/** Preserve an authored triangle's silhouette and UVs while giving cloth enough vertices to bend. */
export function tessellatePennant(source: BufferGeometry): BufferGeometry {
  const position = source.getAttribute("position");
  const uv = source.getAttribute("uv");
  if (position === undefined || position.count !== 3)
    throw new Error("Starter pennant must be one authored triangle.");
  if (uv === undefined || uv.count !== 3) throw new Error("Starter pennant must have three UVs.");
  const corners = [0, 1, 2].map(
    (index) => new Vector3(position.getX(index), position.getY(index), position.getZ(index)),
  );
  const texels = [0, 1, 2].map((index) => new Vector2(uv.getX(index), uv.getY(index)));
  const positions: number[] = [];
  const uvs: number[] = [];
  const emit = (row: number, column: number): void => {
    const alongB = row / DIVISIONS;
    const alongC = column / DIVISIONS;
    const alongA = 1 - alongB - alongC;
    const a = corners[0] as Vector3;
    const b = corners[1] as Vector3;
    const c = corners[2] as Vector3;
    const uvA = texels[0] as Vector2;
    const uvB = texels[1] as Vector2;
    const uvC = texels[2] as Vector2;
    positions.push(
      a.x * alongA + b.x * alongB + c.x * alongC,
      a.y * alongA + b.y * alongB + c.y * alongC,
      a.z * alongA + b.z * alongB + c.z * alongC,
    );
    uvs.push(
      uvA.x * alongA + uvB.x * alongB + uvC.x * alongC,
      uvA.y * alongA + uvB.y * alongB + uvC.y * alongC,
    );
  };
  for (let row = 0; row < DIVISIONS; row += 1) {
    for (let column = 0; column < DIVISIONS - row; column += 1) {
      emit(row, column);
      emit(row + 1, column);
      emit(row, column + 1);
      if (row + column >= DIVISIONS - 1) continue;
      emit(row + 1, column);
      emit(row + 1, column + 1);
      emit(row, column + 1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  return geometry;
}
