import { clamp } from '../../core/math';
import type { EnemyKind } from '../../game/enemies';
import { palette } from '../palette';
import type { RigParts, RigRect } from './types';

/**
 * Procedural rigs for the enemy cast, one builder per {@link EnemyKind}.
 *
 * Same contract as `optimusRig.ts`: every builder is a pure function of its options that returns
 * a flat, painter's-algorithm-ordered list of world-space {@link RigRect}s. Silhouette comes
 * first — each archetype keeps the distinct outline `drawWalker`/`drawDrone`/etc. established in
 * `sprites.ts` (wide tracked chassis, hovering eye, squat bunker, heavy press, gantry crane) — and
 * the per-kind animation flourish (tread flex, rotor bank, recoil/heat, core iris) rides on top of
 * that same shape rather than replacing it, so the GL and Classic silhouettes read as the same
 * enemy at a glance.
 */

export interface EnemyRigOptions {
  readonly kind: EnemyKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly facing: 1 | -1;
  readonly animTime: number;
  /** 0..1 death animation progress (1 = just died). */
  readonly dying?: number;
  /** Crusher/turret/boss telegraph flash — also drives turret heat glow and crusher shake. */
  readonly telegraph?: boolean;
  /** Overseer only: is the cooling core open (and stompable) right now? */
  readonly vulnerable?: boolean;
  /** Overseer only: hits remaining, for the damage pips. */
  readonly hitPoints?: number;
}

interface RectExtras {
  readonly emissive?: number;
  readonly roughness?: number;
  readonly metallic?: number;
  readonly alpha?: number;
}

function rect(x: number, y: number, width: number, height: number, color: string, extras: RectExtras = {}): RigRect {
  return { x, y, width, height, color, ...extras };
}

/** Dying enemies fade and drop away — mirrors `applyDying` in `sprites.ts`. */
function dyingAlpha(dying: number | undefined): number {
  return clamp(1 - (dying ?? 0), 0, 1);
}

function dyingDrop(dying: number | undefined): number {
  return (dying ?? 0) * 4;
}

function buildWalkerRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, facing, animTime, dying } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const wobble = Math.sin(animTime * 10) * 0.5;

  const parts: RigRect[] = [rect(x, dropY + height - 4, width, 4, palette.joint, { alpha })];
  // Idler wheels: two small hubs riding under the tread frame, giving the belt a visible axle
  // to wrap around instead of floating over a flat plate.
  parts.push(rect(x + width * 0.22, dropY + height - 3, 2, 2, palette.plateShadow, { alpha }));
  parts.push(rect(x + width * 0.68, dropY + height - 3, 2, 2, palette.plateShadow, { alpha }));
  // Tread deformation: each track block flexes independently (a small height pulse riding the
  // belt scroll), so the tracks read as flexible rather than a single painted-on strip. More
  // segments than the chassis is wide keeps the belt reading as continuous at any zoom.
  const treadSegments = 10;
  const segmentSpacing = width / treadSegments;
  for (let i = 0; i < treadSegments; i += 1) {
    const offset = (animTime * 40 * facing + i * segmentSpacing) % width;
    const flex = 1 + Math.sin(animTime * 14 + i * 1.7) * 0.28;
    const blockX = dropY + height - 3;
    parts.push(rect(x + ((offset + width) % width), blockX, 2, Math.max(1, 2 * flex), palette.plateLight, { alpha }));
  }
  parts.push(rect(x + 1, dropY + 3 + wobble, width - 2, height - 6, palette.rust, { alpha }));
  parts.push(rect(x + 1, dropY + 3 + wobble, width - 2, 1, palette.uiWarn, { alpha }));
  parts.push(rect(x + 2, dropY + 5 + wobble, width - 4, 2, palette.plateDark, { alpha }));
  const eyeX = facing === 1 ? x + width - 5 : x + 2;
  parts.push(rect(eyeX, dropY + 5 + wobble, 3, 2, palette.hazard, { alpha, emissive: 0.6 }));
  return parts;
}

function buildDroneRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, facing, animTime, dying } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  // Bank: a slow lateral rock, as if correcting for drift, layered under the rotor spin.
  const bank = Math.sin(animTime * 3.4) * 1.2;
  // Softer rotor blur (Dead Cells HD-2D): lower temporal frequency so the disc reads as motion
  // smear rather than a strobing bar at 60 fps.
  const rotor = Math.sin(animTime * 18) * 2;
  const rotorBlurWidth = width - 2 + Math.abs(Math.sin(animTime * 36)) * 1.5;
  // A second blur blade 90° out of phase (cosine instead of sine) reads as the same disc seen
  // from a slightly different angle each frame — two overlapping streaks instead of one bar,
  // which is enough for the eye to fill in a spinning rotor disc rather than a single wing.
  const rotor2 = Math.cos(animTime * 18) * 2;
  const rotor2BlurWidth = width - 4 + Math.abs(Math.cos(animTime * 36)) * 1.5;

  const parts: RigRect[] = [
    rect(x + 1 + rotor + bank, dropY, rotorBlurWidth, 1, palette.plateLight, { alpha, emissive: 0.15 }),
    rect(x + 2 + rotor2 + bank, dropY, rotor2BlurWidth, 1, palette.plateLight, { alpha, emissive: 0.1 }),
    rect(x + width / 2 - 1 + bank, dropY + 1, 2, 2, palette.joint, { alpha }),
    rect(x + 1 + bank * 0.5, dropY + 3, width - 2, height - 4, palette.plateFace, { alpha }),
    rect(x + 1 + bank * 0.5, dropY + 3, width - 2, 1, palette.plateLight, { alpha }),
    rect(x + 2 + bank * 0.5, dropY + height - 2, width - 4, 1, palette.plateShadow, { alpha }),
  ];
  const eyeX = (facing === 1 ? x + width - 6 : x + 3) + bank * 0.5;
  parts.push(rect(eyeX, dropY + 5, 3, 3, palette.hazardDark, { alpha }));
  parts.push(rect(eyeX + (facing === 1 ? 1 : 0), dropY + 6, 2, 1, palette.hazard, { alpha, emissive: 0.7 }));
  return parts;
}

function buildTurretRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, facing, animTime, dying, telegraph } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const charge = telegraph === true ? 1 : 0.35 + 0.35 * Math.sin(animTime * 6);
  // Recoil: the barrel kicks back proportionally to charge, snapping forward again once it drops
  // (i.e. right after a shot), and the heat glow ramps with the same charge value.
  const recoil = telegraph === true ? -Math.max(0, Math.sin(animTime * 6)) * 1.5 : 0;

  const parts: RigRect[] = [
    rect(x, dropY + height - 5, width, 5, palette.plateDark, { alpha }),
    rect(x + 1, dropY + height - 5, width - 2, 1, palette.plateFace, { alpha }),
    rect(x + 2, dropY + 3, width - 4, height - 7, palette.grate, { alpha }),
    rect(x + 3, dropY + 3, width - 6, 1, palette.plateLight, { alpha }),
  ];
  // Barrel: three segments (mount, tube, muzzle) instead of one flat rect, so the heat glow can
  // localise to the muzzle tip rather than washing over the whole barrel.
  const barrelX = (facing === 1 ? x + width - 3 : x - 3) + recoil * facing;
  parts.push(rect(barrelX, dropY + 6, 2, 3, palette.plateDark, { alpha }));
  parts.push(rect(barrelX + 2, dropY + 6, 2, 3, palette.plateFace, { alpha }));
  parts.push(
    rect(barrelX + 4, dropY + 6, 2, 3, charge > 0.6 ? palette.hazard : palette.plateShadow, {
      alpha,
      emissive: charge * 0.7,
    }),
  );
  parts.push(
    rect(x + width / 2 - 1, dropY + 5, 2, 2, charge > 0.8 ? palette.hazard : palette.hazardDark, {
      alpha,
      emissive: charge * 0.8,
    }),
  );
  // Heat glow: a soft emissive halo around the dome that brightens with sustained charge.
  parts.push(rect(x + 1, dropY + 3, width - 2, height - 7, palette.hazardDark, { alpha, emissive: charge * 0.12 }));
  return parts;
}

function buildCrusherRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, animTime, dying, telegraph } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const shake = telegraph === true ? Math.sin(animTime * 60) * 1 : 0;

  const parts: RigRect[] = [
    rect(x + width / 2 - 3, -1, 6, dropY + 2, palette.plateDark, { alpha }),
    rect(x + width / 2 - 1, -1, 2, dropY + 2, palette.plateFace, { alpha }),
    rect(x + shake, dropY, width, height, palette.plateFace, { alpha }),
    rect(x + shake, dropY, width, 2, palette.plateLight, { alpha }),
    rect(x + shake, dropY + height - 4, width, 4, palette.joint, { alpha }),
  ];
  for (let i = 0; i < width; i += 6) {
    const warn = telegraph === true ? palette.hazard : palette.uiWarn;
    parts.push(rect(x + i + shake, dropY + height - 4, 3, 4, warn, { alpha, emissive: telegraph === true ? 0.4 : 0 }));
  }
  return parts;
}

function buildOverseerRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, animTime, dying, telegraph, vulnerable = false, hitPoints = 0 } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const shake = telegraph === true ? Math.sin(animTime * 50) * 1.2 : 0;

  const parts: RigRect[] = [
    // Piston/rails to the ceiling.
    rect(x + 4, -2, width - 8, 3, palette.plateDark, { alpha }),
    rect(x + width / 2 - 4, -2, 8, dropY + 4, palette.plateDark, { alpha }),
    rect(x + width / 2 - 1, -2, 2, dropY + 4, palette.plateFace, { alpha }),
    // Chassis.
    rect(x + shake, dropY, width, height, palette.plateFace, { alpha }),
    rect(x + shake, dropY, width, 3, palette.plateLight, { alpha }),
    rect(x + shake, dropY + height - 5, width, 5, palette.joint, { alpha }),
    rect(x + 3 + shake, dropY + 4, width - 6, height - 11, palette.plateDark, { alpha }),
    // Plating seam and corner rivets: mechanical detail on the flat chassis face so it reads as
    // riveted armour plate rather than a solid block, even where the core cover hides the iris.
    rect(x + 3 + shake, dropY + height / 2, width - 6, 1, palette.plateShadow, { alpha }),
    rect(x + 2 + shake, dropY + 2, 2, 2, palette.joint, { alpha }),
    rect(x + width - 4 + shake, dropY + 2, 2, 2, palette.joint, { alpha }),
  ];

  for (let i = 0; i < width - 6; i += 8) {
    const warn = telegraph === true ? palette.hazard : palette.uiWarn;
    parts.push(rect(x + 3 + i + shake, dropY + height - 5, 4, 5, warn, { alpha, emissive: telegraph === true ? 0.4 : 0 }));
  }

  const coreX = x + width / 2 - 7 + shake;
  const coreY = dropY + 7;
  if (vulnerable) {
    // Core iris: nested layers that pulse together, reading as an aperture rather than a flat
    // rectangle — the widest, dimmest ring first, the brightest pupil last.
    const pulse = 0.6 + 0.4 * Math.sin(animTime * 14);
    parts.push(rect(coreX - 2, coreY - 2, 18, 12, palette.hazardDark, { alpha }));
    parts.push(rect(coreX, coreY, 14, 8, pulse > 0.75 ? palette.visorGlow : palette.visor, { alpha, emissive: 0.5 + pulse * 0.4 }));
    parts.push(rect(coreX + 2, coreY + 1, 10, 6, palette.visorGlow, { alpha, emissive: 0.3 + pulse * 0.3 }));
    parts.push(rect(coreX + 3, coreY + 2, 8, 4, palette.white, { alpha, emissive: 0.8 }));
  } else {
    parts.push(rect(coreX, coreY, 14, 8, palette.grate, { alpha }));
    for (let i = 0; i < 14; i += 4) {
      parts.push(rect(coreX + i, coreY, 2, 8, palette.plateShadow, { alpha }));
    }
  }

  for (let i = 0; i < 3; i += 1) {
    parts.push(rect(x + 5 + i * 6 + shake, dropY + 3, 4, 2, i < hitPoints ? palette.hazard : palette.plateShadow, { alpha }));
  }
  return parts;
}

/**
 * Builds one enemy's rig for this frame. Returns an empty list once its death fade has fully
 * completed (`dying >= 1`), matching `GlWorldRenderer`'s existing `alpha <= 0` skip.
 */
export function buildEnemyRig(options: EnemyRigOptions): RigParts {
  switch (options.kind) {
    case 'walker':
      return buildWalkerRig(options);
    case 'drone':
      return buildDroneRig(options);
    case 'turret':
      return buildTurretRig(options);
    case 'crusher':
      return buildCrusherRig(options);
    case 'overseer':
      return buildOverseerRig(options);
    default: {
      const exhaustive: never = options.kind;
      throw new Error(`Unhandled enemy kind in rig: ${String(exhaustive)}`);
    }
  }
}
