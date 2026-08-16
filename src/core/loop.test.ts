import { describe, it, expect } from 'vitest';
import { GameLoop, FIXED_DT, FIXED_HZ } from './loop.ts';
import { VirtualClock, FrameStats } from './time.ts';

/**
 * Builds a loop driven by a virtual clock, recording what each callback saw.
 *
 * These tests exist because a bug here is invisible in the rendered output: the
 * harness-driven loop was passing dt = 0 to every frame, so captured footage
 * was silently static while looking perfectly plausible as a still.
 */
function makeLoop() {
  const clock = new VirtualClock();
  const fixedDeltas: number[] = [];
  const renderCalls: { alpha: number; dt: number; unscaledDt: number }[] = [];

  const loop = new GameLoop(
    {
      fixedUpdate: (dt) => fixedDeltas.push(dt),
      render: (alpha, dt, unscaledDt) => renderCalls.push({ alpha, dt, unscaledDt }),
    },
    clock,
  );

  return { loop, clock, fixedDeltas, renderCalls };
}

describe('GameLoop.step', () => {
  it('passes a non-zero delta to render', () => {
    const { loop, renderCalls } = makeLoop();
    loop.step(1 / 60);
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]!.unscaledDt).toBeCloseTo(1 / 60, 9);
  });

  it('accumulates simulated time across many steps', () => {
    const { loop } = makeLoop();
    for (let i = 0; i < 120; i++) loop.step(1 / 60);
    // 120 frames at 1/60 s is two seconds of wall time.
    expect(loop.unscaledTime).toBeCloseTo(2, 6);
    // The fixed simulation should have kept up with it.
    expect(loop.simTime).toBeGreaterThan(1.9);
    expect(loop.simTime).toBeLessThanOrEqual(2.0 + FIXED_DT);
  });

  it('runs the expected number of fixed steps', () => {
    const { loop, fixedDeltas } = makeLoop();
    // One second of frames at 60 Hz should produce 120 simulation steps.
    for (let i = 0; i < 60; i++) loop.step(1 / 60);
    expect(fixedDeltas.length).toBeGreaterThanOrEqual(FIXED_HZ - 2);
    expect(fixedDeltas.length).toBeLessThanOrEqual(FIXED_HZ + 2);
    for (const dt of fixedDeltas) expect(dt).toBeCloseTo(FIXED_DT, 9);
  });

  it('is deterministic: two runs produce identical timings', () => {
    const a = makeLoop();
    const b = makeLoop();
    for (let i = 0; i < 90; i++) {
      a.loop.step(1 / 60);
      b.loop.step(1 / 60);
    }
    expect(a.loop.simTime).toBe(b.loop.simTime);
    expect(a.loop.simStep).toBe(b.loop.simStep);
    expect(a.fixedDeltas.length).toBe(b.fixedDeltas.length);
  });

  it('freezes the simulation during hitstop but keeps rendering', () => {
    const { loop, fixedDeltas, renderCalls } = makeLoop();
    // Settle first so the accumulator is empty.
    for (let i = 0; i < 10; i++) loop.step(1 / 60);
    const stepsBefore = fixedDeltas.length;
    const rendersBefore = renderCalls.length;

    loop.hitstop(0.1);
    for (let i = 0; i < 6; i++) loop.step(1 / 60);

    // The world is frozen...
    expect(fixedDeltas.length).toBe(stepsBefore);
    // ...but frames still render, so impact effects keep playing.
    expect(renderCalls.length).toBe(rendersBefore + 6);
    expect(renderCalls[renderCalls.length - 1]!.unscaledDt).toBeCloseTo(1 / 60, 9);
    expect(renderCalls[renderCalls.length - 1]!.dt).toBe(0);
  });

  it('resumes simulating once hitstop expires', () => {
    const { loop, fixedDeltas } = makeLoop();
    loop.hitstop(0.05);
    for (let i = 0; i < 4; i++) loop.step(1 / 60);
    const during = fixedDeltas.length;
    for (let i = 0; i < 10; i++) loop.step(1 / 60);
    expect(fixedDeltas.length).toBeGreaterThan(during);
  });

  it('slows the simulation under time dilation', () => {
    const { loop, fixedDeltas } = makeLoop();
    loop.dilate(0.25, 1.0);
    for (let i = 0; i < 60; i++) loop.step(1 / 60);
    // A quarter-speed second should advance roughly a quarter of a second.
    expect(loop.simTime).toBeGreaterThan(0.2);
    expect(loop.simTime).toBeLessThan(0.32);
    expect(fixedDeltas.length).toBeGreaterThan(20);
  });

  it('caps catch-up so a long stall cannot spiral', () => {
    const { loop, fixedDeltas } = makeLoop();
    // A five-second hitch would be 600 fixed steps if uncapped.
    loop.step(5);
    expect(fixedDeltas.length).toBeLessThanOrEqual(5);
  });

  it('ignores negative or non-finite deltas', () => {
    const { loop, renderCalls } = makeLoop();
    loop.step(-1);
    expect(renderCalls[0]!.unscaledDt).toBe(0);
  });
});

describe('FrameStats', () => {
  it('reports the mean and the 1% low separately', () => {
    const stats = new FrameStats(100);
    // Ninety-nine smooth frames and one severe hitch.
    for (let i = 0; i < 99; i++) stats.push(16.7);
    stats.push(120);

    expect(stats.averageMs).toBeGreaterThan(16.7);
    expect(stats.averageMs).toBeLessThan(18.5);
    // The average barely moves, but the 1% low collapses — which is exactly
    // the discrepancy that makes averages a misleading quality signal.
    expect(stats.percentile1Low).toBeLessThan(30);
  });

  it('scores steady frame times as low jitter', () => {
    const steady = new FrameStats(60);
    for (let i = 0; i < 60; i++) steady.push(11.1);
    expect(steady.jitterMs).toBeCloseTo(0, 6);
  });

  it('scores alternating frame times as high jitter despite a good average', () => {
    const uneven = new FrameStats(60);
    for (let i = 0; i < 60; i++) uneven.push(i % 2 === 0 ? 8.3 : 16.7);
    // Same ballpark average as a steady 12.5 ms, but it feels far worse.
    expect(uneven.averageMs).toBeCloseTo(12.5, 1);
    expect(uneven.jitterMs).toBeGreaterThan(7);
  });
});
