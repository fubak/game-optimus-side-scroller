import { describe, expect, it } from 'vitest';
import {
  applyHatchStrokes,
  applyPanelWear,
  outlineMask,
  softEdgeAlpha,
  texelNoise,
} from '../../src/render/spritesheet/style';

describe('spritesheet style', () => {
  it('texelNoise is deterministic and in 0..1', () => {
    expect(texelNoise(3, 7)).toBe(texelNoise(3, 7));
    expect(texelNoise(3, 7)).toBeGreaterThanOrEqual(0);
    expect(texelNoise(3, 7)).toBeLessThan(1);
    expect(texelNoise(3, 7)).not.toBe(texelNoise(4, 7));
  });

  it('applyPanelWear darkens side-edge texels relative to interior', () => {
    const width = 8;
    const height = 8;
    const hard = new Uint8Array(width * height);
    const rgb = new Uint8Array(width * height * 4);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const i = y * width + x;
        hard[i] = 255;
        const o = i * 4;
        rgb[o] = 200;
        rgb[o + 1] = 200;
        rgb[o + 2] = 200;
        rgb[o + 3] = 255;
      }
    }
    applyPanelWear(rgb, hard, width, height);
    // Left edge mid-height (edge darken, no top specular) vs block centre.
    const edge = (4 * width + 2) * 4;
    const interior = (4 * width + 4) * 4;
    expect(rgb[edge] ?? 0).toBeLessThan(rgb[interior] ?? 0);
  });

  it('applyHatchStrokes only touches covered texels', () => {
    const width = 4;
    const height = 4;
    const hard = new Uint8Array(width * height);
    const rgb = new Uint8Array(width * height * 4);
    hard[0] = 255;
    rgb[0] = 100;
    rgb[1] = 100;
    rgb[2] = 100;
    applyHatchStrokes(rgb, hard, width, height);
    expect(rgb[4]).toBe(0);
    expect(rgb[0]).toBeLessThanOrEqual(100);
  });

  it('softEdgeAlpha and outlineMask still produce a fringe ring', () => {
    const width = 5;
    const height = 5;
    const hard = new Uint8Array(width * height);
    hard[12] = 255;
    const soft = softEdgeAlpha(hard, width, height, 1);
    const outline = outlineMask(hard, width, height, 1);
    expect(soft[12]).toBe(255);
    expect(outline[12]).toBe(0);
    const ring =
      (outline[11] ?? 0) + (outline[13] ?? 0) + (outline[7] ?? 0) + (outline[17] ?? 0);
    expect(ring).toBeGreaterThan(0);
  });
});
