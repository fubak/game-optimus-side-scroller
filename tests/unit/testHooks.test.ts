import { describe, expect, it } from 'vitest';
import { shouldInstallTestHooks } from '../../src/core/testHooks';

describe('shouldInstallTestHooks', () => {
  it('always installs in dev builds', () => {
    expect(shouldInstallTestHooks('', true)).toBe(true);
  });

  it('installs in production only with ?test=1', () => {
    expect(shouldInstallTestHooks('?test=1', false)).toBe(true);
    expect(shouldInstallTestHooks('?seed=5&test=1', false)).toBe(true);
    expect(shouldInstallTestHooks('?test=0', false)).toBe(false);
    expect(shouldInstallTestHooks('', false)).toBe(false);
  });
});
