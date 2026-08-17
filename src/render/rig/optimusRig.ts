import { clamp, clamp01 } from '../../core/math';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../game/constants';
import type { PlayerState } from '../../game/player';
import { palette } from '../palette';
import type { RigParts, RigRect } from './types';

/**
 * Optimus' procedural skeletal rig.
 *
 * This is the higher-density sibling of `sprites.ts`' `drawOptimus`: instead of issuing
 * `ctx.fillRect` calls directly, `buildOptimusRig` returns a flat list of world-space
 * {@link RigRect}s (torso, head, two-segment arms/legs, boots, …) that any backend can consume —
 * a Canvas2D `Surface`, or the WebGL2 `GBufferBatch` (see `drawRig.ts`). Classic keeps using
 * `drawOptimus` unchanged; only the GL path draws Optimus through this rig.
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
 * Secondary motion (antenna sway, hip sway, arm lag) is layered on with slightly de-phased
 * sinusoids so those parts never move in perfect lockstep with the primary limbs.
 */

/** Rectangle placement is measured up from the feet (the origin), matching `sprites.ts`. */
const HEAD_TOP = -24;
const SHOULDER_Y = -18;
const HIP_Y = -10;
const LEG_BASE_X = 2;
const ARM_BASE_X = 5;

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
  /** Secondary motion on the antenna, phase-shifted from `headTilt` so it visibly lags/whips. */
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
}

/** Places one anatomy rectangle in world space, applying the horizontal facing flip. */
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

/** Thigh → shin → boot, hanging from the hip at local `x`. */
function legParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  x: number,
  hipY: number,
  kneeBend: number,
  thighColor: string,
  bootColor: string,
): RigRect[] {
  const knee = hipY + 5;
  const shinX = x - 1.35 + kneeBend * 0.6;
  const shinTipX = x - 1.15 + kneeBend * 0.85;
  const bootX = x - 1.5 + kneeBend;
  return [
    // Hip ball joint — separates pelvis from thigh so the silhouette hinges cleanly.
    seg(originX, originY, facing, x - 1.1, hipY - 0.5, 2.2, 1.2, palette.joint),
    // Softened thigh: three-step taper (wide hip → mid plate → narrow toward knee).
    seg(originX, originY, facing, x - 1.7, hipY, 3.4, 2.2, thighColor),
    seg(originX, originY, facing, x - 1.5, hipY + 2, 3, 1.8, thighColor),
    seg(originX, originY, facing, x - 1.3, hipY + 3.6, 2.6, 1.4, thighColor),
    // Thigh bevel + vertical panel line so the limb reads as stamped plate, not a box.
    seg(originX, originY, facing, x - 1.7, hipY, 3.4, 0.9, palette.shellLight),
    seg(originX, originY, facing, x - 0.15, hipY + 0.8, 0.9, 3.2, palette.plateShadow),
    // Knee cap: a distinct plate so the joint reads even when bend is near zero.
    seg(originX, originY, facing, x - 1.45 + kneeBend * 0.3, knee - 0.8, 2.9, 1.3, palette.shellDark),
    // Shin: tapered (wider at knee, narrower at ankle) + panel seam.
    seg(originX, originY, facing, shinX, knee, 2.7, 2.2, palette.shellDark),
    seg(originX, originY, facing, shinTipX, knee + 2, 2.3, 2, palette.shellDark),
    seg(originX, originY, facing, shinX + 0.85, knee + 0.6, 0.9, 2.8, palette.plateShadow),
    // Boot: toe flare + sole tread for a grounded silhouette.
    seg(originX, originY, facing, bootX, knee + 4, 3.2, 1.8, bootColor),
    seg(originX, originY, facing, bootX - 0.35, knee + 5.6, 3.7, 1.1, palette.joint),
  ];
}

/** Upper arm → forearm → hand, hanging from the shoulder at local `x`. */
function armParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  x: number,
  shoulderY: number,
  elbowBend: number,
  color: string,
): RigRect[] {
  const forearmX = x - 0.95 + elbowBend * 0.6;
  const handX = x - 1.45 + elbowBend;
  return [
    // Pauldron: outer cap + inner bevel so the shoulder reads as armour, not a stump.
    seg(originX, originY, facing, x - 1.45, shoulderY - 0.2, 2.9, 2.1, palette.shellDark),
    seg(originX, originY, facing, x - 1.2, shoulderY, 2.4, 0.9, palette.shellLight),
    // Upper arm: slight taper toward the elbow.
    seg(originX, originY, facing, x - 1.05, shoulderY + 1.6, 2.1, 2.2, color),
    seg(originX, originY, facing, x - 0.9, shoulderY + 3.5, 1.8, 1.6, color),
    seg(originX, originY, facing, x - 1.05, shoulderY + 1.6, 2.1, 0.8, palette.shellLight),
    // Forearm + panel line, offset by elbow bend.
    seg(originX, originY, facing, forearmX, shoulderY + 5.1, 1.9, 2.8, palette.shellDark),
    seg(originX, originY, facing, forearmX + 0.5, shoulderY + 5.5, 0.8, 2, palette.plateShadow),
    // Gauntlet / hand block — wider than the forearm for a readable fist silhouette.
    seg(originX, originY, facing, handX, shoulderY + 7.8, 2.9, 2.1, palette.joint),
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
  // Softened chassis: shoulders wider than hips, stacked chest → abdomen plates.
  const torsoX = -4.3 + lean * 0.4 + torsoTwist * 0.3;
  const torsoH = hipY - shoulderY;
  const coreColor = energyRatio > 0.25 ? palette.energy : palette.uiWarn;
  const seamY1 = shoulderY + torsoH * 0.28;
  const seamY2 = shoulderY + torsoH * 0.52;
  const seamY3 = shoulderY + torsoH * 0.76;
  const hipInset = 0.55;
  return [
    // Shoulder shelf / collar bevel — wider than the chest for a hero silhouette.
    seg(originX, originY, facing, torsoX - 1.35, shoulderY - 0.6, 11.7, 2.1, palette.shellDark),
    seg(originX, originY, facing, torsoX - 0.5, shoulderY - 0.1, 10, 1, palette.shellLight),
    // Main chest plate (upper) and tapered abdomen (lower).
    seg(originX, originY, facing, torsoX, shoulderY, 9, torsoH * 0.54, palette.shell),
    seg(
      originX,
      originY,
      facing,
      torsoX + hipInset,
      shoulderY + torsoH * 0.5,
      9 - hipInset * 2,
      torsoH * 0.5,
      palette.shell,
    ),
    // Top bevel highlight across the collarbone.
    seg(originX, originY, facing, torsoX + 0.5, shoulderY, 8, 1, palette.shellLight),
    // Left/right flank plates — matching pair so the chassis reads as riveted segments.
    seg(originX, originY, facing, torsoX - 1.05 + torsoTwist * 0.1, shoulderY + 1, 2.1, torsoH - 1.5, palette.shellDark),
    seg(originX, originY, facing, torsoX + 7.15, shoulderY + 1, 2.1, torsoH - 1.5, palette.shellDark),
    // Flank bevel strips (inner edge of each side plate).
    seg(originX, originY, facing, torsoX + 0.55, shoulderY + 1.5, 1, torsoH - 2.5, palette.plateShadow),
    seg(originX, originY, facing, torsoX + 6.45, shoulderY + 1.5, 1, torsoH - 2.5, palette.plateShadow),
    // Chest / mid / abdomen horizontal panel seams.
    seg(originX, originY, facing, torsoX + 1.2, seamY1, 6.6, 1, palette.plateShadow),
    seg(originX, originY, facing, torsoX + 1.2, seamY2, 6.6, 1, palette.plateShadow),
    seg(originX, originY, facing, torsoX + 1.55, seamY3, 5.9, 1, palette.plateShadow),
    // Vertical sternum panel line splitting left/right chest plates.
    seg(originX, originY, facing, torsoX + 4, shoulderY + 1.5, 1, torsoH * 0.7, palette.plateShadow),
    // Core well + nested energy cell (cell → hot pupil) for Dead Cells bloom punch.
    seg(originX, originY, facing, torsoX + 2.55, shoulderY + 2.55, 3.9, 3.9, palette.joint),
    seg(originX, originY, facing, torsoX + 3.05, shoulderY + 3.05, 2.9, 2.9, coreColor, { emissive: 0.95 }),
    seg(originX, originY, facing, torsoX + 3.7, shoulderY + 3.65, 1.5, 1.5, palette.white, { emissive: 1 }),
  ];
}

function headParts(
  originX: number,
  originY: number,
  facing: 1 | -1,
  headY: number,
  lean: number,
  headTilt: number,
  antennaSway: number,
  shoulderY: number,
  state: PlayerState,
): RigRect[] {
  // Softened dome: crest + cheek taper read as a rounder helmet without growing the hit-box.
  const headX = -3.4 + lean * 0.8 + headTilt;
  const visorLit = state !== 'dead';
  const antennaBaseX = headX + 3 + antennaSway * 0.3;
  const antennaTipX = headX + 3 + antennaSway;
  const parts: RigRect[] = [
    // Helmet crest: raised ridge + side fins so the silhouette peaks instead of reading as a flat dome.
    seg(originX, originY, facing, headX + 1.5, headY - 2.1, 4, 2.1, palette.shellDark),
    seg(originX, originY, facing, headX + 2.2, headY - 3.1, 2.6, 1, palette.shellLight),
    seg(originX, originY, facing, headX + 0.35, headY - 1.1, 1.6, 1.1, palette.shellDark),
    seg(originX, originY, facing, headX + 5.05, headY - 1.1, 1.6, 1.1, palette.shellDark),
    // Antenna: mast + tip node so sway reads as a hinged rod.
    seg(originX, originY, facing, antennaBaseX, headY - 2 - Math.abs(antennaSway) * 0.3, 1, 2, palette.joint),
    seg(originX, originY, facing, antennaTipX, headY - 3.1 - Math.abs(antennaSway) * 0.5, 1, 1.1, palette.visorGlow, {
      emissive: 0.85,
    }),
    // Dome plates: main shell, cheek taper, top bevel, rear plate.
    seg(originX, originY, facing, headX, headY, 7, 5.6, palette.shellLight),
    seg(originX, originY, facing, headX + 0.55, headY + 4.8, 5.9, 1.2, palette.shell),
    seg(originX, originY, facing, headX + 0.15, headY + 0.15, 6.7, 0.9, palette.white),
    seg(originX, originY, facing, headX + 5.1, headY + 1, 1.9, 4.6, palette.shellDark),
    // Cheek inset — softens the lower dome corners.
    seg(originX, originY, facing, headX - 0.15, headY + 3.2, 1.1, 2.2, palette.shellDark),
    // Helmet panel lines (brow + vertical cheek seam).
    seg(originX, originY, facing, headX + 1, headY + 1, 5, 1, palette.plateShadow),
    seg(originX, originY, facing, headX + 3.5, headY + 1, 1, 3.8, palette.plateShadow),
    // Visor well + lit slit with a hotter glow core.
    seg(originX, originY, facing, headX + 0.9, headY + 1.9, 5.4, 2.2, palette.joint),
    seg(
      originX,
      originY,
      facing,
      headX + 1.05,
      headY + 2.05,
      5,
      1.15,
      visorLit ? palette.visor : palette.plateDark,
      visorLit ? { emissive: 0.9 } : {},
    ),
  ];
  if (visorLit && state !== 'hurt') {
    parts.push(seg(originX, originY, facing, headX + 3.4, headY + 2.05, 2.6, 1.15, palette.visorGlow, { emissive: 1 }));
    parts.push(seg(originX, originY, facing, headX + 4.55, headY + 2.15, 1.05, 0.9, palette.white, { emissive: 1 }));
  }
  // Chin guard + neck collar.
  parts.push(seg(originX, originY, facing, headX + 1.4, headY + 5.1, 4.2, 1.1, palette.shellDark));
  parts.push(seg(originX, originY, facing, -1.5, headY + 6.1, 3, Math.max(0, shoulderY - headY - 6.1), palette.joint));
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
  const length = (5 + flicker * 5) * clamp(0.35 + energyRatio, 0.35, 1);
  return [
    seg(originX, originY, facing, -3.5, 0, 7, length * 0.85, palette.flame, { emissive: 0.85, alpha: 0.7 }),
    seg(originX, originY, facing, -2.5, 0, 5, length, palette.flame, { emissive: 1 }),
    seg(originX, originY, facing, -1.5, 0, 3, length * 0.7, palette.flameHot, { emissive: 1 }),
    seg(originX, originY, facing, -1, 0, 2, length * 1.25, palette.spark, { emissive: 1 }),
  ];
}

/**
 * Builds Optimus' full rig for one frame as a flat, painter's-algorithm-ordered list of
 * world-space rectangles (back-most first): thrust flame (if any), back leg/arm, torso, hips,
 * front leg/arm, head/neck.
 *
 * Pure and allocation-light: everything here is a function of `options` alone, so calling it
 * every frame for every visible actor never touches or needs to know about the simulation beyond
 * the read-only pose parameters it was handed.
 */
export function buildOptimusRig(options: OptimusRigOptions): RigParts {
  const { x, y, facing, state, animTime, speedRatio, energyRatio } = options;
  const pose = resolvePose(state, animTime, speedRatio);

  const originX = x + PLAYER_WIDTH / 2;
  const originY = y + PLAYER_HEIGHT;

  const hipY = HIP_Y * pose.stretch + pose.bob;
  const shoulderY = SHOULDER_Y * pose.stretch + pose.bob;
  const headY = HEAD_TOP * pose.stretch + pose.bob;

  const parts: RigRect[] = [];
  if (state === 'thrust') {
    parts.push(...thrustFlameParts(originX, originY, facing, animTime, energyRatio));
  }

  parts.push(
    ...legParts(
      originX,
      originY,
      facing,
      -LEG_BASE_X + pose.legBackX + pose.hipSway,
      hipY + pose.legBackY,
      pose.kneeBackBend,
      palette.shellDark,
      palette.joint,
    ),
  );
  parts.push(...armParts(originX, originY, facing, -ARM_BASE_X + pose.armBackX, shoulderY + pose.armBackY, pose.elbowBackBend, palette.shellDark));

  parts.push(...torsoParts(originX, originY, facing, shoulderY, hipY, pose.lean, pose.torsoTwist, energyRatio));
  parts.push(seg(originX, originY, facing, -3.5 + pose.lean * 0.3 + pose.hipSway, hipY - 1, 7, 2, palette.joint));

  parts.push(
    ...legParts(
      originX,
      originY,
      facing,
      LEG_BASE_X + pose.legFrontX + pose.hipSway,
      hipY + pose.legFrontY,
      pose.kneeFrontBend,
      palette.shell,
      palette.joint,
    ),
  );
  parts.push(...armParts(originX, originY, facing, ARM_BASE_X + pose.armFrontX, shoulderY + pose.armFrontY, pose.elbowFrontBend, palette.shell));

  parts.push(...headParts(originX, originY, facing, headY, pose.lean, pose.headTilt, pose.antennaSway, shoulderY, state));

  return parts;
}
