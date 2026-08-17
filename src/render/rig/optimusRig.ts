import { clamp, clamp01 } from '../../core/math';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../game/constants';
import type { PlayerState } from '../../game/player';
import { palette } from '../palette';
import { OPTIMUS_ENHANCED as C } from './optimusColors';
import type { RigParts, RigRect, RigShape } from './types';

/**
 * Optimus' procedural skeletal rig (Enhanced path).
 *
 * Visual target: Tesla Optimus Gen 2 — pearl polymer panels, charcoal joint covers, black face
 * screen with soft status LEDs, slim humanoid proportions. Classic Canvas2D keeps using
 * `sprites.ts` + the industrial `palette` unchanged.
 *
 * This is the higher-density sibling of `sprites.ts`' `drawOptimus`: instead of issuing
 * `ctx.fillRect` calls directly, `buildOptimusRig` returns a flat list of world-space
 * {@link RigRect}s that Enhanced bakes into hand-drawn-style sprite sheets (and that
 * `drawRig.ts` can emit into a G-buffer).
 *
 * ## Why a pure function is enough for "blending" and "squash/stretch"
 *
 * `Player.setState` (see `game/player.ts`) resets `animationTime` to `0` on every state change.
 * That means "just entered this state" is already encoded in `animTime` alone, with no need to
 * remember the previous state on the renderer side (which would break the "simulation read-only
 * from render" contract by smuggling extra render-only state past frame boundaries):
 *
 * - **Blending**: every offset field below (`lean`, `legFrontX`, `headTilt`, …) is expressed
 *   relative to a neutral rest pose — i.e. their neutral value is `0`. Scaling the whole offset
 *   vector by a smoothstep of `animTime / TRANSITION_BLEND_SEC` therefore eases *into* the new
 *   state's characteristic pose instead of snapping to it, with no discontinuity in position.
 * - **Squash/stretch**: `transientStretchPulse` adds a short, exponentially-decaying wave on top
 *   of the steady-state `stretch` value, keyed off the same `animTime`. Landing (entering
 *   `idle`/`run`) dips negative first (a squash) before recovering; taking off (`jump`/`thrust`)
 *   pulses positive first (a stretch).
 *
 * Secondary motion (head lag, hip sway, arm lag) is layered on with slightly de-phased
 * sinusoids so those parts never move in perfect lockstep with the primary limbs.
 */

/** Rectangle placement is measured up from the feet (the origin), matching `sprites.ts`. */
/**
 * Enhanced on-screen scale vs the 10×22 collision box. Visual only — gameplay hitbox stays
 * `PLAYER_WIDTH`×`PLAYER_HEIGHT`. ~1.8× makes Tesla Optimus readable in the 480×270 world view.
 */
export const OPTIMUS_VISUAL_SCALE = 1.8;

const S = OPTIMUS_VISUAL_SCALE;
const HEAD_TOP = -24 * S;
const SHOULDER_Y = -17.5 * S;
const HIP_Y = -9.5 * S;
const LEG_BASE_X = 1.9 * S;
const ARM_BASE_X = 4.35 * S;

/**
 * How long a freshly-entered state takes to blend its offsets in from the neutral rest pose.
 * Slightly longer than a hard snap so Enhanced reads closer to Dead Cells' fluid pose changes
 * (see `docs/art-direction.md`) without feeling floaty.
 */
const TRANSITION_BLEND_SEC = 0.14;
/** How long the death collapse takes to fully fold, independent of `DEATH_TIME`'s respawn timer. */
const COLLAPSE_DURATION_SEC = 0.9;

export interface OptimusRigOptions {
  /** Screen-space top-left of the *collision box* (10×22) — identical contract to `drawOptimus`. */
  readonly x: number;
  readonly y: number;
  readonly facing: 1 | -1;
  readonly state: PlayerState;
  readonly animTime: number;
  readonly speedRatio: number;
  readonly energyRatio: number;
}

/** All continuous pose parameters, each expressed as an offset from the neutral rest pose. */
interface Pose {
  readonly bob: number;
  readonly lean: number;
  /** Multiplicative squash/stretch; 1 = neutral. */
  readonly stretch: number;
  readonly headTilt: number;
  readonly legFrontX: number;
  readonly legFrontY: number;
  readonly legBackX: number;
  readonly legBackY: number;
  readonly armFrontX: number;
  readonly armFrontY: number;
  readonly armBackX: number;
  readonly armBackY: number;
  /** Extra fore/aft offset of the lower leg relative to the thigh — reads as a bent knee. */
  readonly kneeFrontBend: number;
  readonly kneeBackBend: number;
  /** Extra fore/aft offset of the forearm relative to the upper arm — reads as a bent elbow. */
  readonly elbowFrontBend: number;
  readonly elbowBackBend: number;
  /** Secondary lateral sway of the hips, independent of the primary leg swing. */
  readonly hipSway: number;
  /** Secondary head lag (historically antenna sway); phase-shifted from `headTilt`. */
  readonly antennaSway: number;
  /** Torso counter-rotation, out of phase with the hips — reads as the chest twisting against the stride. */
  readonly torsoTwist: number;
}

const POSE_NEUTRAL: Pose = {
  bob: 0,
  lean: 0,
  stretch: 1,
  headTilt: 0,
  legFrontX: 0,
  legFrontY: 0,
  legBackX: 0,
  legBackY: 0,
  armFrontX: 0,
  armFrontY: 0,
  armBackX: 0,
  armBackY: 0,
  kneeFrontBend: 0,
  kneeBackBend: 0,
  elbowFrontBend: 0,
  elbowBackBend: 0,
  hipSway: 0,
  antennaSway: 0,
  torsoTwist: 0,
};

function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/** The steady-state pose for a state, as a pure function of how long it has been active. */
function rawPoseFor(state: PlayerState, animTime: number, speedRatio: number): Pose {
  switch (state) {
    case 'idle': {
      const breath = Math.sin(animTime * 2.2);
      return {
        ...POSE_NEUTRAL,
        bob: breath * 0.6,
        headTilt: breath * 0.3,
        hipSway: breath * 0.2,
        antennaSway: Math.sin(animTime * 2.2 + 0.6) * 0.8,
      };
    }
    case 'run': {
      const cadence = 12 + speedRatio * 6;
      const rawPhase = animTime * cadence;
      // Smooth sinusoid (Dead Cells HD-2D), not a chunky stepped cycle — Enhanced's linear-filtered
      // materials and soft lighting make stepped poses read as hitching rather than "pixel craft".
      const phase = rawPhase;
      const swing = Math.sin(phase);
      const lift = Math.abs(Math.cos(phase));
      // Arms lag the legs by a fixed phase offset instead of swinging in perfect anti-phase.
      const armSwing = Math.sin(phase - 0.35);
      return {
        ...POSE_NEUTRAL,
        bob: -lift * 1.2,
        lean: 1.2 + speedRatio,
        legFrontX: swing * 3,
        legFrontY: -Math.max(0, swing) * 2.5,
        legBackX: -swing * 3,
        legBackY: -Math.max(0, -swing) * 2.5,
        armFrontX: -armSwing * 2.4,
        armBackX: armSwing * 2.4,
        kneeFrontBend: Math.max(0, swing) * 1.4,
        kneeBackBend: Math.max(0, -swing) * 1.4,
        elbowFrontBend: -armSwing * 0.8,
        elbowBackBend: armSwing * 0.8,
        hipSway: Math.sin(phase * 0.5) * 0.6 * Math.min(1, speedRatio + 0.4),
        antennaSway: Math.sin(rawPhase * 0.5 + 0.8) * 0.6,
        headTilt: 0.4,
        // Chest counter-rotates against the hip/leg swing — the classic run "wring" that keeps
        // the shoulders reading as independent mass from the pelvis.
        torsoTwist: -swing * 0.9,
      };
    }
    case 'jump':
      return {
        ...POSE_NEUTRAL,
        lean: 0.8,
        legFrontX: 1.5,
        legFrontY: -2.5,
        legBackX: -1,
        legBackY: 0.5,
        armFrontX: 1,
        armFrontY: -3,
        armBackX: -1.5,
        armBackY: -2,
        stretch: 1.1,
        kneeFrontBend: -1,
        elbowBackBend: 1,
        antennaSway: -0.6,
      };
    case 'fall':
      return {
        ...POSE_NEUTRAL,
        lean: -0.4,
        legFrontX: 2.5,
        legFrontY: 0.5,
        legBackX: -2,
        legBackY: -0.5,
        armFrontX: 2,
        armFrontY: -1,
        armBackX: -2.5,
        armBackY: -2.5,
        stretch: 0.96,
        kneeFrontBend: 1.2,
        antennaSway: Math.sin(animTime * 8) * 0.5,
      };
    case 'thrust': {
      const flutter = Math.sin(animTime * 24) * 0.6;
      return {
        ...POSE_NEUTRAL,
        legFrontX: 1,
        legFrontY: 1 + flutter,
        legBackX: -1,
        legBackY: 1 - flutter,
        armFrontX: 2.5,
        armFrontY: -1,
        armBackX: -2.5,
        armBackY: -1,
        stretch: 1.06,
        headTilt: -0.5,
        hipSway: flutter * 0.4,
        antennaSway: Math.sin(animTime * 24 + 1) * 0.9,
      };
    }
    case 'dash':
      return {
        ...POSE_NEUTRAL,
        lean: 3,
        legFrontX: 3.5,
        legFrontY: 1,
        legBackX: -1.5,
        legBackY: 1.5,
        armFrontX: -3,
        armFrontY: 1,
        armBackX: -4.5,
        stretch: 0.9,
        headTilt: 1,
        kneeFrontBend: 1.5,
        antennaSway: -1.2,
      };
    case 'hurt': {
      const shudder = Math.sin(animTime * 40) * 1.2;
      return {
        ...POSE_NEUTRAL,
        lean: -2 + shudder,
        legFrontX: -2,
        legFrontY: 1,
        legBackX: 2,
        armFrontX: -3,
        armFrontY: -3,
        armBackX: 3,
        armBackY: -2,
        headTilt: -1.5,
        stretch: 0.94,
        antennaSway: shudder * 0.8,
      };
    }
    case 'dead': {
      const collapse = clamp01(animTime / COLLAPSE_DURATION_SEC);
      return {
        ...POSE_NEUTRAL,
        bob: collapse * 6,
        lean: -collapse * 3,
        legFrontX: -3 * collapse,
        legFrontY: 4 * collapse,
        legBackX: 3 * collapse,
        legBackY: 4 * collapse,
        armFrontX: -4 * collapse,
        armFrontY: 3 * collapse,
        armBackX: 4 * collapse,
        armBackY: 2 * collapse,
        stretch: 1 - collapse * 0.35,
        headTilt: -2 * collapse,
        // Hinged fold: knees and elbows bend progressively further as the body settles.
        kneeFrontBend: 3 * collapse,
        kneeBackBend: -2 * collapse,
        elbowFrontBend: 4 * collapse,
        elbowBackBend: -3 * collapse,
        antennaSway: -1.5 * collapse,
      };
    }
    case 'victory': {
      const cheer = Math.sin(animTime * 6);
      return {
        ...POSE_NEUTRAL,
        bob: -Math.abs(cheer) * 1.5,
        armFrontX: 1,
        armFrontY: -7 - cheer,
        armBackX: -1,
        armBackY: -7 + cheer,
        stretch: 1.04,
        hipSway: cheer * 0.3,
        antennaSway: cheer * 0.5,
      };
    }
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled player state in rig: ${String(exhaustive)}`);
    }
  }
}

/** Blends every offset field in from the neutral rest pose over `TRANSITION_BLEND_SEC`. */
function blendFromNeutral(raw: Pose, animTime: number): Pose {
  const t = smoothstep(animTime / TRANSITION_BLEND_SEC);
  if (t >= 1) return raw;
  return {
    bob: raw.bob * t,
    lean: raw.lean * t,
    stretch: 1 + (raw.stretch - 1) * t,
    headTilt: raw.headTilt * t,
    legFrontX: raw.legFrontX * t,
    legFrontY: raw.legFrontY * t,
    legBackX: raw.legBackX * t,
    legBackY: raw.legBackY * t,
    armFrontX: raw.armFrontX * t,
    armFrontY: raw.armFrontY * t,
    armBackX: raw.armBackX * t,
    armBackY: raw.armBackY * t,
    kneeFrontBend: raw.kneeFrontBend * t,
    kneeBackBend: raw.kneeBackBend * t,
    elbowFrontBend: raw.elbowFrontBend * t,
    elbowBackBend: raw.elbowBackBend * t,
    hipSway: raw.hipSway * t,
    antennaSway: raw.antennaSway * t,
    torsoTwist: raw.torsoTwist * t,
  };
}

/**
 * A short exponentially-decaying wave layered onto `stretch`, keyed off `animTime` alone.
 *
 * Landing (entering `idle`/`run`) dips negative first — a squash — before settling; taking off
 * (`jump`/`thrust`) pulses positive first — a stretch. Both decay to 0 within a few hundred ms so
 * they never fight the state's own steady-state `stretch` value for long.
 */
function transientStretchPulse(state: PlayerState, animTime: number): number {
  switch (state) {
    case 'jump':
      return Math.exp(-animTime * 14) * Math.sin(animTime * 46) * 0.22;
    case 'thrust':
      return Math.exp(-animTime * 12) * Math.sin(animTime * 40) * 0.16;
    case 'idle':
    case 'run':
      return -Math.exp(-animTime * 16) * Math.cos(animTime * 32) * 0.18;
    case 'dash':
      return -Math.exp(-animTime * 20) * 0.12;
    case 'fall':
    case 'hurt':
    case 'dead':
    case 'victory':
      return 0;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled player state in rig: ${String(exhaustive)}`);
    }
  }
}

/** Resolves the fully blended, transient-pulsed pose for one frame. Pure; never returns NaN. */
function resolvePose(state: PlayerState, animTime: number, speedRatio: number): Pose {
  const raw = rawPoseFor(state, animTime, clamp01(speedRatio));
  // The death collapse curve is itself already a function of elapsed time, so easing it in on
  // top would just slow the fold down twice; every other state benefits from the ease-in.
  const eased = state === 'dead' ? raw : blendFromNeutral(raw, animTime);
  const stretch = clamp(eased.stretch + transientStretchPulse(state, animTime), 0.55, 1.45);
  return { ...eased, stretch };
}

interface RectExtras {
  readonly emissive?: number;
  readonly roughness?: number;
  readonly metallic?: number;
  readonly alpha?: number;
  readonly shape?: RigShape;
}

/** Places one anatomy part in world space, applying the horizontal facing flip. */
function seg(
  originX: number,
  originY: number,
  facing: 1 | -1,
  localX: number,
  localY: number,
  width: number,
  height: number,
  color: string,
  extras: RectExtras = {},
): RigRect {
  const leftUnflipped = originX + localX * facing;
  const rightUnflipped = originX + (localX + width) * facing;
  const x = Math.min(leftUnflipped, rightUnflipped);
  const flippedWidth = Math.abs(rightUnflipped - leftUnflipped);
  return { x, y: originY + localY, width: flippedWidth, height, color, ...extras };
}

/** Compact ellipse helper — Tesla limbs read as polymer cylinders, not armour bricks. */
function oval(
  originX: number,
  originY: number,
  facing: 1 | -1,
  localX: number,
  localY: number,
  width: number,
  height: number,
  color: string,
  extras: RectExtras = {},
): RigRect {
  return seg(originX, originY, facing, localX, localY, width, height, color, { shape: 'ellipse', ...extras });
}

/**
 * Thigh → knee ring → shin → foot, hanging from the hip at local `x`.
 * Slim white polymer tubes with charcoal actuator rings (Tesla Gen 2 language).
 */
function legParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  x: number,
  hipY: number,
  kneeBend: number,
  thighColor: string,
): RigRect[] {
  const knee = hipY + 4.8 * S;
  const shinX = x - 0.9 * S + kneeBend * 0.55;
  const footX = x - 1.2 * S + kneeBend * 0.85;
  return [
    oval(originX, originY, facing, x - 1.15 * S, hipY - 0.6 * S, 2.3 * S, 1.55 * S, C.joint),
    oval(originX, originY, facing, x - 1.05 * S, hipY - 0.15 * S, 2.1 * S, 0.55 * S, C.metal),
    oval(originX, originY, facing, x - 1.25 * S, hipY, 2.5 * S, 2.55 * S, thighColor),
    oval(originX, originY, facing, x - 1.1 * S, hipY + 2.25 * S, 2.2 * S, 2.35 * S, thighColor),
    // Thigh highlight strip.
    oval(originX, originY, facing, x - 0.55 * S, hipY + 0.4 * S, 0.7 * S, 3.6 * S, C.panelLight),
    oval(originX, originY, facing, x - 1.05 * S + kneeBend * 0.25, knee - 0.65 * S, 2.1 * S, 1.45 * S, C.joint),
    oval(originX, originY, facing, x - 0.9 * S + kneeBend * 0.25, knee - 0.3 * S, 1.8 * S, 0.55 * S, C.metal),
    oval(originX, originY, facing, shinX, knee + 0.45 * S, 1.85 * S, 2.5 * S, C.panelShade),
    oval(originX, originY, facing, shinX + 0.05 * S, knee + 2.6 * S, 1.7 * S, 2.05 * S, C.panelShade),
    oval(originX, originY, facing, shinX + 0.45 * S, knee + 0.8 * S, 0.55 * S, 3.2 * S, C.panelLight),
    // Ankle ring + foot with toe toward facing (+X when facing right).
    oval(originX, originY, facing, shinX + 0.05 * S, knee + 4.35 * S, 1.65 * S, 0.7 * S, C.joint),
    oval(originX, originY, facing, footX, knee + 4.7 * S, 2.85 * S, 1.25 * S, C.joint),
    oval(originX, originY, facing, footX + 0.9 * S, knee + 4.85 * S, 1.55 * S, 0.85 * S, C.jointSoft),
    oval(originX, originY, facing, footX - 0.2 * S, knee + 5.55 * S, 3.15 * S, 0.75 * S, C.jointSoft),
  ];
}

/**
 * Upper arm → elbow ring → forearm → hand, hanging from the shoulder at local `x`.
 * Soft rounded pauldrons; black distal hand with finger nubs (Tesla glove).
 */
function armParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  x: number,
  shoulderY: number,
  elbowBend: number,
  color: string,
): RigRect[] {
  const forearmX = x - 0.75 * S + elbowBend * 0.55;
  const handX = x - 1.0 * S + elbowBend;
  return [
    oval(originX, originY, facing, x - 1.4 * S, shoulderY - 0.4 * S, 2.8 * S, 2.2 * S, C.panelShade),
    oval(originX, originY, facing, x - 1.15 * S, shoulderY + 0.1 * S, 2.3 * S, 1.1 * S, C.panelLight),
    oval(originX, originY, facing, x - 0.95 * S, shoulderY + 1.6 * S, 1.9 * S, 2.35 * S, color),
    oval(originX, originY, facing, x - 0.85 * S, shoulderY + 3.55 * S, 1.7 * S, 1.7 * S, color),
    oval(originX, originY, facing, x - 0.45 * S, shoulderY + 1.9 * S, 0.55 * S, 2.8 * S, C.panelLight),
    oval(originX, originY, facing, x - 0.95 * S + elbowBend * 0.25, shoulderY + 4.9 * S, 1.9 * S, 1.25 * S, C.joint),
    oval(originX, originY, facing, x - 0.75 * S + elbowBend * 0.25, shoulderY + 5.25 * S, 1.5 * S, 0.5 * S, C.metal),
    oval(originX, originY, facing, forearmX, shoulderY + 5.85 * S, 1.6 * S, 2.55 * S, C.panelShade),
    oval(originX, originY, facing, forearmX + 0.4 * S, shoulderY + 6.2 * S, 0.5 * S, 1.9 * S, C.panelLight),
    // Palm + three finger nubs — reads as a hand, not a mitten brick.
    oval(originX, originY, facing, handX, shoulderY + 8.15 * S, 2.25 * S, 1.7 * S, C.joint),
    oval(originX, originY, facing, handX - 0.15 * S, shoulderY + 9.55 * S, 0.7 * S, 0.85 * S, C.jointSoft),
    oval(originX, originY, facing, handX + 0.65 * S, shoulderY + 9.7 * S, 0.7 * S, 0.9 * S, C.jointSoft),
    oval(originX, originY, facing, handX + 1.45 * S, shoulderY + 9.55 * S, 0.7 * S, 0.85 * S, C.jointSoft),
  ];
}

function torsoParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  shoulderY: number,
  hipY: number,
  lean: number,
  torsoTwist: number,
  energyRatio: number,
): RigRect[] {
  // Slim humanoid chassis: rounded white chest, charcoal waist belt, soft shoulder slope.
  const torsoX = -3.7 * S + lean * 0.35 + torsoTwist * 0.25;
  const torsoH = hipY - shoulderY;
  const status = energyRatio > 0.25 ? C.status : palette.uiWarn;
  const waistY = shoulderY + torsoH * 0.62;
  return [
    oval(originX, originY, facing, torsoX - 0.95 * S, shoulderY - 0.4 * S, 9.8 * S, 1.9 * S, C.panelShade),
    oval(originX, originY, facing, torsoX, shoulderY + 0.25 * S, 7.9 * S, torsoH * 0.58, C.panel),
    oval(originX, originY, facing, torsoX + 0.4 * S, shoulderY + 0.5 * S, 7.1 * S, 1.15 * S, C.panelLight),
    // Soft flank shading — reads as curved polymer, not riveted armour plates.
    oval(originX, originY, facing, torsoX - 0.2 * S, shoulderY + 1.3 * S, 1.5 * S, torsoH * 0.45, C.panelShade),
    oval(originX, originY, facing, torsoX + 6.6 * S, shoulderY + 1.3 * S, 1.5 * S, torsoH * 0.45, C.panelShade),
    // Subtle chest panel seams.
    oval(originX, originY, facing, torsoX + 1.4 * S, shoulderY + torsoH * 0.28, 5.1 * S, 0.35 * S, C.panelShade),
    oval(originX, originY, facing, torsoX + 3.7 * S, shoulderY + 1.4 * S, 0.4 * S, torsoH * 0.35, C.panelShade),
    // Charcoal midriff / battery housing band (Tesla waist language).
    oval(originX, originY, facing, torsoX + 0.6 * S, waistY - 0.4 * S, 6.7 * S, torsoH * 0.44, C.joint),
    oval(originX, originY, facing, torsoX + 1.15 * S, waistY, 5.6 * S, 0.6 * S, C.metal),
    oval(originX, originY, facing, torsoX + 1.5 * S, waistY + 0.85 * S, 4.9 * S, 0.35 * S, C.jointSoft),
    // Chest status pip + small twin cooling vents.
    oval(originX, originY, facing, torsoX + 3.4 * S, shoulderY + 2.7 * S, 1.15 * S, 1.15 * S, C.jointSoft),
    oval(originX, originY, facing, torsoX + 3.55 * S, shoulderY + 2.85 * S, 0.85 * S, 0.85 * S, status, {
      emissive: 0.95,
    }),
    oval(originX, originY, facing, torsoX + 1.7 * S, shoulderY + 3.9 * S, 1.2 * S, 0.45 * S, C.jointSoft),
    oval(originX, originY, facing, torsoX + 5.0 * S, shoulderY + 3.9 * S, 1.2 * S, 0.45 * S, C.jointSoft),
  ];
}

/**
 * Smooth pearl dome + black face screen biased toward facing (+X when facing right).
 * Sheets bake facing-right; Enhanced mirrors UVs for left so eyes always look the way he moves.
 */
function headParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  headY: number,
  lean: number,
  headTilt: number,
  headLag: number,
  shoulderY: number,
  state: PlayerState,
): RigRect[] {
  const headX = -3.05 * S + lean * 0.7 + headTilt + headLag * 0.15;
  // Bias the face toward +X so left/right flips are obvious (not a flat front billboard).
  const faceBias = 0.85 * S;
  const faceLit = state !== 'dead';
  const parts: RigRect[] = [
    // Rear cranial mass (reads as back of head when mirrored).
    oval(originX, originY, facing, headX - 0.35 * S, headY + 0.6 * S, 2.4 * S, 4.0 * S, C.panelShade),
    // Soft cranial dome (stacked ovals ≈ rounded polymer shell).
    oval(originX, originY, facing, headX + 0.4 * S, headY - 0.65 * S, 5.9 * S, 2.45 * S, C.panelShade),
    oval(originX, originY, facing, headX, headY + 0.35 * S, 6.7 * S, 5.1 * S, C.panel),
    oval(originX, originY, facing, headX + 0.4 * S, headY + 0.55 * S, 5.9 * S, 1.25 * S, C.panelLight),
    // Side camera puck on the facing cheek.
    oval(originX, originY, facing, headX + 5.5 * S, headY + 1.8 * S, 1.15 * S, 1.15 * S, C.jointSoft),
    oval(originX, originY, facing, headX + 5.7 * S, headY + 2.0 * S, 0.7 * S, 0.7 * S, C.face),
    // Chin taper.
    oval(originX, originY, facing, headX + 0.85 * S, headY + 4.55 * S, 5.0 * S, 1.65 * S, C.panelShade),
    // Black face OLED panel — shifted toward facing direction.
    oval(originX, originY, facing, headX + 0.95 * S + faceBias, headY + 1.6 * S, 4.5 * S, 2.8 * S, C.face),
    seg(
      originX,
      originY,
      facing,
      headX + 1.15 * S + faceBias,
      headY + 1.85 * S,
      4.1 * S,
      2.3 * S,
      C.face,
      { shape: 'rect' },
    ),
  ];
  if (faceLit && state !== 'hurt') {
    // Twin teal status LEDs, also biased toward facing.
    const eyeY = headY + 2.4 * S;
    parts.push(
      oval(originX, originY, facing, headX + 1.55 * S + faceBias, eyeY, 1.05 * S, 0.95 * S, C.eye, {
        emissive: 0.95,
      }),
    );
    parts.push(
      oval(originX, originY, facing, headX + 3.55 * S + faceBias, eyeY, 1.05 * S, 0.95 * S, C.eye, {
        emissive: 0.95,
      }),
    );
    parts.push(
      oval(originX, originY, facing, headX + 1.75 * S + faceBias, eyeY + 0.2 * S, 0.55 * S, 0.5 * S, C.eyeHot, {
        emissive: 1,
      }),
    );
    parts.push(
      oval(originX, originY, facing, headX + 3.75 * S + faceBias, eyeY + 0.2 * S, 0.55 * S, 0.5 * S, C.eyeHot, {
        emissive: 1,
      }),
    );
  } else if (faceLit) {
    parts.push(
      oval(originX, originY, facing, headX + 1.8 * S + faceBias, headY + 2.55 * S, 2.9 * S, 0.6 * S, C.eye, {
        emissive: 0.55,
      }),
    );
  }
  // Slim neck column into the collar.
  parts.push(
    oval(
      originX,
      originY,
      facing,
      -1.15 * S,
      headY + 5.9 * S,
      2.3 * S,
      Math.max(0.45 * S, shoulderY - headY - 5.9 * S),
      C.jointSoft,
    ),
  );
  parts.push(oval(originX, originY, facing, -1.7 * S, shoulderY - 0.95 * S, 3.4 * S, 1.25 * S, C.joint));
  return parts;
}

function thrustFlameParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  animTime: number,
  energyRatio: number,
): RigRect[] {
  const flicker = 0.6 + Math.abs(Math.sin(animTime * 30)) * 0.4;
  const length = (5 + flicker * 5) * S * clamp(0.35 + energyRatio, 0.35, 1);
  return [
    oval(originX, originY, facing, -3.4 * S, 0, 6.8 * S, length * 0.85, palette.flame, {
      emissive: 0.85,
      alpha: 0.7,
    }),
    oval(originX, originY, facing, -2.5 * S, 0, 5.0 * S, length, palette.flame, { emissive: 1 }),
    oval(originX, originY, facing, -1.5 * S, 0, 3.0 * S, length * 0.7, palette.flameHot, { emissive: 1 }),
    oval(originX, originY, facing, -1.0 * S, 0, 2.0 * S, length * 1.25, palette.spark, { emissive: 1 }),
  ];
}

/**
 * Builds Optimus' full rig for one frame as a flat, painter's-algorithm-ordered list of
 * world-space parts (back-most first): thrust flame (if any), back leg/arm, torso, hips,
 * front leg/arm, head/neck.
 *
 * Pure and allocation-light: everything here is a function of `options` alone, so calling it
 * every frame for every visible actor never touches or needs to know about the simulation beyond
 * the read-only pose parameters it was handed.
 *
 * Facing: `facing` flips the silhouette in world space (and Enhanced sheets mirror UVs the same
 * way). He faces left or right from movement — not toward the camera.
 */
export function buildOptimusRig(options: OptimusRigOptions): RigParts {
  const { x, y, facing, state, animTime, speedRatio, energyRatio } = options;
  const pose = resolvePose(state, animTime, speedRatio);

  const originX = x + PLAYER_WIDTH / 2;
  const originY = y + PLAYER_HEIGHT;

  const hipY = HIP_Y * pose.stretch + pose.bob * S;
  const shoulderY = SHOULDER_Y * pose.stretch + pose.bob * S;
  const headY = HEAD_TOP * pose.stretch + pose.bob * S;

  const parts: RigRect[] = [];
  if (state === 'thrust') {
    parts.push(...thrustFlameParts(originX, originY, facing, animTime, energyRatio));
  }

  parts.push(
    ...legParts(
      originX,
      originY,
      facing,
      -LEG_BASE_X + pose.legBackX * S + pose.hipSway,
      hipY + pose.legBackY * S,
      pose.kneeBackBend * S,
      C.panelShade,
    ),
  );
  parts.push(
    ...armParts(
      originX,
      originY,
      facing,
      -ARM_BASE_X + pose.armBackX * S,
      shoulderY + pose.armBackY * S,
      pose.elbowBackBend * S,
      C.panelShade,
    ),
  );

  parts.push(...torsoParts(originX, originY, facing, shoulderY, hipY, pose.lean * S, pose.torsoTwist * S, energyRatio));
  // Pelvis hinge — charcoal belt sitting on the white thighs.
  parts.push(
    oval(originX, originY, facing, -2.85 * S + pose.lean * 0.25 + pose.hipSway, hipY - 0.95 * S, 5.7 * S, 1.9 * S, C.joint),
  );

  parts.push(
    ...legParts(
      originX,
      originY,
      facing,
      LEG_BASE_X + pose.legFrontX * S + pose.hipSway,
      hipY + pose.legFrontY * S,
      pose.kneeFrontBend * S,
      C.panel,
    ),
  );
  parts.push(
    ...armParts(
      originX,
      originY,
      facing,
      ARM_BASE_X + pose.armFrontX * S,
      shoulderY + pose.armFrontY * S,
      pose.elbowFrontBend * S,
      C.panel,
    ),
  );

  parts.push(
    ...headParts(
      originX,
      originY,
      facing,
      headY,
      pose.lean * S,
      pose.headTilt * S,
      pose.antennaSway * S,
      shoulderY,
      state,
    ),
  );

  return parts;
}
