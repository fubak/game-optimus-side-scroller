import { describe, expect, it } from 'vitest';
import {
  ENEMY_CLIPS,
  OPTIMUS_CLIPS,
  buildCharacterAtlas,
  frameKey,
  hashCharacterAtlas,
} from '../../src/render/spritesheet';

describe('buildCharacterAtlas', () => {
  it(
    'is deterministic: two builds produce the same hash',
    () => {
      const a = buildCharacterAtlas();
      const b = buildCharacterAtlas();
      expect(hashCharacterAtlas(a)).toBe(hashCharacterAtlas(b));
      expect(a.width).toBe(b.width);
      expect(a.height).toBe(b.height);
      expect(a.albedo.length).toBe(a.width * a.height * 4);
      expect(a.emissive.length).toBe(a.width * a.height * 4);
    },
    30_000,
  );

  it(
    'packs every Optimus and enemy clip frame with a draw size',
    () => {
      const atlas = buildCharacterAtlas();
      const expectedClips = [...OPTIMUS_CLIPS, ...ENEMY_CLIPS];
      expect(atlas.clips.size).toBe(expectedClips.length);

      for (const clip of expectedClips) {
        expect(atlas.clips.get(clip.id)?.fps).toBe(clip.fps);
        expect(atlas.clips.get(clip.id)?.frameCount).toBe(clip.frameCount);
        const draw = atlas.drawSizes.get(clip.id);
        expect(draw).toBeDefined();
        expect(draw!.width).toBeGreaterThan(0);
        expect(draw!.height).toBeGreaterThan(0);

        for (let frame = 0; frame < clip.frameCount; frame += 1) {
          const rect = atlas.rects.get(frameKey(clip.id, frame));
          expect(rect).toBeDefined();
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(atlas.width);
          expect(rect!.y + rect!.height).toBeLessThanOrEqual(atlas.height);
        }
      }
    },
    30_000,
  );

  it(
    'writes opaque silhouette pixels into at least one run-cycle cell',
    () => {
      const atlas = buildCharacterAtlas();
      const rect = atlas.rects.get(frameKey('optimus:run', 0));
      expect(rect).toBeDefined();
      let opaque = 0;
      for (let y = 0; y < rect!.height; y += 4) {
        for (let x = 0; x < rect!.width; x += 4) {
          const i = ((rect!.y + y) * atlas.width + (rect!.x + x)) * 4;
          if ((atlas.albedo[i + 3] ?? 0) > 32) opaque += 1;
        }
      }
      expect(opaque).toBeGreaterThan(20);
    },
    30_000,
  );

  it('keeps Dead Cells–smooth run FPS at or above 16', () => {
    const run = OPTIMUS_CLIPS.find((c) => c.id === 'optimus:run');
    expect(run).toBeDefined();
    expect(run!.fps).toBeGreaterThanOrEqual(16);
    expect(run!.frameCount).toBeGreaterThanOrEqual(16);
    const dash = OPTIMUS_CLIPS.find((c) => c.id === 'optimus:dash');
    expect(dash!.fps).toBeGreaterThanOrEqual(24);
  });

  it('draws Optimus larger than the 10×22 collision box', () => {
    const atlas = buildCharacterAtlas();
    const draw = atlas.drawSizes.get('optimus:run');
    expect(draw).toBeDefined();
    expect(draw!.width).toBeGreaterThanOrEqual(20);
    expect(draw!.height).toBeGreaterThanOrEqual(40);
    expect(atlas.cellWidth).toBeGreaterThanOrEqual(128);
    expect(atlas.cellHeight).toBeGreaterThanOrEqual(240);
  });
});
