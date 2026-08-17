/**
 * Procedural "hand-drawn" raster style for baked character frames.
 *
 * Applied after filling hard rig rects: soft alpha fringe + dark ink outline so Enhanced sheets
 * read closer to Dead Cells painted sprites than stacked hard quads.
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
