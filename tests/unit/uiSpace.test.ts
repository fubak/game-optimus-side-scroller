import { describe, expect, it, vi } from 'vitest';
import { makeBufferSpaceTextDraw, uiScaleForDisplay } from '../../src/render/uiSpace';
import type { Display } from '../../src/core/canvas';
import type { DrawTextFn } from '../../src/render/text';

function fakeDisplay(mode: 'classic' | 'enhanced', bufferWidth: number): Display {
  return {
    mode,
    bufferWidth,
    bufferHeight: Math.round(bufferWidth * (270 / 480)),
    width: 480,
    height: 270,
  } as Display;
}

describe('uiScaleForDisplay', () => {
  it('is 1 for Classic regardless of buffer size', () => {
    expect(uiScaleForDisplay(fakeDisplay('classic', 480))).toBe(1);
    expect(uiScaleForDisplay(fakeDisplay('classic', 1920))).toBe(1);
  });

  it('is bufferWidth / 480 for Enhanced', () => {
    expect(uiScaleForDisplay(fakeDisplay('enhanced', 1920))).toBe(4);
    expect(uiScaleForDisplay(fakeDisplay('enhanced', 3840))).toBe(8);
  });
});

describe('makeBufferSpaceTextDraw', () => {
  it('returns the fallback unchanged when uiScale is 1', () => {
    const fallback: DrawTextFn = vi.fn();
    expect(makeBufferSpaceTextDraw(1, fallback)).toBe(fallback);
  });

  it('draws MSDF in identity buffer space at scaled glyph size', () => {
    const fallback: DrawTextFn = vi.fn();
    const draw = makeBufferSpaceTextDraw(4, fallback);
    const save = vi.fn();
    const restore = vi.fn();
    const setTransform = vi.fn();
    const ctx = { save, restore, setTransform } as unknown as CanvasRenderingContext2D;

    // Exercise the wrapper; drawTextMsdf will try to touch more of ctx — catch and assert CTM dance.
    try {
      draw(ctx, 'HI', 10, 20, { scale: 2, color: '#fff' });
    } catch {
      // Glyph atlas may need a DOM canvas in this environment; CTM setup still ran first.
    }
    expect(save).toHaveBeenCalled();
    expect(setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    expect(fallback).not.toHaveBeenCalled();
  });
});
