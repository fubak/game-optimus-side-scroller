/**
 * Off-screen render targets, including the multi-attachment target used for the
 * deferred G-buffer.
 *
 * The pipeline allocates a lot of these — G-buffer, light accumulation, six
 * bloom mip levels up and down, blur ping-pong pairs, distortion — and they all
 * have to be reallocated whenever the window resizes or dynamic resolution
 * scaling kicks in. {@link RenderTargetPool} exists so that reallocation is a
 * single call rather than a source of leaks.
 */

import { Device, GfxError } from './device.ts';
import { Texture, TexFormat, Filter, Wrap, type TextureOptions } from './texture.ts';

export interface RenderTargetOptions {
  /**
   * One entry per colour attachment. The deferred geometry pass uses four:
   * albedo, normal+height, material, and depth.
   */
  attachments: { format: TexFormat; filter?: Filter; wrap?: Wrap; label?: string }[];
  label?: string;
}

export class RenderTarget {
  readonly framebuffer: WebGLFramebuffer;
  readonly textures: Texture[];
  readonly label: string;
  width: number;
  height: number;
  private readonly drawBuffers: number[];
  private disposed = false;

  constructor(
    private readonly device: Device,
    width: number,
    height: number,
    private readonly options: RenderTargetOptions,
  ) {
    const gl = device.gl;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.label = options.label ?? 'target';

    if (options.attachments.length === 0) {
      throw new GfxError(`Render target "${this.label}" needs at least one attachment`);
    }
    if (options.attachments.length > device.caps.maxDrawBuffers) {
      throw new GfxError(
        `Render target "${this.label}" wants ${options.attachments.length} attachments ` +
          `but the GPU supports ${device.caps.maxDrawBuffers}`,
      );
    }

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new GfxError(`Could not create framebuffer "${this.label}"`);
    this.framebuffer = framebuffer;

    this.textures = [];
    this.drawBuffers = [];

    device.bindFramebuffer(framebuffer);
    for (let i = 0; i < options.attachments.length; i++) {
      const spec = options.attachments[i]!;
      const textureOptions: TextureOptions = {
        format: spec.format,
        filter: spec.filter ?? Filter.Linear,
        wrap: spec.wrap ?? Wrap.Clamp,
        label: spec.label ?? `${this.label}[${i}]`,
      };
      const texture = new Texture(device, this.width, this.height, textureOptions);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0 + i,
        gl.TEXTURE_2D,
        texture.handle,
        0,
      );
      this.textures.push(texture);
      this.drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
    }

    gl.drawBuffers(this.drawBuffers);
    this.verify();
  }

  private verify(): void {
    const gl = this.device.gl;
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status === gl.FRAMEBUFFER_COMPLETE) return;

    const names: Record<number, string> = {
      [gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT]: 'INCOMPLETE_ATTACHMENT',
      [gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT]: 'INCOMPLETE_MISSING_ATTACHMENT',
      [gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS]: 'INCOMPLETE_DIMENSIONS',
      [gl.FRAMEBUFFER_UNSUPPORTED]: 'UNSUPPORTED',
      [gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE]: 'INCOMPLETE_MULTISAMPLE',
    };
    throw new GfxError(
      `Framebuffer "${this.label}" is incomplete: ${names[status] ?? status}. ` +
        `(${this.width}x${this.height}, ${this.options.attachments.length} attachments)`,
    );
  }

  /** The primary colour attachment. */
  get texture(): Texture {
    return this.textures[0]!;
  }

  /** Bind for drawing and set the viewport to cover it. */
  bind(): void {
    this.device.bindFramebuffer(this.framebuffer);
    this.device.setViewport(0, 0, this.width, this.height);
    // Draw buffers are framebuffer state, but some drivers reset them when the
    // binding changes, so reassert on every bind.
    if (this.drawBuffers.length > 1) {
      this.device.gl.drawBuffers(this.drawBuffers);
    }
  }

  /** Bind and clear in one call. */
  bindAndClear(r = 0, g = 0, b = 0, a = 0): void {
    this.bind();
    const gl = this.device.gl;
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Clear a single attachment to a specific value.
   *
   * Needed because the G-buffer's attachments want different clear values — a
   * normal buffer must clear to a flat forward-facing normal (0.5, 0.5), not to
   * black, or unwritten pixels would be lit as though they faced down-left.
   */
  clearAttachment(index: number, values: [number, number, number, number]): void {
    this.bind();
    this.device.gl.clearBufferfv(this.device.gl.COLOR, index, values);
  }

  /** Reallocate at a new size. No-op if the size is unchanged. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;

    const gl = this.device.gl;
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;

    this.width = w;
    this.height = h;

    this.device.bindFramebuffer(this.framebuffer);
    for (let i = 0; i < this.options.attachments.length; i++) {
      const spec = this.options.attachments[i]!;
      const texture = new Texture(this.device, w, h, {
        format: spec.format,
        filter: spec.filter ?? Filter.Linear,
        wrap: spec.wrap ?? Wrap.Clamp,
        label: spec.label ?? `${this.label}[${i}]`,
      });
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0 + i,
        gl.TEXTURE_2D,
        texture.handle,
        0,
      );
      this.textures.push(texture);
    }
    gl.drawBuffers(this.drawBuffers);
    this.verify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures) texture.dispose();
    this.textures.length = 0;
    this.device.gl.deleteFramebuffer(this.framebuffer);
  }
}

/**
 * Owns every render target in the pipeline so they can be resized or released
 * together.
 *
 * Targets are registered with a size *function* rather than a fixed size, which
 * is what lets half-resolution and mip-chain targets follow the main resolution
 * automatically when dynamic resolution scaling adjusts it mid-frame.
 */
export class RenderTargetPool {
  private readonly entries: { target: RenderTarget; size: (w: number, h: number) => [number, number] }[] =
    [];

  constructor(private readonly device: Device) {}

  create(
    label: string,
    attachments: RenderTargetOptions['attachments'],
    baseWidth: number,
    baseHeight: number,
    size: (w: number, h: number) => [number, number] = (w, h) => [w, h],
  ): RenderTarget {
    const [w, h] = size(baseWidth, baseHeight);
    const target = new RenderTarget(this.device, w, h, { attachments, label });
    this.entries.push({ target, size });
    return target;
  }

  /** Resize every registered target against a new base resolution. */
  resizeAll(baseWidth: number, baseHeight: number): void {
    for (const entry of this.entries) {
      const [w, h] = entry.size(baseWidth, baseHeight);
      entry.target.resize(w, h);
    }
  }

  disposeAll(): void {
    for (const entry of this.entries) entry.target.dispose();
    this.entries.length = 0;
  }

  get count(): number {
    return this.entries.length;
  }
}

/** Half resolution, for the occluder mask and volumetrics. */
export const halfRes = (w: number, h: number): [number, number] => [
  Math.max(1, Math.ceil(w / 2)),
  Math.max(1, Math.ceil(h / 2)),
];

/** Arbitrary downscale, for bloom mip levels. */
export const divRes =
  (divisor: number) =>
  (w: number, h: number): [number, number] => [
    Math.max(1, Math.ceil(w / divisor)),
    Math.max(1, Math.ceil(h / divisor)),
  ];
