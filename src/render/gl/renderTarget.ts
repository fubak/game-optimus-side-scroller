/**
 * Multi-attachment (MRT) render target.
 *
 * Wraps a `WEBGL_draw_buffers`-free WebGL2 framebuffer with N colour attachments, so a deferred
 * G-buffer (albedo, normal, emissive, material) — or a single-attachment HDR accumulation target —
 * is one small, resizable object instead of hand-rolled `createFramebuffer`/`framebufferTexture2D`
 * calls scattered through the renderer. Every attachment is a plain {@link Texture}, so downstream
 * passes bind and sample them exactly like any other texture.
 */

import { Texture } from './texture';
import type { TexFormat, TextureOptions } from './texture';

/** One colour attachment: its pixel format/filtering plus the value it clears to. */
export interface AttachmentSpec extends TextureOptions {
  readonly format: TexFormat;
  /** RGBA clear value. Framebuffers with non-zero "no light" or "facing camera" defaults (e.g. a
   * normal buffer) must clear to that packed value, not black — see {@link RenderTarget.clear}. */
  readonly clear: readonly [number, number, number, number];
}

/**
 * A resizable framebuffer with one or more colour attachments.
 *
 * Attachments are created empty at construction (0×0) and sized by the first {@link resize} call —
 * mirroring {@link Texture}, which is also usable before it has real storage. Every attachment
 * shares this target's size; there is no support for mixed-resolution attachments (half-res
 * targets are just separate `RenderTarget` instances, e.g. a shadow occluder mask).
 */
export class RenderTarget {
  readonly gl: WebGL2RenderingContext;
  readonly textures: readonly Texture[];

  private readonly framebuffer: WebGLFramebuffer;
  private readonly drawBufferEnums: readonly GLenum[];
  private readonly clearValues: readonly (readonly [number, number, number, number])[];
  private targetWidth = 0;
  private targetHeight = 0;

  constructor(gl: WebGL2RenderingContext, attachments: readonly AttachmentSpec[]) {
    if (attachments.length === 0) {
      throw new Error('RenderTarget needs at least one attachment.');
    }
    this.gl = gl;
    this.clearValues = attachments.map((spec) => spec.clear);
    this.textures = attachments.map((spec) => new Texture(gl, spec.format, spec));
    this.drawBufferEnums = attachments.map((_spec, index) => gl.COLOR_ATTACHMENT0 + index);
    this.framebuffer = gl.createFramebuffer();
  }

  get width(): number {
    return this.targetWidth;
  }

  get height(): number {
    return this.targetHeight;
  }

  /** Convenience accessor for the common single-attachment case (HDR accumulation, occluder mask). */
  get texture(): Texture {
    const texture = this.textures[0];
    if (texture === undefined) {
      throw new Error('RenderTarget has no attachments.');
    }
    return texture;
  }

  /** Reallocate every attachment at a new size, discarding their contents. No-op if unchanged. */
  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (nextWidth === this.targetWidth && nextHeight === this.targetHeight) return;
    this.targetWidth = nextWidth;
    this.targetHeight = nextHeight;

    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.textures.forEach((texture, index) => {
      texture.createEmpty(nextWidth, nextHeight);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0 + index,
        gl.TEXTURE_2D,
        texture.handle,
        0,
      );
    });
    gl.drawBuffers(this.drawBufferEnums as GLenum[]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`RenderTarget framebuffer incomplete (status 0x${status.toString(16)}).`);
    }
  }

  /** Bind this target's framebuffer and point the viewport/draw buffers at its attachments. */
  bind(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.targetWidth, this.targetHeight);
    gl.drawBuffers(this.drawBufferEnums as GLenum[]);
  }

  /** Clear every attachment to its configured clear value. Must already be bound. */
  clear(): void {
    const { gl } = this;
    this.clearValues.forEach((value, index) => {
      gl.clearBufferfv(gl.COLOR, index, value as unknown as Float32Array);
    });
  }

  /** {@link bind} followed by {@link clear}, for the common "start this pass fresh" case. */
  bindAndClear(): void {
    this.bind();
    this.clear();
  }

  dispose(): void {
    const { gl } = this;
    for (const texture of this.textures) texture.dispose();
    gl.deleteFramebuffer(this.framebuffer);
  }
}
