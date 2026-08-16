/**
 * Seeded pseudo-random number generator (mulberry32).
 *
 * Every random decision in the simulation goes through one of these so a run is fully reproducible
 * from `(level, seed, input tape)`. Fast, tiny, and its state is a single 32-bit integer, which
 * makes snapshot/restore trivial for save-states and tests.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability `chance` (0..1). */
  chance(chance: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** ±amount, useful for particle jitter and screen shake. */
  signedRange(amount: number): number;
  /** Current internal state, for snapshots. */
  getState(): number;
  setState(state: number): void;
  /** Independent generator derived from this one (e.g. per-level decoration). */
  fork(): Rng;
}

class Mulberry32 implements Rng {
  private state: number;

  constructor(seed: number) {
    // Force to uint32; seed 0 is fine for mulberry32 because of the additive constant.
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    const low = Math.ceil(min);
    const high = Math.floor(max);
    if (high < low) return low;
    return low + Math.floor(this.next() * (high - low + 1));
  }

  chance(chance: number): boolean {
    return this.next() < chance;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new Error('rng.pick requires a non-empty array.');
    }
    const index = this.int(0, items.length - 1);
    // `noUncheckedIndexedAccess` — index is provably in range, so assert via a local.
    const item = items[index];
    if (item === undefined) {
      throw new Error('rng.pick produced an out-of-range index.');
    }
    return item;
  }

  signedRange(amount: number): number {
    return this.range(-amount, amount);
  }

  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }

  fork(): Rng {
    return new Mulberry32(Math.floor(this.next() * 4294967296));
  }
}

export function createRng(seed: number): Rng {
  return new Mulberry32(seed);
}

/** Turn an arbitrary string (e.g. a level id) into a stable 32-bit seed. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
