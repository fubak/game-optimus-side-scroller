/**
 * WebGL2 device bootstrap.
 *
 * Wraps context creation and the handful of capability checks the rest of `src/render/gl` needs
 * (max texture size, float colour-buffer support, HDR renderability) so callers never touch raw
 * `getContext` calls or extension names directly.
 */

/** Capabilities probed once at device creation; cheap to read every frame afterwards. */
export interface GlCaps {
  /** Largest square texture dimension the GPU accepts (`MAX_TEXTURE_SIZE`). */
  readonly maxTextureSize: number;
  /** Number of simultaneous colour attachments a framebuffer may have (`MAX_DRAW_BUFFERS`). */
  readonly maxDrawBuffers: number;
  /** Whether `EXT_color_buffer_float` is available, i.e. float formats can be render targets. */
  readonly floatColorBufferSupported: boolean;
  /** Whether an `RGBA16F` texture can actually be attached to a complete framebuffer. */
  readonly hdrSupported: boolean;
}

/**
 * Create a WebGL2 context tuned for this game's pipeline.
 *
 * - `alpha: false` — the canvas is always fully opaque; skipping the alpha channel avoids an
 *   extra blend step the compositor would otherwise perform on every frame.
 * - `antialias: false` — the game renders at a fixed low internal resolution and upscales with
 *   nearest-neighbour sampling, so MSAA would just blur pixel art for no benefit.
 * - `premultipliedAlpha: true` — matches the browser compositor's expected format so blits stay
 *   correct.
 * - `preserveDrawingBuffer: true` — required so the drawing buffer can be blitted onto a 2D
 *   canvas (Classic hybrid rendering path) or read back for pixel-diff tests.
 *
 * Returns `null` rather than throwing so callers can fall back to the Canvas2D renderer.
 */
export function tryCreateWebGL2(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    return gl;
  } catch {
    return null;
  }
}

/** Attempt to attach an `RGBA16F` texture to a framebuffer and check it reports COMPLETE. */
function probeHdrSupport(gl: WebGL2RenderingContext): boolean {
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    return status === gl.FRAMEBUFFER_COMPLETE;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
  }
}

function probeCaps(gl: WebGL2RenderingContext): GlCaps {
  const floatColorBufferSupported = gl.getExtension('EXT_color_buffer_float') !== null;
  return {
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
    floatColorBufferSupported,
    hdrSupported: floatColorBufferSupported && probeHdrSupport(gl),
  };
}

/**
 * Thin device wrapper around a live `WebGL2RenderingContext`.
 *
 * Holds capability probes taken once at construction and tracks context loss/restore so higher
 * layers (the renderer, resource caches) can react instead of calling into a dead context.
 */
export class GlDevice {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCaps;

  private lost = false;
  private readonly boundTextureUnits = new Map<number, WebGLTexture | null>();
  private readonly onContextLost = (event: Event): void => {
    // WebGL loses the context asynchronously; without this the browser never offers it back.
    event.preventDefault();
    this.lost = true;
    this.boundTextureUnits.clear();
  };
  private readonly onContextRestored = (): void => {
    this.lost = false;
  };

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.caps = probeCaps(gl);
    gl.canvas.addEventListener('webglcontextlost', this.onContextLost);
    gl.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  /** True once `webglcontextlost` has fired and no `webglcontextrestored` has followed it yet. */
  get isLost(): boolean {
    return this.lost;
  }

  /** Bind a texture to a unit, skipping the call if it is already bound there. */
  bindTexture(unit: number, texture: WebGLTexture | null): void {
    if (this.boundTextureUnits.get(unit) === texture) return;
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    this.boundTextureUnits.set(unit, texture);
  }

  /** Forget cached texture-unit bindings, e.g. after another caller bypassed {@link bindTexture}. */
  invalidateTextureBindings(): void {
    this.boundTextureUnits.clear();
  }

  /** Detach the loss/restore listeners. Does not free GPU resources owned by other classes. */
  dispose(): void {
    this.gl.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.gl.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
  }
}
