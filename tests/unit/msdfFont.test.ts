import { describe, expect, it } from 'vitest';
import { buildMsdfAtlasData } from '../../src/render/msdfFont';
import { GLYPH_CHARACTERS, GLYPH_HEIGHT, GLYPH_WIDTH, TEXT_LINE_HEIGHT, measureText } from '../../src/render/text';

/**
 * MSDF atlas checks.
 *
 * The atlas is generated at runtime from the same glyph bits `text.ts` uses, so these tests pin
 * down the two things that matter for a drop-in renderer swap: every glyph the bitmap font can
 * draw exists in the atlas, and the layout metrics (advance/line height) match exactly — a
 * mismatch here would make MSDF text drift out of alignment with bitmap text mid-sentence.
 */
describe('buildMsdfAtlasData', () => {
  it('covers every glyph the bitmap font defines', () => {
    const atlas = buildMsdfAtlasData();
    expect(atlas.glyphs.size).toBe(GLYPH_CHARACTERS.length);
    for (const character of GLYPH_CHARACTERS) {
      expect(atlas.glyphs.has(character), `atlas missing glyph '${character}'`).toBe(true);
    }
  });

  it('includes the fallback glyph used for unknown characters', () => {
    const atlas = buildMsdfAtlasData();
    expect(atlas.glyphs.has('?')).toBe(true);
  });

  it('matches the bitmap font advance/line-height metrics exactly', () => {
    const atlas = buildMsdfAtlasData();
    expect(atlas.metrics.advance).toBe(GLYPH_WIDTH);
    expect(atlas.metrics.glyphWidth).toBe(GLYPH_WIDTH);
    expect(atlas.metrics.glyphHeight).toBe(GLYPH_HEIGHT);
    expect(atlas.metrics.lineHeight).toBe(TEXT_LINE_HEIGHT);
  });

  it('produces a stable atlas size deterministically', () => {
    const first = buildMsdfAtlasData();
    const second = buildMsdfAtlasData();
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
    expect(second.glyphs.size).toBe(first.glyphs.size);
  });

  it('gives every glyph cell a positive, uniform pixel footprint', () => {
    const atlas = buildMsdfAtlasData();
    const sizes = new Set<string>();
    for (const rect of atlas.glyphs.values()) {
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(atlas.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(atlas.height);
      sizes.add(`${String(rect.width)}x${String(rect.height)}`);
    }
    // A fixed-size grid keeps advance-width math trivial for both the shader and Canvas2D paths.
    expect(sizes.size).toBe(1);
  });

  it('paints an actual signed-distance field, not a blank canvas', () => {
    // The font's strokes are ~1 source-pixel wide, so "deep inside" bytes never approach 255 the
    // way a filled disc would — 128 is still the meaningful inside/outside threshold, just with a
    // smaller margin. Scanning for values clearly on each side of 128 is enough to prove the field
    // has real structure rather than being uniformly blank.
    const atlas = buildMsdfAtlasData();
    const rect = atlas.glyphs.get('A');
    expect(rect).toBeDefined();
    if (rect === undefined) return;
    let sawInside = false;
    let sawOutside = false;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const value = atlas.pixels[(y * atlas.width + x) * 4] ?? 0;
        if (value > 140) sawInside = true;
        if (value < 116) sawOutside = true;
      }
    }
    expect(sawInside).toBe(true);
    expect(sawOutside).toBe(true);
  });

  it('leaves the space glyph fully outside (background) everywhere', () => {
    const atlas = buildMsdfAtlasData();
    const rect = atlas.glyphs.get(' ');
    expect(rect).toBeDefined();
    if (rect === undefined) return;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        const value = atlas.pixels[(y * atlas.width + x) * 4] ?? 255;
        expect(value).toBeLessThan(128);
      }
    }
  });
});

describe('MSDF/bitmap layout parity', () => {
  it('keeps the same horizontal advance as measureText for a run of glyphs', () => {
    const atlas = buildMsdfAtlasData();
    const text = 'HELLO WORLD';
    const tracking = 1;
    const scale = 2;
    const bitmapWidth = measureText(text, scale, tracking);
    const msdfWidth = text.length * (atlas.metrics.advance + tracking) * scale - tracking * scale;
    expect(msdfWidth).toBe(bitmapWidth);
  });
});
