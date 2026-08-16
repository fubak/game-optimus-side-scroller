/**
 * Seeded pseudo-random number generation.
 *
 * Determinism is a hard requirement, not a nicety. The capture harness replays
 * a scenario and expects the resulting footage to be identical every time, so a
 * critique can be attributed to a code change rather than to luck. `Math.random`
 * is therefore banned everywhere in `src/`.
 *
 * The engine keeps two independent streams:
 *
 * - **`sim`** — anything that affects gameplay (enemy decisions, loot, damage
 *   variance). Advanced only from the fixed-step simulation.
 * - **`fx`** — anything purely visual (particle jitter, spark directions, dust
 *   spawn positions). Advanced from the render loop.
 *
 * Splitting them means a change to particle counts cannot desynchronise
 * gameplay, and a dropped frame cannot alter the outcome of a fight.
 */

/**
 * xorshift128+ — the generator behind most modern `Math.random`
 * implementations. Fast, passes BigCrush, and has a period of 2^128-1, which is
 * far more than a session could ever consume.
 */
export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed = 0x1a2b3c4d) {
    this.seed(seed);
  }

  /** Re-seed the stream. Uses splitmix32 so even tiny seeds fill all 128 bits. */
  seed(seed: number): void {
    let x = seed | 0;
    const next = (): number => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // A freshly-seeded xorshift is weakly mixed for the first few draws.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** Raw 32-bit draw. */
  nextUint32(): number {
    const t = this.s1 << 9;
    let r = Math.imul(this.s0 + this.s3, 5);
    r = ((r << 7) | (r >>> 25)) >>> 0;
    r = Math.imul(r, 9) >>> 0;

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return r >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [-magnitude, magnitude). */
  signed(magnitude = 1): number {
    return (this.next() * 2 - 1) * magnitude;
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on an empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /**
   * Weighted pick. `weights` must be the same length as `items` and sum to a
   * positive value.
   */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i]!;
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  /**
   * Standard normal draw via the Box-Muller transform.
   *
   * Particle lifetimes and sizes look markedly more natural sampled from a
   * bell curve than from a flat one — a uniform distribution produces a
   * visually obvious hard cutoff at both ends of the range.
   */
  gaussian(mean = 0, stdDev = 1): number {
    // `next()` can return exactly 0, and log(0) is -Infinity.
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Uniformly distributed unit vector, written into `out`. */
  direction(out: { x: number; y: number }): void {
    const a = this.next() * Math.PI * 2;
    out.x = Math.cos(a);
    out.y = Math.sin(a);
  }

  /** Uniform point inside a unit disc (not just on its edge), written into `out`. */
  insideCircle(out: { x: number; y: number }, radius = 1): void {
    const a = this.next() * Math.PI * 2;
    // The sqrt is essential: without it, points bunch toward the centre.
    const r = Math.sqrt(this.next()) * radius;
    out.x = Math.cos(a) * r;
    out.y = Math.sin(a) * r;
  }

  /** Snapshot the internal state, for save games and harness rewind. */
  getState(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  setState(state: readonly [number, number, number, number]): void {
    this.s0 = state[0];
    this.s1 = state[1];
    this.s2 = state[2];
    this.s3 = state[3];
  }

  /** A new generator deterministically derived from this one. */
  fork(): Rng {
    return new Rng(this.nextUint32());
  }
}

/** Gameplay-affecting stream. Only the fixed-step simulation may advance this. */
export const simRng = new Rng(0x5eed_0001);

/** Visual-only stream. Safe to advance from the render loop. */
export const fxRng = new Rng(0x5eed_0002);

/** Resets both streams — the harness calls this before every recorded scenario. */
export function reseedAll(seed: number): void {
  simRng.seed(seed ^ 0x5eed_0001);
  fxRng.seed(seed ^ 0x5eed_0002);
}
