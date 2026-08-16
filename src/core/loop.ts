/**
 * The main game loop.
 *
 * Design: **fixed-step simulation, interpolated variable-rate rendering.**
 *
 * The simulation advances in constant 1/120 s slices so that physics, collision
 * response, and combat timing are perfectly deterministic and identical on
 * every machine — a dash covers the same distance and a parry window lasts the
 * same number of steps whether the display runs at 60 Hz or 240 Hz.
 *
 * Rendering then runs once per display refresh and *interpolates* between the
 * two most recent simulation states. Without that interpolation a 144 Hz
 * display showing a 120 Hz simulation would judder visibly, because frames
 * would repeatedly show the same simulation state twice.
 *
 * Two time bases are exposed to the rest of the engine:
 *
 * - **scaled time** — obeys hitstop and slow-motion; drives gameplay.
 * - **unscaled time** — ignores them; drives UI, the pause menu, and any effect
 *   that must keep animating *during* a hitstop (impact flashes would look
 *   broken if they froze along with the world).
 */

import { RealClock, FrameStats, type Clock } from './time.ts';

/** Simulation rate. 120 Hz gives combat enough temporal resolution to feel crisp. */
export const FIXED_HZ = 120;
export const FIXED_DT = 1 / FIXED_HZ;

/**
 * Cap on catch-up steps per frame. Without this, a long stall (an alt-tab, a
 * breakpoint, a shader compile) produces a huge accumulated backlog, and
 * simulating all of it takes even longer — the classic "spiral of death". We
 * drop the excess time instead, which is the right trade: the world lags a
 * fraction of a second behind rather than locking up entirely.
 */
const MAX_STEPS_PER_FRAME = 5;

/** Ignore absurd deltas from tab-switching so nothing teleports on return. */
const MAX_FRAME_DELTA = 0.25;

export interface LoopCallbacks {
  /** Advance the simulation by exactly `FIXED_DT` seconds of scaled time. */
  fixedUpdate(dt: number): void;
  /**
   * Draw a frame.
   *
   * @param alpha       Interpolation factor in [0, 1) between the previous and
   *                    current simulation states.
   * @param dt          Scaled seconds since the previous rendered frame.
   * @param unscaledDt  Real seconds since the previous rendered frame.
   */
  render(alpha: number, dt: number, unscaledDt: number): void;
}

export class GameLoop {
  readonly stats = new FrameStats(240);

  /** Global multiplier on simulation time. Slow-motion sets this below 1. */
  timeScale = 1;

  /** Total elapsed scaled simulation time, in seconds. */
  simTime = 0;
  /** Total elapsed real time since the loop started, in seconds. */
  unscaledTime = 0;
  /** Number of fixed steps executed. Useful as a deterministic frame counter. */
  simStep = 0;

  private accumulator = 0;
  private lastTime = 0;
  private frameHandle = 0;
  private running = false;
  private hitstopRemaining = 0;
  private dilationRemaining = 0;
  private dilationScale = 1;

  /** Cost of the most recent frame's phases, in milliseconds. */
  readonly timings = { simMs: 0, renderMs: 0, frameMs: 0 };

  constructor(
    private readonly callbacks: LoopCallbacks,
    readonly clock: Clock = new RealClock(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = this.clock.now();
    this.accumulator = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle) {
      this.clock.cancelFrame(this.frameHandle);
      this.frameHandle = 0;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Freeze the simulation for a moment while rendering continues.
   *
   * This is the single most important piece of combat feel in the game. Pausing
   * the world for 40-140 ms on impact is what makes a hit land with weight;
   * without it, attacks read as passing through enemies rather than striking
   * them. Duration scales with damage, so heavy blows feel heavier.
   *
   * Repeated calls take the longest remaining duration rather than summing, so
   * a flurry of simultaneous hits cannot lock the game up.
   */
  hitstop(seconds: number): void {
    this.hitstopRemaining = Math.max(this.hitstopRemaining, seconds);
  }

  /**
   * Temporarily scale simulation speed — used for the post-parry slow-motion
   * beat and for boss-phase transitions.
   */
  dilate(scale: number, seconds: number): void {
    this.dilationScale = scale;
    this.dilationRemaining = Math.max(this.dilationRemaining, seconds);
  }

  clearTimeEffects(): void {
    this.hitstopRemaining = 0;
    this.dilationRemaining = 0;
    this.dilationScale = 1;
  }

  get isInHitstop(): boolean {
    return this.hitstopRemaining > 0;
  }

  private schedule(): void {
    this.frameHandle = this.clock.requestFrame(this.onFrame);
  }

  private readonly onFrame = (now: number): void => {
    if (!this.running) return;
    this.tick(now);
    this.schedule();
  };

  /**
   * Runs one frame against an absolute timestamp.
   *
   * Exposed separately from the scheduling machinery so the capture harness can
   * drive frames by hand at exact intervals.
   */
  tick(now: number): void {
    const frameStart = now;
    let unscaledDt = now - this.lastTime;
    this.lastTime = now;

    if (!Number.isFinite(unscaledDt) || unscaledDt < 0) unscaledDt = 0;
    if (unscaledDt > MAX_FRAME_DELTA) unscaledDt = MAX_FRAME_DELTA;
    this.unscaledTime += unscaledDt;

    // Resolve the time-effect stack for this frame.
    let effectiveScale = this.timeScale;

    if (this.dilationRemaining > 0) {
      this.dilationRemaining -= unscaledDt;
      effectiveScale *= this.dilationScale;
      if (this.dilationRemaining <= 0) this.dilationScale = 1;
    }

    if (this.hitstopRemaining > 0) {
      this.hitstopRemaining -= unscaledDt;
      // Hitstop wins outright: the world is fully frozen for its duration.
      effectiveScale = 0;
    }

    const scaledDt = unscaledDt * effectiveScale;
    this.accumulator += scaledDt;

    const simStart = performance.now();
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.callbacks.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      this.simTime += FIXED_DT;
      this.simStep++;
      steps++;
    }
    // Discard any backlog we could not afford, rather than compounding it.
    if (this.accumulator > FIXED_DT * MAX_STEPS_PER_FRAME) {
      this.accumulator = 0;
    }
    this.timings.simMs = performance.now() - simStart;

    const alpha = this.accumulator / FIXED_DT;

    const renderStart = performance.now();
    this.callbacks.render(alpha, scaledDt, unscaledDt);
    this.timings.renderMs = performance.now() - renderStart;

    this.timings.frameMs = unscaledDt * 1000;
    this.stats.push(this.timings.frameMs);
    void frameStart;
  }

  /**
   * Advance by an exact delta, ignoring the wall clock entirely.
   *
   * The capture harness calls this once per recorded frame with a delta of
   * exactly 1/60 s, which is what makes recorded footage frame-perfect on a
   * machine that renders far slower than real time.
   */
  step(deltaSeconds: number): void {
    // `tick` derives its delta as `now - lastTime` and updates `lastTime`
    // itself. Advancing `lastTime` here first made that subtraction zero, so
    // every harness-driven frame ran with dt = 0 and nothing animated at all.
    this.tick(this.lastTime + deltaSeconds);
  }
}
