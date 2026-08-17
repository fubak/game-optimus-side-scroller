/**
 * WebGL2 world renderer (Stage 1 scaffold).
 *
 * Stage 1 goal: prove the GL boot path, graceful Classic fallback, and a stable present contract
 * without changing how the game looks or plays. The scene is still assembled by the Classic
 * Canvas2D painter into an offscreen buffer; that buffer is uploaded and presented through WebGL2
 * (so the device, program, texture, and blit plumbing are live). Later stages replace the CPU
 * paint with instanced materials, deferred lighting, and HDR targets while keeping this class's
 * {@link WorldView} surface.
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

  constructor(device: GlDevice, world: World | null) {
    this.device = device;
    this.canvas = device.gl.canvas as HTMLCanvasElement;
    this.canvas.width = INTERNAL_WIDTH;
    this.canvas.height = INTERNAL_HEIGHT;

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
      throw new Error('Failed to create the Stage-1 paint buffer.');
    }
    paintCtx.imageSmoothingEnabled = false;
    this.paintCtx = paintCtx;

    this.classic = new ClassicWorldRenderer(world);
  }

  trackTrail(world: World, dtSec: number): void {
    this.classic.trackTrail(world, dtSec);
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
    gl.viewport(0, 0, INTERNAL_WIDTH, INTERNAL_HEIGHT);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.blit.draw(this.colorTarget.handle, 0);

    // Present into the game's Canvas2D display surface so HUD/screens/e2e keep working unchanged.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, 0);
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
