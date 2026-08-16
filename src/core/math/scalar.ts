/**
 * Scalar utilities shared by simulation, animation, and rendering.
 *
 * A note on the `*Damp` family: naive `lerp(a, b, 0.1)` smoothing is
 * frame-rate dependent, which would make the game feel measurably different at
 * 60 Hz and 144 Hz. Since frame-rate-independent feel is one of the project's
 * explicit quality bars, every smoothing call in the codebase must go through
 * the exponential-decay forms below.
 */

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Inverse of `lerp`: where does `v` sit between `a` and `b`? */
export const invLerp = (a: number, b: number, v: number): number =>
  Math.abs(b - a) < 1e-9 ? 0 : (v - a) / (b - a);

export const remap = (v: number, inMin: number, inMax: number, outMin: number, outMax: number): number =>
  lerp(outMin, outMax, invLerp(inMin, inMax, v));

/** `remap` with the output clamped to the destination range. */
export const remapClamped = (
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number => lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, v)));

export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Move `current` toward `target` by at most `maxDelta`. */
export const moveToward = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/**
 * Frame-rate-independent exponential smoothing.
 *
 * `halfLife` is the time in seconds for the remaining distance to halve, which
 * is far more intuitive to tune than a raw per-frame coefficient and stays
 * correct whatever the refresh rate.
 */
export const damp = (current: number, target: number, halfLife: number, dt: number): number => {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
};

/** Angular variant of {@link damp} that always takes the short way round. */
export const dampAngle = (current: number, target: number, halfLife: number, dt: number): number => {
  const delta = wrapAngle(target - current);
  return current + delta * (1 - Math.pow(2, -dt / Math.max(halfLife, 1e-6)));
};

/** Wrap an angle into the half-open range [-PI, PI). */
export const wrapAngle = (radians: number): number => {
  let a = (radians + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};

/** Shortest signed angular distance from `a` to `b`. */
export const angleDelta = (a: number, b: number): number => wrapAngle(b - a);

export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

/** Classic Hermite smoothstep; C1 continuous. */
export const smoothstep = (edge0: number, edge1: number, v: number): number => {
  const t = clamp01(invLerp(edge0, edge1, v));
  return t * t * (3 - 2 * t);
};

/** Ken Perlin's C2-continuous variant — no visible acceleration crease. */
export const smootherstep = (edge0: number, edge1: number, v: number): number => {
  const t = clamp01(invLerp(edge0, edge1, v));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Positive modulo, unlike JavaScript's `%` which keeps the sign of the dividend. */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Ping-pong `v` within `[0, len]`. Useful for looping ambient oscillation. */
export const pingPong = (v: number, len: number): number => len - Math.abs(mod(v, len * 2) - len);

/** Snap tiny values to zero so springs and velocities come fully to rest. */
export const deadzone = (v: number, threshold: number): number =>
  Math.abs(v) < threshold ? 0 : v;

/**
 * Radial dead zone with a smooth ramp, used for analogue stick input so the
 * transition out of the dead zone is not a visible step.
 */
export const applyDeadzone = (v: number, inner: number, outer = 1): number => {
  const m = Math.abs(v);
  if (m <= inner) return 0;
  return Math.sign(v) * clamp01((m - inner) / (outer - inner));
};

export const approximately = (a: number, b: number, epsilon = 1e-6): boolean =>
  Math.abs(a - b) <= epsilon;
