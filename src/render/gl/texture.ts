/**
 * 2D texture wrapper.
 *
 * Keeps the handful of texture formats this game actually uses (8-bit colour, 16-bit-float HDR
 * colour, single-channel masks) behind an enum instead of scattering raw `gl.RGBA8` constants
 * through render code.
 */

export enum TexFormat {
  /** Standard 8-bit-per-channel colour, the default for sprites and render targets. */
  RGBA8 = 'RGBA8',
  /** Half-float colour for HDR render targets (requires {@link GlCaps.hdrSupported}). */
  RGBA16F = 'RGBA16F',
  /** Single 8-bit channel, e.g. for lightmaps or alpha-only masks. */
  R8 = 'R8',
}

export enum Filter {
  Nearest = 'Nearest',
  Linear = 'Linear',
}

export enum Wrap {
  Clamp = 'Clamp',
  Repeat = 'Repeat',
  MirroredRepeat = 'MirroredRepeat',
}

interface FormatInfo {
  readonly internalFormat: GLenum;
  readonly format: GLenum;
  readonly type: GLenum;
  readonly channels: number;
  /** Bytes per channel for the upload type (e.g. 1 for `UNSIGNED_BYTE`, 2 for `HALF_FLOAT`). */
  readonly bytesPerChannel: number;
}

function formatInfo(gl: WebGL2RenderingContext, format: TexFormat): FormatInfo {
  switch (format) {
    case TexFormat.RGBA8:
      return {
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        channels: 4,
        bytesPerChannel: 1,
      };
    case TexFormat.RGBA16F:
      return {
        internalFormat: gl.RGBA16F,
        format: gl.RGBA,
        type: gl.HALF_FLOAT,
        channels: 4,
        bytesPerChannel: 2,
      };
    case TexFormat.R8:
      return {
        internalFormat: gl.R8,
        format: gl.RED,
        type: gl.UNSIGNED_BYTE,
        channels: 1,
        bytesPerChannel: 1,
      };
    default: {
      const exhaustive: never = format;
      throw new Error(`Unhandled TexFormat: ${String(exhaustive)}`);
    }
  }
}

function filterEnum(gl: WebGL2RenderingContext, filter: Filter): GLenum {
  switch (filter) {
    case Filter.Nearest:
      return gl.NEAREST;
    case Filter.Linear:
      return gl.LINEAR;
    default: {
      const exhaustive: never = filter;
      throw new Error(`Unhandled Filter: ${String(exhaustive)}`);
    }
  }
}

function wrapEnum(gl: WebGL2RenderingContext, wrap: Wrap): GLenum {
  switch (wrap) {
    case Wrap.Clamp:
      return gl.CLAMP_TO_EDGE;
    case Wrap.Repeat:
      return gl.REPEAT;
    case Wrap.MirroredRepeat:
      return gl.MIRRORED_REPEAT;
    default: {
      const exhaustive: never = wrap;
      throw new Error(`Unhandled Wrap: ${String(exhaustive)}`);
    }
  }
}

export interface TextureOptions {
  readonly filter?: Filter;
  readonly wrap?: Wrap;
}

/**
 * A single 2D texture with a fixed format, resizable in place.
 *
 * No mipmaps: everything this game draws is either pixel-art (nearest filtering, no mip chain
 * needed) or a full-screen HDR target (resolved every frame, so a mip chain would be wasted work).
 */
export class Texture {
  readonly gl: WebGL2RenderingContext;
  readonly handle: WebGLTexture;
  readonly format: TexFormat;

  private texWidth = 0;
  private texHeight = 0;

  constructor(gl: WebGL2RenderingContext, format: TexFormat, options: TextureOptions = {}) {
    this.gl = gl;
    this.format = format;
    this.handle = gl.createTexture();

    const filter = options.filter ?? Filter.Nearest;
    const wrap = options.wrap ?? Wrap.Clamp;
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterEnum(gl, filter));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterEnum(gl, filter));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapEnum(gl, wrap));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapEnum(gl, wrap));
  }

  get width(): number {
    return this.texWidth;
  }

  get height(): number {
    return this.texHeight;
  }

  /** Allocate storage with no image data (e.g. as a render-target attachment). */
  createEmpty(width: number, height: number): void {
    const { gl } = this;
    const info = formatInfo(gl, this.format);
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.texImage2D(gl.TEXTURE_2D, 0, info.internalFormat, width, height, 0, info.format, info.type, null);
    this.texWidth = width;
    this.texHeight = height;
  }

  /**
   * Upload pixel data matching this texture's format (e.g. `Uint8Array` for {@link TexFormat.RGBA8},
   * `Float32Array`/`Uint16Array` for {@link TexFormat.RGBA16F}).
   */
  upload(data: ArrayBufferView, width: number, height: number): void {
    const { gl } = this;
    const info = formatInfo(gl, this.format);
    const expectedBytes = width * height * info.channels * info.bytesPerChannel;
    if (data.byteLength !== expectedBytes) {
      throw new Error(
        `Texture upload size mismatch: expected ${String(expectedBytes)} bytes for a ` +
          `${String(width)}x${String(height)} ${this.format} texture, got ${String(data.byteLength)}.`,
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.texImage2D(gl.TEXTURE_2D, 0, info.internalFormat, width, height, 0, info.format, info.type, data);
    this.texWidth = width;
    this.texHeight = height;
  }

  /** Convenience wrapper for uploading 8-bit RGBA pixels into an {@link TexFormat.RGBA8} texture. */
  uploadRGBA(data: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
    if (this.format !== TexFormat.RGBA8) {
      throw new Error(`uploadRGBA() requires an RGBA8 texture, this one is ${this.format}.`);
    }
    this.upload(data, width, height);
  }

  /**
   * Upload directly from a canvas/image/bitmap source (e.g. a procedurally-painted parallax
   * layer), skipping the `ArrayBufferView` staging step. Always uploads without a Y flip: texture
   * `v = 0` ends up at the source's first (top) row, which is what every GL-rendered pass in this
   * codebase already assumes for its own render targets — see `src/render/gl/backgroundBatch.ts`.
   */
  uploadImage(source: TexImageSource, width: number, height: number): void {
    const { gl } = this;
    const info = formatInfo(gl, this.format);
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, info.internalFormat, info.format, info.type, source);
    this.texWidth = width;
    this.texHeight = height;
  }

  /** Bind this texture to a texture unit for sampling. */
  bind(unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.handle);
  }

  /** Reallocate storage at a new size, discarding existing pixel data. */
  resize(width: number, height: number): void {
    if (width === this.texWidth && height === this.texHeight) return;
    this.createEmpty(width, height);
  }

  dispose(): void {
    this.gl.deleteTexture(this.handle);
  }
}
