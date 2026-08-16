/**
 * Mutable 2D vector helpers.
 *
 * The engine runs its simulation at a fixed 120 Hz and animates dozens of
 * spring-driven bones per frame, so vector math sits on the hot path. Every
 * function here therefore comes in two flavours: an allocating form for setup
 * code, and an `out`-parameter form for per-frame code. Nothing in the render
 * or simulation loop is permitted to allocate.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export const set = (out: Vec2, x: number, y: number): Vec2 => {
  out.x = x;
  out.y = y;
  return out;
};

export const copy = (out: Vec2, a: Vec2): Vec2 => set(out, a.x, a.y);

export const clone = (a: Vec2): Vec2 => vec2(a.x, a.y);

export const add = (out: Vec2, a: Vec2, b: Vec2): Vec2 => set(out, a.x + b.x, a.y + b.y);

export const sub = (out: Vec2, a: Vec2, b: Vec2): Vec2 => set(out, a.x - b.x, a.y - b.y);

export const mul = (out: Vec2, a: Vec2, b: Vec2): Vec2 => set(out, a.x * b.x, a.y * b.y);

export const scale = (out: Vec2, a: Vec2, s: number): Vec2 => set(out, a.x * s, a.y * s);

/** `out = a + b * s` — the workhorse of every integrator in the codebase. */
export const scaleAndAdd = (out: Vec2, a: Vec2, b: Vec2, s: number): Vec2 =>
  set(out, a.x + b.x * s, a.y + b.y * s);

export const negate = (out: Vec2, a: Vec2): Vec2 => set(out, -a.x, -a.y);

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** 2D analogue of the cross product: the z component of `a x b`. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const lengthSq = (a: Vec2): number => a.x * a.x + a.y * a.y;

export const length = (a: Vec2): number => Math.hypot(a.x, a.y);

export const distanceSq = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export const normalize = (out: Vec2, a: Vec2): Vec2 => {
  const len = Math.hypot(a.x, a.y);
  return len > 1e-9 ? set(out, a.x / len, a.y / len) : set(out, 0, 0);
};

/** Rotate 90° counter-clockwise. Used for ribbon/trail width expansion. */
export const perp = (out: Vec2, a: Vec2): Vec2 => set(out, -a.y, a.x);

export const rotate = (out: Vec2, a: Vec2, radians: number): Vec2 => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return set(out, a.x * c - a.y * s, a.x * s + a.y * c);
};

export const fromAngle = (out: Vec2, radians: number, len = 1): Vec2 =>
  set(out, Math.cos(radians) * len, Math.sin(radians) * len);

export const angle = (a: Vec2): number => Math.atan2(a.y, a.x);

export const lerp = (out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 =>
  set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

/** Clamp a vector's magnitude without changing its direction. */
export const limit = (out: Vec2, a: Vec2, max: number): Vec2 => {
  const lenSq = a.x * a.x + a.y * a.y;
  if (lenSq <= max * max || lenSq < 1e-12) return copy(out, a);
  const s = max / Math.sqrt(lenSq);
  return set(out, a.x * s, a.y * s);
};

/** Reflect `a` about the unit-length normal `n`. */
export const reflect = (out: Vec2, a: Vec2, n: Vec2): Vec2 => {
  const d = 2 * (a.x * n.x + a.y * n.y);
  return set(out, a.x - d * n.x, a.y - d * n.y);
};

/** Remove the component of `a` pointing along the unit-length normal `n`. */
export const project = (out: Vec2, a: Vec2, n: Vec2): Vec2 => {
  const d = a.x * n.x + a.y * n.y;
  return set(out, a.x - d * n.x, a.y - d * n.y);
};

export const equals = (a: Vec2, b: Vec2, epsilon = 1e-6): boolean =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;

export const isFinite2 = (a: Vec2): boolean => Number.isFinite(a.x) && Number.isFinite(a.y);

export const ZERO: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });
export const ONE: Readonly<Vec2> = Object.freeze({ x: 1, y: 1 });
export const UP: Readonly<Vec2> = Object.freeze({ x: 0, y: -1 });
export const DOWN: Readonly<Vec2> = Object.freeze({ x: 0, y: 1 });
export const LEFT: Readonly<Vec2> = Object.freeze({ x: -1, y: 0 });
export const RIGHT: Readonly<Vec2> = Object.freeze({ x: 1, y: 0 });
