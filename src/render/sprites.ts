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
 * Draw Optimus.
 *
 * The sprite is a little wider than the 10×22 collision box (robots have shoulders), drawn around
 * the box centre so the visual never desyncs from the physics.
 */
export function drawOptimus(ctx: CanvasRenderingContext2D, options: OptimusRenderOptions): void {
  const { x, y, facing, state, animTime, speedRatio, energyRatio } = options;
  const pose = poseFor(state, animTime, clamp(speedRatio, 0, 1));

  ctx.save();
  ctx.translate(Math.round(x + PLAYER_WIDTH / 2), Math.round(y + PLAYER_HEIGHT));
  ctx.scale(facing, 1);
  // Origin is now the feet, at the horizontal centre of the body, facing right.
  const stretch = pose.stretch;
  const bob = pose.bob;
  const lean = pose.lean;

  if (state === 'thrust') {
    drawThrustFlame(ctx, animTime, energyRatio);
  }

  const hipY = -9 * stretch + bob;
  const shoulderY = -18 * stretch + bob;

  // Back limbs first so the front ones overlap them.
  drawLeg(ctx, pose.legBack[0], hipY + pose.legBack[1], bob, palette.shellDark);
  drawArm(ctx, pose.armBack[0] - 1, shoulderY + pose.armBack[1], palette.shellDark);

  // Torso: a bevelled shell with a chest light that tracks the energy meter.
  const torsoX = -4 + lean * 0.4;
  const torsoY = shoulderY;
  const torsoH = 10 * stretch;
  fill(ctx, torsoX, torsoY, 8, torsoH, palette.shell);
  fill(ctx, torsoX, torsoY, 8, 1, palette.shellLight);
  fill(ctx, torsoX + 6, torsoY + 1, 2, torsoH - 1, palette.shellDark);
  fill(ctx, torsoX + 1, torsoY + torsoH - 1, 6, 1, palette.joint);
  const coreColor = energyRatio > 0.25 ? palette.energy : palette.uiWarn;
  fill(ctx, torsoX + 2, torsoY + 3, 3, 2, coreColor);

  // Waist joint.
  fill(ctx, -3 + lean * 0.3, hipY - 1, 6, 2, palette.joint);

  // Front limbs.
  drawLeg(ctx, pose.legFront[0], hipY + pose.legFront[1], bob, palette.shell);
  drawArm(ctx, pose.armFront[0] + 1, shoulderY + pose.armFront[1], palette.shell);

  // Head: helmet with a glowing visor band.
  const headX = -3.5 + lean * 0.8 + pose.headTilt;
  const headY = torsoY - 7;
  fill(ctx, headX, headY, 7, 6, palette.shellLight);
  fill(ctx, headX, headY, 7, 1, palette.white);
  fill(ctx, headX + 5, headY + 1, 2, 5, palette.shellDark);
  fill(ctx, headX + 1, headY + 2, 5, 2, palette.joint);
  const visorLit = state !== 'dead';
  fill(ctx, headX + 1.5, headY + 2.5, 4, 1, visorLit ? palette.visor : palette.plateDark);
  if (visorLit && state !== 'hurt') {
    fill(ctx, headX + 4, headY + 2.5, 1, 1, palette.visorGlow);
  }
  // Antenna nub.
  fill(ctx, headX + 3, headY - 1, 1, 1, palette.joint);

  ctx.restore();
}

function drawLeg(ctx: CanvasRenderingContext2D, dx: number, y: number, bob: number, color: string): void {
  // Thigh, shin, foot: three chunky segments, offset by the pose.
  fill(ctx, dx - 1.5, y, 3, 5, color);
  fill(ctx, dx - 1.5 + Math.sign(dx) * 0.5, y + 5, 3, 4 - bob * 0.2, palette.shellDark);
  fill(ctx, dx - 2 + Math.sign(dx) * 0.5, y + 9 - bob * 0.2, 4, 1, palette.joint);
}

function drawArm(ctx: CanvasRenderingContext2D, dx: number, y: number, color: string): void {
  fill(ctx, dx + 3, y + 1, 2, 5, color);
  fill(ctx, dx + 3, y + 6, 2, 4, palette.shellDark);
  fill(ctx, dx + 2.5, y + 10, 3, 2, palette.joint);
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
