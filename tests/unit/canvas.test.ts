import { describe, expect, it } from 'vitest';
import {
  computeEnhancedBufferSize,
  computeEnhancedFit,
  computeViewportFit,
  DEFAULT_MAX_BUFFER_HEIGHT,
  DEFAULT_MAX_BUFFER_WIDTH,
  DEFAULT_MAX_DPR,
  INTERNAL_HEIGHT,
  INTERNAL_WIDTH,
} from '../../src/core/canvas';

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

describe('computeEnhancedFit', () => {
  it('fills the viewport exactly when the aspect ratio matches', () => {
    const fit = computeEnhancedFit(1920, 1080);
    expect(fit.width).toBeCloseTo(1920, 5);
    expect(fit.height).toBeCloseTo(1080, 5);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(0);
  });

  it('letterboxes with fractional CSS pixels instead of snapping to an integer scale', () => {
    // 1000x600 has no integer scale that fits: computeViewportFit floors it to 2x (960x540), but
    // the enhanced fit should use every fractional pixel of the limiting axis (here, width).
    const fit = computeEnhancedFit(1000, 600);
    expect(fit.width).toBeCloseTo(1000, 5);
    expect(fit.height).toBeCloseTo(1000 / (INTERNAL_WIDTH / INTERNAL_HEIGHT), 5);
    expect(fit.width).toBeGreaterThan(960);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBeCloseTo((600 - fit.height) / 2, 5);
  });

  it('pillarboxes an ultra-wide viewport on the limiting height axis', () => {
    const fit = computeEnhancedFit(2560, 600);
    expect(fit.height).toBeCloseTo(600, 5);
    expect(fit.offsetY).toBe(0);
    expect(fit.offsetX).toBeGreaterThan(0);
  });

  it('reports a fractional scale factor consistent with its own width', () => {
    const fit = computeEnhancedFit(1366, 768);
    expect(fit.scale).toBeCloseTo(fit.width / INTERNAL_WIDTH, 10);
    expect(fit.scale).toBeCloseTo(fit.height / INTERNAL_HEIGHT, 10);
  });

  it('never produces a zero or negative size for degenerate viewports', () => {
    for (const [width, height] of [
      [0, 0],
      [-100, -100],
      [Number.NaN, Number.NaN],
    ]) {
      const fit = computeEnhancedFit(width!, height!);
      expect(fit.width).toBeGreaterThan(0);
      expect(fit.height).toBeGreaterThan(0);
    }
  });

  it('supports custom internal buffer sizes', () => {
    const fit = computeEnhancedFit(800, 800, 100, 100);
    expect(fit.width).toBeCloseTo(800, 5);
    expect(fit.height).toBeCloseTo(800, 5);
  });
});

describe('computeEnhancedBufferSize', () => {
  it('multiplies CSS size by devicePixelRatio and renderScale', () => {
    const size = computeEnhancedBufferSize({
      cssWidth: 960,
      cssHeight: 540,
      devicePixelRatio: 2,
      renderScale: 1,
    });
    expect(size.width).toBe(1920);
    expect(size.height).toBe(1080);
  });

  it('applies renderScale on top of the device pixel ratio', () => {
    const size = computeEnhancedBufferSize({
      cssWidth: 960,
      cssHeight: 540,
      devicePixelRatio: 1,
      renderScale: 1.5,
    });
    expect(size.width).toBe(1440);
    expect(size.height).toBe(810);
  });

  it('caps the effective devicePixelRatio at maxDpr', () => {
    const uncapped = computeEnhancedBufferSize({
      cssWidth: 500,
      cssHeight: 500,
      devicePixelRatio: 4,
      renderScale: 1,
      maxDpr: 4,
    });
    const capped = computeEnhancedBufferSize({
      cssWidth: 500,
      cssHeight: 500,
      devicePixelRatio: 4,
      renderScale: 1,
      maxDpr: 2,
    });
    expect(uncapped.width).toBe(2000);
    expect(capped.width).toBe(1000);
  });

  it('defaults devicePixelRatio and maxDpr to sane values when omitted', () => {
    const size = computeEnhancedBufferSize({ cssWidth: 480, cssHeight: 270 });
    expect(size.width).toBe(480);
    expect(size.height).toBe(270);
    expect(DEFAULT_MAX_DPR).toBeGreaterThanOrEqual(1);
  });

  it('scales down uniformly, preserving aspect ratio, once the absolute cap is hit', () => {
    const size = computeEnhancedBufferSize({
      cssWidth: 3840,
      cssHeight: 2160,
      devicePixelRatio: 2,
      renderScale: 1,
    });
    expect(size.width).toBeLessThanOrEqual(DEFAULT_MAX_BUFFER_WIDTH);
    expect(size.height).toBeLessThanOrEqual(DEFAULT_MAX_BUFFER_HEIGHT);
    expect(size.width / size.height).toBeCloseTo(3840 / 2160, 5);
  });

  it('respects custom absolute caps', () => {
    const size = computeEnhancedBufferSize({
      cssWidth: 2000,
      cssHeight: 1000,
      devicePixelRatio: 3,
      renderScale: 1,
      maxDpr: 3,
      maxWidth: 1000,
      maxHeight: 1000,
    });
    expect(size.width).toBeLessThanOrEqual(1000);
    expect(size.height).toBeLessThanOrEqual(1000);
  });

  it('never returns a zero or negative buffer size for degenerate inputs', () => {
    for (const [cssWidth, cssHeight] of [
      [0, 0],
      [-50, -50],
      [Number.NaN, Number.NaN],
    ]) {
      const size = computeEnhancedBufferSize({ cssWidth: cssWidth!, cssHeight: cssHeight! });
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
    }
  });
});
