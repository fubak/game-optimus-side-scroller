/**
 * WebGL2 device: context creation, capability detection, and redundant-state
 * elimination.
 *
 * Every GL call in the engine goes through this object. The reason is the state
 * cache: `bindTexture`, `useProgram`, and `bindFramebuffer` are among the most
 * expensive calls in the API, and a batched 2D renderer naturally issues the
 * same bind hundreds of times per frame. Filtering out the no-ops here is worth
 * more than any micro-optimisation inside the shaders.
 */

export interface DeviceCapabilities {
  maxTextureSize: number;
  maxTextureUnits: number;
  maxDrawBuffers: number;
  maxSamples: number;
  /** Required for the HDR lighting accumulation buffer. */
  colorBufferFloat: boolean;
  colorBufferHalfFloat: boolean;
  /** Required to filter the float bloom chain smoothly. */
  floatLinear: boolean;
  anisotropy: number;
  debugRendererInfo: string;
}

export class GfxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GfxError';
  }
}

export class Device {
  readonly gl: WebGL2RenderingContext;
  readonly caps: DeviceCapabilities;
  readonly anisotropicExt: EXT_texture_filter_anisotropic | null;

  /** Draw calls and triangles issued since the last {@link resetFrameStats}. */
  readonly frameStats = { drawCalls: 0, triangles: 0, textureBinds: 0, programBinds: 0, targetBinds: 0 };

  private currentProgram: WebGLProgram | null = null;
  private currentFramebuffer: WebGLFramebuffer | null = null;
  private currentVAO: WebGLVertexArrayObject | null = null;
  private readonly boundTextures: (WebGLTexture | null)[];
  private activeTextureUnit = 0;

  private blendEnabled = false;
  private blendSrcRGB = 0;
  private blendDstRGB = 0;
  private blendSrcAlpha = 0;
  private blendDstAlpha = 0;

  private viewportX = -1;
  private viewportY = -1;
  private viewportW = -1;
  private viewportH = -1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      // Anti-aliasing is done in post; a multisampled default framebuffer would
      // just be wasted bandwidth we never read from.
      antialias: false,
      // The renderer is fully 2D and sorts by layer on the CPU.
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true, // required for in-page frame capture
      powerPreference: 'high-performance',
      desynchronized: true,
    });

    if (!gl) {
      throw new GfxError(
        'WebGL2 is not available. This game requires a WebGL2-capable browser ' +
          '(Chrome 56+, Firefox 51+, Safari 15+).',
      );
    }
    this.gl = gl;

    const colorBufferFloat = !!gl.getExtension('EXT_color_buffer_float');
    const colorBufferHalfFloat =
      colorBufferFloat || !!gl.getExtension('EXT_color_buffer_half_float');
    const floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.anisotropicExt = gl.getExtension('EXT_texture_filter_anisotropic');

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));

    this.caps = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
      maxSamples: gl.getParameter(gl.MAX_SAMPLES) as number,
      colorBufferFloat,
      colorBufferHalfFloat,
      floatLinear,
      anisotropy: this.anisotropicExt
        ? (gl.getParameter(this.anisotropicExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
        : 1,
      debugRendererInfo: rendererName,
    };

    // The deferred pipeline writes albedo, normal+height, material, and depth
    // in a single geometry pass. Without 4 draw buffers it would need four
    // separate passes over the same geometry, which is not a trade worth making.
    if (this.caps.maxDrawBuffers < 4) {
      throw new GfxError(
        `This GPU reports only ${this.caps.maxDrawBuffers} draw buffers; the ` +
          'deferred renderer requires at least 4.',
      );
    }
    if (!colorBufferHalfFloat) {
      throw new GfxError(
        'Floating-point render targets are unavailable, so HDR lighting cannot ' +
          'be accumulated.',
      );
    }

    this.boundTextures = new Array<WebGLTexture | null>(this.caps.maxTextureUnits).fill(null);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    this.setBlend(BlendMode.Alpha);
  }

  useProgram(program: WebGLProgram | null): void {
    if (this.currentProgram === program) return;
    this.currentProgram = program;
    this.gl.useProgram(program);
    this.frameStats.programBinds++;
  }

  bindFramebuffer(framebuffer: WebGLFramebuffer | null): void {
    if (this.currentFramebuffer === framebuffer) return;
    this.currentFramebuffer = framebuffer;
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);
    this.frameStats.targetBinds++;
  }

  bindVAO(vao: WebGLVertexArrayObject | null): void {
    if (this.currentVAO === vao) return;
    this.currentVAO = vao;
    this.gl.bindVertexArray(vao);
  }

  bindTexture(unit: number, texture: WebGLTexture | null, target = this.gl.TEXTURE_2D): void {
    if (this.boundTextures[unit] === texture) return;
    this.boundTextures[unit] = texture;
    if (this.activeTextureUnit !== unit) {
      this.gl.activeTexture(this.gl.TEXTURE0 + unit);
      this.activeTextureUnit = unit;
    }
    this.gl.bindTexture(target, texture);
    this.frameStats.textureBinds++;
  }

  setViewport(x: number, y: number, width: number, height: number): void {
    if (
      this.viewportX === x &&
      this.viewportY === y &&
      this.viewportW === width &&
      this.viewportH === height
    ) {
      return;
    }
    this.viewportX = x;
    this.viewportY = y;
    this.viewportW = width;
    this.viewportH = height;
    this.gl.viewport(x, y, width, height);
  }

  setBlend(mode: BlendMode): void {
    const gl = this.gl;
    const preset = BLEND_PRESETS[mode];

    if (!preset.enabled) {
      if (this.blendEnabled) {
        gl.disable(gl.BLEND);
        this.blendEnabled = false;
      }
      return;
    }

    if (!this.blendEnabled) {
      gl.enable(gl.BLEND);
      this.blendEnabled = true;
    }
    if (
      this.blendSrcRGB !== preset.srcRGB ||
      this.blendDstRGB !== preset.dstRGB ||
      this.blendSrcAlpha !== preset.srcAlpha ||
      this.blendDstAlpha !== preset.dstAlpha
    ) {
      this.blendSrcRGB = preset.srcRGB;
      this.blendDstRGB = preset.dstRGB;
      this.blendSrcAlpha = preset.srcAlpha;
      this.blendDstAlpha = preset.dstAlpha;
      gl.blendFuncSeparate(preset.srcRGB, preset.dstRGB, preset.srcAlpha, preset.dstAlpha);
    }
  }

  /** Issue a draw call, keeping the frame statistics up to date. */
  drawArrays(mode: number, first: number, count: number): void {
    this.gl.drawArrays(mode, first, count);
    this.frameStats.drawCalls++;
    this.frameStats.triangles += mode === this.gl.TRIANGLES ? count / 3 : Math.max(count - 2, 0);
  }

  drawElements(mode: number, count: number, type: number, offset: number): void {
    this.gl.drawElements(mode, count, type, offset);
    this.frameStats.drawCalls++;
    this.frameStats.triangles += count / 3;
  }

  drawArraysInstanced(mode: number, first: number, count: number, instances: number): void {
    this.gl.drawArraysInstanced(mode, first, count, instances);
    this.frameStats.drawCalls++;
    this.frameStats.triangles += (count / 3) * instances;
  }

  drawElementsInstanced(
    mode: number,
    count: number,
    type: number,
    offset: number,
    instances: number,
  ): void {
    this.gl.drawElementsInstanced(mode, count, type, offset, instances);
    this.frameStats.drawCalls++;
    this.frameStats.triangles += (count / 3) * instances;
  }

  resetFrameStats(): void {
    this.frameStats.drawCalls = 0;
    this.frameStats.triangles = 0;
    this.frameStats.textureBinds = 0;
    this.frameStats.programBinds = 0;
    this.frameStats.targetBinds = 0;
  }

  /**
   * Forget every cached binding.
   *
   * Necessary whenever something outside this class touches the context — the
   * capture harness, for instance — otherwise the cache would suppress binds
   * that really are needed.
   */
  invalidateStateCache(): void {
    this.currentProgram = null;
    this.currentFramebuffer = null;
    this.currentVAO = null;
    this.boundTextures.fill(null);
    this.viewportX = -1;
    this.blendSrcRGB = -1;
  }

  /**
   * Force the GPU to finish all outstanding work.
   *
   * `gl.finish()` is documented to do this but is a no-op under several ANGLE
   * backends — notably the SwiftShader configuration used by the headless
   * capture machine, where it silently returned instantly and made every
   * benchmark read as zero milliseconds. Reading a single pixel back is the
   * only reliable way to force a real flush.
   */
  forceSync(): void {
    const gl = this.gl;
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  }

  /** Throws if the context has recorded an error. Debug builds only. */
  checkError(label: string): void {
    const error = this.gl.getError();
    if (error === this.gl.NO_ERROR) return;
    const names: Record<number, string> = {
      [this.gl.INVALID_ENUM]: 'INVALID_ENUM',
      [this.gl.INVALID_VALUE]: 'INVALID_VALUE',
      [this.gl.INVALID_OPERATION]: 'INVALID_OPERATION',
      [this.gl.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION',
      [this.gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
      [this.gl.CONTEXT_LOST_WEBGL]: 'CONTEXT_LOST_WEBGL',
    };
    throw new GfxError(`GL error at ${label}: ${names[error] ?? error}`);
  }
}

export const enum BlendMode {
  /** Writes replace the destination. */
  None = 0,
  /** Standard source-alpha blending. */
  Alpha = 1,
  /** Inputs are already premultiplied — the correct mode for atlas sprites. */
  Premultiplied = 2,
  /** Purely additive. Light accumulation, glows, sparks. */
  Additive = 3,
  /** Darkens; used for smoke and shadow decals. */
  Multiply = 4,
  /** Additive in the highlights, alpha-like in the shadows. Energy effects. */
  Screen = 5,
}

interface BlendPreset {
  enabled: boolean;
  srcRGB: number;
  dstRGB: number;
  srcAlpha: number;
  dstAlpha: number;
}

// Numeric GL enum values, written literally so the table can be a module-level
// constant rather than needing a live context to build.
const ZERO = 0;
const ONE = 1;
const SRC_ALPHA = 0x0302;
const ONE_MINUS_SRC_ALPHA = 0x0303;
const ONE_MINUS_SRC_COLOR = 0x0301;
const DST_COLOR = 0x0306;

const BLEND_PRESETS: Record<BlendMode, BlendPreset> = {
  [BlendMode.None]: { enabled: false, srcRGB: ONE, dstRGB: ZERO, srcAlpha: ONE, dstAlpha: ZERO },
  [BlendMode.Alpha]: {
    enabled: true,
    srcRGB: SRC_ALPHA,
    dstRGB: ONE_MINUS_SRC_ALPHA,
    srcAlpha: ONE,
    dstAlpha: ONE_MINUS_SRC_ALPHA,
  },
  [BlendMode.Premultiplied]: {
    enabled: true,
    srcRGB: ONE,
    dstRGB: ONE_MINUS_SRC_ALPHA,
    srcAlpha: ONE,
    dstAlpha: ONE_MINUS_SRC_ALPHA,
  },
  [BlendMode.Additive]: { enabled: true, srcRGB: ONE, dstRGB: ONE, srcAlpha: ONE, dstAlpha: ONE },
  [BlendMode.Multiply]: {
    enabled: true,
    srcRGB: DST_COLOR,
    dstRGB: ZERO,
    srcAlpha: ZERO,
    dstAlpha: ONE,
  },
  [BlendMode.Screen]: {
    enabled: true,
    srcRGB: ONE,
    dstRGB: ONE_MINUS_SRC_COLOR,
    srcAlpha: ONE,
    dstAlpha: ONE_MINUS_SRC_ALPHA,
  },
};
