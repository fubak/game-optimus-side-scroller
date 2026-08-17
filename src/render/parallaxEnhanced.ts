import { createRng } from '../core/rng';
import type { Rng } from '../core/rng';
import { parseColor } from './color';
import type { ParallaxLayer, ParallaxOptions } from './parallax';
import { palette } from './palette';

/**
 * Enhanced-quality parallax backdrop: a dense, detailed factory skyline for `GlWorldRenderer`'s
 * WebGL2 path.
 *
 * `parallax.ts`'s classic generator paints straight onto a `CanvasRenderingContext2D` at 1 texel
 * per screen pixel — fine for Classic's pixel-art look, but "chunky silhouette" once blown up
 * across a real display. This module instead paints into a plain RGBA byte buffer at
 * {@link ENHANCED_SCALE} texels per screen pixel (see {@link buildEnhancedParallaxData}), which:
 *
 *  - is pure and DOM-free, so it is unit-testable in Node (mirrors `msdfFont.ts`'s
 *    `buildMsdfAtlasData()`/`getMsdfAtlas()` split — build the pixels, then separately rasterize
 *    them onto a `<canvas>` for actual use, see {@link createEnhancedParallaxLayers});
 *  - gives every structure (window grids, pipe flanges, hazard stripes) enough texels to read as
 *    detail instead of single blocky pixels once uploaded with linear filtering
 *    (`BackgroundBatch.setLayers`);
 *  - lets the far layer get a cheap one-time box blur baked into its own texture — a "distance
 *    blur"/DoF stand-in that costs nothing per frame, unlike a real screen-space blur pass.
 *
 * Layer content, seeded the same way as Classic (`seed ^ <constant>` per layer) so a level's
 * skyline is stable but each layer is independent:
 *  - far: cool/dark, sparse towers with floor lines and rare dim windows, softened by
 *    {@link boxBlurPremultiplied} to read as distant and slightly out of focus.
 *  - mid: warmer lit windows, denser towers with smokestacks, gantries/conveyor links between
 *    neighbouring buildings, and the occasional cooling tower silhouette. Left crisp.
 *  - near: horizontal pipe runs with flanges, brackets and valve wheels, vertical drops, and a
 *    hazard-stripe band along the very bottom edge — the "readable" foreground layer.
 *
 * Every layer also gets a subtle vertical haze gradient baked in (denser toward its base), giving
 * the backdrop atmospheric depth without any extra per-frame shader work.
 */

/** Texels per logical screen pixel for every Enhanced layer's canvas. */
export const ENHANCED_SCALE = 5;

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function rgbOf(css: string): Rgb {
  const [r, g, b] = parseColor(css);
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

/** A plain RGBA pixel buffer — the pure, DOM-free equivalent of a `CanvasRenderingContext2D`. */
interface PixelLayer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

function createPixelLayer(width: number, height: number): PixelLayer {
  return { width, height, data: new Uint8ClampedArray(Math.max(1, width) * Math.max(1, height) * 4) };
}

function inBounds(layer: PixelLayer, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < layer.width && y < layer.height;
}

/** Overwrite one texel fully opaque. */
function plot(layer: PixelLayer, x: number, y: number, color: Rgb): void {
  if (!inBounds(layer, x, y)) return;
  const i = (y * layer.width + x) * 4;
  layer.data[i] = color.r;
  layer.data[i + 1] = color.g;
  layer.data[i + 2] = color.b;
  layer.data[i + 3] = 255;
}

/** Standard "source over" alpha compositing onto one texel — correct even over a transparent one. */
function plotBlend(layer: PixelLayer, x: number, y: number, color: Rgb, alpha: number): void {
  if (!inBounds(layer, x, y) || alpha <= 0) return;
  const i = (y * layer.width + x) * 4;
  const dstA = (layer.data[i + 3] ?? 0) / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) {
    layer.data[i + 3] = 0;
    return;
  }
  const dr = layer.data[i] ?? 0;
  const dg = layer.data[i + 1] ?? 0;
  const db = layer.data[i + 2] ?? 0;
  layer.data[i] = (color.r * alpha + dr * dstA * (1 - alpha)) / outA;
  layer.data[i + 1] = (color.g * alpha + dg * dstA * (1 - alpha)) / outA;
  layer.data[i + 2] = (color.b * alpha + db * dstA * (1 - alpha)) / outA;
  layer.data[i + 3] = outA * 255;
}

function blendRect(layer: PixelLayer, x: number, y: number, w: number, h: number, color: Rgb, alpha: number): void {
  if (w <= 0 || h <= 0 || alpha <= 0) return;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(layer.width, Math.ceil(x + w));
  const y1 = Math.min(layer.height, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) plotBlend(layer, xx, yy, color, alpha);
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Fractional-coverage rect fill: edge texels are alpha-blended by how much of that texel the rect
 * actually covers, instead of rounding to the nearest whole texel. Painting at
 * {@link ENHANCED_SCALE} texels per screen pixel already gives edges room to be soft; this is what
 * spends that room — building/pipe/window silhouettes end up anti-aliased rather than the hard
 * "stair-stepped" edges Classic's 1:1 pixel-art painter has to live with.
 */
function fillRectAA(layer: PixelLayer, x: number, y: number, w: number, h: number, color: Rgb): void {
  if (w <= 0 || h <= 0) return;
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(layer.width, Math.ceil(x + w));
  const y1 = Math.min(layer.height, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy += 1) {
    const coverY = Math.min(yy + 1, y + h) - Math.max(yy, y);
    if (coverY <= 0) continue;
    for (let xx = x0; xx < x1; xx += 1) {
      const coverX = Math.min(xx + 1, x + w) - Math.max(xx, x);
      if (coverX <= 0) continue;
      const coverage = coverX * coverY;
      if (coverage >= 0.999) plot(layer, xx, yy, color);
      else plotBlend(layer, xx, yy, color, coverage);
    }
  }
}

/** A ring (valve wheel rim), `thickness` texels wide, with a soft one-texel anti-aliased edge. */
function strokeCircle(layer: PixelLayer, cx: number, cy: number, radius: number, thickness: number, color: Rgb): void {
  const outer = radius;
  const inner = Math.max(0, radius - thickness);
  const x0 = Math.floor(cx - outer - 1);
  const x1 = Math.ceil(cx + outer + 1);
  const y0 = Math.floor(cy - outer - 1);
  const y1 = Math.ceil(cy + outer + 1);
  for (let yy = y0; yy <= y1; yy += 1) {
    const dy = yy + 0.5 - cy;
    for (let xx = x0; xx <= x1; xx += 1) {
      const dx = xx + 0.5 - cx;
      const dist = Math.hypot(dx, dy);
      // Soft coverage on both the outer and inner edge of the ring, one texel wide each.
      const outerCoverage = clamp01(outer - dist + 0.5);
      const innerCoverage = clamp01(dist - inner + 0.5);
      const coverage = Math.min(outerCoverage, innerCoverage);
      if (coverage > 0) plotBlend(layer, xx, yy, color, coverage);
    }
  }
}

/** A subtle vertical haze wash, denser toward the base — baked-in atmospheric depth. */
function paintHaze(layer: PixelLayer, color: Rgb, topAlpha: number, bottomAlpha: number): void {
  const { width, height } = layer;
  for (let y = 0; y < height; y += 1) {
    const t = height <= 1 ? 0 : y / (height - 1);
    const alpha = topAlpha + (bottomAlpha - topAlpha) * t;
    blendRect(layer, 0, y, width, 1, color, alpha);
  }
}

/**
 * One-dimensional sliding-window box blur (used twice, horizontal then vertical, by
 * {@link boxBlurPremultiplied}). Edge texels clamp to the array bounds rather than wrapping.
 */
function boxBlur1d(src: Float32Array, dst: Float32Array, width: number, height: number, radius: number, horizontal: boolean): void {
  const span = radius * 2 + 1;
  const clampIndex = (i: number, size: number): number => Math.min(size - 1, Math.max(0, i));
  if (horizontal) {
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) sum += src[row + clampIndex(k, width)] ?? 0;
      for (let x = 0; x < width; x += 1) {
        dst[row + x] = sum / span;
        sum += (src[row + clampIndex(x + radius + 1, width)] ?? 0) - (src[row + clampIndex(x - radius, width)] ?? 0);
      }
    }
  } else {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) sum += src[clampIndex(k, height) * width + x] ?? 0;
      for (let y = 0; y < height; y += 1) {
        dst[y * width + x] = sum / span;
        sum +=
          (src[clampIndex(y + radius + 1, height) * width + x] ?? 0) - (src[clampIndex(y - radius, height) * width + x] ?? 0);
      }
    }
  }
}

/**
 * Cheap one-time distance blur for the far layer (stands in for a per-frame background DoF pass,
 * see the module doc). Premultiplies by alpha first so blurring a silhouette's edge fades it into
 * transparency instead of muddying it toward black.
 */
function boxBlurPremultiplied(layer: PixelLayer, radius: number): void {
  if (radius <= 0) return;
  const { width, height, data } = layer;
  const n = width * height;
  const pr = new Float32Array(n);
  const pg = new Float32Array(n);
  const pb = new Float32Array(n);
  const pa = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = (data[i * 4 + 3] ?? 0) / 255;
    pr[i] = (data[i * 4] ?? 0) * a;
    pg[i] = (data[i * 4 + 1] ?? 0) * a;
    pb[i] = (data[i * 4 + 2] ?? 0) * a;
    pa[i] = a;
  }
  const tr = new Float32Array(n);
  const tg = new Float32Array(n);
  const tb = new Float32Array(n);
  const ta = new Float32Array(n);
  boxBlur1d(pr, tr, width, height, radius, true);
  boxBlur1d(pg, tg, width, height, radius, true);
  boxBlur1d(pb, tb, width, height, radius, true);
  boxBlur1d(pa, ta, width, height, radius, true);
  boxBlur1d(tr, pr, width, height, radius, false);
  boxBlur1d(tg, pg, width, height, radius, false);
  boxBlur1d(tb, pb, width, height, radius, false);
  boxBlur1d(ta, pa, width, height, radius, false);
  for (let i = 0; i < n; i += 1) {
    const a = pa[i] ?? 0;
    data[i * 4 + 3] = a * 255;
    if (a > 1e-4) {
      data[i * 4] = (pr[i] ?? 0) / a;
      data[i * 4 + 1] = (pg[i] ?? 0) / a;
      data[i * 4 + 2] = (pb[i] ?? 0) / a;
    } else {
      data[i * 4] = 0;
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = 0;
    }
  }
}

interface TowerFieldStyle {
  readonly body: Rgb;
  readonly trim: Rgb;
  readonly windowWarm: Rgb;
  readonly windowCool: Rgb;
  /** Fraction of lit windows that use `windowWarm` instead of `windowCool`. */
  readonly warmChance: number;
  readonly windowChance: number;
  readonly widthRange: readonly [number, number];
  readonly heightFrac: readonly [number, number];
  readonly floorSpacing: number;
  readonly windowSize: readonly [number, number];
  readonly windowGap: readonly [number, number];
  readonly smokestackChance: number;
  readonly linkChance: number;
}

/** Smokestack: a thin column above the roofline plus a soft blended puff of smoke at its cap. */
function paintSmokestack(layer: PixelLayer, rng: Rng, x: number, roofY: number, towerWidth: number, style: TowerFieldStyle, scale: number): void {
  const stackWidth = Math.max(2 * scale, Math.round(towerWidth * 0.12));
  const stackHeight = rng.int(6, 18) * scale;
  const stackX = x + rng.int(1, Math.max(1, towerWidth - stackWidth - 1));
  const stackTop = roofY - stackHeight;
  fillRectAA(layer, stackX, stackTop, stackWidth, stackHeight, style.body);
  blendRect(layer, stackX - 1, stackTop, stackWidth + 2, Math.max(1, scale), style.trim, 0.5);
  // Soft smoke puff, translucent so it reads as haze rather than a solid cap.
  const puffRadius = stackWidth * rng.range(0.9, 1.4);
  fillCircleBlend(layer, stackX + stackWidth / 2, stackTop - puffRadius * 0.3, puffRadius, style.trim, 0.22);
}

function fillCircleBlend(layer: PixelLayer, cx: number, cy: number, radius: number, color: Rgb, alpha: number): void {
  const r2 = radius * radius;
  const x0 = Math.floor(cx - radius);
  const x1 = Math.ceil(cx + radius);
  const y0 = Math.floor(cy - radius);
  const y1 = Math.ceil(cy + radius);
  for (let yy = y0; yy <= y1; yy += 1) {
    const dy = yy + 0.5 - cy;
    for (let xx = x0; xx <= x1; xx += 1) {
      const dx = xx + 0.5 - cx;
      if (dx * dx + dy * dy <= r2) plotBlend(layer, xx, yy, color, alpha);
    }
  }
}

/** Gantry walkway or a diagonal conveyor belt bridging the gap between two neighbouring towers. */
function paintLink(layer: PixelLayer, rng: Rng, x0: number, gapWidth: number, y0: number, y1: number, style: TowerFieldStyle, scale: number): void {
  const diagonal = rng.chance(0.4);
  const beamThickness = Math.max(2 * scale, Math.round(1.5 * scale));
  const steps = Math.max(3, Math.round(gapWidth / (2 * scale)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const px = x0 + t * gapWidth;
    const py = diagonal ? y0 + t * (y1 - y0) : Math.min(y0, y1);
    fillRectAA(layer, px, py, gapWidth / steps + scale, beamThickness, style.trim);
    if (i % 3 === 0) {
      blendRect(layer, px, py + beamThickness, Math.max(1, scale), scale * 2, style.trim, 0.4);
    }
  }
}

/**
 * A hyperboloid-ish cooling tower silhouette: stacked bands that narrow toward the middle. Rows
 * overlap slightly and are drawn with fractional-coverage edges so the waist curve reads as one
 * continuous soft silhouette rather than a discrete staircase of rectangles.
 */
function paintCoolingTower(layer: PixelLayer, x: number, baseY: number, height: number, width: number, style: TowerFieldStyle): void {
  const rows = Math.max(10, Math.round(height / 3));
  for (let i = 0; i < rows; i += 1) {
    const t = rows <= 1 ? 0 : i / (rows - 1);
    const waist = Math.sin(t * Math.PI);
    const rowWidth = width * (0.62 + 0.38 * (1 - waist));
    const rowY = baseY - height + t * height;
    const rowHeight = height / rows + 1.5;
    fillRectAA(layer, x + (width - rowWidth) / 2, rowY, rowWidth, rowHeight, style.body);
  }
  blendRect(layer, x + width * 0.1, baseY - height, width * 0.8, Math.max(1, height * 0.03), style.trim, 0.5);
}

/** Towers with floor lines, window grids, smokestacks, gantry/conveyor links and cooling towers. */
function paintTowerField(layer: PixelLayer, rng: Rng, style: TowerFieldStyle, scale: number, coolingTowers: boolean): void {
  const { width, height } = layer;
  let x = 0;
  let prevRight: number | null = null;
  let prevTop: number | null = null;
  while (x < width) {
    const towerWidth = rng.int(style.widthRange[0], style.widthRange[1]) * scale;
    const towerHeight = Math.round(height * rng.range(style.heightFrac[0], style.heightFrac[1]));
    const top = height - towerHeight;

    // Bridge the gap left by the previous iteration now that both towers' rooflines are known.
    if (prevRight !== null && prevTop !== null) {
      const gapWidth = x - prevRight;
      if (gapWidth > 3 * scale && rng.chance(style.linkChance)) {
        paintLink(layer, rng, prevRight, gapWidth, prevTop + scale * 2, top + scale * 2, style, scale);
      }
    }

    if (coolingTowers && rng.chance(0.08)) {
      paintCoolingTower(layer, x, height, towerHeight, towerWidth, style);
    } else {
      fillRectAA(layer, x, top, towerWidth, towerHeight, style.body);
      blendRect(layer, x, top, towerWidth, Math.max(1, scale), style.trim, 0.8);

      const floorStep = Math.max(4 * scale, style.floorSpacing * scale);
      for (let fy = top + floorStep; fy < height - 2 * scale; fy += floorStep) {
        blendRect(layer, x + scale * 0.5, fy, towerWidth - scale, Math.max(1, scale * 0.4), style.trim, 0.35);
      }

      // Windows: a soft-edged rect for the pane itself, plus — for lit ones — a wider, much
      // fainter glow blended behind it so light appears to spill onto the facade instead of the
      // window reading as a single flat-coloured dot.
      const [winW, winH] = style.windowSize;
      const [gapX, gapY] = style.windowGap;
      const stepX = (winW + gapX) * scale;
      const stepY = (winH + gapY) * scale;
      for (let wy = top + floorStep * 0.6; wy < height - winH * scale - 2 * scale; wy += stepY) {
        for (let wx = x + gapX * scale; wx < x + towerWidth - winW * scale; wx += stepX) {
          if (!rng.chance(style.windowChance)) continue;
          const isWarm = rng.chance(style.warmChance);
          const color = isWarm ? style.windowWarm : style.windowCool;
          const paneW = winW * scale;
          const paneH = winH * scale;
          const glowRadius = Math.max(paneW, paneH) * (isWarm ? 1.9 : 1.3);
          fillCircleBlend(layer, wx + paneW / 2, wy + paneH / 2, glowRadius, color, isWarm ? 0.16 : 0.09);
          fillRectAA(layer, wx, wy, paneW, paneH, color);
        }
      }

      if (rng.chance(style.smokestackChance)) {
        paintSmokestack(layer, rng, x, top, towerWidth, style, scale);
      }
    }

    prevRight = x + towerWidth;
    prevTop = top;
    x = prevRight + rng.int(2, 10) * scale;
  }
}

interface PipelineStyle {
  readonly pipe: Rgb;
  readonly pipeLight: Rgb;
  readonly pipeDark: Rgb;
  readonly bracket: Rgb;
  readonly rust: Rgb;
  readonly hazard: Rgb;
  readonly hazardDark: Rgb;
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function smoothstep01(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/** Horizontal pipe runs with flanges/brackets, valve wheels and soft rail ticks, plus a few vertical drops. */
function paintPipeRuns(layer: PixelLayer, rng: Rng, style: PipelineStyle, scale: number): void {
  const { width, height } = layer;
  for (let i = 0; i < 3; i += 1) {
    const y = Math.round(height * rng.range(0.25, 0.85));
    const thickness = rng.int(3, 6) * scale;
    fillRectAA(layer, 0, y, width, thickness, style.pipe);
    blendRect(layer, 0, y, width, Math.max(1, scale), style.pipeLight, 0.4);
    blendRect(layer, 0, y + thickness - scale, width, Math.max(1, scale), style.pipeDark, 0.55);
    // A soft repeating rail tick along the underside — reads as segment/rivet detail without
    // resorting to a single hard-edged dot every bracket.
    const tickSpacing = 6 * scale;
    for (let tx = rng.int(0, tickSpacing); tx < width; tx += tickSpacing) {
      blendRect(layer, tx, y + thickness - scale * 1.4, scale * 2, scale * 0.6, style.pipeDark, 0.3);
    }

    for (let x = rng.int(0, 40) * scale; x < width; x += rng.int(28, 70) * scale) {
      fillRectAA(layer, x, y - 2 * scale, 3 * scale, thickness + 4 * scale, style.bracket);
      if (rng.chance(0.3)) {
        strokeCircle(layer, x + 1.5 * scale, y + thickness / 2, 3 * scale, Math.max(1, scale), style.bracket);
      }
      if (rng.chance(0.35)) {
        // A small soft rust blotch rather than a single hard-edged pixel dot.
        fillCircleBlend(layer, x + scale * 1.5, y - 2 * scale, scale * 1.6, style.rust, 0.5);
      }
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const x = rng.int(0, width - 4 * scale);
    fillRectAA(layer, x, 0, rng.int(2, 4) * scale, height, style.pipeDark);
  }
}

/**
 * A diagonal hazard-chevron band along the very bottom edge — the near layer's readable marking.
 * Each stripe boundary is soft-blended across roughly a texel instead of a hard integer-phase
 * cutoff, so the chevrons read as clean anti-aliased bands rather than jagged 8-bit steps.
 */
function paintHazardStripes(layer: PixelLayer, style: PipelineStyle, scale: number): void {
  const { width, height } = layer;
  const bandHeight = Math.max(4 * scale, Math.round(height * 0.05));
  const y0 = height - bandHeight;
  const period = 10 * scale;
  const half = period / 2;
  const edgeSoft = Math.max(1, scale * 0.6);
  for (let y = y0; y < height; y += 1) {
    const rowIndex = y - y0;
    for (let x = 0; x < width; x += 1) {
      const phase = (((x + rowIndex) % period) + period) % period;
      const local = phase % half;
      const distToEdge = Math.min(local, half - local);
      const t = smoothstep01(distToEdge / edgeSoft);
      const isHazard = Math.floor(phase / half) % 2 === 0;
      const nearColor = isHazard ? style.hazard : style.hazardDark;
      const farColor = isHazard ? style.hazardDark : style.hazard;
      plot(layer, x, y, mixRgb(farColor, nearColor, t));
    }
  }
}

export interface EnhancedLayerData {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly texWidth: number;
  readonly texHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly factor: number;
  readonly offsetY: number;
  readonly verticalFactor: number;
}

/**
 * Pure, DOM-free layer generation — unit-testable in Node. See {@link createEnhancedParallaxLayers}
 * for the browser-only wrapper that rasterizes this onto real `<canvas>` elements.
 */
export function buildEnhancedParallaxData(options: ParallaxOptions): readonly EnhancedLayerData[] {
  const { seed, viewWidth, viewHeight } = options;
  const scale = ENHANCED_SCALE;
  const logicalWidth = viewWidth * 2;

  const farLogicalHeight = Math.round(viewHeight * 0.75);
  const far = createPixelLayer(logicalWidth * scale, farLogicalHeight * scale);
  paintTowerField(
    far,
    createRng(seed ^ 0x9e37),
    {
      body: rgbOf(palette.farStructure),
      trim: rgbOf(palette.fog),
      windowWarm: rgbOf(palette.rust),
      windowCool: rgbOf(palette.fog),
      warmChance: 0.06,
      windowChance: 0.04,
      widthRange: [12, 30],
      heightFrac: [0.25, 0.75],
      floorSpacing: 7,
      windowSize: [1.5, 2],
      windowGap: [2, 3],
      smokestackChance: 0.18,
      linkChance: 0.1,
    },
    scale,
    false,
  );
  paintHaze(far, rgbOf(palette.fog), 0.05, 0.26);
  // One-time distance blur: stands in for a per-frame background DoF pass (see module doc).
  boxBlurPremultiplied(far, Math.round(scale * 0.75));

  const midLogicalHeight = Math.round(viewHeight * 0.6);
  const mid = createPixelLayer(logicalWidth * scale, midLogicalHeight * scale);
  paintTowerField(
    mid,
    createRng(seed ^ 0x2f1b),
    {
      body: rgbOf(palette.midStructure),
      trim: rgbOf(palette.nearStructure),
      windowWarm: rgbOf(palette.rust),
      windowCool: rgbOf(palette.visorGlow),
      warmChance: 0.55,
      windowChance: 0.16,
      widthRange: [9, 22],
      heightFrac: [0.3, 0.95],
      floorSpacing: 5,
      windowSize: [1.5, 2],
      windowGap: [1.5, 2],
      smokestackChance: 0.32,
      linkChance: 0.3,
    },
    scale,
    true,
  );
  paintHaze(mid, rgbOf(palette.fog), 0.03, 0.18);

  const nearLogicalHeight = Math.round(viewHeight * 0.4);
  const near = createPixelLayer(logicalWidth * scale, nearLogicalHeight * scale);
  const pipelineStyle: PipelineStyle = {
    pipe: rgbOf(palette.nearStructure),
    pipeLight: rgbOf(palette.midStructure),
    pipeDark: rgbOf(palette.plateShadow),
    bracket: rgbOf(palette.nearStructure),
    rust: rgbOf(palette.rust),
    hazard: rgbOf(palette.hazard),
    hazardDark: rgbOf(palette.hazardDark),
  };
  paintPipeRuns(near, createRng(seed ^ 0x77d1), pipelineStyle, scale);
  // A whisper of haze fading to nothing by the floor — softens the seam where this layer's top
  // edge meets mid's silhouettes instead of a hard depth cut, without dulling the readable pipes.
  paintHaze(near, rgbOf(palette.fog), 0.05, 0);
  paintHazardStripes(near, pipelineStyle, scale);

  return [
    {
      data: far.data,
      texWidth: far.width,
      texHeight: far.height,
      logicalWidth,
      logicalHeight: farLogicalHeight,
      factor: 0.15,
      offsetY: 8,
      verticalFactor: 0.05,
    },
    {
      data: mid.data,
      texWidth: mid.width,
      texHeight: mid.height,
      logicalWidth,
      logicalHeight: midLogicalHeight,
      factor: 0.32,
      offsetY: Math.round(viewHeight * 0.22),
      verticalFactor: 0.1,
    },
    {
      data: near.data,
      texWidth: near.width,
      texHeight: near.height,
      logicalWidth,
      logicalHeight: nearLogicalHeight,
      factor: 0.55,
      offsetY: Math.round(viewHeight * 0.55),
      verticalFactor: 0.18,
    },
  ];
}

/**
 * Rasterizes {@link buildEnhancedParallaxData}'s pixel buffers onto real `<canvas>` elements.
 * Requires a DOM (`document`); call {@link buildEnhancedParallaxData} directly in non-browser
 * contexts (tests).
 */
export function createEnhancedParallaxLayers(options: ParallaxOptions): ParallaxLayer[] {
  if (typeof document === 'undefined') {
    throw new Error(
      'createEnhancedParallaxLayers() needs document.createElement to rasterize its layers. Use ' +
        'buildEnhancedParallaxData() directly in non-browser contexts (tests).',
    );
  }
  return buildEnhancedParallaxData(options).map((layer) => {
    const canvas = document.createElement('canvas');
    canvas.width = layer.texWidth;
    canvas.height = layer.texHeight;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Failed to create an enhanced parallax layer context.');
    ctx.putImageData(new ImageData(layer.data, layer.texWidth, layer.texHeight), 0, 0);
    return {
      canvas,
      width: layer.logicalWidth,
      height: layer.logicalHeight,
      factor: layer.factor,
      offsetY: layer.offsetY,
      verticalFactor: layer.verticalFactor,
    };
  });
}
