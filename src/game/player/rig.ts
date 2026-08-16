/**
 * The Optimus skeleton and its sprite attachments.
 *
 * ## Coordinate convention
 *
 * The rig's origin sits **between the feet at ground level**, with -Y upward.
 * Anchoring at the feet rather than the hips means the character's world
 * position *is* its ground contact point, so placing it on a platform is exact
 * rather than an offset that has to be remembered everywhere.
 *
 * ## Bone orientation
 *
 * A bone's local +X axis runs along its length toward its child. A limb hanging
 * straight down therefore has a rest rotation of +PI/2. Limb *sprites* are
 * generated with the joint at the top of the image, so they are attached with a
 * -PI/2 rotation offset that cancels the bone's own orientation — which means a
 * limb sprite stays visually upright when the bone hangs down, and rotates
 * exactly with the bone from there.
 *
 * ## Near and far limbs
 *
 * A side view shows both arms and both legs. The far pair use separately
 * generated darker art rather than a runtime tint, so they also carry reduced
 * relief and recede properly instead of merely being dimmer.
 */

import { Skeleton, type BoneDefinition } from '../../anim/skeleton.ts';
import { OPTIMUS_DIMENSIONS as D } from '../../art/optimus.ts';

const HALF_PI = Math.PI / 2;

/**
 * Bone table.
 *
 * Parents must precede their children so the world transform resolves in a
 * single forward pass; the Skeleton constructor enforces this.
 */
export const OPTIMUS_BONES: BoneDefinition[] = [
  // --- Spine -------------------------------------------------------------
  // Positions are solved so the parts stack to exactly 1.73 m with no gaps.
  { name: 'root', parent: -1, x: 0, y: 0, rotation: 0, length: 0 },
  { name: 'hips', parent: 0, x: 0, y: -0.90, rotation: 0, length: D.pelvisHeight },
  { name: 'abdomen', parent: 1, x: 0, y: -0.10, rotation: 0, length: D.abdomenHeight },
  { name: 'chest', parent: 2, x: 0, y: -0.17, rotation: 0, length: D.chestHeight },
  { name: 'neck', parent: 3, x: 0.008, y: -0.26, rotation: 0, length: D.neckLength },
  { name: 'head', parent: 4, x: 0.004, y: -0.06, rotation: 0, length: D.headHeight },
  { name: 'backpack', parent: 3, x: -0.115, y: -0.06, rotation: 0, length: D.backpackHeight },

  // --- Far arm (index 7-10) ----------------------------------------------
  // Shoulders sit high and wide on the collar, which is what gives the
  // character its broad mechanical silhouette.
  { name: 'shoulderFar', parent: 3, x: -0.055, y: -0.215, rotation: 0, length: 0.10 },
  { name: 'upperArmFar', parent: 7, x: 0.004, y: 0.048, rotation: HALF_PI, length: D.upperArmLength },
  { name: 'forearmFar', parent: 8, x: D.upperArmLength, y: 0, rotation: 0, length: D.forearmLength },
  { name: 'handFar', parent: 9, x: D.forearmLength, y: 0, rotation: 0, length: D.handLength },

  // --- Near arm (index 11-14) --------------------------------------------
  { name: 'shoulderNear', parent: 3, x: 0.075, y: -0.215, rotation: 0, length: 0.10 },
  { name: 'upperArmNear', parent: 11, x: 0.004, y: 0.048, rotation: HALF_PI, length: D.upperArmLength },
  { name: 'forearmNear', parent: 12, x: D.upperArmLength, y: 0, rotation: 0, length: D.forearmLength },
  { name: 'handNear', parent: 13, x: D.forearmLength, y: 0, rotation: 0, length: D.handLength },

  // --- Far leg (index 15-17) ---------------------------------------------
  { name: 'thighFar', parent: 1, x: -0.048, y: 0.035, rotation: HALF_PI, length: D.thighLength },
  { name: 'shinFar', parent: 15, x: D.thighLength, y: 0, rotation: 0, length: D.shinLength },
  { name: 'footFar', parent: 16, x: D.shinLength, y: 0, rotation: -HALF_PI, length: D.footLength },

  // --- Near leg (index 18-20) --------------------------------------------
  { name: 'thighNear', parent: 1, x: 0.048, y: 0.035, rotation: HALF_PI, length: D.thighLength },
  { name: 'shinNear', parent: 18, x: D.thighLength, y: 0, rotation: 0, length: D.shinLength },
  { name: 'footNear', parent: 19, x: D.shinLength, y: 0, rotation: -HALF_PI, length: D.footLength },

  // --- Power cables (index 21-24) ----------------------------------------
  // Driven entirely by spring physics rather than by animation clips. Their
  // trailing motion is a large part of what sells the character's weight.
  { name: 'cableUpperA', parent: 6, x: -0.02, y: 0.06, rotation: HALF_PI, length: 0.11 },
  { name: 'cableLowerA', parent: 21, x: 0.11, y: 0, rotation: 0, length: 0.11 },
  { name: 'cableUpperB', parent: 6, x: 0.03, y: 0.09, rotation: HALF_PI, length: 0.09 },
  { name: 'cableLowerB', parent: 23, x: 0.09, y: 0, rotation: 0, length: 0.09 },
];

export interface Attachment {
  bone: string;
  sprite: string;
  /** Offset in the bone's local frame, in metres. */
  x: number;
  y: number;
  /** Extra rotation applied on top of the bone's world rotation. */
  rotation: number;
  /** Rendered size in metres. */
  width: number;
  height: number;
  /** Draw order within the character; lower draws first (further back). */
  order: number;
  /** Multiplied into the sprite's colour. */
  tint?: [number, number, number];
  emissive?: number;
}

/** Padding, in metres, that each generator added around its part. */
const PAD = {
  limb: 0.035,
  head: 0.03,
  torso: 0.04,
  small: 0.03,
  hand: 0.02,
  foot: 0.02,
  shoulder: 0.02,
};

/**
 * Builds a limb-segment attachment.
 *
 * Sits at the segment's midpoint, rotated by -PI/2 so the sprite (drawn with
 * its joint at the top) aligns with the bone (which points along +X).
 */
const limb = (
  bone: string,
  sprite: string,
  length: number,
  width: number,
  order: number,
): Attachment => ({
  bone,
  sprite,
  x: length / 2,
  y: 0,
  rotation: -HALF_PI,
  width: width + PAD.limb * 2,
  height: length + PAD.limb * 2,
  order,
});

/**
 * Sprite attachments.
 *
 * Order runs back to front: far leg, far arm, backpack and cables, torso,
 * head, near leg, near arm. Putting the near arm last means it silhouettes
 * over the chest, which is what gives the side view its sense of depth.
 */
export const OPTIMUS_ATTACHMENTS: Attachment[] = [
  // --- Far leg -----------------------------------------------------------
  limb('thighFar', 'optimus.thighFar', D.thighLength, D.thighWidth, 0),
  limb('shinFar', 'optimus.shinFar', D.shinLength, D.shinWidth, 1),
  {
    bone: 'footFar',
    sprite: 'optimus.footFar',
    // Offsets are in the bone's frame, which points forward along the foot.
    x: D.footLength * 0.34,
    y: -D.footHeight * 0.62,
    rotation: 0,
    width: D.footLength + PAD.foot * 2,
    height: D.footHeight * 2.0 + PAD.foot * 2,
    order: 2,
  },

  // --- Far arm -----------------------------------------------------------
  {
    bone: 'shoulderFar',
    sprite: 'optimus.shoulderFar',
    x: 0.01,
    y: 0.02,
    rotation: 0,
    width: 0.17 + PAD.shoulder * 2,
    height: 0.15 + PAD.shoulder * 2,
    order: 3,
  },
  limb('upperArmFar', 'optimus.upperArmFar', D.upperArmLength, D.upperArmWidth, 4),
  limb('forearmFar', 'optimus.forearmFar', D.forearmLength, D.forearmWidth, 5),
  {
    bone: 'handFar',
    sprite: 'optimus.handFar',
    x: D.handLength * 0.42,
    y: 0,
    rotation: -HALF_PI,
    width: D.handWidth * 1.6 + PAD.hand * 2,
    height: D.handLength + PAD.hand * 2,
    order: 6,
  },

  // --- Backpack and cables -----------------------------------------------
  {
    bone: 'backpack',
    sprite: 'optimus.backpack',
    x: 0,
    y: D.backpackHeight * 0.5 - 0.02,
    rotation: 0,
    width: D.backpackWidth + PAD.small * 2,
    height: D.backpackHeight + PAD.small * 2,
    order: 7,
  },

  // --- Torso -------------------------------------------------------------
  {
    bone: 'neck',
    sprite: 'optimus.neck',
    x: 0,
    y: 0,
    rotation: 0,
    width: D.neckWidth + 0.015 * 2,
    height: D.neckLength * 2.4 + 0.015 * 2,
    order: 9,
  },
  {
    bone: 'hips',
    sprite: 'optimus.pelvis',
    x: 0,
    y: 0.01,
    rotation: 0,
    width: D.pelvisWidth + PAD.small * 2,
    height: D.pelvisHeight + PAD.small * 2,
    order: 10,
  },
  {
    bone: 'abdomen',
    sprite: 'optimus.abdomen',
    x: 0,
    y: -D.abdomenHeight * 0.34,
    rotation: 0,
    width: D.abdomenWidth + PAD.small * 2,
    height: D.abdomenHeight + PAD.small * 2,
    order: 11,
  },
  {
    bone: 'chest',
    sprite: 'optimus.chest',
    x: 0.004,
    y: -D.chestHeight * 0.44,
    rotation: 0,
    width: D.chestWidth + PAD.torso * 2,
    height: D.chestHeight + PAD.torso * 2,
    order: 12,
  },
  {
    bone: 'head',
    sprite: 'optimus.head',
    x: 0,
    y: -D.headHeight * 0.46,
    rotation: 0,
    width: D.headWidth + PAD.head * 2,
    height: D.headHeight + PAD.head * 2,
    order: 13,
  },

  // --- Near leg ----------------------------------------------------------
  limb('thighNear', 'optimus.thigh', D.thighLength, D.thighWidth, 20),
  limb('shinNear', 'optimus.shin', D.shinLength, D.shinWidth, 21),
  {
    bone: 'footNear',
    sprite: 'optimus.foot',
    x: D.footLength * 0.34,
    y: -D.footHeight * 0.62,
    rotation: 0,
    width: D.footLength + PAD.foot * 2,
    height: D.footHeight * 2.0 + PAD.foot * 2,
    order: 22,
  },

  // --- Near arm ----------------------------------------------------------
  {
    bone: 'shoulderNear',
    sprite: 'optimus.shoulder',
    x: 0.01,
    y: 0.02,
    rotation: 0,
    width: 0.17 + PAD.shoulder * 2,
    height: 0.15 + PAD.shoulder * 2,
    order: 30,
  },
  limb('upperArmNear', 'optimus.upperArm', D.upperArmLength, D.upperArmWidth, 31),
  limb('forearmNear', 'optimus.forearm', D.forearmLength, D.forearmWidth, 32),
  {
    bone: 'handNear',
    sprite: 'optimus.hand',
    x: D.handLength * 0.42,
    y: 0,
    rotation: -HALF_PI,
    width: D.handWidth * 1.6 + PAD.hand * 2,
    height: D.handLength + PAD.hand * 2,
    order: 33,
  },
];

export function createOptimusSkeleton(): Skeleton {
  return new Skeleton(OPTIMUS_BONES);
}

/** Bone indices looked up once, so the hot path never does string lookups. */
export interface OptimusBoneIndices {
  root: number;
  hips: number;
  abdomen: number;
  chest: number;
  neck: number;
  head: number;
  backpack: number;
  shoulderFar: number;
  upperArmFar: number;
  forearmFar: number;
  handFar: number;
  shoulderNear: number;
  upperArmNear: number;
  forearmNear: number;
  handNear: number;
  thighFar: number;
  shinFar: number;
  footFar: number;
  thighNear: number;
  shinNear: number;
  footNear: number;
  cableUpperA: number;
  cableLowerA: number;
  cableUpperB: number;
  cableLowerB: number;
}

export function resolveBoneIndices(skeleton: Skeleton): OptimusBoneIndices {
  return {
    root: skeleton.index('root'),
    hips: skeleton.index('hips'),
    abdomen: skeleton.index('abdomen'),
    chest: skeleton.index('chest'),
    neck: skeleton.index('neck'),
    head: skeleton.index('head'),
    backpack: skeleton.index('backpack'),
    shoulderFar: skeleton.index('shoulderFar'),
    upperArmFar: skeleton.index('upperArmFar'),
    forearmFar: skeleton.index('forearmFar'),
    handFar: skeleton.index('handFar'),
    shoulderNear: skeleton.index('shoulderNear'),
    upperArmNear: skeleton.index('upperArmNear'),
    forearmNear: skeleton.index('forearmNear'),
    handNear: skeleton.index('handNear'),
    thighFar: skeleton.index('thighFar'),
    shinFar: skeleton.index('shinFar'),
    footFar: skeleton.index('footFar'),
    thighNear: skeleton.index('thighNear'),
    shinNear: skeleton.index('shinNear'),
    footNear: skeleton.index('footNear'),
    cableUpperA: skeleton.index('cableUpperA'),
    cableLowerA: skeleton.index('cableLowerA'),
    cableUpperB: skeleton.index('cableUpperB'),
    cableLowerB: skeleton.index('cableLowerB'),
  };
}
