/**
 * Cubic Hermite animation curves.
 *
 * This is the backbone of the animation system and the reason the game can
 * claim genuine high-frame-rate fluidity. Sprite-sheet animation is quantised
 * to whatever frame count was authored; a Hermite curve is a *continuous*
 * function of time, so sampling it at 144 Hz genuinely produces 144 distinct
 * poses per second rather than 24 poses shown repeatedly.
 *
 * Curves are C1 continuous by construction (position and velocity match across
 * every keyframe boundary), which is what stops joints from visibly "ticking"
 * as they pass through a key.
 */

import { clamp } from './scalar.ts';

export const enum Interp {
  /** Cubic Hermite using the keyframes' tangents. The default. */
  Cubic = 0,
  /** Straight line — deliberate mechanical linearity. */
  Linear = 1,
  /** Hold the value until the next key. Used for discrete channel switches. */
  Step = 2,
}

export interface Keyframe {
  /** Time in seconds from the start of the clip. */
  time: number;
  value: number;
  /** Incoming slope, in value-units per second. */
  inTangent: number;
  /** Outgoing slope, in value-units per second. */
  outTangent: number;
  interp: Interp;
}

export const key = (
  time: number,
  value: number,
  inTangent = 0,
  outTangent = inTangent,
  interp: Interp = Interp.Cubic,
): Keyframe => ({ time, value, inTangent, outTangent, interp });

/**
 * Evaluates the cubic Hermite basis over a normalised span.
 *
 * `dt` is the real duration of the span; tangents are expressed per second, so
 * they must be scaled by `dt` to move into normalised-parameter space.
 */
export function hermite(
  p0: number,
  m0: number,
  p1: number,
  m1: number,
  t: number,
  dt: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * dt * m0 + h01 * p1 + h11 * dt * m1;
}

/** Analytic derivative of {@link hermite}, in value-units per second. */
export function hermiteDerivative(
  p0: number,
  m0: number,
  p1: number,
  m1: number,
  t: number,
  dt: number,
): number {
  const t2 = t * t;
  const d00 = 6 * t2 - 6 * t;
  const d10 = 3 * t2 - 4 * t + 1;
  const d01 = -6 * t2 + 6 * t;
  const d11 = 3 * t2 - 2 * t;
  return (d00 * p0 + d01 * p1) / dt + d10 * m0 + d11 * m1;
}

export class Curve {
  readonly keys: Keyframe[];
  /**
   * Playback cursor. Animation sampling is overwhelmingly sequential, so
   * remembering the last span turns the common case into an O(1) check instead
   * of an O(log n) binary search on every bone, every frame.
   */
  private cursor = 0;

  constructor(keys: Keyframe[]) {
    if (keys.length === 0) throw new Error('Curve requires at least one keyframe');
    this.keys = [...keys].sort((a, b) => a.time - b.time);
  }

  get duration(): number {
    return this.keys[this.keys.length - 1]!.time;
  }

  get startTime(): number {
    return this.keys[0]!.time;
  }

  /** Sample the curve. Times outside the range clamp to the end values. */
  evaluate(time: number): number {
    const keys = this.keys;
    const n = keys.length;
    if (n === 1) return keys[0]!.value;

    const first = keys[0]!;
    const last = keys[n - 1]!;
    if (time <= first.time) return first.value;
    if (time >= last.time) return last.value;

    const i = this.findSpan(time);
    const a = keys[i]!;
    const b = keys[i + 1]!;

    if (a.interp === Interp.Step) return a.value;

    const dt = b.time - a.time;
    if (dt <= 1e-9) return b.value;
    const t = (time - a.time) / dt;

    if (a.interp === Interp.Linear) return a.value + (b.value - a.value) * t;
    return hermite(a.value, a.outTangent, b.value, b.inTangent, t, dt);
  }

  /** Sample the curve's slope. Used to seed inertialised blends. */
  evaluateVelocity(time: number): number {
    const keys = this.keys;
    const n = keys.length;
    if (n === 1) return 0;

    const first = keys[0]!;
    const last = keys[n - 1]!;
    if (time <= first.time || time >= last.time) return 0;

    const i = this.findSpan(time);
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (a.interp === Interp.Step) return 0;

    const dt = b.time - a.time;
    if (dt <= 1e-9) return 0;
    const t = (time - a.time) / dt;

    if (a.interp === Interp.Linear) return (b.value - a.value) / dt;
    return hermiteDerivative(a.value, a.outTangent, b.value, b.inTangent, t, dt);
  }

  private findSpan(time: number): number {
    const keys = this.keys;
    const n = keys.length;

    // Fast path: still inside the remembered span, or stepped into the next one.
    let c = clamp(this.cursor, 0, n - 2);
    if (time >= keys[c]!.time && time < keys[c + 1]!.time) return c;
    if (c + 2 < n && time >= keys[c + 1]!.time && time < keys[c + 2]!.time) {
      this.cursor = c + 1;
      return c + 1;
    }

    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid]!.time <= time) lo = mid;
      else hi = mid;
    }
    c = clamp(lo, 0, n - 2);
    this.cursor = c;
    return c;
  }

  /** Reset the sequential-sampling cursor; call when a clip loops or seeks. */
  resetCursor(): void {
    this.cursor = 0;
  }
}

/**
 * Builds a curve from `[time, value]` pairs, deriving smooth tangents
 * automatically using the Catmull-Rom rule (each key's slope is the slope of
 * the chord between its neighbours).
 *
 * This is how the vast majority of clips are authored: an animator specifies
 * poses and timing, not tangents.
 */
export function smoothCurve(points: readonly (readonly [number, number])[]): Curve {
  const n = points.length;
  if (n === 0) throw new Error('smoothCurve requires at least one point');
  if (n === 1) {
    const p = points[0]!;
    return new Curve([key(p[0], p[1], 0, 0)]);
  }

  const keys: Keyframe[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(i - 1, 0)]!;
    const next = points[Math.min(i + 1, n - 1)]!;
    const span = next[0] - prev[0];
    const tangent = span > 1e-9 ? (next[1] - prev[1]) / span : 0;
    keys.push(key(points[i]![0], points[i]![1], tangent, tangent));
  }
  return new Curve(keys);
}

/**
 * Like {@link smoothCurve}, but flattens tangents at local extrema so the curve
 * cannot overshoot past an authored value.
 *
 * Essential for channels where overshoot is physically impossible — a knee that
 * bends past its stop, or a normalised 0..1 glow channel that would otherwise
 * momentarily exceed 1 and blow out the bloom pass.
 */
export function clampedCurve(points: readonly (readonly [number, number])[]): Curve {
  const curve = smoothCurve(points);
  const keys = curve.keys;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    const prev = keys[i - 1];
    const next = keys[i + 1];
    const risingBefore = prev ? k.value - prev.value : 0;
    const risingAfter = next ? next.value - k.value : 0;
    // A sign change between the incoming and outgoing deltas means this key is
    // a peak or a trough; a zero slope there guarantees no overshoot.
    if (prev && next && risingBefore * risingAfter <= 0) {
      k.inTangent = 0;
      k.outTangent = 0;
    }
  }
  return curve;
}

/** A curve that holds a single constant value. */
export const constantCurve = (value: number): Curve => new Curve([key(0, value, 0, 0)]);
