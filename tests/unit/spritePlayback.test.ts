import { describe, expect, it } from 'vitest';
import type { ClipDesc } from '../../src/render/spritesheet';
import { enemyClipId, optimusClipId, sampleClipFrame } from '../../src/render/spritesheet';

describe('sampleClipFrame', () => {
  const loopClip: ClipDesc = { id: 'optimus:run', frameCount: 20, fps: 20, loop: true };
  const oneShot: ClipDesc = { id: 'optimus:dash', frameCount: 10, fps: 30, loop: false };

  it('advances at clip FPS for looping clips', () => {
    expect(sampleClipFrame(loopClip, 0)).toBe(0);
    expect(sampleClipFrame(loopClip, 0.05)).toBe(1);
    expect(sampleClipFrame(loopClip, 1)).toBe(0);
    expect(sampleClipFrame(loopClip, 0.95)).toBe(19);
  });

  it('clamps one-shot clips to the last frame', () => {
    expect(sampleClipFrame(oneShot, 0)).toBe(0);
    expect(sampleClipFrame(oneShot, 0.1)).toBe(3);
    expect(sampleClipFrame(oneShot, 10)).toBe(9);
  });
});

describe('optimusClipId / enemyClipId', () => {
  it('maps every player state to an optimus clip', () => {
    expect(optimusClipId('idle')).toBe('optimus:idle');
    expect(optimusClipId('run')).toBe('optimus:run');
    expect(optimusClipId('thrust')).toBe('optimus:thrust');
    expect(optimusClipId('dash')).toBe('optimus:dash');
    expect(optimusClipId('victory')).toBe('optimus:victory');
  });

  it('maps every enemy kind to an enemy clip', () => {
    expect(enemyClipId('walker')).toBe('enemy:walker');
    expect(enemyClipId('overseer')).toBe('enemy:overseer');
  });
});
