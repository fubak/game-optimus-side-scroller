import { describe, expect, it, vi } from 'vitest';
import { createLoop, DEFAULT_STEP_MS } from '../../src/core/loop';
import type { Loop, LoopOptions } from '../../src/core/loop';

interface Harness {
  loop: Loop;
  updates: number[];
  renders: number[];
  dts: number[];
  runFrame(timestampMs: number): void;
}

function harness(options: LoopOptions = {}): Harness {
  const updates: number[] = [];
  const renders: number[] = [];
  const dts: number[] = [];
  let scheduled: ((timestampMs: number) => void) | null = null;
  let clock = 0;

  const loop = createLoop(
    {
      update(dtSec, frame) {
        updates.push(frame);
        dts.push(dtSec);
      },
      render(alpha) {
        renders.push(alpha);
      },
    },
    {
      now: () => clock,
      requestFrame: (callback) => {
        scheduled = callback;
        return 1;
      },
      cancelFrame: () => {
        scheduled = null;
      },
      ...options,
    },
  );

  return {
    loop,
    updates,
    renders,
    dts,
    runFrame(timestampMs: number) {
      clock = timestampMs;
      const callback = scheduled;
      if (callback === null) throw new Error('No animation frame scheduled.');
      callback(timestampMs);
    },
  };
}

describe('createLoop', () => {
  it('runs exactly one fixed update per step worth of elapsed time', () => {
    const { loop, updates, dts } = harness({ stepMs: 10 });
    expect(loop.advance(10)).toBe(1);
    expect(loop.advance(30)).toBe(3);
    expect(updates).toEqual([0, 1, 2, 3]);
    expect(loop.frame).toBe(4);
    expect(dts.every((dt) => dt === 0.01)).toBe(true);
  });

  it('uses a fixed 1/60 s timestep by default', () => {
    const { loop, dts } = harness();
    loop.stepFrames(2);
    expect(dts).toEqual([DEFAULT_STEP_MS / 1000, DEFAULT_STEP_MS / 1000]);
  });

  it('accumulates leftover time instead of dropping it', () => {
    const { loop } = harness({ stepMs: 10 });
    expect(loop.advance(4)).toBe(0);
    expect(loop.alpha).toBeCloseTo(0.4, 10);
    expect(loop.advance(4)).toBe(0);
    expect(loop.advance(4)).toBe(1);
    expect(loop.alpha).toBeCloseTo(0.2, 10);
  });

  it('runs one update per frame on a jittery 60 Hz display (no skip-then-double hitching)', () => {
    // Real rAF deltas wobble a hair under/over 1/60 s; every frame must still yield exactly one step.
    const { loop } = harness();
    const deltas = [16.666, 16.6667, 16.66, 16.667, 16.6666, 16.665, 16.6668];
    for (const delta of deltas) {
      expect(loop.advance(delta)).toBe(1);
    }
    expect(loop.frame).toBe(deltas.length);
    expect(loop.metrics.droppedSteps).toBe(0);
  });

  it('clamps huge frame gaps and drops the unrunnable backlog', () => {
    const { loop } = harness({ stepMs: 10, maxSubSteps: 5, maxFrameMs: 250 });
    // 10 s of "tab was hidden" is clamped to 250 ms == 25 steps: 5 run, 20 discarded.
    expect(loop.advance(10_000)).toBe(5);
    expect(loop.metrics.droppedSteps).toBe(20);
    expect(loop.alpha).toBeLessThan(1);
    expect(loop.metrics.stepsLastFrame).toBe(5);
  });

  it('ignores negative elapsed time', () => {
    const { loop } = harness();
    expect(loop.advance(-100)).toBe(0);
    expect(loop.alpha).toBe(0);
  });

  it('stepFrames advances exactly N steps regardless of the clock', () => {
    const { loop, updates } = harness();
    loop.stepFrames(7);
    expect(updates).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(loop.frame).toBe(7);
    expect(loop.alpha).toBe(0);
    loop.stepFrames(-3);
    expect(loop.frame).toBe(7);
    loop.stepFrames(2.9);
    expect(loop.frame).toBe(9);
  });

  it('drives update and render from animation frames while running', () => {
    const h = harness({ stepMs: 10 });
    h.loop.start();
    expect(h.loop.running).toBe(true);
    h.runFrame(0);
    // First frame assumes a single step of elapsed time so nothing stutters on boot.
    expect(h.updates.length).toBe(1);
    expect(h.renders.length).toBe(1);
    h.runFrame(20);
    expect(h.updates.length).toBe(3);
    expect(h.renders.length).toBe(2);
    expect(h.loop.metrics.fps).toBeGreaterThan(0);
    expect(h.loop.metrics.frameTimeMs).toBeGreaterThan(0);
    h.loop.stop();
    expect(h.loop.running).toBe(false);
  });

  it('start is idempotent and stop cancels the pending frame', () => {
    const requestFrame = vi.fn(() => 42);
    const cancelFrame = vi.fn();
    const { loop } = harness({ requestFrame, cancelFrame });
    loop.start();
    loop.start();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    loop.stop();
    expect(cancelFrame).toHaveBeenCalledWith(42);
    loop.stop();
    expect(cancelFrame).toHaveBeenCalledTimes(1);
  });

  it('does not update or render after stop', () => {
    const h = harness({ stepMs: 10 });
    h.loop.start();
    h.runFrame(0);
    const updatesAfterFirstFrame = h.updates.length;
    h.loop.stop();
    h.loop.start();
    h.runFrame(10);
    expect(h.updates.length).toBeGreaterThan(updatesAfterFirstFrame);
  });

  it('reset clears frame counter, accumulator and dropped steps', () => {
    const { loop } = harness();
    loop.advance(10_000);
    loop.reset();
    expect(loop.frame).toBe(0);
    expect(loop.alpha).toBe(0);
    expect(loop.metrics.droppedSteps).toBe(0);
  });
});
