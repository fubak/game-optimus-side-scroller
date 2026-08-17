import { describe, expect, it } from 'vitest';
import { buildEnhancedParallaxData, ENHANCED_SCALE } from '../../src/render/parallaxEnhanced';
import type { EnhancedLayerData } from '../../src/render/parallaxEnhanced';

/**
 * Cheap FNV-1a-ish hash over a layer's full pixel buffer. Layers are several million bytes at
 * Enhanced's resolution, so asserting byte-for-byte equality (e.g. via `toEqual` on an array copy)
 * is both slow and unnecessary — a hash collapses the whole buffer to one number for a single,
 * fast `expect` while still catching any pixel-level difference between two runs.
 */
function hashLayer(layer: EnhancedLayerData): number {
  let h = 0x811c9dc5;
  for (const byte of layer.data) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Enhanced parallax generation checks.
 *
 * `createClassicParallaxLayers` (`parallax.ts`) needs a real `document.createElement('canvas')`,
 * so it can't run under this suite's Node environment (see `vitest.config.ts`) — but its layer
 * dimensions are a pure function of `viewWidth`/`viewHeight` (`viewWidth * 2` wide, texel-for-texel
 * with its logical size), so this suite pins those down directly instead and compares Enhanced's
 * texel resolution against them. `buildEnhancedParallaxData` itself is the pure, DOM-free half of
 * `parallaxEnhanced.ts` (see its module doc), so it can be exercised directly here.
 */
describe('buildEnhancedParallaxData', () => {
  const options = { seed: 1234, viewWidth: 480, viewHeight: 270 } as const;

  it('produces three layers with far/mid/near scroll factors matching Classic', () => {
    const layers = buildEnhancedParallaxData(options);
    expect(layers).toHaveLength(3);
    const [far, mid, near] = layers;
    expect(far!.factor).toBeCloseTo(0.15, 10);
    expect(mid!.factor).toBeCloseTo(0.32, 10);
    expect(near!.factor).toBeCloseTo(0.55, 10);
  });

  it('is deterministic: the same seed produces an identical pixel hash per layer', () => {
    const first = buildEnhancedParallaxData(options);
    const second = buildEnhancedParallaxData(options);
    expect(first).toHaveLength(second.length);
    for (let i = 0; i < first.length; i += 1) {
      const a = first[i]!;
      const b = second[i]!;
      expect(b.texWidth).toBe(a.texWidth);
      expect(b.texHeight).toBe(a.texHeight);
      expect(hashLayer(b)).toBe(hashLayer(a));
    }
  });

  it('produces a different pixel hash for a different seed', () => {
    const a = buildEnhancedParallaxData(options);
    const b = buildEnhancedParallaxData({ ...options, seed: options.seed + 1 });
    // At least one layer's content must differ once the seed changes, otherwise every level
    // would render an identical skyline.
    const anyDifferent = a.some((layer, i) => hashLayer(layer) !== hashLayer(b[i]!));
    expect(anyDifferent).toBe(true);
  });

  it('paints nonzero (non-fully-transparent) content into every layer', () => {
    const layers = buildEnhancedParallaxData(options);
    for (const layer of layers) {
      let opaqueTexelCount = 0;
      for (let i = 3; i < layer.data.length; i += 4) {
        if ((layer.data[i] ?? 0) > 0) opaqueTexelCount += 1;
      }
      expect(opaqueTexelCount).toBeGreaterThan(0);
    }
  });

  it('generates layers at ENHANCED_SCALE texels per logical pixel, larger than Classic', () => {
    const layers = buildEnhancedParallaxData(options);
    // Classic's own layer canvases are texel-for-texel with their logical size: width = viewWidth
    // * 2 (see `createClassicParallaxLayers`), heights = viewHeight * {0.75, 0.6, 0.4} for
    // {far, mid, near}. Enhanced must be strictly larger in both dimensions for every layer.
    const classicWidth = options.viewWidth * 2;
    const classicHeightFractions = [0.75, 0.6, 0.4];
    layers.forEach((layer, i) => {
      const classicHeight = Math.round(options.viewHeight * classicHeightFractions[i]!);
      expect(layer.texWidth).toBe(classicWidth * ENHANCED_SCALE);
      expect(layer.texHeight).toBe(Math.round(options.viewHeight * classicHeightFractions[i]!) * ENHANCED_SCALE);
      expect(layer.texWidth).toBeGreaterThan(classicWidth);
      expect(layer.texHeight).toBeGreaterThan(classicHeight);
      // Logical size (used for on-screen placement/scrolling) matches Classic's exactly, so
      // swapping quality tiers doesn't change gameplay-visible layout.
      expect(layer.logicalWidth).toBe(classicWidth);
      expect(layer.logicalHeight).toBe(classicHeight);
    });
  });

  it('scales texel resolution with the view size, staying an exact multiple of ENHANCED_SCALE', () => {
    // 140/280 are chosen so that every layer's height fraction (0.75/0.6/0.4) lands on an exact
    // integer with no intermediate rounding, letting the doubled case double exactly too.
    const small = buildEnhancedParallaxData({ seed: 1, viewWidth: 240, viewHeight: 140 });
    const large = buildEnhancedParallaxData({ seed: 1, viewWidth: 480, viewHeight: 280 });
    small.forEach((layer, i) => {
      const other = large[i]!;
      expect(layer.texWidth % ENHANCED_SCALE).toBe(0);
      expect(layer.texHeight % ENHANCED_SCALE).toBe(0);
      expect(other.texWidth).toBe(layer.texWidth * 2);
      expect(other.texHeight).toBe(layer.texHeight * 2);
    });
  });
});
