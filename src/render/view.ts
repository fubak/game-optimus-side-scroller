import type { World } from '../game/world';
import type { RenderSettings } from './settings';

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
  /**
   * @param alpha Interpolation factor in [0,1) between the previous and current simulation step.
   * @param settings Active render settings (quality/shadows/etc). Classic ignores these; WebGL2's
   *   deferred pipeline uses them to gate light count and shadow rendering.
   * @param reducedMotion Accessibility flag: backends must not introduce flashing lights >3Hz
   *   (or any motion-sensitive effect) while this is set, regardless of `settings`.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    world: World,
    alpha?: number,
    settings?: RenderSettings,
    reducedMotion?: boolean,
  ): void;
  /** Debug overlay: collision boxes, tile grid, and similar diagnostics. */
  drawDebug(ctx: CanvasRenderingContext2D, world: World): void;
  /**
   * Notify the backend of the display's real backbuffer size (device pixels). Classic ignores
   * this — its backbuffer is always the world view — but WebGL2 uses it to render at the display's
   * native resolution instead of a fixed low-res target.
   */
  resize?(bufferWidth: number, bufferHeight: number): void;
  /** Release any backend-specific resources (GL contexts, buffers, etc.). */
  dispose?(): void;
  readonly backend: 'classic' | 'webgl2';
  /** Approximate GPU frame time in milliseconds, when the backend can measure it; else `null`. */
  readonly lastGpuMs?: number | null;
}
