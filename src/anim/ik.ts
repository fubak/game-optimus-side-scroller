/**
 * Inverse kinematics.
 *
 * Used mainly for foot placement. Without IK, a character walking across uneven
 * ground has feet that sink into slopes and hover over steps, and the illusion
 * of physical presence collapses immediately — the eye is extremely good at
 * spotting a foot that is not actually touching the floor.
 *
 * The two-bone solver is analytic rather than iterative: for a limb with a
 * fixed shoulder, a known target, and two segments of known length, the elbow
 * angle follows directly from the law of cosines. It is exact, cannot fail to
 * converge, and costs a handful of operations.
 */

import type { Vec2 } from '../core/math/vec2.ts';
import { clamp } from '../core/math/scalar.ts';

export interface TwoBoneResult {
  /** World-space rotation for the upper bone, in radians. */
  upperRotation: number;
  /** World-space rotation for the lower bone, in radians. */
  lowerRotation: number;
  /** True when the target was out of reach and the limb was left extended. */
  overReach: boolean;
}

/**
 * Solves a two-bone chain so its tip reaches `target`.
 *
 * @param bendPositive Which way the joint bends. A knee and an elbow bend in
 *   opposite directions, and getting this wrong is instantly, comically wrong.
 */
export function solveTwoBone(
  rootX: number,
  rootY: number,
  targetX: number,
  targetY: number,
  upperLength: number,
  lowerLength: number,
  bendPositive: boolean,
  out: TwoBoneResult,
): TwoBoneResult {
  const dx = targetX - rootX;
  const dy = targetY - rootY;
  let distance = Math.hypot(dx, dy);

  const maxReach = upperLength + lowerLength;
  const minReach = Math.abs(upperLength - lowerLength);

  out.overReach = distance > maxReach;

  // Clamping keeps the law-of-cosines arguments inside [-1, 1]. Without it an
  // unreachable target produces NaN and the limb vanishes.
  // A small epsilon short of full extension avoids a locked, rigid-looking
  // joint at maximum reach.
  distance = clamp(distance, minReach + 1e-4, maxReach - 1e-4);

  const targetAngle = Math.atan2(dy, dx);

  // Interior angle at the root, between the limb's baseline and the upper bone.
  const cosRoot =
    (upperLength * upperLength + distance * distance - lowerLength * lowerLength) /
    (2 * upperLength * distance);
  const rootAngle = Math.acos(clamp(cosRoot, -1, 1));

  // Interior angle at the joint itself.
  const cosJoint =
    (upperLength * upperLength + lowerLength * lowerLength - distance * distance) /
    (2 * upperLength * lowerLength);
  const jointAngle = Math.acos(clamp(cosJoint, -1, 1));

  const sign = bendPositive ? 1 : -1;
  out.upperRotation = targetAngle + rootAngle * sign;
  // The lower bone's rotation is the upper's plus the supplement of the joint
  // angle, mirrored by the bend direction.
  out.lowerRotation = out.upperRotation - (Math.PI - jointAngle) * sign;

  return out;
}

export const createTwoBoneResult = (): TwoBoneResult => ({
  upperRotation: 0,
  lowerRotation: 0,
  overReach: false,
});

/**
 * Aims a bone at a target, with an angular limit.
 *
 * Used for head look-at and for aiming the ranged weapon. The limit stops the
 * neck rotating past what a physical machine could manage, which matters a
 * great deal for a character whose whole read is "believable mechanism".
 */
export function aimAt(
  boneX: number,
  boneY: number,
  targetX: number,
  targetY: number,
  restRotation: number,
  maxDeviation: number,
): number {
  const desired = Math.atan2(targetY - boneY, targetX - boneX);
  let delta = desired - restRotation;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return restRotation + clamp(delta, -maxDeviation, maxDeviation);
}

/**
 * Positions a foot for the current ground contact.
 *
 * Two jobs beyond simply placing the foot at the ground height:
 *
 * - **Slope alignment.** The foot rotates to match the surface it stands on.
 *   A flat foot on a ramp is one of the most obvious tells of missing IK.
 * - **Step-over.** The target is raised by the swing phase, so the foot lifts
 *   and clears the ground rather than sliding through it.
 */
export function resolveFootTarget(
  desiredX: number,
  groundY: number,
  groundNormalX: number,
  groundNormalY: number,
  swingHeight: number,
  footOffset: number,
  out: Vec2,
): number {
  out.x = desiredX;
  out.y = groundY - footOffset - swingHeight;
  // The surface normal's angle, minus 90 degrees, is the surface's own slope.
  return Math.atan2(groundNormalY, groundNormalX) + Math.PI / 2;
}
