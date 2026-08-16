/**
 * Procedural texture generation.
 *
 * The project has no artist, so every pixel is generated from code. That turns
 * out to be an advantage rather than a compromise:
 *
 * - **Normal and material maps come for free.** Each surface is authored as a
 *   *height field* first; the normal map is its gradient and the ambient
 *   occlusion is derived from its local relief. Hand-painted art would need all
 *   three maps drawn separately and kept in sync by hand.
 * - **Scale is exact.** Textures are requested in metres and rasterised at a
 *   known pixels-per-metre, so a 2 m crate and a 1.73 m robot are genuinely in
 *   proportion rather than approximately so.
 * - **The design language cannot drift.** Bevel widths, panel gaps, and wear
 *   patterns are shared constants, so every mechanical surface in the game is
 *   recognisably built by the same hand.
 *
 * Generation runs on `OffscreenCanvas` where available and falls back to a DOM
 * canvas, so the same code path serves both the running game and the headless
 * baker.
 */

import { NoiseField } from '../core/math/noise.ts';
import { clamp01, smoothstep } from '../core/math/scalar.ts';

export interface Surface {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  albedo: Uint8ClampedArray;
  /** Relief in [0, 1]; the source for normals and ambient occlusion. */
  heightField: Float32Array;
  /** Per-pixel roughness in [0, 1]. */
  roughness: Float32Array;
  /** Per-pixel metallic in [0, 1]. */
  metallic: Float32Array;
  /** Per-pixel emissive mask in [0, 1]. */
  emissive: Float32Array;
  /** Per-pixel translucency in [0, 1]. */
  translucency: Float32Array;
}

export function createSurface(width: number, height: number): Surface {
  const pixels = width * height;
  return {
    width,
    height,
    albedo: new Uint8ClampedArray(pixels * 4),
    heightField: new Float32Array(pixels),
    roughness: new Float32Array(pixels).fill(0.6),
    metallic: new Float32Array(pixels),
    emissive: new Float32Array(pixels),
    translucency: new Float32Array(pixels),
  };
}

export function createCanvas(width: number, height: number): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not acquire a 2D context from OffscreenCanvas');
    return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not acquire a 2D context');
  return { canvas, ctx };
}

/**
 * Converts a height field into a tangent-space normal map, packed for the
 * G-buffer as `RG = normal.xy, B = height, A = ambient occlusion`.
 *
 * Uses a Sobel operator rather than a simple forward difference. Forward
 * differences are one-sided and leave a visible directional bias — surfaces end
 * up looking lit from the upper-left even when they are not. Sobel is
 * symmetric, so the derived normals are unbiased.
 */
export function heightToNormalMap(
  surface: Surface,
  strength = 2.0,
  occlusionRadius = 4,
): Uint8ClampedArray {
  const { width, height, heightField } = surface;
  const out = new Uint8ClampedArray(width * height * 4);

  const at = (x: number, y: number): number => {
    // Clamp at the edges so borders do not fold onto the opposite side.
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return heightField[cy * width + cx]!;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length;
      ny /= length;

      // Ambient occlusion: compare this pixel against the average of a
      // neighbourhood. Sitting in a pit means neighbours are higher, so the
      // pixel is darkened; sitting on a ridge leaves it fully lit.
      let neighbourSum = 0;
      let samples = 0;
      for (let dyy = -occlusionRadius; dyy <= occlusionRadius; dyy += 2) {
        for (let dxx = -occlusionRadius; dxx <= occlusionRadius; dxx += 2) {
          if (dxx === 0 && dyy === 0) continue;
          neighbourSum += at(x + dxx, y + dyy);
          samples++;
        }
      }
      const centre = at(x, y);
      const average = samples > 0 ? neighbourSum / samples : centre;
      const occlusion = clamp01(1 - Math.max(0, average - centre) * 2.4);

      const index = (y * width + x) * 4;
      out[index] = (nx * 0.5 + 0.5) * 255;
      out[index + 1] = (ny * 0.5 + 0.5) * 255;
      out[index + 2] = centre * 255;
      out[index + 3] = occlusion * 255;
    }
  }
  return out;
}

/** Packs the material channels into an RGBA buffer for the G-buffer. */
export function packMaterialMap(surface: Surface): Uint8ClampedArray {
  const { width, height, roughness, metallic, emissive, translucency } = surface;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = roughness[i]! * 255;
    out[i * 4 + 1] = metallic[i]! * 255;
    out[i * 4 + 2] = emissive[i]! * 255;
    out[i * 4 + 3] = translucency[i]! * 255;
  }
  return out;
}

/** Writes a pixel's albedo and coverage. */
export function setPixel(
  surface: Surface,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return;
  const index = (y * surface.width + x) * 4;
  surface.albedo[index] = r * 255;
  surface.albedo[index + 1] = g * 255;
  surface.albedo[index + 2] = b * 255;
  surface.albedo[index + 3] = a * 255;
}

/**
 * Fills a rounded rectangle into the height field, producing a smooth bevel.
 *
 * This is the primitive nearly every mechanical part is built from. The bevel
 * is what makes a panel read as a solid object with thickness rather than as a
 * flat coloured rectangle, because it gives the lighting pass a real edge to
 * catch.
 */
export function bevelledRect(
  surface: Surface,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cornerRadius: number,
  bevelWidth: number,
  peakHeight = 1,
): void {
  const { width, heightField } = surface;
  const minX = Math.max(0, Math.floor(x0));
  const maxX = Math.min(surface.width - 1, Math.ceil(x1));
  const minY = Math.max(0, Math.floor(y0));
  const maxY = Math.min(surface.height - 1, Math.ceil(y1));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Signed distance to a rounded rectangle: negative inside.
      const halfW = (x1 - x0) / 2 - cornerRadius;
      const halfH = (y1 - y0) / 2 - cornerRadius;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const dx = Math.abs(x - cx) - halfW;
      const dy = Math.abs(y - cy) - halfH;
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
      const inside = Math.min(Math.max(dx, dy), 0);
      const distance = outside + inside - cornerRadius;

      if (distance > 0) continue;

      // Ramp from the edge inward over `bevelWidth`.
      const relief = smoothstep(0, bevelWidth, -distance) * peakHeight;
      const index = y * width + x;
      if (relief > heightField[index]!) heightField[index] = relief;
    }
  }
}

/** Adds fine surface grain so flat areas are not perfectly, artificially smooth. */
export function addSurfaceNoise(
  surface: Surface,
  noise: NoiseField,
  scale: number,
  amplitude: number,
  octaves = 3,
): void {
  const { width, height, heightField } = surface;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (heightField[index]! <= 0) continue;
      const n = noise.fbm2(x * scale, y * scale, octaves);
      heightField[index] = clamp01(heightField[index]! + n * amplitude);
    }
  }
}

/**
 * Scores wear into edges and corners.
 *
 * Uniform wear looks like a filter; real wear concentrates where a surface gets
 * knocked. Driving it from the height field's gradient puts scratches exactly
 * on the raised edges that would actually take the damage.
 */
export function addEdgeWear(
  surface: Surface,
  noise: NoiseField,
  intensity = 0.5,
  scale = 0.08,
): void {
  const { width, height, heightField, roughness } = surface;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const centre = heightField[index]!;
      if (centre <= 0.01) continue;

      const gradientX = heightField[index + 1]! - heightField[index - 1]!;
      const gradientY = heightField[index + width]! - heightField[index - width]!;
      const edge = Math.min(1, Math.hypot(gradientX, gradientY) * 6);

      const streak = noise.fbm2(x * scale, y * scale * 0.35, 3) * 0.5 + 0.5;
      const wear = edge * streak * intensity;

      if (wear > 0.02) {
        const albedoIndex = index * 4;
        // Worn metal brightens and becomes shinier as paint is removed.
        surface.albedo[albedoIndex] = Math.min(255, surface.albedo[albedoIndex]! + wear * 90);
        surface.albedo[albedoIndex + 1] = Math.min(
          255,
          surface.albedo[albedoIndex + 1]! + wear * 90,
        );
        surface.albedo[albedoIndex + 2] = Math.min(
          255,
          surface.albedo[albedoIndex + 2]! + wear * 88,
        );
        roughness[index] = clamp01(roughness[index]! - wear * 0.35);
      }
    }
  }
}

/**
 * Fills the entire surface with a vertical gradient.
 *
 * Used as a base for rock strata and painted panels, where a subtle top-to-
 * bottom shift stops large areas reading as dead flat colour.
 */
export function verticalGradient(
  surface: Surface,
  topR: number,
  topG: number,
  topB: number,
  bottomR: number,
  bottomG: number,
  bottomB: number,
  alpha = 1,
): void {
  const { width, height } = surface;
  for (let y = 0; y < height; y++) {
    const t = height > 1 ? y / (height - 1) : 0;
    const r = topR + (bottomR - topR) * t;
    const g = topG + (bottomG - topG) * t;
    const b = topB + (bottomB - topB) * t;
    for (let x = 0; x < width; x++) {
      setPixel(surface, x, y, r, g, b, alpha);
    }
  }
}

/**
 * A soft radial falloff sprite.
 *
 * The single most reused texture in the whole game: light glows, dust motes,
 * sparks, smoke, and bloom seeds are all this one image tinted and scaled. The
 * falloff is deliberately not linear — a squared-then-smoothed curve keeps the
 * core bright and the edge genuinely invisible, which is what stops layered
 * particles building up a visible boxy edge.
 */
export function radialFalloff(size: number, power = 2.2, innerBoost = 0.25): Surface {
  const surface = createSurface(size, size);
  const centre = (size - 1) / 2;
  const radius = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre) / radius;
      let alpha = clamp01(1 - distance);
      alpha = Math.pow(alpha, power);
      alpha = clamp01(alpha + Math.pow(clamp01(1 - distance * 2.2), 3) * innerBoost);

      const index = (y * size + x) * 4;
      surface.albedo[index] = 255;
      surface.albedo[index + 1] = 255;
      surface.albedo[index + 2] = 255;
      surface.albedo[index + 3] = alpha * 255;

      const pixel = y * size + x;
      surface.emissive[pixel] = alpha;
      surface.roughness[pixel] = 1;
      // A dome-shaped normal makes glows catch light plausibly when they sit on
      // a surface rather than floating in the air.
      surface.heightField[pixel] = alpha;
    }
  }
  return surface;
}

/** Premultiplies alpha, which is what the sprite batch's blend mode expects. */
export function premultiply(albedo: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < albedo.length; i += 4) {
    const a = albedo[i + 3]! / 255;
    albedo[i] = albedo[i]! * a;
    albedo[i + 1] = albedo[i + 1]! * a;
    albedo[i + 2] = albedo[i + 2]! * a;
  }
  return albedo;
}
