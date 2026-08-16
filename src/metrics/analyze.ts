/**
 * Objective image metrics.
 *
 * This is the automated half of the critique loop. A written critique can be
 * argued with; a number cannot, and more importantly a number can be tracked
 * across builds so a regression is caught the round it appears rather than
 * three rounds later when someone notices the game looks worse.
 *
 * Every metric here was chosen because it corresponds to a specific,
 * identifiable property of the reference games:
 *
 * - **Dynamic range** — the reference titles hold deep blacks *and* bright
 *   highlights in the same frame. Cheap 2D renderers sit in a narrow mid-grey
 *   band, which is the single most obvious tell.
 * - **Aerial perspective** — distant layers must be lower-contrast and less
 *   saturated than near ones. This is what makes depth read.
 * - **Bloom energy** — a measurable band. Too little and the image is flat; too
 *   much and it turns to soup.
 * - **Silhouette contrast** — the character has to separate from its
 *   background, or every frame reads as visual mush.
 * - **Hue coherence** — a biome should occupy a controlled palette, with the
 *   player's cyan as the accent nothing else owns.
 */

import type { Device } from '../gfx/device.ts';

export interface FrameMetrics {
  /** Mean luminance in [0, 1]. */
  meanLuminance: number;
  /** 1st and 99th percentile luminance; their gap is the usable dynamic range. */
  luminanceP1: number;
  luminanceP99: number;
  dynamicRange: number;
  /** Fraction of pixels crushed to black or blown to white. */
  clippedBlack: number;
  clippedWhite: number;

  /** Mean HSV saturation across the frame. */
  meanSaturation: number;
  /** Saturation of the brightest decile — where accents live. */
  highlightSaturation: number;

  /** RMS of a Laplacian kernel; a proxy for perceived detail. */
  localContrast: number;
  /** Fraction of pixels sitting on a strong edge. */
  edgeDensity: number;

  /** Fraction of pixels above the bloom threshold. */
  bloomEnergy: number;

  /** Local contrast per horizontal band, far to near (top, middle, bottom). */
  bandContrast: [number, number, number];
  /** Saturation per horizontal band. */
  bandSaturation: [number, number, number];

  /** Fraction of pixels within the protected player-cyan hue range. */
  cyanPresence: number;
  /** Shannon entropy of the hue histogram; low means a disciplined palette. */
  hueEntropy: number;

  /** Dominant hues by pixel share, most common first. */
  dominantHues: { hue: number; share: number }[];

  width: number;
  height: number;
}

/** Working canvas, reused so analysis does not allocate every frame. */
let scratchCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let scratchCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function ensureScratch(
  width: number,
  height: number,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (!scratchCanvas || scratchCanvas.width !== width || scratchCanvas.height !== height) {
    if (typeof OffscreenCanvas !== 'undefined') {
      scratchCanvas = new OffscreenCanvas(width, height);
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      scratchCanvas = canvas;
    }
    scratchCtx = (
      scratchCanvas as HTMLCanvasElement
    ).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  }
  if (!scratchCtx) throw new Error('Could not acquire the analysis 2D context');
  return scratchCtx;
}

/**
 * Analyses the currently-rendered frame.
 *
 * Downsamples to a fixed working size first. That costs almost nothing, makes
 * the metrics resolution-independent (so a 720p and a 1080p capture are
 * directly comparable), and the box filter incidentally suppresses film grain
 * that would otherwise dominate the edge-density figure.
 */
export function analyzeFrame(
  _device: Device,
  canvas: HTMLCanvasElement,
  workingWidth = 480,
): FrameMetrics {
  const aspect = canvas.height / Math.max(canvas.width, 1);
  const width = workingWidth;
  const height = Math.max(1, Math.round(workingWidth * aspect));

  const ctx = ensureScratch(width, height);
  ctx.drawImage(canvas, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  return analyzePixels(image.data, width, height);
}

/** Metric computation, split out so Node-side tools can reuse it. */
export function analyzePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): FrameMetrics {
  const pixelCount = width * height;
  const luminance = new Float32Array(pixelCount);
  const saturation = new Float32Array(pixelCount);
  const hue = new Float32Array(pixelCount);

  let luminanceSum = 0;
  let saturationSum = 0;
  let clippedBlack = 0;
  let clippedWhite = 0;

  const HUE_BINS = 36;
  const hueHistogram = new Float32Array(HUE_BINS);

  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 4]! / 255;
    const g = data[i * 4 + 1]! / 255;
    const b = data[i * 4 + 2]! / 255;

    // Rec. 709 luma: matches how the eye weights the channels.
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[i] = luma;
    luminanceSum += luma;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const sat = max > 1e-6 ? delta / max : 0;
    saturation[i] = sat;
    saturationSum += sat;

    let h = 0;
    if (delta > 1e-6) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    hue[i] = h;

    // Weight the hue histogram by saturation so near-grey pixels, whose hue is
    // numerically unstable and visually irrelevant, do not swamp it.
    if (sat > 0.12 && luma > 0.04) {
      hueHistogram[Math.min(HUE_BINS - 1, Math.floor((h / 360) * HUE_BINS))]! += sat;
    }

    if (luma < 0.004) clippedBlack++;
    if (luma > 0.996) clippedWhite++;
  }

  // --- Percentiles ---------------------------------------------------------
  const sortedLuminance = Float32Array.from(luminance).sort();
  const percentile = (p: number): number =>
    sortedLuminance[Math.min(pixelCount - 1, Math.max(0, Math.floor(p * pixelCount)))]!;
  const luminanceP1 = percentile(0.01);
  const luminanceP99 = percentile(0.99);

  // --- Highlight saturation ------------------------------------------------
  const highlightThreshold = percentile(0.9);
  let highlightSaturationSum = 0;
  let highlightCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (luminance[i]! >= highlightThreshold) {
      highlightSaturationSum += saturation[i]!;
      highlightCount++;
    }
  }

  // --- Local contrast and edges -------------------------------------------
  let laplacianSquaredSum = 0;
  let edgePixels = 0;
  let interiorCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian =
        4 * luminance[i]! -
        luminance[i - 1]! -
        luminance[i + 1]! -
        luminance[i - width]! -
        luminance[i + width]!;
      laplacianSquaredSum += laplacian * laplacian;
      if (Math.abs(laplacian) > 0.08) edgePixels++;
      interiorCount++;
    }
  }

  // --- Horizontal bands ----------------------------------------------------
  // A crude but effective proxy for depth: in a side-scroller the sky and
  // distant layers occupy the top of the frame and the foreground the bottom,
  // so comparing bands detects a missing aerial-perspective gradient.
  const bandContrast: [number, number, number] = [0, 0, 0];
  const bandSaturation: [number, number, number] = [0, 0, 0];
  const bandCounts = [0, 0, 0];
  const bandHeight = height / 3;

  for (let y = 1; y < height - 1; y++) {
    const band = Math.min(2, Math.floor(y / bandHeight));
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian =
        4 * luminance[i]! -
        luminance[i - 1]! -
        luminance[i + 1]! -
        luminance[i - width]! -
        luminance[i + width]!;
      bandContrast[band] += laplacian * laplacian;
      bandSaturation[band] += saturation[i]!;
      bandCounts[band]!++;
    }
  }
  for (let b = 0; b < 3; b++) {
    const count = Math.max(bandCounts[b]!, 1);
    bandContrast[b] = Math.sqrt(bandContrast[b]! / count);
    bandSaturation[b] = bandSaturation[b]! / count;
  }

  // --- Bloom energy --------------------------------------------------------
  let bloomPixels = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (luminance[i]! > 0.82) bloomPixels++;
  }

  // --- Player cyan ---------------------------------------------------------
  // The protected accent band, roughly 170-200 degrees.
  let cyanPixels = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (hue[i]! >= 168 && hue[i]! <= 202 && saturation[i]! > 0.3 && luminance[i]! > 0.15) {
      cyanPixels++;
    }
  }

  // --- Hue entropy ---------------------------------------------------------
  let hueTotal = 0;
  for (let i = 0; i < HUE_BINS; i++) hueTotal += hueHistogram[i]!;
  let hueEntropy = 0;
  if (hueTotal > 0) {
    for (let i = 0; i < HUE_BINS; i++) {
      const p = hueHistogram[i]! / hueTotal;
      if (p > 0) hueEntropy -= p * Math.log2(p);
    }
    // Normalise against the maximum possible entropy for this bin count, so the
    // figure is comparable regardless of binning.
    hueEntropy /= Math.log2(HUE_BINS);
  }

  const dominantHues = Array.from(hueHistogram, (value, index) => ({
    hue: (index + 0.5) * (360 / HUE_BINS),
    share: hueTotal > 0 ? value / hueTotal : 0,
  }))
    .sort((a, b) => b.share - a.share)
    .slice(0, 5);

  return {
    meanLuminance: luminanceSum / pixelCount,
    luminanceP1,
    luminanceP99,
    dynamicRange: luminanceP99 - luminanceP1,
    clippedBlack: clippedBlack / pixelCount,
    clippedWhite: clippedWhite / pixelCount,

    meanSaturation: saturationSum / pixelCount,
    highlightSaturation: highlightCount > 0 ? highlightSaturationSum / highlightCount : 0,

    localContrast: Math.sqrt(laplacianSquaredSum / Math.max(interiorCount, 1)),
    edgeDensity: edgePixels / Math.max(interiorCount, 1),

    bloomEnergy: bloomPixels / pixelCount,

    bandContrast,
    bandSaturation,

    cyanPresence: cyanPixels / pixelCount,
    hueEntropy,
    dominantHues,

    width,
    height,
  };
}
