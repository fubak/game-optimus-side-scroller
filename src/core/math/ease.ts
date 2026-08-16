/**
 * Easing functions.
 *
 * Every one of these takes and returns a normalised `t` in [0, 1]. They are
 * used for UI motion, camera blends, and the shaping of authored animation
 * segments. Anything that needs velocity continuity across a *transition*
 * should use inertialised blending (see `src/anim/blender.ts`) instead — easing
 * curves alone cannot preserve incoming velocity.
 */

import { clamp01 } from './scalar.ts';

export type EaseFn = (t: number) => number;

export const linear: EaseFn = (t) => t;

export const quadIn: EaseFn = (t) => t * t;
export const quadOut: EaseFn = (t) => t * (2 - t);
export const quadInOut: EaseFn = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

export const cubicIn: EaseFn = (t) => t * t * t;
export const cubicOut: EaseFn = (t) => {
  const f = t - 1;
  return f * f * f + 1;
};
export const cubicInOut: EaseFn = (t) =>
  t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;

export const quartIn: EaseFn = (t) => t * t * t * t;
export const quartOut: EaseFn = (t) => 1 - Math.pow(1 - t, 4);
export const quartInOut: EaseFn = (t) =>
  t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;

export const quintIn: EaseFn = (t) => t * t * t * t * t;
export const quintOut: EaseFn = (t) => 1 - Math.pow(1 - t, 5);
export const quintInOut: EaseFn = (t) =>
  t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;

export const sineIn: EaseFn = (t) => 1 - Math.cos((t * Math.PI) / 2);
export const sineOut: EaseFn = (t) => Math.sin((t * Math.PI) / 2);
export const sineInOut: EaseFn = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

export const expoIn: EaseFn = (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10));
export const expoOut: EaseFn = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const expoInOut: EaseFn = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;

export const circIn: EaseFn = (t) => 1 - Math.sqrt(1 - t * t);
export const circOut: EaseFn = (t) => Math.sqrt(1 - (t - 1) * (t - 1));
export const circInOut: EaseFn = (t) =>
  t < 0.5
    ? (1 - Math.sqrt(1 - 4 * t * t)) / 2
    : (Math.sqrt(1 - (-2 * t + 2) * (-2 * t + 2)) + 1) / 2;

const BACK_C1 = 1.70158;
const BACK_C2 = BACK_C1 * 1.525;
const BACK_C3 = BACK_C1 + 1;

/** Anticipation — pulls back before moving. Reads as "winding up". */
export const backIn: EaseFn = (t) => BACK_C3 * t * t * t - BACK_C1 * t * t;
/** Follow-through — overshoots then settles. Reads as momentum. */
export const backOut: EaseFn = (t) => 1 + BACK_C3 * Math.pow(t - 1, 3) + BACK_C1 * Math.pow(t - 1, 2);
export const backInOut: EaseFn = (t) =>
  t < 0.5
    ? (Math.pow(2 * t, 2) * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((BACK_C2 + 1) * (t * 2 - 2) + BACK_C2) + 2) / 2;

const ELASTIC_C4 = (2 * Math.PI) / 3;

export const elasticOut: EaseFn = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1;

export const bounceOut: EaseFn = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const t2 = t - 1.5 / d1;
    return n1 * t2 * t2 + 0.75;
  }
  if (t < 2.5 / d1) {
    const t2 = t - 2.25 / d1;
    return n1 * t2 * t2 + 0.9375;
  }
  const t2 = t - 2.625 / d1;
  return n1 * t2 * t2 + 0.984375;
};

export const bounceIn: EaseFn = (t) => 1 - bounceOut(1 - t);

/**
 * Evaluates a CSS-style cubic Bezier easing curve `(0,0) -> (x1,y1) ->
 * (x2,y2) -> (1,1)`.
 *
 * Solving `x(t) = target` requires iteration; Newton-Raphson converges in a
 * handful of steps for the well-behaved curves we author, with a bisection
 * fallback for the near-vertical cases where the derivative vanishes.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const bezier = (a: number, b: number, t: number): number => {
    const c = 3 * a;
    const bTerm = 3 * (b - a) - c;
    const aTerm = 1 - c - bTerm;
    return ((aTerm * t + bTerm) * t + c) * t;
  };
  const slope = (a: number, b: number, t: number): number => {
    const c = 3 * a;
    const bTerm = 3 * (b - a) - c;
    const aTerm = 1 - c - bTerm;
    return (3 * aTerm * t + 2 * bTerm) * t + c;
  };

  return (t: number): number => {
    const target = clamp01(t);
    if (target <= 0) return 0;
    if (target >= 1) return 1;

    let guess = target;
    for (let i = 0; i < 8; i++) {
      const err = bezier(x1, x2, guess) - target;
      if (Math.abs(err) < 1e-6) return bezier(y1, y2, guess);
      const d = slope(x1, x2, guess);
      if (Math.abs(d) < 1e-6) break;
      guess -= err / d;
    }

    let lo = 0;
    let hi = 1;
    guess = target;
    for (let i = 0; i < 24; i++) {
      const value = bezier(x1, x2, guess);
      if (Math.abs(value - target) < 1e-6) break;
      if (value > target) hi = guess;
      else lo = guess;
      guess = (lo + hi) / 2;
    }
    return bezier(y1, y2, guess);
  };
}

/**
 * Named curves used across the game so motion stays stylistically consistent.
 * `snapOut` in particular is the house curve for anything mechanical: a very
 * fast start that decelerates hard, which reads as servo-driven rather than
 * floaty.
 */
export const EASE = {
  linear,
  snapOut: cubicBezier(0.12, 0.9, 0.2, 1),
  softOut: cubicBezier(0.22, 0.61, 0.36, 1),
  softInOut: cubicBezier(0.65, 0.05, 0.36, 1),
  anticipate: backIn,
  overshoot: backOut,
  quadIn,
  quadOut,
  quadInOut,
  cubicIn,
  cubicOut,
  cubicInOut,
  quartOut,
  quintOut,
  sineIn,
  sineOut,
  sineInOut,
  expoIn,
  expoOut,
  circOut,
  elasticOut,
  bounceOut,
  bounceIn,
} as const;

export type EaseName = keyof typeof EASE;
