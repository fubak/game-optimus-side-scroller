/**
 * Blue-noise generation via the void-and-cluster algorithm.
 *
 * The renderer dithers in several places — shadow raymarch jitter, god-ray
 * sample offsets, film grain — and the *kind* of noise used matters enormously.
 * White noise clumps, so dithering with it produces visible blotches that the
 * eye immediately reads as dirt. Blue noise has no low-frequency energy: its
 * samples are evenly spread at every scale, so the error it introduces sits in
 * the high frequencies where vision is least sensitive and simply disappears.
 *
 * The texture is generated once at startup (a few milliseconds at 64x64) rather
 * than shipped as an asset, which keeps the single-file build self-contained.
 *
 * Reference: Ulichney, "The void-and-cluster method for dither array
 * generation", SPIE 1993.
 */

import { Rng } from '../core/rng.ts';

/**
 * Generates a tileable blue-noise mask.
 *
 * @param size Edge length; must be a power of two for clean tiling.
 * @param seed Deterministic seed.
 * @returns `size * size` bytes of blue noise.
 */
export function generateBlueNoise(size = 64, seed = 0xb1e): Uint8Array {
  const count = size * size;
  const rng = new Rng(seed);

  // --- Step 1: a sparse random initial binary pattern -----------------------
  const binary = new Uint8Array(count);
  const initialPoints = Math.max(1, Math.floor(count / 10));
  let placed = 0;
  while (placed < initialPoints) {
    const index = rng.int(0, count - 1);
    if (binary[index] === 0) {
      binary[index] = 1;
      placed++;
    }
  }

  // --- Energy field --------------------------------------------------------
  // Each set pixel radiates a Gaussian; the field is the sum. Clusters are
  // energy peaks, voids are troughs. Sigma 1.5 is the value Ulichney found
  // works well and matches the spatial frequency the eye is least sensitive to.
  const sigma = 1.5;
  const radius = Math.min(Math.floor(size / 2), Math.ceil(sigma * 3));
  const kernelWidth = radius * 2 + 1;
  const kernel = new Float32Array(kernelWidth * kernelWidth);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const distanceSq = dx * dx + dy * dy;
      kernel[(dy + radius) * kernelWidth + (dx + radius)] = Math.exp(
        -distanceSq / (2 * sigma * sigma),
      );
    }
  }

  const energy = new Float32Array(count);

  /** Add or remove one pixel's Gaussian contribution, wrapping toroidally. */
  const splat = (index: number, sign: number): void => {
    const px = index % size;
    const py = (index / size) | 0;
    for (let dy = -radius; dy <= radius; dy++) {
      // Wrapping is what makes the result tile seamlessly, which matters
      // because the shaders repeat this texture across the whole screen.
      const y = (py + dy + size) % size;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = (px + dx + size) % size;
        energy[y * size + x]! += sign * kernel[(dy + radius) * kernelWidth + (dx + radius)]!;
      }
    }
  };

  for (let i = 0; i < count; i++) {
    if (binary[i] === 1) splat(i, 1);
  }

  const findTightestCluster = (): number => {
    let best = -1;
    let bestEnergy = -Infinity;
    for (let i = 0; i < count; i++) {
      if (binary[i] === 1 && energy[i]! > bestEnergy) {
        bestEnergy = energy[i]!;
        best = i;
      }
    }
    return best;
  };

  const findLargestVoid = (): number => {
    let best = -1;
    let bestEnergy = Infinity;
    for (let i = 0; i < count; i++) {
      if (binary[i] === 0 && energy[i]! < bestEnergy) {
        bestEnergy = energy[i]!;
        best = i;
      }
    }
    return best;
  };

  // --- Step 2: relax the initial pattern -----------------------------------
  // Repeatedly move the most clustered point into the largest gap. Once the
  // tightest cluster *is* the largest void, the pattern is maximally even.
  for (let iteration = 0; iteration < count * 2; iteration++) {
    const cluster = findTightestCluster();
    if (cluster < 0) break;
    binary[cluster] = 0;
    splat(cluster, -1);

    const gap = findLargestVoid();
    if (gap < 0 || gap === cluster) {
      binary[cluster] = 1;
      splat(cluster, 1);
      break;
    }
    binary[gap] = 1;
    splat(gap, 1);
  }

  const ranks = new Int32Array(count).fill(-1);
  const prototype = Uint8Array.from(binary);

  // --- Step 3: rank the initial points, densest first ----------------------
  let remaining = 0;
  for (let i = 0; i < count; i++) if (binary[i] === 1) remaining++;

  for (let rank = remaining - 1; rank >= 0; rank--) {
    const cluster = findTightestCluster();
    if (cluster < 0) break;
    binary[cluster] = 0;
    splat(cluster, -1);
    ranks[cluster] = rank;
  }

  // --- Step 4: rank the remaining pixels by filling the largest voids -------
  binary.set(prototype);
  energy.fill(0);
  for (let i = 0; i < count; i++) if (binary[i] === 1) splat(i, 1);

  for (let rank = remaining; rank < count; rank++) {
    const gap = findLargestVoid();
    if (gap < 0) break;
    binary[gap] = 1;
    splat(gap, 1);
    ranks[gap] = rank;
  }

  // --- Step 5: normalise ranks into byte values ----------------------------
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const rank = ranks[i]! < 0 ? 0 : ranks[i]!;
    out[i] = Math.min(255, Math.floor((rank / count) * 256));
  }
  return out;
}

/**
 * Expands a single-channel mask into RGBA, offsetting each channel by a
 * different amount.
 *
 * Effects that need several uncorrelated random values per pixel can then take
 * them from one texture fetch. Using the same value for, say, both shadow
 * jitter and grain would visibly correlate the two.
 */
export function blueNoiseToRGBA(mask: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const count = size * size;
  for (let i = 0; i < count; i++) {
    const x = i % size;
    const y = (i / size) | 0;
    // Offsets are coprime with the size so the channels stay decorrelated.
    const g = mask[((y + 13) % size) * size + ((x + 29) % size)]!;
    const b = mask[((y + 41) % size) * size + ((x + 7) % size)]!;
    const a = mask[((y + 23) % size) * size + ((x + 47) % size)]!;
    out[i * 4] = mask[i]!;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/**
 * Builds an identity colour-grading LUT as a 1024x32 strip of 32 slices.
 *
 * Biomes supply their own graded LUTs; this is the neutral starting point and
 * the fallback when a biome has none.
 */
export function identityLUT(size = 32): Uint8Array {
  const width = size * size;
  const out = new Uint8Array(width * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const x = b * size + r;
        const y = g;
        const index = (y * width + x) * 4;
        out[index] = Math.round((r / (size - 1)) * 255);
        out[index + 1] = Math.round((g / (size - 1)) * 255);
        out[index + 2] = Math.round((b / (size - 1)) * 255);
        out[index + 3] = 255;
      }
    }
  }
  return out;
}
