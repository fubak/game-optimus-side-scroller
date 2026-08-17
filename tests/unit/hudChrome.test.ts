import { describe, expect, it, vi } from 'vitest';
import { fillSoftBar, fillSoftPip } from '../../src/render/hudChrome';

describe('hudChrome', () => {
  it('fillSoftBar paints well, track, and proportional fill', () => {
    const fillRect = vi.fn();
    const ctx = { fillStyle: '', globalAlpha: 1, fillRect } as unknown as CanvasRenderingContext2D;
    fillSoftBar(ctx, 10, 20, 40, 4, 0.5, {
      well: '#111',
      track: '#222',
      fill: '#0ff',
      highlight: '#fff',
    });
    expect(fillRect).toHaveBeenCalled();
    // Fill width is half of 40.
    expect(fillRect.mock.calls.some((c) => c[0] === 10 && c[1] === 20 && c[2] === 20 && c[3] === 4)).toBe(
      true,
    );
  });

  it('fillSoftPip paints filled and empty plates', () => {
    const fillRect = vi.fn();
    const ctx = { fillStyle: '', globalAlpha: 1, fillRect } as unknown as CanvasRenderingContext2D;
    fillSoftPip(ctx, 0, 0, 7, 6, true, {
      filled: '#f00',
      empty: '#333',
      highlight: '#fff',
      emptyShade: '#222',
    });
    expect(fillRect).toHaveBeenCalled();
  });
});
