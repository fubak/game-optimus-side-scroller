import type { World } from '../game/world';

/**
 * Shared contract between the Classic Canvas2D renderer and any future WebGL2 renderer.
 *
 * Keeping both backends behind the same interface means the game loop, HUD, and screens never
 * need to know which backend is active — they just call `trackTrail`/`draw`/`drawDebug` on
 * whatever {@link WorldView} was constructed for the session.
 */
export interface WorldView {
  /** Sample per-frame state (e.g. trail/ghost history); called once per simulation step. */
  trackTrail(world: World, dtSec: number): void;
  /** alpha in [0,1) for interpolation between previous and current sim state. */
  draw(ctx: CanvasRenderingContext2D, world: World, alpha?: number): void;
  /** Debug overlay: collision boxes, tile grid, and similar diagnostics. */
  drawDebug(ctx: CanvasRenderingContext2D, world: World): void;
  /** Release any backend-specific resources (GL contexts, buffers, etc.). */
  dispose?(): void;
  readonly backend: 'classic' | 'webgl2';
}
