import { describe, it, expect } from 'vitest';
import * as V2 from './vec2.ts';
import { damp, wrapAngle, remapClamped, moveToward, pingPong } from './scalar.ts';
import { spring, stepSpring, SPRING_PRESETS, isSettled } from './spring.ts';
import { Curve, key, smoothCurve, clampedCurve, Interp } from './curve.ts';
import { aabb, sweepAABB, overlaps, rayAABB, type SweepHit, type RayHit } from './aabb.ts';
import { NoiseField } from './noise.ts';
import { cubicBezier } from './ease.ts';

describe('vec2', () => {
  it('normalizes without dividing by zero', () => {
    const out = V2.vec2();
    V2.normalize(out, V2.vec2(0, 0));
    expect(out).toEqual({ x: 0, y: 0 });
    V2.normalize(out, V2.vec2(3, 4));
    expect(out.x).toBeCloseTo(0.6);
    expect(out.y).toBeCloseTo(0.8);
  });

  it('limits magnitude while preserving direction', () => {
    const out = V2.vec2();
    V2.limit(out, V2.vec2(30, 40), 5);
    expect(V2.length(out)).toBeCloseTo(5);
    expect(V2.angle(out)).toBeCloseTo(Math.atan2(40, 30));
  });

  it('leaves short vectors untouched when limiting', () => {
    const out = V2.vec2();
    V2.limit(out, V2.vec2(1, 1), 5);
    expect(out.x).toBeCloseTo(1);
    expect(out.y).toBeCloseTo(1);
  });

  it('reflects about a surface normal', () => {
    const out = V2.vec2();
    // Travelling down-right, bouncing off a floor whose normal points up.
    V2.reflect(out, V2.vec2(1, 1), V2.vec2(0, -1));
    expect(out.x).toBeCloseTo(1);
    expect(out.y).toBeCloseTo(-1);
  });
});

describe('scalar', () => {
  it('damp is frame-rate independent', () => {
    // Smoothing across one big step must match many small steps.
    const halfLife = 0.15;
    const total = 0.5;

    let coarse = 0;
    coarse = damp(coarse, 100, halfLife, total);

    let fine = 0;
    const steps = 500;
    for (let i = 0; i < steps; i++) fine = damp(fine, 100, halfLife, total / steps);

    expect(coarse).toBeCloseTo(fine, 6);
  });

  it('damp halves the remaining distance every half-life', () => {
    const value = damp(0, 100, 0.1, 0.1);
    expect(value).toBeCloseTo(50, 6);
  });

  it('wraps angles into [-PI, PI)', () => {
    // +/-3PI are both the same angle as PI, which sits on the boundary and
    // normalises to the -PI end of the half-open range.
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeCloseTo(Math.PI);
    expect(Math.abs(wrapAngle(-Math.PI * 3))).toBeCloseTo(Math.PI);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5);
    expect(wrapAngle(Math.PI * 2 + 0.25)).toBeCloseTo(0.25);
    expect(wrapAngle(-Math.PI * 2 - 0.25)).toBeCloseTo(-0.25);
    // Every result must land inside the range.
    for (let a = -20; a < 20; a += 0.13) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThan(Math.PI + 1e-12);
    }
  });

  it('remapClamped stays inside the destination range', () => {
    expect(remapClamped(-99, 0, 10, 100, 200)).toBe(100);
    expect(remapClamped(99, 0, 10, 100, 200)).toBe(200);
    expect(remapClamped(5, 0, 10, 100, 200)).toBeCloseTo(150);
  });

  it('moveToward never overshoots', () => {
    expect(moveToward(0, 1, 10)).toBe(1);
    expect(moveToward(0, -1, 10)).toBe(-1);
    expect(moveToward(0, 10, 1)).toBe(1);
  });

  it('pingPong stays within range', () => {
    for (let t = 0; t < 20; t += 0.37) {
      const v = pingPong(t, 3);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(3 + 1e-9);
    }
  });
});

describe('spring', () => {
  it('critically damped springs never overshoot', () => {
    const s = spring(0);
    let maxValue = 0;
    for (let i = 0; i < 600; i++) {
      stepSpring(s, 1, { frequency: 4, damping: 1 }, 1 / 120);
      maxValue = Math.max(maxValue, s.value);
    }
    expect(maxValue).toBeLessThanOrEqual(1 + 1e-6);
    expect(s.value).toBeCloseTo(1, 4);
  });

  it('underdamped springs do overshoot', () => {
    const s = spring(0);
    let maxValue = 0;
    for (let i = 0; i < 600; i++) {
      stepSpring(s, 1, SPRING_PRESETS.cable, 1 / 120);
      maxValue = Math.max(maxValue, s.value);
    }
    expect(maxValue).toBeGreaterThan(1.05);
  });

  it('overdamped springs converge without oscillating', () => {
    const s = spring(0);
    let maxValue = 0;
    for (let i = 0; i < 1200; i++) {
      stepSpring(s, 1, { frequency: 3, damping: 2.2 }, 1 / 120);
      maxValue = Math.max(maxValue, s.value);
    }
    expect(maxValue).toBeLessThanOrEqual(1 + 1e-6);
    expect(s.value).toBeCloseTo(1, 3);
  });

  it('is stable at wildly different timesteps', () => {
    // The whole point of the analytic solver: 30 Hz and 240 Hz must agree.
    const slow = spring(0);
    const fast = spring(0);
    const cfg = { frequency: 6, damping: 0.5 };
    for (let i = 0; i < 30; i++) stepSpring(slow, 1, cfg, 1 / 30);
    for (let i = 0; i < 240; i++) stepSpring(fast, 1, cfg, 1 / 240);
    expect(slow.value).toBeCloseTo(fast.value, 4);
  });

  it('does not explode with a very stiff spring at a large timestep', () => {
    const s = spring(0);
    for (let i = 0; i < 100; i++) stepSpring(s, 1, { frequency: 40, damping: 0.2 }, 0.25);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(Math.abs(s.value)).toBeLessThan(10);
  });

  it('reports settling', () => {
    const s = spring(0);
    expect(isSettled(s, 1)).toBe(false);
    for (let i = 0; i < 2000; i++) stepSpring(s, 1, SPRING_PRESETS.chassis, 1 / 120);
    expect(isSettled(s, 1)).toBe(true);
  });
});

describe('curve', () => {
  it('passes exactly through its keyframes', () => {
    const c = smoothCurve([
      [0, 0],
      [0.5, 10],
      [1, 3],
    ]);
    expect(c.evaluate(0)).toBeCloseTo(0);
    expect(c.evaluate(0.5)).toBeCloseTo(10);
    expect(c.evaluate(1)).toBeCloseTo(3);
  });

  it('clamps outside its time range', () => {
    const c = smoothCurve([
      [0, 2],
      [1, 7],
    ]);
    expect(c.evaluate(-5)).toBeCloseTo(2);
    expect(c.evaluate(50)).toBeCloseTo(7);
  });

  it('is C1 continuous across keyframe boundaries', () => {
    // A visible "tick" as a joint crosses a key is exactly what a velocity
    // discontinuity looks like, so assert the derivative matches from each side.
    const c = smoothCurve([
      [0, 0],
      [0.3, 5],
      [0.6, -2],
      [1, 4],
    ]);
    const eps = 1e-5;
    for (const t of [0.3, 0.6]) {
      const before = (c.evaluate(t) - c.evaluate(t - eps)) / eps;
      const after = (c.evaluate(t + eps) - c.evaluate(t)) / eps;
      expect(Math.abs(after - before)).toBeLessThan(1e-2);
    }
  });

  it('analytic velocity matches finite differences', () => {
    const c = smoothCurve([
      [0, 0],
      [0.4, 8],
      [1, 1],
    ]);
    const eps = 1e-6;
    for (const t of [0.1, 0.25, 0.5, 0.8]) {
      const numeric = (c.evaluate(t + eps) - c.evaluate(t - eps)) / (2 * eps);
      expect(c.evaluateVelocity(t)).toBeCloseTo(numeric, 3);
    }
  });

  it('clampedCurve never overshoots its authored extremes', () => {
    const c = clampedCurve([
      [0, 0],
      [0.5, 1],
      [1, 0],
    ]);
    for (let t = 0; t <= 1; t += 0.005) {
      expect(c.evaluate(t)).toBeLessThanOrEqual(1 + 1e-9);
      expect(c.evaluate(t)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('smoothCurve alone can overshoot, which is why clampedCurve exists', () => {
    const c = smoothCurve([
      [0, 0],
      [0.5, 1],
      [0.55, 1],
      [1, 0],
    ]);
    let max = 0;
    for (let t = 0; t <= 1; t += 0.005) max = Math.max(max, c.evaluate(t));
    expect(max).toBeGreaterThan(1);
  });

  it('honours step interpolation', () => {
    const c = new Curve([key(0, 0, 0, 0, Interp.Step), key(1, 1, 0, 0, Interp.Step)]);
    expect(c.evaluate(0.99)).toBe(0);
    expect(c.evaluate(1)).toBe(1);
  });

  it('honours linear interpolation', () => {
    const c = new Curve([key(0, 0, 0, 0, Interp.Linear), key(1, 10, 0, 0, Interp.Linear)]);
    expect(c.evaluate(0.5)).toBeCloseTo(5);
  });

  it('gives identical results whether sampled forwards or randomly', () => {
    // Guards the sequential-sampling cursor optimisation.
    const c = smoothCurve([
      [0, 0],
      [0.2, 4],
      [0.5, -3],
      [0.9, 6],
      [1.4, 1],
    ]);
    const times = [0.05, 0.31, 0.77, 1.2, 1.39];
    const forward = times.map((t) => c.evaluate(t));
    c.resetCursor();
    const random = [...times].reverse().map((t) => c.evaluate(t)).reverse();
    for (let i = 0; i < forward.length; i++) {
      expect(forward[i]).toBeCloseTo(random[i]!, 10);
    }
  });
});

describe('aabb', () => {
  const hit: SweepHit = { time: 0, normalX: 0, normalY: 0 };

  it('detects a horizontal sweep and reports the correct normal', () => {
    const moving = aabb(0, 0, 0.5, 0.5);
    const solid = aabb(5, 0, 0.5, 0.5);
    expect(sweepAABB(moving, 10, 0, solid, hit)).toBe(true);
    // Contact when the gap of 4 units is closed by a 10-unit motion.
    expect(hit.time).toBeCloseTo(0.4);
    expect(hit.normalX).toBe(-1);
    expect(hit.normalY).toBe(0);
  });

  it('detects a downward sweep onto a floor', () => {
    const moving = aabb(0, 0, 0.5, 0.5);
    const floor = aabb(0, 4, 2, 0.5);
    expect(sweepAABB(moving, 0, 8, floor, hit)).toBe(true);
    expect(hit.time).toBeCloseTo(0.375);
    expect(hit.normalY).toBe(-1);
  });

  it('prevents tunnelling through thin geometry at high speed', () => {
    // A dash-speed move across a wall only one tenth of a unit thick.
    const moving = aabb(0, 0, 0.4, 0.9);
    const thinWall = aabb(50, 0, 0.05, 5);
    expect(sweepAABB(moving, 200, 0, thinWall, hit)).toBe(true);
    expect(hit.time).toBeGreaterThan(0);
    expect(hit.time).toBeLessThan(1);
  });

  it('misses when the motion stops short', () => {
    const moving = aabb(0, 0, 0.5, 0.5);
    const solid = aabb(5, 0, 0.5, 0.5);
    expect(sweepAABB(moving, 1, 0, solid, hit)).toBe(false);
  });

  it('misses when passing alongside without contact', () => {
    const moving = aabb(0, 0, 0.5, 0.5);
    const solid = aabb(5, 10, 0.5, 0.5);
    expect(sweepAABB(moving, 10, 0, solid, hit)).toBe(false);
  });

  it('reports no sweep hit when already overlapping', () => {
    const moving = aabb(0, 0, 1, 1);
    const solid = aabb(0.5, 0, 1, 1);
    expect(overlaps(moving, solid)).toBe(true);
    expect(sweepAABB(moving, 1, 0, solid, hit)).toBe(false);
  });

  it('handles a purely diagonal sweep into a corner', () => {
    const moving = aabb(0, 0, 0.5, 0.5);
    const solid = aabb(4, 4, 0.5, 0.5);
    expect(sweepAABB(moving, 8, 8, solid, hit)).toBe(true);
    expect(hit.time).toBeGreaterThan(0);
  });

  it('intersects rays with boxes', () => {
    const rayHit: RayHit = { time: 0, normalX: 0, normalY: 0 };
    const box = aabb(0, 5, 3, 0.5);
    expect(rayAABB(0, 0, 0, 10, box, rayHit)).toBe(true);
    expect(rayHit.time).toBeCloseTo(0.45);
    expect(rayHit.normalY).toBe(-1);
  });
});

describe('noise', () => {
  it('is deterministic for a given seed', () => {
    const a = new NoiseField(42);
    const b = new NoiseField(42);
    for (let i = 0; i < 50; i++) {
      expect(a.noise2(i * 0.37, i * 0.11)).toBe(b.noise2(i * 0.37, i * 0.11));
    }
  });

  it('differs between seeds', () => {
    const a = new NoiseField(1);
    const b = new NoiseField(2);
    let differences = 0;
    for (let i = 0; i < 50; i++) {
      if (a.noise2(i * 0.37, i * 0.11) !== b.noise2(i * 0.37, i * 0.11)) differences++;
    }
    expect(differences).toBeGreaterThan(40);
  });

  it('stays inside its nominal range and is smooth', () => {
    const n = new NoiseField(7);
    // Seed `prev` from the same row we are about to walk, otherwise the first
    // comparison spans two unrelated samples.
    let prev = n.noise2(0, 3.5);
    for (let x = 0; x < 30; x += 0.01) {
      const v = n.noise2(x, 3.5);
      expect(v).toBeGreaterThanOrEqual(-1.5);
      expect(v).toBeLessThanOrEqual(1.5);
      // Adjacent samples must not jump: gradient noise is continuous.
      expect(Math.abs(v - prev)).toBeLessThan(0.2);
      prev = v;
    }
  });

  it('fbm stays bounded', () => {
    const n = new NoiseField(11);
    for (let i = 0; i < 200; i++) {
      const v = n.fbm2(i * 0.13, i * 0.29, 5);
      expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.2);
    }
  });

  it('ridged noise is non-negative', () => {
    const n = new NoiseField(3);
    for (let i = 0; i < 200; i++) {
      expect(n.ridged(i * 0.17, i * 0.23)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('ease', () => {
  it('cubicBezier hits both endpoints exactly', () => {
    const e = cubicBezier(0.25, 0.1, 0.25, 1);
    expect(e(0)).toBeCloseTo(0);
    expect(e(1)).toBeCloseTo(1);
  });

  it('cubicBezier is monotonic for a standard ease', () => {
    const e = cubicBezier(0.42, 0, 0.58, 1);
    let prev = -Infinity;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = e(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = v;
    }
  });
});
