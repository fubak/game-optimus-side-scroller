import { describe, expect, it } from 'vitest';
import { computeViewportFit, INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../../src/core/canvas';

describe('computeViewportFit', () => {
  it('uses the internal 16:9 buffer size', () => {
    expect(INTERNAL_WIDTH / INTERNAL_HEIGHT).toBeCloseTo(16 / 9, 10);
  });

  it.each([
    { viewport: [480, 270], scale: 1, offsetX: 0, offsetY: 0 },
    { viewport: [960, 540], scale: 2, offsetX: 0, offsetY: 0 },
    { viewport: [1920, 1080], scale: 4, offsetX: 0, offsetY: 0 },
    // Non-integer fits round down and letterbox the remainder.
    { viewport: [1000, 600], scale: 2, offsetX: 20, offsetY: 30 },
    { viewport: [1600, 900], scale: 3, offsetX: 80, offsetY: 45 },
    // Ultra-wide: height is the limiting axis, so wide pillarboxes appear.
    { viewport: [2560, 600], scale: 2, offsetX: 800, offsetY: 30 },
  ])('fits $viewport at integer scale $scale', ({ viewport, scale, offsetX, offsetY }) => {
    const [width, height] = viewport as [number, number];
    const fit = computeViewportFit(width, height);
    expect(fit.scale).toBe(scale);
    expect(fit.width).toBe(INTERNAL_WIDTH * scale);
    expect(fit.height).toBe(INTERNAL_HEIGHT * scale);
    expect(fit.offsetX).toBe(offsetX);
    expect(fit.offsetY).toBe(offsetY);
  });

  it('never scales below 1 for tiny or degenerate viewports', () => {
    for (const [width, height] of [
      [320, 200],
      [0, 0],
      [-100, -100],
      [Number.NaN, Number.NaN],
    ]) {
      const fit = computeViewportFit(width!, height!);
      expect(fit.scale).toBe(1);
      expect(fit.offsetX).toBe(0);
      expect(fit.offsetY).toBe(0);
    }
  });

  it('always produces integer scales and offsets', () => {
    for (let width = 300; width < 2000; width += 37) {
      const fit = computeViewportFit(width, width * 0.61);
      expect(Number.isInteger(fit.scale)).toBe(true);
      expect(Number.isInteger(fit.offsetX)).toBe(true);
      expect(Number.isInteger(fit.offsetY)).toBe(true);
    }
  });

  it('supports custom internal buffer sizes', () => {
    const fit = computeViewportFit(800, 800, 100, 100);
    expect(fit.scale).toBe(8);
    expect(fit.width).toBe(800);
  });
});
