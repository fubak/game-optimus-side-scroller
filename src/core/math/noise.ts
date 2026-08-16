/**
 * Deterministic gradient noise.
 *
 * Used pervasively: dust and fog density fields, camera shake, the dissolve
 * mask on enemy deaths, surface wear during asset baking, and the drift of
 * ambient particles.
 *
 * Everything here is a pure function of its coordinates and a permutation seed
 * — no hidden state. That matters because the capture harness replays scenarios
 * frame-for-frame, and any noise that depended on call order would make
 * recorded footage non-reproducible.
 */

const PERM_SIZE = 512;

/** Builds a seeded permutation table for a noise field. */
function buildPermutation(seed: number): Uint8Array {
  const p = new Uint8Array(PERM_SIZE);
  const source = new Uint8Array(256);
  for (let i = 0; i < 256; i++) source[i] = i;

  // Fisher-Yates driven by a small xorshift so tables are stable per seed.
  let state = (seed | 0) || 0x9e3779b9;
  for (let i = 255; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = Math.abs(state) % (i + 1);
    const tmp = source[i]!;
    source[i] = source[j]!;
    source[j] = tmp;
  }
  for (let i = 0; i < PERM_SIZE; i++) p[i] = source[i & 255]!;
  return p;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function grad2(hash: number, x: number, y: number): number {
  // Eight evenly-spaced gradient directions; the low 3 bits pick one.
  switch (hash & 7) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return x;
    case 5:
      return -x;
    case 6:
      return y;
    default:
      return -y;
  }
}

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/**
 * A seeded Perlin noise field.
 *
 * Instantiate one per visual system (dust, fog, wear) so that retuning one
 * effect cannot shift the appearance of another.
 */
export class NoiseField {
  private readonly perm: Uint8Array;

  constructor(seed = 1337) {
    this.perm = buildPermutation(seed);
  }

  /** 2D Perlin noise in roughly [-1, 1]. */
  noise2(x: number, y: number): number {
    const p = this.perm;
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const aa = p[p[xi]! + yi]!;
    const ab = p[p[xi]! + yi + 1]!;
    const ba = p[p[xi + 1]! + yi]!;
    const bb = p[p[xi + 1]! + yi + 1]!;

    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /** 3D Perlin noise in roughly [-1, 1]. The third axis is normally time. */
  noise3(x: number, y: number, z: number): number {
    const p = this.perm;
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const zi = Math.floor(z) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);
    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const a = p[xi]! + yi;
    const aa = p[a]! + zi;
    const ab = p[a + 1]! + zi;
    const b = p[xi + 1]! + yi;
    const ba = p[b]! + zi;
    const bb = p[b + 1]! + zi;

    const x1 = lerp(grad3(p[aa]!, xf, yf, zf), grad3(p[ba]!, xf - 1, yf, zf), u);
    const x2 = lerp(grad3(p[ab]!, xf, yf - 1, zf), grad3(p[bb]!, xf - 1, yf - 1, zf), u);
    const y1 = lerp(x1, x2, v);

    const x3 = lerp(grad3(p[aa + 1]!, xf, yf, zf - 1), grad3(p[ba + 1]!, xf - 1, yf, zf - 1), u);
    const x4 = lerp(
      grad3(p[ab + 1]!, xf, yf - 1, zf - 1),
      grad3(p[bb + 1]!, xf - 1, yf - 1, zf - 1),
      u,
    );
    const y2 = lerp(x3, x4, v);

    return lerp(y1, y2, w);
  }

  /**
   * Fractal Brownian motion: octaves of noise at doubling frequency and
   * decaying amplitude. This is what turns bland noise into something that
   * reads as natural detail.
   */
  fbm2(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  fbm3(x: number, y: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise3(x * freq, y * freq, z * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Ridged multifractal — sharp creases instead of soft blobs. Used for rock
   * strata in the Ares canyons and the crystalline fracture patterns in the
   * Prismatic Hollow.
   */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise2(x * freq, y * freq));
      sum += n * n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Turbulent, divergence-free flow derived from the curl of a noise potential.
   *
   * Divergence-free means particles advected by this field never bunch up or
   * thin out artificially, which is exactly the swirling-but-uniform behaviour
   * wanted for airborne dust and drifting spores.
   */
  curl(x: number, y: number, out: { x: number; y: number }, epsilon = 0.01): void {
    const n1 = this.fbm2(x, y + epsilon, 3);
    const n2 = this.fbm2(x, y - epsilon, 3);
    const n3 = this.fbm2(x + epsilon, y, 3);
    const n4 = this.fbm2(x - epsilon, y, 3);
    const inv = 1 / (2 * epsilon);
    out.x = (n1 - n2) * inv;
    out.y = -(n3 - n4) * inv;
  }
}

/** Shared field for effects that do not need their own tuning identity. */
export const defaultNoise = new NoiseField(0x0f71);

/**
 * Sums three incommensurate sine waves to produce smooth, non-repeating 1D
 * wobble. Much cheaper than gradient noise, and used for camera handheld sway
 * and idle breathing where the exact spectrum does not matter.
 */
export const wobble = (t: number, seed = 0): number =>
  (Math.sin(t * 1.0 + seed * 1.7) +
    Math.sin(t * 2.31 + seed * 3.1) * 0.5 +
    Math.sin(t * 4.73 + seed * 5.9) * 0.25) /
  1.75;
