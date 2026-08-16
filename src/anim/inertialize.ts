/**
 * Inertialized pose blending.
 *
 * ## The problem with cross-fading
 *
 * The usual way to move between animation states is to cross-fade: sample both
 * clips and lerp. It has two well-known failures. Averaging two poses produces
 * a third pose that is often nonsense — mid-fade between a left-foot-forward
 * run and an idle, the character stands with its legs merged. And the blend
 * weight ramps linearly, so velocity jumps at both ends of the fade, which the
 * eye reads as a small but persistent hitch on every state change.
 *
 * ## Inertialization
 *
 * Instead of blending two poses, the character snaps immediately to the new
 * clip and carries a decaying *offset* recording how far it was from the new
 * pose at the moment of transition. The offset starts at exactly the previous
 * pose's difference, with exactly the previous pose's velocity, and decays to
 * zero over the blend duration.
 *
 * The result is continuous in both position and velocity, only ever displays
 * one clip's actual pose plus a small correction, and physically resembles the
 * body's own momentum settling into the new motion. It is what makes a hundred
 * transitions per minute read as one continuous performance.
 *
 * Based on the technique presented by David Bollo, "Inertialization:
 * High-Performance Animation Transitions in Gears of War", GDC 2018.
 */

import { Pose } from './skeleton.ts';
import { wrapAngle } from '../core/math/scalar.ts';

/** Channels tracked per bone. */
const CHANNELS = 5;
const CHANNEL_X = 0;
const CHANNEL_Y = 1;
const CHANNEL_ROTATION = 2;
const CHANNEL_SCALE_X = 3;
const CHANNEL_SCALE_Y = 4;

export class Inertializer {
  /** Offset value at the moment of transition, per channel. */
  private readonly offset0: Float32Array;
  /** Offset velocity at the moment of transition, per channel. */
  private readonly velocity0: Float32Array;
  /** Blend duration per channel; channels can finish at different times. */
  private readonly duration: Float32Array;
  /** Elapsed blend time per channel. */
  private readonly elapsed: Float32Array;

  /** The previous two output poses, used to measure velocity at a transition. */
  private readonly previousOutput: Pose;
  private readonly previousOutput2: Pose;
  private previousDt = 1 / 60;
  private hasHistory = false;

  constructor(readonly boneCount: number) {
    const size = boneCount * CHANNELS;
    this.offset0 = new Float32Array(size);
    this.velocity0 = new Float32Array(size);
    this.duration = new Float32Array(size);
    this.elapsed = new Float32Array(size);
    this.previousOutput = new Pose(boneCount);
    this.previousOutput2 = new Pose(boneCount);
  }

  /**
   * Begin a transition.
   *
   * Call at the instant the active clip changes, *before* the first `apply`
   * against the new target. `target` must be the new clip's pose sampled at the
   * transition moment.
   */
  transition(target: Pose, blendDuration: number): void {
    if (!this.hasHistory || blendDuration <= 0) {
      // Nothing to blend from on the very first pose.
      this.duration.fill(0);
      this.elapsed.fill(0);
      return;
    }

    const previous = this.previousOutput;
    const previous2 = this.previousOutput2;
    const dt = Math.max(this.previousDt, 1e-5);

    for (let bone = 0; bone < this.boneCount; bone++) {
      this.setupChannel(
        bone * CHANNELS + CHANNEL_X,
        previous.x[bone]! - target.x[bone]!,
        (previous.x[bone]! - previous2.x[bone]!) / dt,
        blendDuration,
      );
      this.setupChannel(
        bone * CHANNELS + CHANNEL_Y,
        previous.y[bone]! - target.y[bone]!,
        (previous.y[bone]! - previous2.y[bone]!) / dt,
        blendDuration,
      );
      // Rotations are wrapped so a transition never takes the long way round
      // the circle, which would spin a limb through a full revolution.
      this.setupChannel(
        bone * CHANNELS + CHANNEL_ROTATION,
        wrapAngle(previous.rotation[bone]! - target.rotation[bone]!),
        wrapAngle(previous.rotation[bone]! - previous2.rotation[bone]!) / dt,
        blendDuration,
      );
      this.setupChannel(
        bone * CHANNELS + CHANNEL_SCALE_X,
        previous.scaleX[bone]! - target.scaleX[bone]!,
        (previous.scaleX[bone]! - previous2.scaleX[bone]!) / dt,
        blendDuration,
      );
      this.setupChannel(
        bone * CHANNELS + CHANNEL_SCALE_Y,
        previous.scaleY[bone]! - target.scaleY[bone]!,
        (previous.scaleY[bone]! - previous2.scaleY[bone]!) / dt,
        blendDuration,
      );
    }
  }

  private setupChannel(index: number, x0: number, v0: number, blendDuration: number): void {
    this.offset0[index] = x0;
    this.velocity0[index] = v0;
    this.elapsed[index] = 0;

    // If the offset is already moving *away* from zero, a fixed duration would
    // overshoot badly. Shortening the blend in proportion keeps the correction
    // monotonic. (Bollo's t1 clamp.)
    let duration = blendDuration;
    if (Math.abs(x0) > 1e-6 && v0 * Math.sign(x0) > 0) {
      duration = Math.min(duration, (5 * Math.abs(x0)) / Math.abs(v0));
    }
    this.duration[index] = Math.max(duration, 1e-4);
  }

  /**
   * Evaluates the decaying offset for one channel.
   *
   * A quintic with `p(0) = x0`, `p'(0) = v0`, and `p(1) = p'(1) = p''(1) = 0`,
   * so the correction lands on the target with zero velocity *and* zero
   * acceleration — no residual twitch as the blend completes.
   */
  private evaluate(index: number, dt: number): number {
    const duration = this.duration[index]!;
    if (duration <= 0) return 0;

    const elapsed = this.elapsed[index]! + dt;
    this.elapsed[index] = elapsed;
    if (elapsed >= duration) {
      this.duration[index] = 0;
      return 0;
    }

    const t1 = duration;
    const s = elapsed / t1;

    const a0 = this.offset0[index]!;
    const a1 = this.velocity0[index]! * t1;
    // Coefficients solved from the five boundary conditions above, with zero
    // initial acceleration as the sixth.
    const S = -(a1 + a0);
    const T = -a1;
    const a5 = 6 * S - 3 * T;
    const a4 = 7 * T - 15 * S;
    const a3 = 10 * S - 4 * T;

    const s2 = s * s;
    const s3 = s2 * s;
    const s4 = s3 * s;
    const s5 = s4 * s;
    return a5 * s5 + a4 * s4 + a3 * s3 + a1 * s + a0;
  }

  /**
   * Adds the decaying offset to `target`, writing the result into `out`.
   *
   * `target` and `out` may safely be the same object.
   */
  apply(target: Pose, out: Pose, dt: number): void {
    for (let bone = 0; bone < this.boneCount; bone++) {
      const base = bone * CHANNELS;
      out.x[bone] = target.x[bone]! + this.evaluate(base + CHANNEL_X, dt);
      out.y[bone] = target.y[bone]! + this.evaluate(base + CHANNEL_Y, dt);
      out.rotation[bone] = target.rotation[bone]! + this.evaluate(base + CHANNEL_ROTATION, dt);
      out.scaleX[bone] = target.scaleX[bone]! + this.evaluate(base + CHANNEL_SCALE_X, dt);
      out.scaleY[bone] = target.scaleY[bone]! + this.evaluate(base + CHANNEL_SCALE_Y, dt);
    }

    // Keep two frames of history so the next transition can measure velocity.
    this.previousOutput2.copyFrom(this.previousOutput);
    this.previousOutput.copyFrom(out);
    this.previousDt = dt;
    this.hasHistory = true;
  }

  /** Clears all state, e.g. on respawn or a scene change. */
  reset(): void {
    this.offset0.fill(0);
    this.velocity0.fill(0);
    this.duration.fill(0);
    this.elapsed.fill(0);
    this.hasHistory = false;
  }

  /** True while any channel is still correcting. */
  get isBlending(): boolean {
    for (let i = 0; i < this.duration.length; i++) {
      if (this.duration[i]! > 0) return true;
    }
    return false;
  }
}
