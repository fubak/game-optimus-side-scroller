/**
 * WebGL2 world renderer (Stage 2: resolution-independent presentation).
 *
 * The scene is still assembled by the Classic Canvas2D painter into a fixed 480×270 world-view
 * buffer (so the device, program, texture, and blit plumbing stay simple, and gameplay-facing
 * drawing code is untouched). What Stage 2 changes is *presentation*: the GL canvas and viewport
 * are sized to the display's real backbuffer (via {@link GlWorldRenderer.resize}, called whenever
 * the display resizes) instead of being pinned to 480×270. `FullscreenBlit` draws a plain clip-space
 * quad, so the same draw call fills whatever viewport is bound — the low-res world texture is
 * supersampled up to the backbuffer resolution by the rasterizer for free, no shader changes
 * needed. Later stages replace the CPU paint with instanced materials, deferred lighting, and HDR
 * targets while keeping this class's {@link WorldView} surface.
 */

import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../../core/canvas';
import type { World } from '../../game/world';
import { ClassicWorldRenderer } from '../renderer';
import type { WorldView } from '../view';
import { FullscreenBlit } from './blit';
import { GlDevice, tryCreateWebGL2 } from './device';
import { Filter, TexFormat, Texture, Wrap } from './texture';

export class GlWorldRenderer implements WorldView {
  readonly backend = 'webgl2';

  private readonly device: GlDevice;
  private readonly canvas: HTMLCanvasElement;
  private readonly blit: FullscreenBlit;
  private readonly colorTarget: Texture;
  private readonly classic: ClassicWorldRenderer;
  private readonly paintCanvas: HTMLCanvasElement;
  private readonly paintCtx: CanvasRenderingContext2D;
  private disposed = false;
  /** Real backbuffer size (device pixels); defaults to the world view until {@link resize} is called. */
  private backbufferWidth = INTERNAL_WIDTH;
  private backbufferHeight = INTERNAL_HEIGHT;

  constructor(device: GlDevice, world: World | null) {
    this.device = device;
    this.canvas = device.gl.canvas as HTMLCanvasElement;
    this.canvas.width = this.backbufferWidth;
    this.canvas.height = this.backbufferHeight;

    this.blit = new FullscreenBlit(device.gl);
    this.colorTarget = new Texture(device.gl, TexFormat.RGBA8, {
      filter: Filter.Nearest,
      wrap: Wrap.Clamp,
    });
    this.colorTarget.createEmpty(INTERNAL_WIDTH, INTERNAL_HEIGHT);

    this.paintCanvas = document.createElement('canvas');
    this.paintCanvas.width = INTERNAL_WIDTH;
    this.paintCanvas.height = INTERNAL_HEIGHT;
    const paintCtx = this.paintCanvas.getContext('2d', { alpha: false });
    if (paintCtx === null) {
      throw new Error('Failed to create the world paint buffer.');
    }
    paintCtx.imageSmoothingEnabled = false;
    this.paintCtx = paintCtx;

    this.classic = new ClassicWorldRenderer(world);
  }

  trackTrail(world: World, dtSec: number): void {
    this.classic.trackTrail(world, dtSec);
  }

  /**
   * Resize the GL backbuffer to match the display's real buffer (device pixels). The world is
   * still painted at 480×270 and the camera stays in world-view units — only the presentation
   * surface changes size, which is what makes the result crisp at any window size instead of being
   * CSS-upscaled from a small bitmap.
   */
  resize(bufferWidth: number, bufferHeight: number): void {
    const width = Math.max(1, Math.round(bufferWidth));
    const height = Math.max(1, Math.round(bufferHeight));
    if (width === this.backbufferWidth && height === this.backbufferHeight) return;
    this.backbufferWidth = width;
    this.backbufferHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  draw(ctx: CanvasRenderingContext2D, world: World, alpha?: number): void {
    if (this.disposed || this.device.isLost) {
      this.classic.draw(ctx, world, alpha);
      return;
    }

    const { gl } = this.device;
    this.classic.draw(this.paintCtx, world, alpha);

    this.colorTarget.bind(0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.paintCanvas,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.backbufferWidth, this.backbufferHeight);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.blit.draw(this.colorTarget.handle, 0);

    // Present into the game's Canvas2D display surface so HUD/screens/e2e keep working unchanged.
    // Destination size is given in world-view units, not backbuffer pixels: an Enhanced display
    // applies its own transform so this lands at the real (larger) buffer resolution untouched.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
  }

  drawDebug(ctx: CanvasRenderingContext2D, world: World): void {
    this.classic.drawDebug(ctx, world);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.blit.dispose();
    this.colorTarget.dispose();
    this.device.dispose();
  }
}

/**
 * Try to stand up a {@link GlWorldRenderer}.
 *
 * Returns `null` when WebGL2 is unavailable or initialisation throws, so the factory can fall
 * back to Classic without the game failing to boot.
 */
export function tryCreateGlWorldRenderer(world: World | null): WorldView | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = INTERNAL_WIDTH;
    canvas.height = INTERNAL_HEIGHT;
    const gl = tryCreateWebGL2(canvas);
    if (gl === null) return null;
    const device = new GlDevice(gl);
    return new GlWorldRenderer(device, world);
  } catch {
    return null;
  }
}
