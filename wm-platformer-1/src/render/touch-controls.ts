import {
  CircleGeometry,
  type ColorRepresentation,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  RingGeometry,
  Vector2,
} from "three";
import { C, palette } from "./palette.js";
import {
  BUTTON_RADIUS,
  type ITouchInput,
  type ITouchPointer,
  type ITouchViewport,
  MOVE_RADIUS,
  touchControlPoint,
} from "./touch-layout.js";

/** Flat overlay material: drawn over the scene, never occluded by it. */
function overlayMaterial(color: ColorRepresentation, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    opacity,
    transparent: true,
  });
}

/** Controls live on a flat plane, so z is always 0. */
function place(mesh: Mesh, x: number, y: number): void {
  mesh.position.set(x, y, 0);
}

/** The 5px-thick outline every control shares. */
function ringMesh(radius: number, material: MeshBasicMaterial): Mesh {
  return new Mesh(new RingGeometry(radius - 5, radius, 32), material);
}

export class TouchControls {
  readonly root = new Group();
  readonly object = this.root;
  #camera: PerspectiveCamera;
  #input: { dashPressed: boolean; jumpPressed: boolean; move: Vector2 } = {
    dashPressed: false,
    jumpPressed: false,
    move: new Vector2(),
  };
  #wasDash = false;
  #wasJump = false;
  /** Where the current thumb landed. Undefined between touches. */
  #moveAnchor = new Vector2();
  #hasMoveAnchor = false;
  #jumpCenter = new Vector2();
  #dashCenter = new Vector2();
  #resting = new Vector2();
  #lastWidth = -1;
  #lastHeight = -1;
  #moveBase: Mesh;
  #moveKnob: Mesh;
  #dash: Mesh;
  #jump: Mesh;
  #idleMaterial: MeshBasicMaterial;
  #activeMaterial: MeshBasicMaterial;

  constructor(camera: PerspectiveCamera) {
    this.#camera = camera;
    // Ink, not white: this route is bright sky, bright grass and pale stone almost everywhere a
    // thumb lands, and a white control at low opacity has nothing to contrast against. A dark ring
    // reads on light art and on dark art alike, and the gold fill says which one is pressed.
    this.#idleMaterial = overlayMaterial(C.ink, 0.3);
    this.#activeMaterial = overlayMaterial(palette.accent, 0.58);
    this.#moveBase = ringMesh(MOVE_RADIUS, this.#idleMaterial);
    this.#moveKnob = new Mesh(new CircleGeometry(28, 24), this.#activeMaterial);
    this.#dash = ringMesh(BUTTON_RADIUS, this.#idleMaterial);
    this.#jump = ringMesh(BUTTON_RADIUS, this.#idleMaterial);
    this.root.add(this.#moveBase, this.#moveKnob, this.#dash, this.#jump);
    this.root.renderOrder = 10_001;
    camera.add(this.root);
  }

  update(pointers: ReadonlyMap<number, ITouchPointer>, size: ITouchViewport): ITouchInput {
    this.#ensureLayout(size);
    const jump = this.#at(pointers, this.#jumpCenter, BUTTON_RADIUS);
    const dash = this.#at(pointers, this.#dashCenter, BUTTON_RADIUS);
    let left: ITouchPointer | undefined;
    for (const pointer of pointers.values()) {
      if (this.#isMovementPointer(pointer, size)) {
        left = pointer;
        break;
      }
    }
    const move = this.#input.move;
    if (left === undefined) {
      // Thumb lifted: forget where it was, so the next touch anchors fresh.
      this.#hasMoveAnchor = false;
      move.set(0, 0);
    } else {
      if (!this.#hasMoveAnchor) {
        this.#moveAnchor.copy(left.position);
        this.#hasMoveAnchor = true;
      }
      move.set(
        MathUtils.clamp((left.position.x - this.#moveAnchor.x) / MOVE_RADIUS, -1, 1),
        MathUtils.clamp((this.#moveAnchor.y - left.position.y) / MOVE_RADIUS, -1, 1),
      );
    }
    // The ring follows the thumb to its anchor, so the player can see where the stick went
    // instead of watching a knob move against a circle their thumb is nowhere near.
    const center = this.#hasMoveAnchor ? this.#moveAnchor : this.#resting;
    place(this.#moveKnob, center.x + move.x * MOVE_RADIUS, center.y - move.y * MOVE_RADIUS);
    this.#jump.material = jump ? this.#activeMaterial : this.#idleMaterial;
    this.#dash.material = dash ? this.#activeMaterial : this.#idleMaterial;
    this.#input.dashPressed = dash && !this.#wasDash;
    this.#input.jumpPressed = jump && !this.#wasJump;
    this.#wasDash = dash;
    this.#wasJump = jump;
    this.#layout(size);
    return this.#input;
  }

  debug(): Record<string, unknown> {
    return { dash: this.#wasDash, jump: this.#wasJump, move: this.#input.move.toArray() };
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const child of this.root.children) {
      if (child instanceof Mesh) child.geometry.dispose();
    }
    this.#idleMaterial.dispose();
    this.#activeMaterial.dispose();
  }

  #ensureLayout(size: ITouchViewport): void {
    if (size.width === this.#lastWidth && size.height === this.#lastHeight) return;
    this.#lastWidth = size.width;
    this.#lastHeight = size.height;
    this.#resting.copy(touchControlPoint(size, "move"));
    this.#dashCenter.copy(touchControlPoint(size, "dash"));
    this.#jumpCenter.copy(touchControlPoint(size, "jump"));
  }

  #layout(size: ITouchViewport): void {
    const worldHeight = 2 * Math.tan(MathUtils.degToRad(this.#camera.fov / 2));
    const pixels = worldHeight / Math.max(1, size.height);
    const worldWidth = size.width * pixels;
    this.root.position.set(-worldWidth / 2, worldHeight / 2, -1);
    this.root.scale.set(pixels, -pixels, 1);
    // The anchor wins while a thumb is down; this only re-homes the ring once it lifts.
    const move = this.#hasMoveAnchor ? this.#moveAnchor : this.#resting;
    place(this.#moveBase, move.x, move.y);
    place(this.#dash, this.#dashCenter.x, this.#dashCenter.y);
    place(this.#jump, this.#jumpCenter.x, this.#jumpCenter.y);
  }

  #isMovementPointer(pointer: ITouchPointer, size: ITouchViewport): boolean {
    if (pointer.position.x >= size.width * 0.5 || pointer.position.y <= size.height * 0.5)
      return false;
    if (size.height <= size.width) return true;
    const radiusSquared = BUTTON_RADIUS * BUTTON_RADIUS;
    return (
      pointer.position.distanceToSquared(this.#dashCenter) > radiusSquared &&
      pointer.position.distanceToSquared(this.#jumpCenter) > radiusSquared
    );
  }

  #at(pointers: ReadonlyMap<number, ITouchPointer>, center: Vector2, radius: number): boolean {
    const radiusSquared = radius * radius;
    for (const pointer of pointers.values()) {
      if (pointer.position.distanceToSquared(center) <= radiusSquared) return true;
    }
    return false;
  }
}
