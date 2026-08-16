/**
 * Skeletal hierarchy and pose evaluation.
 *
 * ## Why a rig rather than sprite frames
 *
 * The project's headline claim is fluid animation at high frame rates. A sprite
 * sheet cannot deliver that: it holds however many frames were drawn, and
 * showing them at 144 Hz just shows each one several times. A skeleton driven
 * by continuous curves is genuinely evaluated afresh every frame, so 144 Hz
 * produces 144 distinct poses per second.
 *
 * It also unlocks things sprite sheets structurally cannot do: feet that plant
 * on uneven ground via IK, cables that swing with real spring physics, a body
 * that leans into its own velocity, and impacts that compress the chassis by an
 * amount proportional to the force. All of that is secondary motion the eye
 * reads as weight, and it is the difference between a character that moves and
 * one that feels like a machine with mass.
 *
 * Bones store a local transform relative to their parent. Parents always
 * precede their children in the array, so a single forward pass resolves the
 * whole hierarchy to world space with no recursion.
 */

import type { Vec2 } from '../core/math/vec2.ts';

export interface BoneDefinition {
  name: string;
  /** Index of the parent bone, or -1 for the root. */
  parent: number;
  /** Rest position relative to the parent, in metres. */
  x: number;
  y: number;
  /** Rest rotation relative to the parent, in radians. */
  rotation: number;
  /** Length in metres. Used by IK and to place child bones. */
  length: number;
}

export interface BoneTransform {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/**
 * A complete set of local bone transforms.
 *
 * Stored as flat arrays rather than an array of objects: poses are blended,
 * copied, and interpolated many times per frame, and a struct-of-arrays layout
 * makes those operations tight loops over contiguous memory instead of chasing
 * pointers.
 */
export class Pose {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly rotation: Float32Array;
  readonly scaleX: Float32Array;
  readonly scaleY: Float32Array;

  constructor(readonly boneCount: number) {
    this.x = new Float32Array(boneCount);
    this.y = new Float32Array(boneCount);
    this.rotation = new Float32Array(boneCount);
    this.scaleX = new Float32Array(boneCount).fill(1);
    this.scaleY = new Float32Array(boneCount).fill(1);
  }

  copyFrom(other: Pose): void {
    this.x.set(other.x);
    this.y.set(other.y);
    this.rotation.set(other.rotation);
    this.scaleX.set(other.scaleX);
    this.scaleY.set(other.scaleY);
  }

  reset(): void {
    this.x.fill(0);
    this.y.fill(0);
    this.rotation.fill(0);
    this.scaleX.fill(1);
    this.scaleY.fill(1);
  }
}

/** World-space transform of every bone, rebuilt each frame. */
export class SkeletonPose {
  readonly worldX: Float32Array;
  readonly worldY: Float32Array;
  readonly worldRotation: Float32Array;
  readonly worldScaleX: Float32Array;
  readonly worldScaleY: Float32Array;

  constructor(readonly boneCount: number) {
    this.worldX = new Float32Array(boneCount);
    this.worldY = new Float32Array(boneCount);
    this.worldRotation = new Float32Array(boneCount);
    this.worldScaleX = new Float32Array(boneCount).fill(1);
    this.worldScaleY = new Float32Array(boneCount).fill(1);
  }
}

export class Skeleton {
  readonly bones: BoneDefinition[];
  readonly boneIndex = new Map<string, number>();
  /** The rest pose, used as the base every animation is expressed relative to. */
  readonly restPose: Pose;
  readonly world: SkeletonPose;

  constructor(bones: BoneDefinition[]) {
    this.bones = bones;

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]!;
      if (bone.parent >= i) {
        // A single forward pass only resolves correctly if parents come first.
        throw new Error(
          `Bone "${bone.name}" (index ${i}) references parent ${bone.parent}, ` +
            'which must come before it in the array.',
        );
      }
      this.boneIndex.set(bone.name, i);
    }

    this.restPose = new Pose(bones.length);
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]!;
      this.restPose.x[i] = bone.x;
      this.restPose.y[i] = bone.y;
      this.restPose.rotation[i] = bone.rotation;
    }

    this.world = new SkeletonPose(bones.length);
  }

  get boneCount(): number {
    return this.bones.length;
  }

  /** Looks up a bone index by name, throwing if it does not exist. */
  index(name: string): number {
    const index = this.boneIndex.get(name);
    if (index === undefined) {
      throw new Error(
        `Unknown bone "${name}". Available: ${[...this.boneIndex.keys()].join(', ')}`,
      );
    }
    return index;
  }

  /**
   * Resolves a local pose into world space.
   *
   * @param pose     Local transforms, already blended.
   * @param rootX    World position of the root, in metres.
   * @param rootY    World position of the root, in metres.
   * @param facing   +1 faces right, -1 faces left.
   * @param rootRotation Extra rotation on the whole character.
   */
  computeWorld(
    pose: Pose,
    rootX: number,
    rootY: number,
    facing: number,
    rootRotation = 0,
  ): void {
    const bones = this.bones;
    const world = this.world;

    for (let i = 0; i < bones.length; i++) {
      const parent = bones[i]!.parent;

      const localX = pose.x[i]!;
      const localY = pose.y[i]!;
      const localRotation = pose.rotation[i]!;

      if (parent < 0) {
        // Mirroring is applied once, at the root, via a negative X scale. Doing
        // it per-bone would require every clip to be authored twice.
        world.worldX[i] = rootX + localX * facing;
        world.worldY[i] = rootY + localY;
        world.worldRotation[i] = rootRotation + localRotation * facing;
        world.worldScaleX[i] = pose.scaleX[i]! * facing;
        world.worldScaleY[i] = pose.scaleY[i]!;
        continue;
      }

      const parentRotation = world.worldRotation[parent]!;
      const parentScaleX = world.worldScaleX[parent]!;
      const parentScaleY = world.worldScaleY[parent]!;
      const cos = Math.cos(parentRotation);
      const sin = Math.sin(parentRotation);

      const scaledX = localX * parentScaleX;
      const scaledY = localY * parentScaleY;

      world.worldX[i] = world.worldX[parent]! + scaledX * cos - scaledY * sin;
      world.worldY[i] = world.worldY[parent]! + scaledX * sin + scaledY * cos;
      // A negative parent scale mirrors the child's rotation as well as its
      // position, otherwise a mirrored character's limbs bend backwards.
      world.worldRotation[i] = parentRotation + localRotation * Math.sign(parentScaleX);
      world.worldScaleX[i] = parentScaleX * pose.scaleX[i]!;
      world.worldScaleY[i] = parentScaleY * pose.scaleY[i]!;
    }
  }

  /** World position of a bone's tip, following its length along its rotation. */
  tipOf(index: number, out: Vec2): Vec2 {
    const world = this.world;
    const length = this.bones[index]!.length;
    const rotation = world.worldRotation[index]!;
    out.x = world.worldX[index]! + Math.cos(rotation) * length * Math.abs(world.worldScaleX[index]!);
    out.y = world.worldY[index]! + Math.sin(rotation) * length * Math.abs(world.worldScaleX[index]!);
    return out;
  }
}
