/**
 * Axis-aligned bounding boxes and swept collision queries.
 *
 * The player moves fast — a dash covers several body-lengths in a few frames —
 * so discrete overlap tests would let it tunnel straight through thin geometry.
 * Every movement query in the game is therefore *swept*: it solves for the exact
 * fraction of the motion at which contact occurs.
 *
 * Coordinate convention: +X is right, +Y is **down** (screen space). "Up" is
 * therefore negative Y, and a floor contact has a normal of (0, -1).
 */

import type { Vec2 } from './vec2.ts';

export interface AABB {
  /** Centre position. */
  x: number;
  y: number;
  /** Half-extents. Storing halves avoids a divide in every single test. */
  hw: number;
  hh: number;
}

export const aabb = (x = 0, y = 0, hw = 0.5, hh = 0.5): AABB => ({ x, y, hw, hh });

export const fromMinMax = (minX: number, minY: number, maxX: number, maxY: number): AABB => ({
  x: (minX + maxX) / 2,
  y: (minY + maxY) / 2,
  hw: (maxX - minX) / 2,
  hh: (maxY - minY) / 2,
});

export const minX = (b: AABB): number => b.x - b.hw;
export const maxX = (b: AABB): number => b.x + b.hw;
export const minY = (b: AABB): number => b.y - b.hh;
export const maxY = (b: AABB): number => b.y + b.hh;

export const overlaps = (a: AABB, b: AABB): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw && Math.abs(a.y - b.y) < a.hh + b.hh;

/** Overlap test with a slack margin — used for "is the player near a ledge" style queries. */
export const overlapsExpanded = (a: AABB, b: AABB, margin: number): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw + margin && Math.abs(a.y - b.y) < a.hh + b.hh + margin;

export const containsPoint = (b: AABB, px: number, py: number): boolean =>
  Math.abs(px - b.x) <= b.hw && Math.abs(py - b.y) <= b.hh;

/** Signed overlap depth on each axis. Negative means separated on that axis. */
export const overlapDepth = (a: AABB, b: AABB, out: Vec2): Vec2 => {
  out.x = a.hw + b.hw - Math.abs(a.x - b.x);
  out.y = a.hh + b.hh - Math.abs(a.y - b.y);
  return out;
};

export interface SweepHit {
  /** Fraction of the motion travelled before contact, in [0, 1]. */
  time: number;
  /** Surface normal of the face that was hit. */
  normalX: number;
  normalY: number;
}

/**
 * Sweeps `box` along `(dx, dy)` against the static `solid` and reports the
 * first contact.
 *
 * Implemented as a slab test on the Minkowski-expanded solid: growing `solid`
 * by `box`'s half-extents turns "moving box vs box" into the much simpler
 * "moving point vs box".
 *
 * Returns `false` when there is no contact within the motion. `hit` is only
 * meaningful when the function returns `true`.
 */
export function sweepAABB(
  box: AABB,
  dx: number,
  dy: number,
  solid: AABB,
  hit: SweepHit,
): boolean {
  const ex = solid.hw + box.hw;
  const ey = solid.hh + box.hh;

  // Already interpenetrating: not a sweep case. Callers resolve this with
  // depenetration rather than a time-of-impact, so report no hit.
  const relX = box.x - solid.x;
  const relY = box.y - solid.y;
  if (Math.abs(relX) < ex && Math.abs(relY) < ey) return false;

  let entryX: number;
  let exitX: number;
  if (Math.abs(dx) < 1e-9) {
    // Parallel to the X slabs: either permanently inside them or never.
    if (Math.abs(relX) >= ex) return false;
    entryX = -Infinity;
    exitX = Infinity;
  } else {
    const inv = 1 / dx;
    let t1 = (solid.x - ex - box.x) * inv;
    let t2 = (solid.x + ex - box.x) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    entryX = t1;
    exitX = t2;
  }

  let entryY: number;
  let exitY: number;
  if (Math.abs(dy) < 1e-9) {
    if (Math.abs(relY) >= ey) return false;
    entryY = -Infinity;
    exitY = Infinity;
  } else {
    const inv = 1 / dy;
    let t1 = (solid.y - ey - box.y) * inv;
    let t2 = (solid.y + ey - box.y) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    entryY = t1;
    exitY = t2;
  }

  const entry = Math.max(entryX, entryY);
  const exit = Math.min(exitX, exitY);

  if (entry > exit || entry > 1 || exit < 0) return false;

  // A meaningfully negative entry time means contact began behind the start of
  // the motion, so this sweep did not cause it.
  //
  // The tolerance matters more than it looks. A body resting exactly on a
  // surface computes its entry time from an expression like
  // `3 - 3.83 + 0.83`, which in floating point is -1.1e-16 rather than 0.
  // Rejecting that as "behind the motion" made a character standing precisely
  // on the floor fail to collide with it, sink in by a fraction of a
  // millimetre, and then fall through the world for ever, because the
  // interpenetration guard above suppressed every subsequent sweep.
  if (entry < -1e-6) return false;

  hit.time = entry < 0 ? 0 : entry;
  // The axis with the later entry time is the one actually responsible for the
  // contact, and therefore determines the normal.
  if (entryX > entryY) {
    hit.normalX = dx > 0 ? -1 : 1;
    hit.normalY = 0;
  } else {
    hit.normalX = 0;
    hit.normalY = dy > 0 ? -1 : 1;
  }
  return true;
}

export interface RayHit {
  time: number;
  normalX: number;
  normalY: number;
}

/** Ray/AABB slab intersection. Used for ground probes and line-of-sight checks. */
export function rayAABB(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  box: AABB,
  hit: RayHit,
  maxTime = 1,
): boolean {
  let tMin = 0;
  let tMax = maxTime;
  let nx = 0;
  let ny = 0;

  if (Math.abs(dx) < 1e-9) {
    if (Math.abs(ox - box.x) > box.hw) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (box.x - box.hw - ox) * inv;
    let t2 = (box.x + box.hw - ox) * inv;
    let sign = -Math.sign(dx);
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = -sign;
    }
    if (t1 > tMin) {
      tMin = t1;
      nx = sign;
      ny = 0;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  if (Math.abs(dy) < 1e-9) {
    if (Math.abs(oy - box.y) > box.hh) return false;
  } else {
    const inv = 1 / dy;
    let t1 = (box.y - box.hh - oy) * inv;
    let t2 = (box.y + box.hh - oy) * inv;
    let sign = -Math.sign(dy);
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = -sign;
    }
    if (t1 > tMin) {
      tMin = t1;
      nx = 0;
      ny = sign;
    }
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  hit.time = tMin;
  hit.normalX = nx;
  hit.normalY = ny;
  return true;
}

/** Grow a box in place by a uniform margin. */
export const expand = (b: AABB, margin: number): AABB => {
  b.hw += margin;
  b.hh += margin;
  return b;
};

/** Smallest box containing both inputs. */
export const union = (out: AABB, a: AABB, b: AABB): AABB => {
  const lo0 = Math.min(minX(a), minX(b));
  const hi0 = Math.max(maxX(a), maxX(b));
  const lo1 = Math.min(minY(a), minY(b));
  const hi1 = Math.max(maxY(a), maxY(b));
  out.x = (lo0 + hi0) / 2;
  out.y = (lo1 + hi1) / 2;
  out.hw = (hi0 - lo0) / 2;
  out.hh = (hi1 - lo1) / 2;
  return out;
};

/**
 * Expands a box to cover an entire motion, giving the broad-phase a cheap
 * conservative bound for candidate gathering.
 */
export const sweptBounds = (out: AABB, b: AABB, dx: number, dy: number): AABB => {
  out.x = b.x + dx / 2;
  out.y = b.y + dy / 2;
  out.hw = b.hw + Math.abs(dx) / 2;
  out.hh = b.hh + Math.abs(dy) / 2;
  return out;
};
