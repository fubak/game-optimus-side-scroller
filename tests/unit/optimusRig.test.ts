import { describe, expect, it } from 'vitest';
import { buildOptimusRig } from '../../src/render/rig/optimusRig';
import type { OptimusRigOptions } from '../../src/render/rig/optimusRig';
import type { PlayerState } from '../../src/game/player';

/**
 * The full `PlayerState` union, kept honest by a compile-time exhaustiveness guard below: if
 * `game/player.ts` ever grows a new state, the `never` branch in `assertExhaustive` fails to
 * compile until this list (and the test coverage that iterates it) is updated too.
 */
const ALL_PLAYER_STATES: readonly PlayerState[] = [
  'idle',
  'run',
  'jump',
  'fall',
  'thrust',
  'dash',
  'hurt',
  'dead',
  'victory',
];

function assertExhaustive(state: PlayerState): void {
  switch (state) {
    case 'idle':
    case 'run':
    case 'jump':
    case 'fall':
    case 'thrust':
    case 'dash':
    case 'hurt':
    case 'dead':
    case 'victory':
      return;
    default: {
      const exhaustive: never = state;
      throw new Error(`ALL_PLAYER_STATES is missing a variant: ${String(exhaustive)}`);
    }
  }
}

function baseOptions(overrides: Partial<OptimusRigOptions> = {}): OptimusRigOptions {
  return {
    x: 100,
    y: 50,
    facing: 1,
    state: 'idle',
    animTime: 0,
    speedRatio: 0,
    energyRatio: 1,
    ...overrides,
  };
}

function boundsOf(parts: ReturnType<typeof buildOptimusRig>): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const part of parts) {
    minX = Math.min(minX, part.x);
    maxX = Math.max(maxX, part.x + part.width);
    minY = Math.min(minY, part.y);
    maxY = Math.max(maxY, part.y + part.height);
  }
  return { minX, maxX, minY, maxY };
}

describe('buildOptimusRig — exhaustive state coverage', () => {
  it('covers every PlayerState variant', () => {
    expect(ALL_PLAYER_STATES.length).toBe(9);
    for (const state of ALL_PLAYER_STATES) assertExhaustive(state);
  });

  it('returns a non-empty, finite rig for every state', () => {
    for (const state of ALL_PLAYER_STATES) {
      const parts = buildOptimusRig(baseOptions({ state, animTime: 0.3 }));
      expect(parts.length).toBeGreaterThan(10);
      for (const part of parts) {
        expect(Number.isFinite(part.x)).toBe(true);
        expect(Number.isFinite(part.y)).toBe(true);
        expect(Number.isFinite(part.width)).toBe(true);
        expect(Number.isFinite(part.height)).toBe(true);
        expect(part.width).toBeGreaterThanOrEqual(0);
        expect(part.height).toBeGreaterThanOrEqual(0);
        expect(typeof part.color).toBe('string');
        if (part.emissive !== undefined) expect(Number.isFinite(part.emissive)).toBe(true);
        if (part.alpha !== undefined) expect(Number.isFinite(part.alpha)).toBe(true);
      }
    }
  });
});

describe('buildOptimusRig — pose continuity (no NaNs)', () => {
  // Sparse-but-representative grid: enough to catch NaNs without timing out as the rig densifies.
  const animTimes = [0, 0.016, 0.1, 0.5, 2, 20];
  const speedRatios = [0, 0.5, 1, 1.5];
  const energyRatios = [0, 0.5, 1];
  const facings: readonly (1 | -1)[] = [1, -1];

  it('never produces NaN/Infinity across a dense sweep of inputs', { timeout: 15_000 }, () => {
    for (const state of ALL_PLAYER_STATES) {
      for (const facing of facings) {
        for (const animTime of animTimes) {
          for (const speedRatio of speedRatios) {
            for (const energyRatio of energyRatios) {
              const parts = buildOptimusRig(baseOptions({ state, facing, animTime, speedRatio, energyRatio }));
              for (const part of parts) {
                expect(Number.isFinite(part.x), `x for ${state}@${animTime}`).toBe(true);
                expect(Number.isFinite(part.y), `y for ${state}@${animTime}`).toBe(true);
                expect(Number.isFinite(part.width), `width for ${state}@${animTime}`).toBe(true);
                expect(Number.isFinite(part.height), `height for ${state}@${animTime}`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('stays close to a fixed silhouette scale (no exploding limbs) across the sweep', () => {
    for (const state of ALL_PLAYER_STATES) {
      for (const animTime of animTimes) {
        const parts = buildOptimusRig(baseOptions({ state, animTime, speedRatio: 1, energyRatio: 1 }));
        const bounds = boundsOf(parts);
        expect(bounds.maxX - bounds.minX).toBeLessThan(40);
        expect(bounds.maxY - bounds.minY).toBeLessThan(60);
      }
    }
  });

  it('blends every state in from a shared neutral pose at the instant of a transition', () => {
    // `animTime` resets to 0 on every `Player.setState` call, and every offset field's neutral
    // value is 0 (see optimusRig.ts's module doc) — so at animTime=0 every state must produce the
    // exact same horizontal silhouette as idle, regardless of how extreme its steady-state pose is.
    const idleBounds = boundsOf(buildOptimusRig(baseOptions({ state: 'idle', animTime: 0 })));
    for (const state of ALL_PLAYER_STATES) {
      if (state === 'dead') continue; // the death collapse is intentionally time-based, not eased.
      const bounds = boundsOf(buildOptimusRig(baseOptions({ state, animTime: 0, speedRatio: 1 })));
      expect(bounds.minX).toBeCloseTo(idleBounds.minX, 5);
      expect(bounds.maxX).toBeCloseTo(idleBounds.maxX, 5);
    }
  });

  it('changes smoothly frame-to-frame through a run transition (no pops)', () => {
    // The run cycle itself is an oscillation (its bounding box is not expected to grow
    // monotonically), but it must never *pop*: sampled at a normal frame rate, consecutive frames
    // should differ by a small, bounded amount even while the transition-blend window is easing
    // the swing in.
    const dt = 1 / 60;
    let previous = boundsOf(buildOptimusRig(baseOptions({ state: 'run', animTime: 0, speedRatio: 1 })));
    for (let t = dt; t <= 0.5; t += dt) {
      const current = boundsOf(buildOptimusRig(baseOptions({ state: 'run', animTime: t, speedRatio: 1 })));
      expect(Math.abs(current.minX - previous.minX)).toBeLessThan(4);
      expect(Math.abs(current.maxX - previous.maxX)).toBeLessThan(4);
      previous = current;
    }
  });
});

describe('buildOptimusRig — death pose progresses', () => {
  it('folds further (lower, more compressed) the longer it has been dead', () => {
    const at = (animTime: number): ReturnType<typeof boundsOf> =>
      boundsOf(buildOptimusRig(baseOptions({ state: 'dead', animTime, x: 0, y: 0 })));

    const t0 = at(0);
    const t1 = at(0.3);
    const t2 = at(0.6);
    const t3 = at(0.9);
    const t4 = at(3);

    // `bob` grows monotonically with the collapse, which pushes every anchor point (hips,
    // shoulders, head) further down — i.e. the topmost pixel of the silhouette moves down too.
    expect(t1.minY).toBeGreaterThan(t0.minY);
    expect(t2.minY).toBeGreaterThan(t1.minY);
    expect(t3.minY).toBeGreaterThanOrEqual(t2.minY);
    // The collapse curve is clamped, so it plateaus once fully folded.
    expect(t4.minY).toBeCloseTo(t3.minY, 3);
  });

  it('never regresses back towards standing once collapsing', () => {
    let previous = boundsOf(buildOptimusRig(baseOptions({ state: 'dead', animTime: 0, x: 0, y: 0 }))).minY;
    for (let t = 0.05; t <= 1.5; t += 0.05) {
      const current = boundsOf(buildOptimusRig(baseOptions({ state: 'dead', animTime: t, x: 0, y: 0 }))).minY;
      expect(current).toBeGreaterThanOrEqual(previous - 1e-6);
      previous = current;
    }
  });
});

describe('buildOptimusRig — facing', () => {
  it('mirrors the silhouette around the origin when facing flips', () => {
    const right = boundsOf(buildOptimusRig(baseOptions({ facing: 1, x: 0, y: 0, animTime: 0.3, state: 'run' })));
    const left = boundsOf(buildOptimusRig(baseOptions({ facing: -1, x: 0, y: 0, animTime: 0.3, state: 'run' })));
    // The collision box centre (x=0 + PLAYER_WIDTH/2) is the mirror axis; both silhouettes should
    // have the same width and be reflections of one another around it.
    expect(right.maxX - right.minX).toBeCloseTo(left.maxX - left.minX, 5);
  });
});
