import type { LoopMetrics } from './loop';

/**
 * Bridge that lets automated browser tests drive the game deterministically.
 *
 * Exposed on `window.__optimus` only in dev builds or when the page is loaded with `?test=1`, so
 * the production bundle stays free of test affordances.
 */

export interface TestHooks {
  /** Run exactly `steps` fixed simulation updates and redraw once. */
  stepFrames(steps: number): void;
  /** Number of fixed updates executed so far. */
  frame(): number;
  /** Stop the animation-frame driver so only `stepFrames` advances the sim. */
  pauseDriver(): void;
  /** Resume the animation-frame driver. */
  resumeDriver(): void;
  /** JSON-safe snapshot of the current game state, for assertions. */
  snapshot(): unknown;
  /** Smoothed loop performance metrics (fps, frame/update/render time, dropped steps). */
  metrics(): LoopMetrics;
  /**
   * Raw wall-clock time (ms) between consecutive real `requestAnimationFrame` render calls, since
   * the last `resetFrameSamples()` — used by `scripts/bench.ts` to compute frame-time percentiles.
   * Unlike `metrics().frameTimeMs` (an exponential moving average), these are unsmoothed samples.
   */
  frameSamples(): readonly number[];
  /** Clear the frame-sample buffer, so a bench run can discard warm-up frames before measuring. */
  resetFrameSamples(): void;
}

declare global {
  interface Window {
    __optimus?: TestHooks;
  }
}

export const TEST_HOOK_KEY = '__optimus';

export function shouldInstallTestHooks(search: string, isDev: boolean): boolean {
  if (isDev) return true;
  return new URLSearchParams(search).get('test') === '1';
}

export function installTestHooks(hooks: TestHooks): void {
  window.__optimus = hooks;
}
