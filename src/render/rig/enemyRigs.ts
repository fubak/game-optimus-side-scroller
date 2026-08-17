import { clamp } from '../../core/math';
import type { EnemyKind } from '../../game/enemies';
import { palette } from '../palette';
import type { RigParts, RigRect, RigShape } from './types';

/**
 * Procedural rigs for the enemy cast, one builder per {@link EnemyKind}.
 *
 * Same contract as `optimusRig.ts`: every builder is a pure function of its options that returns
 * a flat, painter's-algorithm-ordered list of world-space {@link RigRect}s. Silhouette comes
 * first — each archetype keeps the distinct outline `drawWalker`/`drawDrone`/etc. established in
 * `sprites.ts` — with elliptical polymer/metal parts so Enhanced sheet bakes read as rounded
 * factory machines rather than stacked bricks.
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
  readonly shape?: RigShape;
}

function rect(x: number, y: number, width: number, height: number, color: string, extras: RectExtras = {}): RigRect {
  return { x, y, width, height, color, ...extras };
}

function oval(x: number, y: number, width: number, height: number, color: string, extras: RectExtras = {}): RigRect {
  return rect(x, y, width, height, color, { shape: 'ellipse', ...extras });
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
  const bodyY = dropY + 3 + wobble;
  const bodyH = height - 6;

  const parts: RigRect[] = [oval(x, dropY + height - 4, width, 4, palette.joint, { alpha })];
  // Idler wheels.
  parts.push(oval(x + width * 0.16, dropY + height - 3.4, 2.8, 2.8, palette.plateShadow, { alpha }));
  parts.push(oval(x + width * 0.64, dropY + height - 3.4, 2.8, 2.8, palette.plateShadow, { alpha }));
  parts.push(oval(x + width * 0.2, dropY + height - 2.8, 1.5, 1.5, palette.plateDark, { alpha }));
  parts.push(oval(x + width * 0.68, dropY + height - 2.8, 1.5, 1.5, palette.plateDark, { alpha }));
  // Tread deformation.
  const treadSegments = 10;
  const segmentSpacing = width / treadSegments;
  for (let i = 0; i < treadSegments; i += 1) {
    const offset = (animTime * 40 * facing + i * segmentSpacing) % width;
    const flex = 1 + Math.sin(animTime * 14 + i * 1.7) * 0.28;
    const blockY = dropY + height - 3;
    parts.push(
      oval(x + ((offset + width) % width), blockY, 2.2, Math.max(1, 2.2 * flex), palette.plateLight, { alpha }),
    );
  }
  // Softened hull.
  parts.push(oval(x + 0.4, bodyY, width - 0.8, bodyH, palette.rust, { alpha }));
  parts.push(oval(x + 0.4, bodyY, width - 0.8, 1.3, palette.uiWarn, { alpha }));
  parts.push(oval(x + 1.4, bodyY + 1.2, width - 2.8, bodyH - 2.4, palette.plateDark, { alpha }));
  parts.push(oval(x + 2.1, bodyY + 2, width - 4.2, bodyH * 0.55, palette.plateFace, { alpha }));
  parts.push(rect(x + 1.5, bodyY + bodyH * 0.35, width - 3, 0.9, palette.plateShadow, { alpha }));
  parts.push(rect(x + 1.5, bodyY + bodyH * 0.58, width - 3, 0.9, palette.plateShadow, { alpha }));
  parts.push(rect(x + 2.5, bodyY + 2, 0.9, bodyH - 3.2, palette.plateShadow, { alpha }));
  parts.push(rect(x + width - 3.4, bodyY + 2, 0.9, bodyH - 3.2, palette.plateShadow, { alpha }));
  // Sensor eye — well → iris → pupil.
  const eyeX = facing === 1 ? x + width - 5.4 : x + 1.8;
  parts.push(oval(eyeX, bodyY + 1.6, 3.8, 3.8, palette.hazardDark, { alpha }));
  parts.push(oval(eyeX + 0.25, bodyY + 2.0, 3.3, 2.8, palette.hazard, { alpha, emissive: 0.95 }));
  parts.push(
    oval(eyeX + (facing === 1 ? 1.35 : 0.45), bodyY + 2.55, 1.7, 1.4, palette.white, {
      alpha,
      emissive: 1,
    }),
  );
  return parts;
}

function buildDroneRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, facing, animTime, dying } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const bank = Math.sin(animTime * 3.4) * 1.2;
  const rotor = Math.sin(animTime * 18) * 2;
  const rotorBlurWidth = width - 2 + Math.abs(Math.sin(animTime * 36)) * 1.5;
  const rotor2 = Math.cos(animTime * 18) * 2;
  const rotor2BlurWidth = width - 4 + Math.abs(Math.cos(animTime * 36)) * 1.5;
  const bodyX = x + 1.2 + bank * 0.5;
  const bodyW = width - 2.4;
  const midH = height - 5;

  const parts: RigRect[] = [
    oval(x + 1 + rotor + bank, dropY, rotorBlurWidth, 1.4, palette.plateLight, { alpha, emissive: 0.25 }),
    oval(x + 2 + rotor2 + bank, dropY + 0.2, rotor2BlurWidth, 1.1, palette.plateLight, {
      alpha,
      emissive: 0.14,
    }),
    oval(x + width / 2 - 1.4 + bank, dropY + 1, 2.8, 2.4, palette.joint, { alpha }),
    oval(bodyX, dropY + 3, bodyW, midH * 0.55, palette.plateFace, { alpha }),
    oval(bodyX + 0.55, dropY + 3 + midH * 0.48, bodyW - 1.1, midH * 0.52, palette.plateFace, { alpha }),
    oval(bodyX, dropY + 3, bodyW, 1.1, palette.plateLight, { alpha }),
    oval(bodyX + 0.75, dropY + 4, bodyW - 1.5, midH - 1.5, palette.plateDark, { alpha }),
    rect(bodyX + 0.8, dropY + 4 + (midH - 1.5) * 0.4, bodyW - 1.6, 0.9, palette.plateShadow, { alpha }),
    oval(x + 2.1 + bank * 0.5, dropY + height - 2.4, width - 4.2, 1.5, palette.plateShadow, { alpha }),
    oval(x + 2.9 + bank * 0.5, dropY + height - 1.7, 1.6, 1.15, palette.hazard, { alpha, emissive: 0.55 }),
    oval(x + width - 4.5 + bank * 0.5, dropY + height - 1.7, 1.6, 1.15, palette.hazard, {
      alpha,
      emissive: 0.55,
    }),
  ];
  const eyeX = (facing === 1 ? x + width - 6.4 : x + 2.6) + bank * 0.5;
  parts.push(oval(eyeX, dropY + 4.4, 3.8, 3.8, palette.hazardDark, { alpha }));
  parts.push(
    oval(eyeX + (facing === 1 ? 0.85 : 0.25), dropY + 4.95, 2.5, 2.5, palette.hazard, {
      alpha,
      emissive: 0.95,
    }),
  );
  parts.push(
    oval(eyeX + (facing === 1 ? 1.45 : 0.75), dropY + 5.45, 1.25, 1.25, palette.white, {
      alpha,
      emissive: 1,
    }),
  );
  return parts;
}

function buildTurretRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, facing, animTime, dying, telegraph } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const charge = telegraph === true ? 1 : 0.35 + 0.35 * Math.sin(animTime * 6);
  const recoil = telegraph === true ? -Math.max(0, Math.sin(animTime * 6)) * 1.5 : 0;
  const muzzleEmissive = Math.min(1, charge * 0.98);
  const domeEmissive = Math.min(1, charge * 0.98);

  const parts: RigRect[] = [
    oval(x, dropY + height - 5, width, 5.2, palette.plateDark, { alpha }),
    oval(x + 0.5, dropY + height - 5, width - 1, 1.3, palette.plateFace, { alpha }),
    oval(x + 1.4, dropY + 2.4, width - 2.8, height - 6.2, palette.grate, { alpha }),
    oval(x + 2.3, dropY + 2.4, width - 4.6, 1.2, palette.plateLight, { alpha }),
    rect(x + 2.5, dropY + 2.5 + (height - 6.5) * 0.35, width - 5, 0.9, palette.plateShadow, { alpha }),
    rect(x + 2.5, dropY + 2.5 + (height - 6.5) * 0.62, width - 5, 0.9, palette.plateShadow, { alpha }),
    oval(x + 0.4, dropY + 4, 1.6, height - 10, palette.plateDark, { alpha }),
    oval(x + width - 2.0, dropY + 4, 1.6, height - 10, palette.plateDark, { alpha }),
  ];
  const barrelX = (facing === 1 ? x + width - 3 : x - 3) + recoil * facing;
  parts.push(oval(barrelX, dropY + 5.4, 2.4, 3.6, palette.plateDark, { alpha }));
  parts.push(oval(barrelX + 2, dropY + 5.6, 2.4, 3.2, palette.plateFace, { alpha }));
  parts.push(oval(barrelX + 2, dropY + 5.6, 2.4, 1.1, palette.plateLight, { alpha }));
  parts.push(
    oval(barrelX + 4, dropY + 5.6, 2.4, 3.2, charge > 0.55 ? palette.hazard : palette.plateShadow, {
      alpha,
      emissive: muzzleEmissive,
    }),
  );
  parts.push(
    oval(barrelX + 5.3, dropY + 6.1, 1.4, 2.2, charge > 0.5 ? palette.white : palette.plateDark, {
      alpha,
      emissive: Math.min(1, charge),
    }),
  );
  parts.push(
    oval(x + width / 2 - 1.5, dropY + 4.3, 3.0, 3.0, charge > 0.75 ? palette.hazard : palette.hazardDark, {
      alpha,
      emissive: domeEmissive,
    }),
  );
  parts.push(
    oval(x + width / 2 - 0.7, dropY + 5.0, 1.4, 1.4, charge > 0.6 ? palette.white : palette.plateDark, {
      alpha,
      emissive: Math.min(1, charge * 0.9),
    }),
  );
  return parts;
}

function buildCrusherRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, animTime, dying, telegraph } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const shake = telegraph === true ? Math.sin(animTime * 60) * 1 : 0;
  // Rail stays inside the bake cell (local to the press), not world y = -1.
  const railTop = dropY - height * 0.85;

  const parts: RigRect[] = [
    oval(x + width / 2 - 3.4, railTop, 6.8, dropY - railTop + 2, palette.plateDark, { alpha }),
    oval(x + width / 2 - 1.2, railTop, 2.4, dropY - railTop + 2, palette.plateFace, { alpha }),
    oval(x + shake, dropY, width, height, palette.plateFace, { alpha }),
    oval(x + shake, dropY, width, 2.4, palette.plateLight, { alpha }),
    oval(x + 1.4 + shake, dropY + 2, width - 2.8, height - 6.2, palette.plateDark, { alpha }),
    oval(x + 2.3 + shake, dropY + 3, width - 4.6, height * 0.35, palette.plateFace, { alpha }),
    rect(x + 2 + shake, dropY + height * 0.38, width - 4, 0.9, palette.plateShadow, { alpha }),
    rect(x + 2 + shake, dropY + height * 0.55, width - 4, 0.9, palette.plateShadow, { alpha }),
    oval(x + 1.4 + shake, dropY + 2.4, 1.8, 1.8, palette.joint, { alpha }),
    oval(x + width - 3.2 + shake, dropY + 2.4, 1.8, 1.8, palette.joint, { alpha }),
    oval(x + shake, dropY + height - 4.2, width, 4.2, palette.joint, { alpha }),
  ];
  for (let i = 0; i < width; i += 6) {
    const warn = telegraph === true ? palette.hazard : palette.uiWarn;
    parts.push(
      oval(x + i + shake, dropY + height - 4.2, 3.4, 4.2, warn, {
        alpha,
        emissive: telegraph === true ? 0.7 : 0.12,
      }),
    );
  }
  return parts;
}

function buildOverseerRig(options: EnemyRigOptions): RigParts {
  const { x, y, width, height, animTime, dying, telegraph, vulnerable = false, hitPoints = 0 } = options;
  const alpha = dyingAlpha(dying);
  if (alpha <= 0) return [];
  const dropY = y + dyingDrop(dying);
  const shake = telegraph === true ? Math.sin(animTime * 50) * 1.2 : 0;
  const railTop = dropY - height * 0.75;

  const parts: RigRect[] = [
    oval(x + 4, railTop, width - 8, 3.2, palette.plateDark, { alpha }),
    oval(x + width / 2 - 4.4, railTop, 8.8, dropY - railTop + 4, palette.plateDark, { alpha }),
    oval(x + width / 2 - 1.3, railTop, 2.6, dropY - railTop + 4, palette.plateFace, { alpha }),
    oval(x + shake, dropY, width, height, palette.plateFace, { alpha }),
    oval(x + shake, dropY, width, 3.4, palette.plateLight, { alpha }),
    oval(x + shake, dropY + height - 5.2, width, 5.2, palette.joint, { alpha }),
    oval(x + 2.3 + shake, dropY + 3.4, width - 4.6, height - 10, palette.plateDark, { alpha }),
    oval(x + 3.8 + shake, dropY + 5, width - 7.6, height * 0.42, palette.plateFace, { alpha }),
    rect(x + 2.5 + shake, dropY + height * 0.32, width - 5, 0.9, palette.plateShadow, { alpha }),
    rect(x + 2.5 + shake, dropY + height * 0.48, width - 5, 0.9, palette.plateShadow, { alpha }),
    oval(x + 1.6 + shake, dropY + 1.6, 2.4, 2.4, palette.joint, { alpha }),
    oval(x + width - 4 + shake, dropY + 1.6, 2.4, 2.4, palette.joint, { alpha }),
  ];

  for (let i = 0; i < width - 6; i += 8) {
    const warn = telegraph === true ? palette.hazard : palette.uiWarn;
    parts.push(
      oval(x + 3 + i + shake, dropY + height - 5.2, 4.4, 5.2, warn, {
        alpha,
        emissive: telegraph === true ? 0.7 : 0.1,
      }),
    );
  }

  const coreX = x + width / 2 - 7 + shake;
  const coreY = dropY + 7;
  if (vulnerable) {
    const pulse = 0.6 + 0.4 * Math.sin(animTime * 14);
    parts.push(oval(coreX - 2.5, coreY - 2.5, 19, 13, palette.hazardDark, { alpha, emissive: 0.25 + pulse * 0.2 }));
    parts.push(
      oval(coreX, coreY, 14, 8, pulse > 0.75 ? palette.visorGlow : palette.visor, {
        alpha,
        emissive: 0.75 + pulse * 0.25,
      }),
    );
    parts.push(oval(coreX + 2, coreY + 1, 10, 6, palette.visorGlow, { alpha, emissive: 0.55 + pulse * 0.4 }));
    parts.push(oval(coreX + 3.5, coreY + 2.2, 7, 3.6, palette.white, { alpha, emissive: 1 }));
  } else {
    parts.push(oval(coreX, coreY, 14, 8, palette.grate, { alpha }));
    for (let i = 0; i < 14; i += 4) {
      parts.push(rect(coreX + i, coreY, 2, 8, palette.plateShadow, { alpha }));
    }
    parts.push(rect(coreX + 1, coreY + 3, 12, 1, palette.plateDark, { alpha }));
    parts.push(rect(coreX + 1, coreY + 5.5, 12, 1, palette.plateDark, { alpha }));
  }

  for (let i = 0; i < 3; i += 1) {
    parts.push(
      oval(x + 5 + i * 6 + shake, dropY + 2.6, 4.4, 2.4, i < hitPoints ? palette.hazard : palette.plateShadow, {
        alpha,
        emissive: i < hitPoints ? 0.65 : 0,
      }),
    );
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
