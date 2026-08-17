import { describe, expect, it } from 'vitest';
import { buildEnemyRig } from '../../src/render/rig/enemyRigs';
import type { EnemyRigOptions } from '../../src/render/rig/enemyRigs';
import type { EnemyKind } from '../../src/game/enemies';
import { palette } from '../../src/render/palette';

/**
 * The full `EnemyKind` union, kept honest by a compile-time exhaustiveness guard: if
 * `game/enemies.ts` ever grows a new archetype, `assertExhaustive`'s `never` branch fails to
 * compile until this list is updated too.
 */
const ALL_ENEMY_KINDS: readonly EnemyKind[] = ['walker', 'drone', 'turret', 'crusher', 'overseer'];

function assertExhaustive(kind: EnemyKind): void {
  switch (kind) {
    case 'walker':
    case 'drone':
    case 'turret':
    case 'crusher':
    case 'overseer':
      return;
    default: {
      const exhaustive: never = kind;
      throw new Error(`ALL_ENEMY_KINDS is missing a variant: ${String(exhaustive)}`);
    }
  }
}

function baseOptions(kind: EnemyKind, overrides: Partial<EnemyRigOptions> = {}): EnemyRigOptions {
  return {
    kind,
    x: 40,
    y: 60,
    width: 14,
    height: 14,
    facing: 1,
    animTime: 0,
    ...overrides,
  };
}

describe('buildEnemyRig — exhaustive kind coverage', () => {
  it('covers every EnemyKind variant', () => {
    expect(ALL_ENEMY_KINDS.length).toBe(5);
    for (const kind of ALL_ENEMY_KINDS) assertExhaustive(kind);
  });

  it('returns a non-empty, finite rig for every kind when alive', () => {
    for (const kind of ALL_ENEMY_KINDS) {
      const parts = buildEnemyRig(baseOptions(kind, { animTime: 0.4, telegraph: false, vulnerable: true, hitPoints: 2 }));
      expect(parts.length).toBeGreaterThan(3);
      for (const part of parts) {
        expect(Number.isFinite(part.x)).toBe(true);
        expect(Number.isFinite(part.y)).toBe(true);
        expect(Number.isFinite(part.width)).toBe(true);
        expect(Number.isFinite(part.height)).toBe(true);
        expect(part.width).toBeGreaterThanOrEqual(0);
        expect(part.height).toBeGreaterThanOrEqual(0);
        expect(typeof part.color).toBe('string');
      }
    }
  });
});

describe('buildEnemyRig — pose continuity (no NaNs)', () => {
  const animTimes = [0, 0.016, 0.1, 0.5, 1, 3, 10];
  const facings: readonly (1 | -1)[] = [1, -1];
  const dyings = [0, 0.25, 0.5, 0.75, 0.99];
  const telegraphs = [true, false];

  it('never produces NaN/Infinity across a dense sweep of inputs', () => {
    for (const kind of ALL_ENEMY_KINDS) {
      for (const facing of facings) {
        for (const animTime of animTimes) {
          for (const dying of dyings) {
            for (const telegraph of telegraphs) {
              for (const vulnerable of [true, false]) {
                for (const hitPoints of [0, 1, 2, 3]) {
                  const parts = buildEnemyRig(
                    baseOptions(kind, { facing, animTime, dying, telegraph, vulnerable, hitPoints }),
                  );
                  for (const part of parts) {
                    expect(Number.isFinite(part.x), `x for ${kind}@${animTime}`).toBe(true);
                    expect(Number.isFinite(part.y), `y for ${kind}@${animTime}`).toBe(true);
                    expect(Number.isFinite(part.width), `width for ${kind}@${animTime}`).toBe(true);
                    expect(Number.isFinite(part.height), `height for ${kind}@${animTime}`).toBe(true);
                    if (part.emissive !== undefined) expect(Number.isFinite(part.emissive)).toBe(true);
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

describe('buildEnemyRig — death fade progresses', () => {
  it('fades every part to the same alpha as dying progresses, and vanishes once dead', () => {
    for (const kind of ALL_ENEMY_KINDS) {
      const alive = buildEnemyRig(baseOptions(kind, { dying: 0 }));
      expect(alive.length).toBeGreaterThan(0);
      for (const part of alive) expect(part.alpha ?? 1).toBeCloseTo(1, 5);

      const halfway = buildEnemyRig(baseOptions(kind, { dying: 0.5 }));
      expect(halfway.length).toBeGreaterThan(0);
      for (const part of halfway) expect(part.alpha ?? 1).toBeCloseTo(0.5, 5);

      const gone = buildEnemyRig(baseOptions(kind, { dying: 1 }));
      expect(gone.length).toBe(0);
    }
  });
});

describe('buildEnemyRig — telegraph/vulnerability flourishes stay finite and bounded', () => {
  it('turret heat glow and recoil never exceed a sane emissive range', () => {
    for (const telegraph of [true, false]) {
      for (let t = 0; t < 3; t += 0.13) {
        const parts = buildEnemyRig(baseOptions('turret', { animTime: t, telegraph }));
        for (const part of parts) {
          if (part.emissive === undefined) continue;
          expect(part.emissive).toBeGreaterThanOrEqual(0);
          expect(part.emissive).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('overseer draws an open core iris only while vulnerable', () => {
    const closed = buildEnemyRig(baseOptions('overseer', { width: 46, height: 26, vulnerable: false, hitPoints: 2 }));
    const open = buildEnemyRig(baseOptions('overseer', { width: 46, height: 26, vulnerable: true, hitPoints: 2 }));
    // The open core's innermost iris layer is a bright white pupil; the sealed core never draws one.
    expect(open.some((part) => part.color === palette.white)).toBe(true);
    expect(closed.some((part) => part.color === palette.white)).toBe(false);
  });
});
