import { describe, expect, it } from 'vitest';
import {
  aabbOverlap,
  aabbOverlapArea,
  approach,
  clamp,
  clamp01,
  distance,
  lerp,
  mix,
  rectCenterX,
  rectCenterY,
  rectContains,
  remap,
  sign,
  smoothingFactor,
} from '../../src/core/math';

describe('math helpers', () => {
  it('clamps and clamp01', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it('lerps and mixes', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerp(0, 10, 2)).toBe(20);
    expect(mix(0, 10, 2)).toBe(10);
    expect(mix(0, 10, -1)).toBe(0);
  });

  it('approaches a target without overshooting', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(9, 10, 3)).toBe(10);
    expect(approach(10, 0, 3)).toBe(7);
    expect(approach(1, 0, 3)).toBe(0);
    expect(approach(5, 5, 3)).toBe(5);
  });

  it('smoothingFactor is frame-rate independent', () => {
    // Two 1/120 s steps must close the same gap as one 1/60 s step.
    const gap = 100;
    const oneBigStep = gap * smoothingFactor(0.1, 1 / 60);
    let remaining = gap;
    for (let i = 0; i < 2; i += 1) {
      remaining -= remaining * smoothingFactor(0.1, 1 / 120);
    }
    expect(gap - remaining).toBeCloseTo(oneBigStep, 6);
    // A step of exactly one half-life closes half the gap.
    expect(smoothingFactor(0.25, 0.25)).toBeCloseTo(0.5, 10);
    expect(smoothingFactor(0, 0.016)).toBe(1);
  });

  it('signs values', () => {
    expect(sign(3)).toBe(1);
    expect(sign(-3)).toBe(-1);
    expect(sign(0)).toBe(0);
  });

  it('detects AABB overlap (touching edges do not count)', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(aabbOverlap(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(aabbOverlap(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(aabbOverlap(a, { x: 0, y: -10, width: 10, height: 10 })).toBe(false);
    expect(aabbOverlapArea(a, { x: 5, y: 0, width: 10, height: 4 })).toBe(20);
    expect(aabbOverlapArea(a, { x: 20, y: 0, width: 10, height: 4 })).toBe(0);
  });

  it('rect helpers', () => {
    const rect = { x: 10, y: 20, width: 8, height: 4 };
    expect(rectCenterX(rect)).toBe(14);
    expect(rectCenterY(rect)).toBe(22);
    expect(rectContains(rect, 10, 20)).toBe(true);
    expect(rectContains(rect, 19, 20)).toBe(false);
    expect(distance(0, 0, 3, 4)).toBe(5);
  });

  it('remaps ranges with clamping', () => {
    expect(remap(5, 0, 10, 0, 100)).toBe(50);
    expect(remap(-5, 0, 10, 0, 100)).toBe(0);
    expect(remap(50, 0, 10, 0, 100)).toBe(100);
    expect(remap(5, 3, 3, 7, 9)).toBe(7);
  });
});
