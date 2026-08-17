/**
 * Minimal drawing surface abstraction.
 *
 * Draw helpers that only need flat-filled rectangles (most of `sprites.ts`, `tiles.ts`, etc.) can
 * target this instead of `CanvasRenderingContext2D` directly, which is what will let a future
 * WebGL2 backend reuse the same draw code behind a batched-quad implementation.
 */
export interface Surface {
  fillRect(x: number, y: number, w: number, h: number, color: string): void;
  /** optional: set global alpha multiplier default 1 */
  setAlpha?(a: number): void;
}
