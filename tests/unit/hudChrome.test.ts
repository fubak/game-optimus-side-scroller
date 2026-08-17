import { describe, expect, it, vi } from 'vitest';
import { fillSoftBar, fillSoftPip } from '../../src/render/hudChrome';

function mockCtx(): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    globalAlpha: 1,
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe('hudChrome', () => {
  it('fillSoftBar paints well, track, and proportional fill', () => {
    const ctx = mockCtx();
    fillSoftBar(ctx, 10, 20, 40, 4, 0.5, {
      well: '#111',
      track: '#222',
      fill: '#0ff',
      highlight: '#fff',
    });
    expect(ctx.fillRect).toHaveBeenCalled();
    const calls = vi.mocked(ctx.fillRect).mock.calls;
    // Fill width is half of 40.
    expect(calls.some((c) => c[0] === 10 && c[1] === 20 && c[2] === 20 && c[3] === 4)).toBe(true);
  });

  it('fillSoftPip paints filled and empty plates', () => {
    const ctx = mockCtx();
    fillSoftPip(ctx, 0, 0, 7, 6, true, {
      filled: '#f00',
      empty: '#333',
      highlight: '#fff',
      emptyShade: '#222',
    });
    expect(ctx.fillRect).toHaveBeenCalled();
  });
});
