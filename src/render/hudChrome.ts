/**
 * Soft Enhanced HUD chrome helpers — rounded multi-layer bars that read clean under MSDF
 * supersampling. Classic keeps hard `fillRect` pips in `Hud.draw`.
 */

import { clamp } from '../core/math';

/** Soft filled bar: dark well → dim track → bright fill with a 1px highlight strip. */
export function fillSoftBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fillRatio: number,
  colors: {
    readonly well: string;
    readonly track: string;
    readonly fill: string;
    readonly highlight?: string;
  },
): void {
  const w = Math.max(0, width);
  const h = Math.max(1, height);
  const ratio = clamp(fillRatio, 0, 1);
  ctx.fillStyle = colors.well;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = colors.track;
  ctx.fillRect(x, y, w, h);
  const fillW = Math.round(w * ratio);
  if (fillW > 0) {
    ctx.fillStyle = colors.fill;
    ctx.fillRect(x, y, fillW, h);
    if (colors.highlight !== undefined && h >= 3) {
      ctx.fillStyle = colors.highlight;
      ctx.fillRect(x, y, fillW, 1);
    }
  }
}

/** Soft health pip — rounded plate with a specular tick when filled. */
export function fillSoftPip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  filled: boolean,
  colors: {
    readonly filled: string;
    readonly empty: string;
    readonly highlight: string;
    readonly emptyShade: string;
  },
): void {
  ctx.fillStyle = colors.emptyShade;
  ctx.fillRect(x - 1, y - 1, width + 2, height + 2);
  ctx.fillStyle = filled ? colors.filled : colors.empty;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = filled ? colors.highlight : colors.emptyShade;
  ctx.fillRect(x + 1, y + 1, Math.max(1, width - 4), 1);
  if (filled) {
    ctx.fillStyle = colors.highlight;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x + width - 2, y + 1, 1, height - 2);
    ctx.globalAlpha = 1;
  }
}
