import { describe, expect, it } from 'vitest';
import { createRng, hashSeed } from '../../src/core/rng';

describe('createRng', () => {
  it('is deterministic for a given seed', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const seriesA = Array.from({ length: 20 }, () => a.next());
    const seriesB = Array.from({ length: 20 }, () => b.next());
    expect(seriesA).toEqual(seriesB);
  });

  it('produces different streams for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('stays inside [0, 1) and looks roughly uniform', () => {
    const rng = createRng(99);
    const buckets = new Array<number>(10).fill(0);
    const samples = 20_000;
    for (let i = 0; i < samples; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      buckets[Math.floor(value * 10)] = (buckets[Math.floor(value * 10)] ?? 0) + 1;
    }
    const expected = samples / 10;
    for (const count of buckets) {
      expect(Math.abs(count - expected)).toBeLessThan(expected * 0.15);
    }
  });

  it('range and int respect their bounds', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.range(-5, 5);
      expect(value).toBeGreaterThanOrEqual(-5);
      expect(value).toBeLessThan(5);
      const integer = rng.int(3, 6);
      expect(Number.isInteger(integer)).toBe(true);
      expect(integer).toBeGreaterThanOrEqual(3);
      expect(integer).toBeLessThanOrEqual(6);
    }
    expect(rng.int(4, 4)).toBe(4);
    expect(rng.int(9, 2)).toBe(9);
  });

  it('int covers both endpoints', () => {
    const rng = createRng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 400; i += 1) seen.add(rng.int(0, 2));
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it('signedRange is symmetric around zero', () => {
    const rng = createRng(3);
    for (let i = 0; i < 200; i += 1) {
      const value = rng.signedRange(4);
      expect(Math.abs(value)).toBeLessThanOrEqual(4);
    }
  });

  it('picks elements and rejects empty arrays', () => {
    const rng = createRng(5);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i += 1) {
      expect(items).toContain(rng.pick(items));
    }
    expect(() => rng.pick([])).toThrow(/non-empty/);
  });

  it('snapshots and restores state', () => {
    const rng = createRng(42);
    rng.next();
    const state = rng.getState();
    const expected = [rng.next(), rng.next(), rng.next()];
    rng.setState(state);
    expect([rng.next(), rng.next(), rng.next()]).toEqual(expected);
  });

  it('forks into an independent but reproducible stream', () => {
    const parentA = createRng(8);
    const childA = parentA.fork();
    const parentB = createRng(8);
    const childB = parentB.fork();
    expect(childA.next()).toBe(childB.next());
    expect(childA.getState()).toBe(childB.getState());
  });

  it('hashSeed is stable and spreads similar strings apart', () => {
    expect(hashSeed('level-1')).toBe(hashSeed('level-1'));
    expect(hashSeed('level-1')).not.toBe(hashSeed('level-2'));
    expect(hashSeed('')).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(hashSeed('foundry'))).toBe(true);
  });
});
