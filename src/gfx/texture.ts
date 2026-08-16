/**
 * Texture creation and pixel formats.
 *
 * The format table matters more than it looks. The deferred pipeline runs a
 * dozen fullscreen passes per frame, and on integrated GPUs those passes are
 * bandwidth-bound rather than ALU-bound — so choosing `RGBA16F` where `RGBA8`
 * would do quietly halves the frame rate. Each format below is annotated with
 * why it was chosen for its role.
 */

import { Device, GfxError } from './device.ts';

export const enum TexFormat {
  /** 8-bit RGBA. Albedo, material channels, UI. */
  RGBA8,
  /** 8-bit single channel. Occluder masks, AO. */
  R8,
  /** 8-bit two channel. Screen-space distortion offsets. */
  RG8,
  /**
   * Half-float RGBA. HDR light accumulation and the bloom chain.
   * Half precision is ample for colour and costs half the bandwidth of full.
   */
  RGBA16F,
  /** Full-float RGBA. Reserved for cases where half-float banding shows. */
  RGBA32F,
  /** Half-float single channel. Scene depth. */
  R16F,
}

export const enum Filter {
  Nearest,
  Linear,
  /** Linear with mipmapping; for atlases sampled at varying scales. */
  LinearMipmap,
}

export const enum Wrap {
  Clamp,
  Repeat,
  MirrorRepeat,
}

export interface TextureOptions {
  filter?: Filter;
  wrap?: Wrap;
  format?: TexFormat;
  /** Anisotropic filtering level; clamped to hardware support. */
  anisotropy?: number;
  label?: string;
}

interface FormatSpec {
  internalFormat: number;
  format: number;
  type: number;
  /** Bytes per pixel, for the texture-memory budget audit. */
  bytesPerPixel: number;
  /** Whether linear filtering is legal without extra extensions. */
  filterable: boolean;
}

/** Resolves a format descriptor against the live context's enum values. */
function formatSpec(gl: WebGL2RenderingContext, format: TexFormat): FormatSpec {
  switch (format) {
    case TexFormat.RGBA8:
      return {
        internalFormat: gl.RGBA8,
        format: gl.RGBA,
        type: gl.UNSIGNED_BYTE,
        bytesPerPixel: 4,
        filterable: true,
      };
    case TexFormat.R8:
      return {
        internalFormat: gl.R8,
        format: gl.RED,
        type: gl.UNSIGNED_BYTE,
        bytesPerPixel: 1,
        filterable: true,
      };
    case TexFormat.RG8:
      return {
        internalFormat: gl.RG8,
        format: gl.RG,
        type: gl.UNSIGNED_BYTE,
        bytesPerPixel: 2,
        filterable: true,
      };
    case TexFormat.RGBA16F:
      return {
        internalFormat: gl.RGBA16F,
        format: gl.RGBA,
        type: gl.HALF_FLOAT,
        bytesPerPixel: 8,
        filterable: true,
      };
    case TexFormat.RGBA32F:
      return {
        internalFormat: gl.RGBA32F,
        format: gl.RGBA,
        type: gl.FLOAT,
        bytesPerPixel: 16,
        filterable: false,
      };
    case TexFormat.R16F:
      return {
        internalFormat: gl.R16F,
        format: gl.RED,
        type: gl.HALF_FLOAT,
        bytesPerPixel: 2,
        filterable: true,
      };
    default: {
      // Exhaustiveness guard: adding a format without handling it here becomes
      // a compile error rather than a runtime surprise.
      const never: never = format;
      throw new GfxError(`Unhandled texture format: ${never}`);
    }
  }
}

/** Running total of GPU texture memory, checked against the budget. */
let textureMemoryBytes = 0;

export const getTextureMemoryBytes = (): number => textureMemoryBytes;

export class Texture {
  readonly handle: WebGLTexture;
  readonly format: TexFormat;
  readonly label: string;
  width: number;
  height: number;
  private readonly spec: FormatSpec;
  private byteSize = 0;
  private disposed = false;

  constructor(
    private readonly device: Device,
    width: number,
    height: number,
    options: TextureOptions = {},
  ) {
    const gl = device.gl;
    const handle = gl.createTexture();
    if (!handle) throw new GfxError('Could not create texture');

    this.handle = handle;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.format = options.format ?? TexFormat.RGBA8;
    this.label = options.label ?? 'texture';
    this.spec = formatSpec(gl, this.format);

    if (this.width > device.caps.maxTextureSize || this.height > device.caps.maxTextureSize) {
      throw new GfxError(
        `Texture "${this.label}" is ${this.width}x${this.height}, exceeding the ` +
          `${device.caps.maxTextureSize}px hardware limit.`,
      );
    }

    device.bindTexture(0, handle);
    gl.texStorage2D(
      gl.TEXTURE_2D,
      options.filter === Filter.LinearMipmap ? mipLevels(this.width, this.height) : 1,
      this.spec.internalFormat,
      this.width,
      this.height,
    );

    this.applyParameters(options);
    this.trackMemory();
  }

  private applyParameters(options: TextureOptions): void {
    const gl = this.device.gl;
    const filter = options.filter ?? Filter.Linear;
    const wrap = options.wrap ?? Wrap.Clamp;

    // Requesting linear filtering on a non-filterable format is silently
    // ignored by some drivers and an error on others; force nearest instead.
    const wantsLinear = filter !== Filter.Nearest;
    const canFilter = this.spec.filterable || this.device.caps.floatLinear;
    const useLinear = wantsLinear && canFilter;

    const minFilter =
      filter === Filter.LinearMipmap && canFilter
        ? gl.LINEAR_MIPMAP_LINEAR
        : useLinear
          ? gl.LINEAR
          : gl.NEAREST;
    const magFilter = useLinear ? gl.LINEAR : gl.NEAREST;

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);

    const wrapMode =
      wrap === Wrap.Repeat
        ? gl.REPEAT
        : wrap === Wrap.MirrorRepeat
          ? gl.MIRRORED_REPEAT
          : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);

    const ext = this.device.anisotropicExt;
    if (ext && options.anisotropy && options.anisotropy > 1) {
      gl.texParameterf(
        gl.TEXTURE_2D,
        ext.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(options.anisotropy, this.device.caps.anisotropy),
      );
    }
  }

  private trackMemory(): void {
    textureMemoryBytes -= this.byteSize;
    this.byteSize = this.width * this.height * this.spec.bytesPerPixel;
    textureMemoryBytes += this.byteSize;
  }

  /** Upload pixel data covering the whole texture. */
  upload(pixels: ArrayBufferView | null): void {
    const gl = this.device.gl;
    this.device.bindTexture(0, this.handle);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width,
      this.height,
      this.spec.format,
      this.spec.type,
      pixels,
    );
  }

  /** Upload from an image, canvas, or bitmap source. */
  uploadImage(source: TexImageSource): void {
    const gl = this.device.gl;
    this.device.bindTexture(0, this.handle);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.width,
      this.height,
      this.spec.format,
      this.spec.type,
      source,
    );
  }

  generateMipmaps(): void {
    const gl = this.device.gl;
    this.device.bindTexture(0, this.handle);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  bind(unit: number): void {
    this.device.bindTexture(unit, this.handle);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    textureMemoryBytes -= this.byteSize;
    this.device.gl.deleteTexture(this.handle);
  }
}

function mipLevels(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * Creates a 1x1 texture of a solid colour.
 *
 * Used as a stand-in whenever a shader expects a texture that a given draw does
 * not have — a white pixel for untextured geometry, a flat normal for
 * unlit props. Binding a dummy is far cheaper than compiling a second shader
 * variant for the missing-texture case.
 */
export function solidTexture(device: Device, r: number, g: number, b: number, a: number): Texture {
  const texture = new Texture(device, 1, 1, { filter: Filter.Nearest, label: 'solid' });
  texture.upload(new Uint8Array([r * 255, g * 255, b * 255, a * 255]));
  return texture;
}
