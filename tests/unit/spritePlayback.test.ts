import { describe, expect, it } from 'vitest';
import type { ClipDesc } from '../../src/render/spritesheet';
import {
  dyingClipAnimTime,
  enemyClipId,
  optimusClipId,
  sampleClipFrame,
} from '../../src/render/spritesheet';

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

  it('selects telegraph and sealed-core clips from combat state', () => {
    expect(enemyClipId('turret', { telegraph: true })).toBe('enemy:turretTelegraph');
    expect(enemyClipId('crusher', { telegraph: true })).toBe('enemy:crusherTelegraph');
    expect(enemyClipId('overseer', { vulnerable: false })).toBe('enemy:overseerSealed');
    expect(enemyClipId('overseer', { vulnerable: true })).toBe('enemy:overseer');
  });

  it('selects dying clips over telegraph state', () => {
    expect(enemyClipId('walker', { dying: true })).toBe('enemy:walkerDying');
    expect(enemyClipId('turret', { dying: true, telegraph: true })).toBe('enemy:turretDying');
    expect(enemyClipId('overseer', { dying: true, vulnerable: false })).toBe('enemy:overseerDying');
  });
});

describe('dyingClipAnimTime', () => {
  it('maps progress 0..1 across a one-shot clip', () => {
    const clip: ClipDesc = { id: 'enemy:walkerDying', frameCount: 8, fps: 20, loop: false };
    expect(dyingClipAnimTime(clip, 0)).toBe(0);
    expect(dyingClipAnimTime(clip, 1)).toBeCloseTo(7 / 20, 5);
    expect(sampleClipFrame(clip, dyingClipAnimTime(clip, 1))).toBe(7);
  });
});
