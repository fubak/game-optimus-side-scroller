import type { Surface } from './surface';

/**
 * {@link Surface} backed by a `CanvasRenderingContext2D`.
 *
 * Coordinates are rounded the same way `sprites.ts`'s `fill()` helper does today, so wrapping the
 * context here changes nothing about Classic's pixel-crisp look.
 */
export class CanvasSurface implements Surface {
  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  fillRect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  setAlpha(a: number): void {
    this.ctx.globalAlpha = a;
  }
}

export function createCanvasSurface(ctx: CanvasRenderingContext2D): CanvasSurface {
  return new CanvasSurface(ctx);
}
