/**
 * Enhanced UI scaling helpers.
 *
 * The Enhanced display maps 480×270 world-view units onto a large device backbuffer via
 * `ctx.setTransform`. That keeps HUD/menu *layout* code in world units, but MSDF glyphs stamped
 * at `scale: 1` then stretched by the transform look soft. These helpers keep layout in world
 * units while rasterizing MSDF at true buffer-pixel size.
 */

import { INTERNAL_WIDTH } from '../core/canvas';
import type { Display } from '../core/canvas';
import { drawTextMsdf } from './msdfFont';
import type { DrawTextFn } from './text';

/** Backbuffer pixels per world-view unit on Enhanced; Classic is always 1. */
export function uiScaleForDisplay(display: Display): number {
  if (display.mode !== 'enhanced') return 1;
  return display.bufferWidth / INTERNAL_WIDTH;
}

/**
 * MSDF text drawer that temporarily resets the CTM to identity, places glyphs at buffer pixels,
 * and rasterizes at `logicalScale * uiScale` so edges stay sharp under Enhanced supersampling.
 * No-op wrapper when `uiScale === 1` (Classic).
 */
export function makeBufferSpaceTextDraw(uiScale: number, fallback: DrawTextFn): DrawTextFn {
  if (uiScale === 1) return fallback;
  return (ctx, text, x, y, options = {}) => {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const scale = Math.max(1, Math.round((options.scale ?? 1) * uiScale));
    drawTextMsdf(ctx, text, x * uiScale, y * uiScale, { ...options, scale });
    ctx.restore();
  };
}

/**
 * Enter Enhanced buffer-pixel UI space: scale the CTM so world-view layout coords land on the
 * backbuffer. Caller must pair with {@link endUiSpace}. Returns the uiScale used (1 on Classic).
 */
export function beginUiSpace(ctx: CanvasRenderingContext2D, display: Display): number {
  const uiScale = uiScaleForDisplay(display);
  if (uiScale === 1) return 1;
  ctx.save();
  ctx.setTransform(uiScale, 0, 0, uiScale, 0, 0);
  ctx.imageSmoothingEnabled = true;
  return uiScale;
}

/** Restore the CTM after {@link beginUiSpace} when Enhanced. */
export function endUiSpace(ctx: CanvasRenderingContext2D, uiScale: number): void {
  if (uiScale === 1) return;
  ctx.restore();
}
