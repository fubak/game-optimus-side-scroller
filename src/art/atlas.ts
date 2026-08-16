/**
 * Texture atlas packing.
 *
 * Every sprite the game draws must come from one of a small number of atlases,
 * because the batcher can only merge consecutive draws that share a texture.
 * An unatlased scene would flush on every single sprite and collapse the frame
 * rate regardless of how fast the shaders are.
 *
 * Three pages are produced per atlas, sharing one UV layout: albedo,
 * normal+height, and material. They are generated together from the same source
 * surfaces, so they cannot drift out of alignment.
 */

import { Device } from '../gfx/device.ts';
import { Texture, TexFormat, Filter, Wrap } from '../gfx/texture.ts';
import type { TextureSet } from '../gfx/batch.ts';
import {
  type Surface,
  heightToNormalMap,
  packMaterialMap,
  premultiply,
} from './texgen.ts';
import { PIXELS_PER_METRE } from '../core/config.ts';

export interface AtlasEntry {
  name: string;
  /** UV rectangle within the atlas. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Pixel dimensions. */
  width: number;
  height: number;
  /** Physical size in metres — the value the scale audit checks. */
  widthMetres: number;
  heightMetres: number;
  /** Origin within the sprite, normalised, for rotation and attachment. */
  pivotX: number;
  pivotY: number;
}

export interface AtlasSource {
  name: string;
  surface: Surface;
  /**
   * Physical width in metres. Height follows from the aspect ratio, which
   * guarantees a sprite can never be non-uniformly scaled by accident.
   */
  widthMetres: number;
  pivotX?: number;
  pivotY?: number;
}

/**
 * Packs sources into an atlas using a shelf algorithm.
 *
 * Shelf packing is not the tightest option, but the inputs are generated at
 * controlled sizes rather than being arbitrary, so the wasted space is small
 * and the predictable row structure makes the output far easier to inspect
 * when debugging a UV problem.
 */
export class Atlas {
  readonly entries = new Map<string, AtlasEntry>();
  readonly textures: TextureSet;
  readonly width: number;
  readonly height: number;

  constructor(device: Device, sources: AtlasSource[], maxWidth = 2048) {
    /** Transparent gutter between entries, to stop bilinear filtering bleeding. */
    const padding = 2;

    // --- Layout ------------------------------------------------------------
    const sorted = [...sources].sort((a, b) => b.surface.height - a.surface.height);

    let shelfX = padding;
    let shelfY = padding;
    let shelfHeight = 0;
    let usedWidth = 0;

    const placements: { source: AtlasSource; x: number; y: number }[] = [];

    for (const source of sorted) {
      const w = source.surface.width;
      const h = source.surface.height;

      if (shelfX + w + padding > maxWidth) {
        shelfX = padding;
        shelfY += shelfHeight + padding;
        shelfHeight = 0;
      }

      placements.push({ source, x: shelfX, y: shelfY });
      shelfX += w + padding;
      shelfHeight = Math.max(shelfHeight, h);
      usedWidth = Math.max(usedWidth, shelfX);
    }

    this.width = nextPowerOfTwo(Math.min(maxWidth, Math.max(usedWidth + padding, 4)));
    this.height = nextPowerOfTwo(shelfY + shelfHeight + padding);

    // --- Rasterise ---------------------------------------------------------
    const pixelCount = this.width * this.height;
    const albedoData = new Uint8ClampedArray(pixelCount * 4);
    const normalData = new Uint8ClampedArray(pixelCount * 4);
    const materialData = new Uint8ClampedArray(pixelCount * 4);

    // Empty atlas space must still decode as a sane normal, otherwise bilinear
    // taps near an entry's edge pull in a garbage direction.
    for (let i = 0; i < pixelCount; i++) {
      normalData[i * 4] = 128;
      normalData[i * 4 + 1] = 128;
      normalData[i * 4 + 2] = 0;
      normalData[i * 4 + 3] = 255;
      materialData[i * 4] = 160;
    }

    for (const { source, x, y } of placements) {
      const surface = source.surface;
      const normal = heightToNormalMap(surface, 2.2);
      const material = packMaterialMap(surface);
      const albedo = premultiply(Uint8ClampedArray.from(surface.albedo));

      blit(albedoData, this.width, albedo, surface.width, surface.height, x, y);
      blit(normalData, this.width, normal, surface.width, surface.height, x, y);
      blit(materialData, this.width, material, surface.width, surface.height, x, y);

      const heightMetres = (source.widthMetres * surface.height) / surface.width;

      this.entries.set(source.name, {
        name: source.name,
        // Half-texel inset stops bilinear filtering sampling the neighbouring
        // entry, which shows up as a bright seam along sprite edges.
        u0: (x + 0.5) / this.width,
        v0: (y + 0.5) / this.height,
        u1: (x + surface.width - 0.5) / this.width,
        v1: (y + surface.height - 0.5) / this.height,
        width: surface.width,
        height: surface.height,
        widthMetres: source.widthMetres,
        heightMetres,
        pivotX: source.pivotX ?? 0.5,
        pivotY: source.pivotY ?? 0.5,
      });
    }

    const makeTexture = (data: Uint8ClampedArray, label: string): Texture => {
      const texture = new Texture(device, this.width, this.height, {
        format: TexFormat.RGBA8,
        filter: Filter.Linear,
        wrap: Wrap.Clamp,
        label,
      });
      texture.upload(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return texture;
    };

    this.textures = {
      albedo: makeTexture(albedoData, 'atlas-albedo'),
      normal: makeTexture(normalData, 'atlas-normal'),
      material: makeTexture(materialData, 'atlas-material'),
    };
  }

  get(name: string): AtlasEntry {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(
        `Atlas entry "${name}" does not exist. Available: ${[...this.entries.keys()].join(', ')}`,
      );
    }
    return entry;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  dispose(): void {
    this.textures.albedo.dispose();
    this.textures.normal.dispose();
    this.textures.material.dispose();
  }
}

function blit(
  destination: Uint8ClampedArray,
  destinationWidth: number,
  source: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  offsetX: number,
  offsetY: number,
): void {
  for (let y = 0; y < sourceHeight; y++) {
    const sourceRow = y * sourceWidth * 4;
    const destinationRow = ((offsetY + y) * destinationWidth + offsetX) * 4;
    destination.set(source.subarray(sourceRow, sourceRow + sourceWidth * 4), destinationRow);
  }
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/** Converts a size in metres into the texel count to generate for it. */
export const metresToTexels = (metres: number, supersample = 1): number =>
  Math.max(2, Math.round(metres * PIXELS_PER_METRE * supersample));
