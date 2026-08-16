/** Small, allocation-free math helpers shared by the simulation and the renderer. */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Linear interpolation that is safe to call every fixed step (t is clamped). */
export function mix(from: number, to: number, t: number): number {
  return lerp(from, to, clamp01(t));
}

/** Step `current` towards `target` by at most `maxDelta`. Never overshoots. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return target;
}

/** Frame-rate independent exponential smoothing: fraction of the gap to close in `dt` seconds. */
export function smoothingFactor(halfLifeSec: number, dtSec: number): number {
  if (halfLifeSec <= 0) return 1;
  return 1 - Math.pow(0.5, dtSec / halfLifeSec);
}

export function sign(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

export function aabbOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Overlap area of two rectangles (0 when they do not intersect). */
export function aabbOverlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  return width * height;
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

export function rectCenterX(rect: Rect): number {
  return rect.x + rect.width / 2;
}

export function rectCenterY(rect: Rect): number {
  return rect.y + rect.height / 2;
}

export function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(distanceSquared(ax, ay, bx, by));
}

/** Map `value` from [inMin, inMax] to [outMin, outMax], clamped to the output range. */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return outMin + (outMax - outMin) * clamp01((value - inMin) / (inMax - inMin));
}
