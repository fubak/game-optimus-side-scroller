/**
 * Fixed-timestep game loop.
 *
 * The simulation always advances in exact 1/60 s steps regardless of display refresh rate, which
 * makes gameplay reproducible: the same input tape and seed always produce the same world state.
 * Rendering happens once per animation frame and receives an interpolation `alpha` so motion still
 * looks smooth on 120 Hz+ displays.
 *
 * `advance()` and `stepFrames()` are wall-clock free, so tests can drive the loop frame-exactly.
 */

export const DEFAULT_STEP_MS = 1000 / 60;

/** Hard cap on how much time a single animation frame may contribute (tab switches, breakpoints). */
export const DEFAULT_MAX_FRAME_MS = 250;

/** Maximum fixed updates per animation frame before we give up and drop the backlog. */
export const DEFAULT_MAX_SUB_STEPS = 5;

export interface LoopHooks {
  /** Advance the simulation by a fixed `dtSec`. `frame` is a monotonically increasing step index. */
  update(dtSec: number, frame: number): void;
  /** Draw the world. `alpha` in [0, 1) is the fraction of a step past the last update. */
  render(alpha: number): void;
}

export interface LoopOptions {
  readonly stepMs?: number;
  readonly maxSubSteps?: number;
  readonly maxFrameMs?: number;
  readonly now?: () => number;
  readonly requestFrame?: (callback: (timestampMs: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface LoopMetrics {
  /** Smoothed frames per second (animation frames, not simulation steps). */
  readonly fps: number;
  /** Smoothed wall-clock time between animation frames, in ms. */
  readonly frameTimeMs: number;
  /** Smoothed time spent inside `update` per animation frame, in ms. */
  readonly updateMs: number;
  /** Smoothed time spent inside `render` per animation frame, in ms. */
  readonly renderMs: number;
  /** Fixed updates executed during the most recent `advance`. */
  readonly stepsLastFrame: number;
  /** Simulation steps discarded because the loop could not keep up. */
  readonly droppedSteps: number;
}

export interface Loop {
  readonly running: boolean;
  /** Number of fixed updates executed since creation (or the last `reset`). */
  readonly frame: number;
  /** Render interpolation factor in [0, 1). */
  readonly alpha: number;
  readonly metrics: LoopMetrics;
  start(): void;
  stop(): void;
  /**
   * Feed `elapsedMs` of wall-clock time into the accumulator and run as many fixed updates as fit.
   * Returns the number of updates that ran.
   */
  advance(elapsedMs: number): number;
  /** Run exactly `steps` fixed updates, bypassing the accumulator (deterministic stepping). */
  stepFrames(steps: number): void;
  reset(): void;
}

const SMOOTHING = 0.12;

/**
 * Fraction of a step that still counts as "a whole step is available".
 *
 * Frame deltas are floating point and 1/60 s is not representable exactly, so a genuine 60 Hz
 * frame often measures a hair *less* than one step. Without this tolerance the accumulator would
 * occasionally skip an update and then run two on the next frame, which reads as a visible hitch.
 */
const STEP_TOLERANCE = 0.002;

function smooth(previous: number, sample: number): number {
  return previous === 0 ? sample : previous + (sample - previous) * SMOOTHING;
}

class FixedStepLoop implements Loop {
  private readonly hooks: LoopHooks;
  private readonly stepMs: number;
  private readonly stepSec: number;
  private readonly maxSubSteps: number;
  private readonly maxFrameMs: number;
  private readonly now: () => number;
  private readonly requestFrame: (callback: (timestampMs: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  private readonly stepThresholdMs: number;
  private accumulatorMs = 0;
  private frameIndex = 0;
  private isRunning = false;
  private frameHandle: number | null = null;
  private lastTimestampMs: number | null = null;

  private fps = 0;
  private frameTimeMs = 0;
  private updateMs = 0;
  private renderMs = 0;
  private stepsLastFrame = 0;
  private droppedSteps = 0;

  private readonly tick = (timestampMs: number): void => {
    if (!this.isRunning) return;
    this.frameHandle = this.requestFrame(this.tick);

    const previous = this.lastTimestampMs;
    this.lastTimestampMs = timestampMs;
    const elapsedMs = previous === null ? this.stepMs : Math.max(0, timestampMs - previous);
    this.frameTimeMs = smooth(this.frameTimeMs, elapsedMs);
    this.fps = elapsedMs > 0 ? smooth(this.fps, 1000 / elapsedMs) : this.fps;

    const updateStart = this.now();
    this.advance(elapsedMs);
    const updateEnd = this.now();
    this.updateMs = smooth(this.updateMs, updateEnd - updateStart);

    this.hooks.render(this.alpha);
    this.renderMs = smooth(this.renderMs, this.now() - updateEnd);
  };

  constructor(hooks: LoopHooks, options: LoopOptions = {}) {
    this.hooks = hooks;
    this.stepMs = options.stepMs ?? DEFAULT_STEP_MS;
    this.stepSec = this.stepMs / 1000;
    this.stepThresholdMs = this.stepMs * (1 - STEP_TOLERANCE);
    this.maxSubSteps = options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS;
    this.maxFrameMs = options.maxFrameMs ?? DEFAULT_MAX_FRAME_MS;
    this.now = options.now ?? ((): number => performance.now());
    this.requestFrame = options.requestFrame ?? ((callback): number => requestAnimationFrame(callback));
    this.cancelFrame =
      options.cancelFrame ??
      ((handle): void => {
        cancelAnimationFrame(handle);
      });
  }

  get running(): boolean {
    return this.isRunning;
  }

  get frame(): number {
    return this.frameIndex;
  }

  get alpha(): number {
    return this.accumulatorMs / this.stepMs;
  }

  get metrics(): LoopMetrics {
    return {
      fps: this.fps,
      frameTimeMs: this.frameTimeMs,
      updateMs: this.updateMs,
      renderMs: this.renderMs,
      stepsLastFrame: this.stepsLastFrame,
      droppedSteps: this.droppedSteps,
    };
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTimestampMs = null;
    this.frameHandle = this.requestFrame(this.tick);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.frameHandle !== null) {
      this.cancelFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.lastTimestampMs = null;
  }

  advance(elapsedMs: number): number {
    const clamped = Math.min(Math.max(0, elapsedMs), this.maxFrameMs);
    this.accumulatorMs += clamped;

    let steps = 0;
    while (this.accumulatorMs >= this.stepThresholdMs && steps < this.maxSubSteps) {
      this.accumulatorMs = Math.max(0, this.accumulatorMs - this.stepMs);
      this.hooks.update(this.stepSec, this.frameIndex);
      this.frameIndex += 1;
      steps += 1;
    }

    // Still behind after the sub-step budget: drop the backlog instead of spiralling.
    if (this.accumulatorMs >= this.stepThresholdMs) {
      const dropped = Math.floor(this.accumulatorMs / this.stepMs);
      this.droppedSteps += dropped;
      this.accumulatorMs -= dropped * this.stepMs;
    }

    this.stepsLastFrame = steps;
    return steps;
  }

  stepFrames(steps: number): void {
    const count = Math.max(0, Math.floor(steps));
    for (let i = 0; i < count; i += 1) {
      this.hooks.update(this.stepSec, this.frameIndex);
      this.frameIndex += 1;
    }
    this.stepsLastFrame = count;
  }

  reset(): void {
    this.accumulatorMs = 0;
    this.frameIndex = 0;
    this.stepsLastFrame = 0;
    this.droppedSteps = 0;
    this.lastTimestampMs = null;
  }
}

export function createLoop(hooks: LoopHooks, options: LoopOptions = {}): Loop {
  return new FixedStepLoop(hooks, options);
}
