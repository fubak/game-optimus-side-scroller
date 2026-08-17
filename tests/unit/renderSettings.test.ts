import { describe, expect, it } from 'vitest';
import { parseColor } from '../../src/render/color';
import {
  applyQualityPreset,
  parseRenderSettings,
  resolveBackendPreference,
  withReducedMotion,
} from '../../src/render/settings';

describe('parseColor', () => {
  it('parses #rrggbb and caches the same tuple', () => {
    const a = parseColor('#3fd0ff');
    const b = parseColor('#3fd0ff');
    expect(a).toBe(b);
    expect(a[0]).toBeCloseTo(0x3f / 255, 5);
    expect(a[3]).toBe(1);
  });

  it('parses modern rgb() with alpha', () => {
    const color = parseColor('rgb(9 12 20 / 0.45)');
    expect(color[0]).toBeCloseTo(9 / 255, 5);
    expect(color[3]).toBeCloseTo(0.45, 5);
  });
});

describe('render settings', () => {
  it('defaults missing values', () => {
    const settings = parseRenderSettings({});
    expect(settings.backend).toBe('auto');
    expect(settings.quality).toBe('high');
  });

  it('applies quality presets', () => {
    const low = applyQualityPreset(parseRenderSettings({}), 'low');
    expect(low.bloom).toBe(false);
    expect(low.shadows).toBe(false);
  });

  it('forces motion-sensitive effects off under reduced motion', () => {
    const settings = withReducedMotion(parseRenderSettings({ quality: 'ultra' }));
    expect(settings.bloom).toBe(false);
    expect(settings.grain).toBe(false);
    expect(settings.chromaticAberration).toBe(false);
    expect(settings.motionBlur).toBe(false);
  });

  it('resolves backend from URL params', () => {
    expect(resolveBackendPreference('?classic=1', parseRenderSettings({}))).toBe('classic');
    expect(resolveBackendPreference('?renderer=webgl2', parseRenderSettings({}))).toBe('webgl2');
  });
});
