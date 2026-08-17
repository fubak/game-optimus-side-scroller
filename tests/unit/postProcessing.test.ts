import { describe, expect, it } from 'vitest';
import { particleBlendGroup, shapeValue } from '../../src/render/gl/particleBatch';
import { tonemapOperatorIndex } from '../../src/render/gl/post/composite';

/**
 * Pure-logic coverage for Stage 6/7's small exhaustive-switch helpers.
 *
 * The classes around these (`BloomPass`, `CompositePass`, `ParticleBatch`) all need a live
 * `WebGL2RenderingContext` to construct, so — same rationale as `tests/unit/lights.test.ts` for
 * the deferred lighting pass — only the GL-free pure functions get a unit test here; the shader
 * pipelines themselves are exercised visually via the Playwright smoke/visual tests.
 */

describe('tonemapOperatorIndex', () => {
  it('maps every TonemapOperator to a stable, distinct index', () => {
    expect(tonemapOperatorIndex('aces')).toBe(0);
    expect(tonemapOperatorIndex('agx')).toBe(1);
  });
});

describe('particleBlendGroup', () => {
  it('groups bright/glowy kinds as additive', () => {
    expect(particleBlendGroup('spark')).toBe('additive');
    expect(particleBlendGroup('exhaust')).toBe('additive');
  });

  it('groups solid-ish kinds as alpha', () => {
    expect(particleBlendGroup('debris')).toBe('alpha');
    expect(particleBlendGroup('dust')).toBe('alpha');
    expect(particleBlendGroup('pickup')).toBe('alpha');
    expect(particleBlendGroup('ring')).toBe('alpha');
  });
});

describe('shapeValue', () => {
  it('maps blob/ring to distinct shader attribute values', () => {
    expect(shapeValue('blob')).toBe(0);
    expect(shapeValue('ring')).toBe(1);
  });
});
