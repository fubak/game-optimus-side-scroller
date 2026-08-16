import { clamp } from '../core/math';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../game/constants';
import type { PlayerState } from '../game/player';
import { palette } from './palette';

/**
 * Procedural sprite drawing.
 *
 * There are no image assets in this project: Optimus and friends are assembled from rectangles
 * every frame. At a 480×270 internal resolution that is cheap, it keeps the repo text-only, and it
 * makes animation a matter of maths rather than sprite sheets — the pose is a pure function of
 * `(state, animTime, facing)`, which keeps rendering deterministic for screenshot tests.
 */

export interface OptimusRenderOptions {
  /** Screen-space top-left of the *collision box* (10×22). */
  readonly x: number;
  readonly y: number;
  readonly facing: 1 | -1;
  readonly state: PlayerState;
  readonly animTime: number;
  readonly speedRatio: number;
  readonly energyRatio: number;
  /** Hide/flash the sprite while invulnerable. */
  readonly flash?: boolean;
}

function fill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}

interface Pose {
  /** Vertical bob applied to the whole body. */
  readonly bob: number;
  /** Forward lean in pixels. */
  readonly lean: number;
  /** Front/back leg offsets: [x, y] each. */
  readonly legFront: readonly [number, number];
  readonly legBack: readonly [number, number];
  /** Arm offsets: [x, y] each. */
  readonly armFront: readonly [number, number];
  readonly armBack: readonly [number, number];
  /** Squash factor (1 = neutral, <1 = squashed, >1 = stretched). */
  readonly stretch: number;
  readonly headTilt: number;
}

const NEUTRAL: Pose = {
  bob: 0,
  lean: 0,
  legFront: [0, 0],
  legBack: [0, 0],
  armFront: [0, 0],
  armBack: [0, 0],
  stretch: 1,
  headTilt: 0,
};

function poseFor(state: PlayerState, animTime: number, speedRatio: number): Pose {
  switch (state) {
    case 'idle': {
      // Slow servo hum: a 1 px breathing bob with the head barely drifting.
      const breath = Math.sin(animTime * 2.2);
      return { ...NEUTRAL, bob: breath * 0.6, headTilt: breath * 0.3 };
    }
    case 'run': {
      const cadence = 12 + speedRatio * 6;
      const phase = animTime * cadence;
      const swing = Math.sin(phase);
      const lift = Math.abs(Math.cos(phase));
      return {
        bob: -lift * 1.2,
        lean: 1.2 + speedRatio,
        legFront: [swing * 3, -Math.max(0, swing) * 2.5],
        legBack: [-swing * 3, -Math.max(0, -swing) * 2.5],
        armFront: [-swing * 2.4, 0],
        armBack: [swing * 2.4, 0],
        stretch: 1,
        headTilt: 0.4,
      };
    }
    case 'jump':
      return {
        ...NEUTRAL,
        lean: 0.8,
        legFront: [1.5, -2.5],
        legBack: [-1, 0.5],
        armFront: [1, -3],
        armBack: [-1.5, -2],
        stretch: 1.1,
      };
    case 'fall':
      return {
        ...NEUTRAL,
        lean: -0.4,
        legFront: [2.5, 0.5],
        legBack: [-2, -0.5],
        armFront: [2, -1],
        armBack: [-2.5, -2.5],
        stretch: 0.96,
      };
    case 'thrust': {
      const flutter = Math.sin(animTime * 24) * 0.6;
      return {
        ...NEUTRAL,
        legFront: [1, 1 + flutter],
        legBack: [-1, 1 - flutter],
        armFront: [2.5, -1],
        armBack: [-2.5, -1],
        stretch: 1.06,
        headTilt: -0.5,
      };
    }
    case 'dash':
      return {
        ...NEUTRAL,
        lean: 3,
        legFront: [3.5, 1],
        legBack: [-1.5, 1.5],
        armFront: [-3, 1],
        armBack: [-4.5, 0],
        stretch: 0.9,
        headTilt: 1,
      };
    case 'hurt': {
      const shudder = Math.sin(animTime * 40) * 1.2;
      return {
        ...NEUTRAL,
        lean: -2 + shudder,
        legFront: [-2, 1],
        legBack: [2, 0],
        armFront: [-3, -3],
        armBack: [3, -2],
        headTilt: -1.5,
        stretch: 0.94,
      };
    }
    case 'dead': {
      const collapse = clamp(animTime * 3, 0, 1);
      return {
        ...NEUTRAL,
        bob: collapse * 6,
        lean: -collapse * 3,
        legFront: [-3 * collapse, 4 * collapse],
        legBack: [3 * collapse, 4 * collapse],
        armFront: [-4 * collapse, 3 * collapse],
        armBack: [4 * collapse, 2 * collapse],
        stretch: 1 - collapse * 0.35,
        headTilt: -2 * collapse,
      };
    }
    case 'victory': {
      const cheer = Math.sin(animTime * 6);
      return {
        ...NEUTRAL,
        bob: -Math.abs(cheer) * 1.5,
        armFront: [1, -7 - cheer],
        armBack: [-1, -7 + cheer],
        stretch: 1.04,
      };
    }
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled player state in renderer: ${String(exhaustive)}`);
    }
  }
}

/**
 * Anatomy, in pixels measured up from the feet (the sprite is ~24 px tall and ~12 px wide, a little
 * roomier than the 10×22 collision box because robots have shoulders and boots).
 *
 * ```
 *  -24 ┬ head (7×6, visor band)
 *  -18 ┼ shoulders (11 wide) / torso (9×8, chest core)
 *  -10 ┼ hips (7×2)
 *   -9 ┼ thighs → shins → boots
 *    0 ┴ ground
 * ```
 */
const HEAD_TOP = -24;
const SHOULDER_Y = -18;
const HIP_Y = -10;
const LEG_BASE_X = 2;
const ARM_BASE_X = 5;

/**
 * Draw Optimus.
 *
 * Everything is positioned around the collision box centre so the visual can never desync from the
 * physics, and `facing` is applied as a horizontal flip so only the right-facing pose is authored.
 */
export function drawOptimus(ctx: CanvasRenderingContext2D, options: OptimusRenderOptions): void {
  const { x, y, facing, state, animTime, speedRatio, energyRatio } = options;
  const pose = poseFor(state, animTime, clamp(speedRatio, 0, 1));

  ctx.save();
  ctx.translate(Math.round(x + PLAYER_WIDTH / 2), Math.round(y + PLAYER_HEIGHT));
  ctx.scale(facing, 1);
  // Origin is now the feet, at the horizontal centre of the body, facing right.
  const { stretch, bob, lean } = pose;

  if (state === 'thrust') {
    drawThrustFlame(ctx, animTime, energyRatio);
  }

  const hipY = HIP_Y * stretch + bob;
  const shoulderY = SHOULDER_Y * stretch + bob;
  const headY = HEAD_TOP * stretch + bob;

  // Back-side limbs first so the front ones overlap them.
  drawLeg(ctx, -LEG_BASE_X + pose.legBack[0], hipY + pose.legBack[1], palette.shellDark, palette.joint);
  drawArm(ctx, -ARM_BASE_X + pose.armBack[0], shoulderY + pose.armBack[1], palette.shellDark);

  // Torso: bevelled shell, shoulder yoke, and a chest core that tracks the energy meter.
  const torsoX = -4.5 + lean * 0.4;
  const torsoH = hipY - shoulderY;
  fill(ctx, torsoX - 1, shoulderY, 11, 2, palette.shellDark);
  fill(ctx, torsoX, shoulderY, 9, torsoH, palette.shell);
  fill(ctx, torsoX, shoulderY, 9, 1, palette.shellLight);
  fill(ctx, torsoX + 7, shoulderY + 1, 2, torsoH - 1, palette.shellDark);
  const coreColor = energyRatio > 0.25 ? palette.energy : palette.uiWarn;
  fill(ctx, torsoX + 3, shoulderY + 3, 3, 3, palette.joint);
  fill(ctx, torsoX + 3.5, shoulderY + 3.5, 2, 2, coreColor);

  // Hip block.
  fill(ctx, -3.5 + lean * 0.3, hipY - 1, 7, 2, palette.joint);

  // Front-side limbs.
  drawLeg(ctx, LEG_BASE_X + pose.legFront[0], hipY + pose.legFront[1], palette.shell, palette.joint);
  drawArm(ctx, ARM_BASE_X + pose.armFront[0], shoulderY + pose.armFront[1], palette.shell);

  // Head: helmet with a glowing visor band.
  const headX = -3.5 + lean * 0.8 + pose.headTilt;
  fill(ctx, headX + 3, headY - 1, 1, 1, palette.joint); // antenna nub
  fill(ctx, headX, headY, 7, 6, palette.shellLight);
  fill(ctx, headX, headY, 7, 1, palette.white);
  fill(ctx, headX + 5, headY + 1, 2, 5, palette.shellDark);
  fill(ctx, headX + 1, headY + 2, 6, 2, palette.joint);
  const visorLit = state !== 'dead';
  fill(ctx, headX + 1, headY + 2, 5, 1, visorLit ? palette.visor : palette.plateDark);
  if (visorLit && state !== 'hurt') {
    fill(ctx, headX + 4, headY + 2, 2, 1, palette.visorGlow);
  }
  // Neck.
  fill(ctx, -1.5, headY + 6, 3, Math.max(0, shoulderY - headY - 6), palette.joint);

  ctx.restore();
}

/** Thigh → shin → boot, hanging from the hip at `x`. */
function drawLeg(
  ctx: CanvasRenderingContext2D,
  x: number,
  hipY: number,
  color: string,
  jointColor: string,
): void {
  const knee = hipY + 5;
  fill(ctx, x - 1.5, hipY, 3, 5, color);
  fill(ctx, x - 1.5, knee, 3, 4, palette.shellDark);
  // Boots stay 3 px wide so a neutral stance still reads as two feet, not one block.
  fill(ctx, x - 1.5, knee + 4, 3, 2, jointColor);
}

/** Upper arm → forearm → hand, hanging from the shoulder at `x`. */
function drawArm(ctx: CanvasRenderingContext2D, x: number, shoulderY: number, color: string): void {
  fill(ctx, x - 1, shoulderY + 1, 2, 4, color);
  fill(ctx, x - 1, shoulderY + 5, 2, 3, palette.shellDark);
  fill(ctx, x - 1.5, shoulderY + 8, 3, 2, palette.joint);
}

function drawThrustFlame(ctx: CanvasRenderingContext2D, animTime: number, energyRatio: number): void {
  const flicker = 0.6 + Math.abs(Math.sin(animTime * 30)) * 0.4;
  const length = (5 + flicker * 5) * clamp(0.35 + energyRatio, 0.35, 1);
  fill(ctx, -3, 0, 6, length, palette.flame);
  fill(ctx, -2, 0, 4, length * 0.6, palette.flameHot);
  fill(ctx, -1, 0, 2, length * 1.2, palette.spark);
}

/** Ghost trail drawn behind a dashing Optimus. */
export function drawDashGhost(
  ctx: CanvasRenderingContext2D,
  options: OptimusRenderOptions,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.globalCompositeOperation = 'lighter';
  drawOptimus(ctx, options);
  ctx.restore();
}
