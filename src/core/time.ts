/**
 * Clocks and frame timing.
 *
 * Two clock implementations exist behind one interface:
 *
 * - {@link RealClock} drives the game in a browser, reading `performance.now`
 *   and scheduling via `requestAnimationFrame`.
 * - {@link VirtualClock} advances by an exact, fixed amount only when told to.
 *
 * The virtual clock is what makes recorded footage reproducible. The capture
 * machine has no GPU and renders a frame in roughly a third of a second, but
 * because every frame is *stamped* as exactly 1/60 s the resulting video plays
 * back as flawless 60 fps motion. It also means two runs of the same scenario
 * produce identical frames, so a visual diff between builds is meaningful.
 */

export interface Clock {
  /** Current time in seconds. Monotonic. */
  now(): number;
  /** Schedule a callback for the next frame; returns a cancellation handle. */
  requestFrame(callback: (timeSeconds: number) => void): number;
  cancelFrame(handle: number): void;
}

export class RealClock implements Clock {
  private readonly origin = performance.now();

  now(): number {
    return (performance.now() - this.origin) / 1000;
  }

  requestFrame(callback: (timeSeconds: number) => void): number {
    return requestAnimationFrame(() => callback(this.now()));
  }

  cancelFrame(handle: number): void {
    cancelAnimationFrame(handle);
  }
}

/**
 * A clock that only moves when {@link advance} is called.
 *
 * Frame callbacks are queued rather than scheduled; the harness drains them
 * synchronously so that rendering, capture, and time advancement stay in
 * lockstep no matter how slow the renderer actually is.
 */
export class VirtualClock implements Clock {
  private time = 0;
  private nextHandle = 1;
  private pending = new Map<number, (timeSeconds: number) => void>();

  now(): number {
    return this.time;
  }

  requestFrame(callback: (timeSeconds: number) => void): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.pending.delete(handle);
  }

  /** Move time forward and run everything that was waiting on a frame. */
  advance(deltaSeconds: number): void {
    this.time += deltaSeconds;
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const callback of due) callback(this.time);
  }

  reset(): void {
    this.time = 0;
    this.pending.clear();
  }
}

/**
 * Rolling frame-time statistics.
 *
 * Average frame rate hides exactly the problem that matters. A build that
 * averages 144 fps but stutters to 40 for one frame every second feels
 * dramatically worse than a rock-solid 90, and only the percentile figures
 * reveal it — which is why the perf overlay and the automated gate both key off
 * `percentile1Low` rather than the mean.
 */
export class FrameStats {
  private readonly samples: Float32Array;
  private index = 0;
  private count = 0;

  constructor(readonly capacity = 240) {
    this.samples = new Float32Array(capacity);
  }

  push(frameMs: number): void {
    this.samples[this.index] = frameMs;
    this.index = (this.index + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get sampleCount(): number {
    return this.count;
  }

  get averageMs(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.samples[i]!;
    return sum / this.count;
  }

  get averageFps(): number {
    const ms = this.averageMs;
    return ms > 0 ? 1000 / ms : 0;
  }

  get maxMs(): number {
    let max = 0;
    for (let i = 0; i < this.count; i++) max = Math.max(max, this.samples[i]!);
    return max;
  }

  /**
   * The frame time at the given percentile. `percentile(99)` is the "1% low"
   * frame — the one users actually perceive as a hitch.
   */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const sorted = Array.from(this.samples.subarray(0, this.count)).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[idx]!;
  }

  /**
   * The "1% low" frame rate, as the term is used in game benchmarking: the
   * *mean of the worst one percent* of frames, not the value at the 99th
   * percentile.
   *
   * The distinction matters. Indexing at the 99th percentile of 100 samples
   * returns the second-worst frame and so completely hides a single severe
   * hitch — which is exactly the event this metric exists to expose.
   */
  get percentile1Low(): number {
    if (this.count === 0) return 0;
    const sorted = Array.from(this.samples.subarray(0, this.count)).sort((a, b) => b - a);
    const worstCount = Math.max(1, Math.round(this.count * 0.01));
    let sum = 0;
    for (let i = 0; i < worstCount; i++) sum += sorted[i]!;
    const ms = sum / worstCount;
    return ms > 0 ? 1000 / ms : 0;
  }

  /**
   * Mean absolute difference between consecutive frame times.
   *
   * This is the numeric expression of "does it feel smooth". A steady 90 fps
   * scores near zero; a run alternating 60/120 fps has the same average but a
   * terrible score here, matching how it actually feels to play.
   */
  get jitterMs(): number {
    if (this.count < 2) return 0;
    let sum = 0;
    for (let i = 1; i < this.count; i++) {
      sum += Math.abs(this.samples[i]! - this.samples[i - 1]!);
    }
    return sum / (this.count - 1);
  }

  reset(): void {
    this.samples.fill(0);
    this.index = 0;
    this.count = 0;
  }
}
