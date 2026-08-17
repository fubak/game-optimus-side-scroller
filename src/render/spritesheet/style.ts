/**
 * Procedural "hand-drawn" raster style for baked character frames.
 *
 * Applied after filling hard rig rects: soft alpha fringe + dark ink outline so Enhanced sheets
 * read closer to Dead Cells painted sprites than stacked hard quads. Panel wear and hatch strokes
 * add cheap paint-like variation without authored bitmaps.
 */

/** Dilate the alpha silhouette by `radius` texels (max over neighbourhood). */
export function dilateAlpha(alpha: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          const v = alpha[sy * width + sx] ?? 0;
          if (v > best) best = v;
        }
      }
      out[y * width + x] = best;
    }
  }
  return out;
}

/**
 * Soften hard coverage edges: coverage becomes a smooth ramp over `softPx` texels outside the
 * hard silhouette (using distance from dilated vs original).
 */
export function softEdgeAlpha(
  hard: Uint8Array,
  width: number,
  height: number,
  softPx: number,
): Uint8Array {
  const dilated = dilateAlpha(hard, width, height, Math.max(1, Math.ceil(softPx)));
  const out = new Uint8Array(hard.length);
  for (let i = 0; i < hard.length; i += 1) {
    const h = hard[i] ?? 0;
    const d = dilated[i] ?? 0;
    if (h > 0) {
      out[i] = 255;
    } else if (d > 0) {
      out[i] = Math.round((d / 255) * 160);
    } else {
      out[i] = 0;
    }
  }
  return out;
}

/**
 * Dark outline ring: texels that are outside the hard fill but inside a small dilation.
 * Written into RGB as ink; caller composites under the fill.
 */
export function outlineMask(hard: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  const dilated = dilateAlpha(hard, width, height, radius);
  const out = new Uint8Array(hard.length);
  for (let i = 0; i < hard.length; i += 1) {
    const h = hard[i] ?? 0;
    const d = dilated[i] ?? 0;
    out[i] = h === 0 && d > 0 ? 255 : 0;
  }
  return out;
}

/** Deterministic 0..1 noise from texel coords (stable across atlas rebuilds). */
export function texelNoise(x: number, y: number): number {
  let n = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n >>> 0) % 1000) / 1000;
}

/**
 * Cheap paint wear on filled texels: edge darkening, top-edge specular ticks, and grain.
 * Mutates `rgb` in place (RGBA interleaved); only texels with hard coverage &gt; 0.
 */
export function applyPanelWear(
  rgb: Uint8Array,
  hard: Uint8Array,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if ((hard[i] ?? 0) === 0) continue;
      const left = x > 0 ? (hard[i - 1] ?? 0) : 0;
      const right = x + 1 < width ? (hard[i + 1] ?? 0) : 0;
      const up = y > 0 ? (hard[i - width] ?? 0) : 0;
      const down = y + 1 < height ? (hard[i + width] ?? 0) : 0;
      const edge = left === 0 || right === 0 || up === 0 || down === 0;
      const topLit = up === 0 && down > 0;
      const grain = texelNoise(x, y);
      let mul = 0.94 + grain * 0.1;
      if (edge) mul *= 0.88;
      if (topLit) mul *= 1.12;
      const o = i * 4;
      rgb[o] = Math.min(255, Math.round((rgb[o] ?? 0) * mul));
      rgb[o + 1] = Math.min(255, Math.round((rgb[o + 1] ?? 0) * mul));
      rgb[o + 2] = Math.min(255, Math.round((rgb[o + 2] ?? 0) * mul));
    }
  }
}

/**
 * Subtle diagonal hatch strokes inside the silhouette (Dead Cells brush-direction hint).
 * Mutates `rgb` in place.
 */
export function applyHatchStrokes(
  rgb: Uint8Array,
  hard: Uint8Array,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if ((hard[i] ?? 0) === 0) continue;
      const band = (x + y * 2) % 7;
      if (band !== 0 && band !== 1) continue;
      if (texelNoise(x * 3, y * 5) < 0.35) continue;
      const o = i * 4;
      const shade = band === 0 ? 0.9 : 0.95;
      rgb[o] = Math.round((rgb[o] ?? 0) * shade);
      rgb[o + 1] = Math.round((rgb[o + 1] ?? 0) * shade);
      rgb[o + 2] = Math.round((rgb[o + 2] ?? 0) * shade);
    }
  }
}
