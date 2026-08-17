/**
 * Canvas2D Optimus for Enhanced menus/epilogue — Tesla Gen 2 polymer silhouette from the same
 * skeletal rig as the sprite sheets. Classic screens keep `drawOptimus` from `sprites.ts`.
 */

import type { PlayerState } from '../game/player';
import { buildOptimusRig } from './rig/optimusRig';
import type { OptimusRigOptions } from './rig/optimusRig';

export type OptimusUiOptions = OptimusRigOptions;

/** Paint Enhanced Optimus into a 2D context (menus, epilogue). Honours facing + state. */
export function drawOptimusEnhanced(ctx: CanvasRenderingContext2D, options: OptimusUiOptions): void {
  const parts = buildOptimusRig(options);
  for (const part of parts) {
    const alpha = part.alpha ?? 1;
    if (alpha <= 0 || part.width <= 0 || part.height <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = part.color;
    if (part.shape === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        part.x + part.width * 0.5,
        part.y + part.height * 0.5,
        Math.max(0.25, part.width * 0.5),
        Math.max(0.25, part.height * 0.5),
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else {
      ctx.fillRect(part.x, part.y, part.width, part.height);
    }
  }
  ctx.globalAlpha = 1;
}

/** Convenience for the campaign epilogue victory pose. */
export function drawOptimusVictory(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  animTime: number,
): void {
  drawOptimusEnhanced(ctx, {
    x,
    y,
    facing: 1,
    state: 'victory' satisfies PlayerState,
    animTime,
    speedRatio: 0,
    energyRatio: 1,
  });
}
