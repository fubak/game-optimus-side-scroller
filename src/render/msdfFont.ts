/**
 * Runtime-generated MSDF (multi-channel signed distance field) font atlas.
 *
 * Stage 1's bitmap font (`text.ts`) paints one `fillRect` per lit pixel — crisp at 1x, blocky at
 * anything else. An MSDF atlas encodes *distance to the nearest edge* instead of on/off coverage,
 * so a GPU shader (or careful CPU sampling) can reconstruct smooth, scale-independent edges from
 * the same source data. There is no font file to trace here — the "vector art" is the existing
 * 5×7 bit patterns in `text.ts` — so the atlas is built by brute-force distance transform over
 * those bits, once, lazily, at first use. Nothing is written to disk and nothing binary is
 * committed; `scripts/generateMsdfFont.ts` just exercises this module as a smoke test.
 *
 * Approximation vs. "real" MSDF: authentic MSDF assigns each channel to a different *vector
 * edge* of the glyph outline so per-channel median sampling sharpens corners. There are no vector
 * edges here, only a bitmap, so each channel instead encodes the same signed distance under a
 * different distance metric (Euclidean, Chebyshev, Manhattan). The three metrics agree away from
 * corners and diverge near them, which reproduces the "median sharpens corners, disagreement
 * softens" behaviour real MSDF relies on, cheaply.
 */

import {
  GLYPH_CHARACTERS,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  getGlyphBitmap,
  measureText,
  resolveGlyphCharacter,
  TEXT_LINE_HEIGHT,
  type TextOptions,
} from './text';
import { parseColor } from './color';

/** Atlas pixels per source (bitmap) pixel. Higher = smoother edges, bigger atlas. */
const SUPERSAMPLE = 8;
/** Padding ring around each glyph, in source-pixel units, so distance fields don't clip at cell edges. */
const PAD_UNITS = 1;
/** Source-pixel units the signed distance is normalized against; matches typical MSDF "pxRange" scale. */
const DISTANCE_RANGE_UNITS = 2;
/** How far (in whole source cells) to search for the nearest opposite-state cell. Covers the range above. */
const SEARCH_RADIUS_CELLS = 3;

const CELL_WIDTH_UNITS = GLYPH_WIDTH + PAD_UNITS * 2;
const CELL_HEIGHT_UNITS = GLYPH_HEIGHT + PAD_UNITS * 2;
const CELL_WIDTH_PX = CELL_WIDTH_UNITS * SUPERSAMPLE;
const CELL_HEIGHT_PX = CELL_HEIGHT_UNITS * SUPERSAMPLE;
const PAD_PX = PAD_UNITS * SUPERSAMPLE;

export interface MsdfGlyphRect {
  /** Atlas pixel origin of this glyph's cell, including its padding ring. */
  readonly x: number;
  readonly y: number;
  /** Cell size in atlas pixels, including padding on both sides. */
  readonly width: number;
  readonly height: number;
  /** Padding (atlas pixels) between the cell edge and the glyph's own 5×7 box. */
  readonly padPx: number;
}

export interface MsdfFontMetrics {
  /** Un-padded glyph box size, in source (bitmap) pixel units — matches `text.ts`'s `GLYPH_WIDTH/HEIGHT`. */
  readonly glyphWidth: number;
  readonly glyphHeight: number;
  /** Horizontal distance between glyph origins with zero tracking; same unit `measureText` uses. */
  readonly advance: number;
  /** Same unit `TEXT_LINE_HEIGHT` uses, so multi-line MSDF layout never drifts from the bitmap font. */
  readonly lineHeight: number;
  /** Atlas pixels per source-pixel unit. */
  readonly supersample: number;
  /** Source-pixel units the encoded distance saturates at (byte 0 or 255). */
  readonly distanceRangeSourceUnits: number;
}

export interface MsdfAtlasData {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row-major, top-left origin. R/G/B are the three distance-metric channels; A mirrors R. */
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  readonly metrics: MsdfFontMetrics;
  readonly glyphs: ReadonlyMap<string, MsdfGlyphRect>;
}

/** {@link MsdfAtlasData} plus a rasterized `<canvas>`, for Canvas2D/WebGL callers that need one. */
export interface MsdfAtlas extends MsdfAtlasData {
  readonly canvas: HTMLCanvasElement;
}

function bitAt(bits: readonly number[], row: number, col: number): boolean {
  if (row < 0 || row >= GLYPH_HEIGHT || col < 0 || col >= GLYPH_WIDTH) return false;
  const rowBits = bits[row] ?? 0;
  return (rowBits & (1 << (GLYPH_WIDTH - 1 - col))) !== 0;
}

interface ChannelDistances {
  readonly euclidean: number;
  readonly chebyshev: number;
  readonly manhattan: number;
}

/**
 * Distance from continuous point `(sx, sy)` (source-pixel units) to the nearest grid cell whose
 * bit state differs from `insideQuery`, under three metrics. A cell's "shape" is treated as the
 * closed unit square it occupies, so distance is 0 anywhere inside a same-state neighbour cell.
 */
function nearestBoundaryDistances(
  bits: readonly number[],
  sx: number,
  sy: number,
  insideQuery: boolean,
): ChannelDistances {
  const baseRow = Math.floor(sy);
  const baseCol = Math.floor(sx);
  let euclidean = Number.POSITIVE_INFINITY;
  let chebyshev = Number.POSITIVE_INFINITY;
  let manhattan = Number.POSITIVE_INFINITY;

  for (let row = baseRow - SEARCH_RADIUS_CELLS; row <= baseRow + SEARCH_RADIUS_CELLS; row += 1) {
    for (let col = baseCol - SEARCH_RADIUS_CELLS; col <= baseCol + SEARCH_RADIUS_CELLS; col += 1) {
      if (bitAt(bits, row, col) === insideQuery) continue;
      const dx = Math.max(col - sx, 0, sx - (col + 1));
      const dy = Math.max(row - sy, 0, sy - (row + 1));
      euclidean = Math.min(euclidean, Math.sqrt(dx * dx + dy * dy));
      chebyshev = Math.min(chebyshev, Math.max(dx, dy));
      manhattan = Math.min(manhattan, dx + dy);
    }
  }
  return { euclidean, chebyshev, manhattan };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Encode an unsigned distance (source-pixel units) as a 0-255 byte, 128 = the glyph edge. */
function encodeSignedDistance(distance: number, inside: boolean): number {
  const signed = inside ? distance : -distance;
  const normalized = clamp(signed / DISTANCE_RANGE_UNITS, -1, 1);
  return Math.round((normalized * 0.5 + 0.5) * 255);
}

function glyphOrder(): readonly string[] {
  return GLYPH_CHARACTERS;
}

/** Column count for a roughly-square atlas; kept simple and deterministic. */
function atlasColumns(glyphCount: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(glyphCount)));
}

function writeGlyphCell(
  pixels: Uint8ClampedArray<ArrayBuffer>,
  atlasWidth: number,
  cellX: number,
  cellY: number,
  bits: readonly number[],
): void {
  for (let ly = 0; ly < CELL_HEIGHT_PX; ly += 1) {
    const sy = (ly + 0.5) / SUPERSAMPLE - PAD_UNITS;
    for (let lx = 0; lx < CELL_WIDTH_PX; lx += 1) {
      const sx = (lx + 0.5) / SUPERSAMPLE - PAD_UNITS;
      const inside = bitAt(bits, Math.floor(sy), Math.floor(sx));
      const distances = nearestBoundaryDistances(bits, sx, sy, inside);
      const r = encodeSignedDistance(distances.euclidean, inside);
      const g = encodeSignedDistance(distances.chebyshev, inside);
      const b = encodeSignedDistance(distances.manhattan, inside);

      const atlasIndex = ((cellY + ly) * atlasWidth + (cellX + lx)) * 4;
      pixels[atlasIndex] = r;
      pixels[atlasIndex + 1] = g;
      pixels[atlasIndex + 2] = b;
      pixels[atlasIndex + 3] = r;
    }
  }
}

/**
 * Build the MSDF atlas as plain pixel data — no `document`, no `canvas`, safe to call from Node
 * (tests, `scripts/generateMsdfFont.ts`) as well as the browser.
 */
export function buildMsdfAtlasData(): MsdfAtlasData {
  const characters = glyphOrder();
  const columns = atlasColumns(characters.length);
  const rows = Math.ceil(characters.length / columns);
  const width = columns * CELL_WIDTH_PX;
  const height = rows * CELL_HEIGHT_PX;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const glyphs = new Map<string, MsdfGlyphRect>();

  characters.forEach((character, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const cellX = col * CELL_WIDTH_PX;
    const cellY = row * CELL_HEIGHT_PX;
    writeGlyphCell(pixels, width, cellX, cellY, getGlyphBitmap(character));
    glyphs.set(character, { x: cellX, y: cellY, width: CELL_WIDTH_PX, height: CELL_HEIGHT_PX, padPx: PAD_PX });
  });

  const metrics: MsdfFontMetrics = {
    glyphWidth: GLYPH_WIDTH,
    glyphHeight: GLYPH_HEIGHT,
    advance: GLYPH_WIDTH,
    lineHeight: TEXT_LINE_HEIGHT,
    supersample: SUPERSAMPLE,
    distanceRangeSourceUnits: DISTANCE_RANGE_UNITS,
  };

  return { width, height, pixels, metrics, glyphs };
}

function glyphRectFor(atlas: MsdfAtlasData, character: string): MsdfGlyphRect {
  const key = resolveGlyphCharacter(character);
  const rect = atlas.glyphs.get(key);
  if (rect !== undefined) return rect;
  // Every atlas is built from GLYPH_CHARACTERS, which always contains '?'.
  const fallback = atlas.glyphs.get('?');
  if (fallback === undefined) {
    throw new Error("MSDF atlas is missing the '?' fallback glyph.");
  }
  return fallback;
}

let cachedAtlas: MsdfAtlas | null = null;

/**
 * Lazily build and rasterize the MSDF atlas into a `<canvas>`, caching the result. Requires a DOM
 * (`document`); call {@link buildMsdfAtlasData} directly in non-browser contexts.
 */
export function getMsdfAtlas(): MsdfAtlas {
  if (cachedAtlas !== null) return cachedAtlas;
  if (typeof document === 'undefined') {
    throw new Error(
      'getMsdfAtlas() needs document.createElement to rasterize the atlas. Use buildMsdfAtlasData() ' +
        'directly in non-browser contexts (tests, scripts/generateMsdfFont.ts).',
    );
  }
  const data = buildMsdfAtlasData();
  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Failed to create a 2D context to rasterize the MSDF atlas.');
  }
  ctx.putImageData(new ImageData(data.pixels, data.width, data.height), 0, 0);
  cachedAtlas = { ...data, canvas };
  return cachedAtlas;
}

/** Test-only: drop the cached atlas so the next {@link getMsdfAtlas} call rebuilds it. */
export function resetMsdfAtlasCache(): void {
  cachedAtlas = null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Bilinear-sample the R/G/B distance channels of the atlas at a fractional pixel coordinate. */
function sampleBilinearRGB(atlas: MsdfAtlasData, ax: number, ay: number): readonly [number, number, number] {
  const { pixels, width, height } = atlas;
  const x0 = clampInt(Math.floor(ax), 0, width - 1);
  const y0 = clampInt(Math.floor(ay), 0, height - 1);
  const x1 = clampInt(x0 + 1, 0, width - 1);
  const y1 = clampInt(y0 + 1, 0, height - 1);
  const fx = clamp(ax - Math.floor(ax), 0, 1);
  const fy = clamp(ay - Math.floor(ay), 0, 1);

  const sample = (x: number, y: number, channel: number): number => pixels[(y * width + x) * 4 + channel] ?? 0;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  const result: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const top = lerp(sample(x0, y0, channel), sample(x1, y0, channel), fx);
    const bottom = lerp(sample(x0, y1, channel), sample(x1, y1, channel), fx);
    result[channel] = lerp(top, bottom, fy);
  }
  return result;
}

/** The real MSDF trick: the median of three per-edge channels reconstructs a robust single SDF. */
function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function smoothstep(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

function colorToBytes(color: string): readonly [number, number, number] {
  const [r, g, b] = parseColor(color);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

type GlyphCacheKey = string;

function glyphCacheKey(character: string, scale: number, rgb: readonly [number, number, number]): GlyphCacheKey {
  return `${character}\u0000${String(scale)}\u0000${rgb.join(',')}`;
}

const glyphCanvasCache = new Map<GlyphCacheKey, HTMLCanvasElement>();

/**
 * Render (and cache) one glyph as a small, already-tinted, already-anti-aliased canvas at the
 * requested integer scale. `drawTextMsdf` composites these with `drawImage`, which — unlike
 * `putImageData` — blends normally against whatever is already on the destination canvas.
 */
function getGlyphCanvas(
  atlas: MsdfAtlas,
  character: string,
  scale: number,
  rgb: readonly [number, number, number],
): HTMLCanvasElement {
  const key = glyphCacheKey(character, scale, rgb);
  const cached = glyphCanvasCache.get(key);
  if (cached !== undefined) return cached;

  const rect = glyphRectFor(atlas, character);
  const outWidth = GLYPH_WIDTH * scale;
  const outHeight = GLYPH_HEIGHT * scale;
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Failed to create a 2D context for an MSDF glyph cache canvas.');
  }

  const imageData = ctx.createImageData(outWidth, outHeight);
  // Anti-alias width, in encoded-distance bytes, chosen so the ramp spans ~1 destination pixel.
  const bytesPerSourceUnit = 255 / (2 * atlas.metrics.distanceRangeSourceUnits);
  const aaHalfWidthBytes = Math.max(1, (bytesPerSourceUnit / scale) * 0.5);
  const [red, green, blue] = rgb;

  for (let oy = 0; oy < outHeight; oy += 1) {
    const gy = (oy + 0.5) / scale;
    const ay = rect.y + rect.padPx + gy * atlas.metrics.supersample;
    for (let ox = 0; ox < outWidth; ox += 1) {
      const gx = (ox + 0.5) / scale;
      const ax = rect.x + rect.padPx + gx * atlas.metrics.supersample;
      const [sr, sg, sb] = sampleBilinearRGB(atlas, ax, ay);
      const distanceByte = median3(sr, sg, sb);
      const alpha = smoothstep((distanceByte - 128 + aaHalfWidthBytes) / (2 * aaHalfWidthBytes));

      const index = (oy * outWidth + ox) * 4;
      imageData.data[index] = red;
      imageData.data[index + 1] = green;
      imageData.data[index + 2] = blue;
      imageData.data[index + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(imageData, 0, 0);
  glyphCanvasCache.set(key, canvas);
  return canvas;
}

function drawGlyphsMsdf(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  scale: number,
  tracking: number,
  color: string,
): void {
  const atlas = getMsdfAtlas();
  const rgb = colorToBytes(color);
  let cursorX = Math.round(x);
  const baseY = Math.round(y);
  for (const character of text) {
    const glyphCanvas = getGlyphCanvas(atlas, character, scale, rgb);
    ctx.drawImage(glyphCanvas, cursorX, baseY);
    cursorX += (GLYPH_WIDTH + tracking) * scale;
  }
}

/**
 * MSDF-atlas counterpart to `drawText`: identical signature, identical layout metrics (same
 * `measureText`/align/tracking/shadow behaviour), but glyphs are reconstructed from the distance
 * field instead of stamped as flat pixels — so at scales above 1 the edges are smooth rather than
 * blocky. Requires a DOM; not used by `drawText` itself so Canvas2D callers that never opt in stay
 * exactly as before.
 */
export function drawTextMsdf(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: TextOptions = {},
): void {
  const scale = Math.max(1, Math.round(options.scale ?? 1));
  const tracking = options.tracking ?? 1;
  const align = options.align ?? 'left';
  const width = measureText(text, scale, tracking);
  const startX =
    align === 'left' ? x : align === 'center' ? Math.round(x - width / 2) : Math.round(x - width);

  if (options.shadow !== undefined) {
    drawGlyphsMsdf(ctx, text, startX + scale, y + scale, scale, tracking, options.shadow);
  }
  drawGlyphsMsdf(ctx, text, startX, y, scale, tracking, options.color ?? '#ffffff');
}
