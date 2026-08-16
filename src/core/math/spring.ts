/**
 * Analytically-solved damped springs.
 *
 * Secondary motion — the sway of Optimus's power cables, the settle of the
 * backpack after a landing, camera recoil, HUD needle overshoot — is what sells
 * mechanical weight. Naive per-frame integration of a stiff spring explodes at
 * low frame rates and changes character with the refresh rate, both of which
 * would violate the project's frame-rate-independence bar.
 *
 * These solvers use the closed-form solution of the second-order ODE
 *
 *     x'' + 2*zeta*omega*x' + omega^2*(x - target) = 0
 *
 * so they are unconditionally stable and produce identical motion at 30 Hz and
 * 240 Hz. Springs are parameterised by frequency (Hz) and damping ratio, which
 * are the two numbers an animator actually reasons about.
 */

import type { Vec2 } from './vec2.ts';
import { TAU } from './scalar.ts';

export interface SpringState {
  /** Current value. */
  value: number;
  /** Current velocity, in units per second. */
  velocity: number;
}

export interface SpringConfig {
  /** Undamped natural frequency in Hz — how "fast" the spring is. */
  frequency: number;
  /**
   * Damping ratio.
   * - `< 1` underdamped: overshoots and oscillates (bouncy, springy metal).
   * - `= 1` critically damped: fastest approach with no overshoot.
   * - `> 1` overdamped: sluggish, no overshoot (heavy, damped machinery).
   */
  damping: number;
}

export const spring = (value = 0, velocity = 0): SpringState => ({ value, velocity });

/**
 * Advance a scalar spring toward `target` by `dt` seconds.
 *
 * Implements the exact solution for each of the three damping regimes, after
 * Ryan Juckett's derivation. Mutates and returns `state`.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dt: number,
): SpringState {
  if (dt <= 0) return state;

  const omega = config.frequency * TAU;
  const zeta = config.damping;

  // A zero-frequency spring has no restoring force; it would divide by zero
  // below and physically just coasts, so snap it and bail out.
  if (omega < 1e-6) {
    state.value = target;
    state.velocity = 0;
    return state;
  }

  const x = state.value - target;
  const v = state.velocity;

  if (zeta < 1 - 1e-4) {
    // Underdamped: decaying sinusoid.
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega * dt);
    const c = Math.cos(omegaD * dt);
    const s = Math.sin(omegaD * dt);
    const a = x;
    const b = (v + zeta * omega * x) / omegaD;

    state.value = target + decay * (a * c + b * s);
    state.velocity =
      decay * (v * c - (omega * (zeta * v + omega * x) * s) / omegaD);
  } else if (zeta > 1 + 1e-4) {
    // Overdamped: sum of two real exponentials.
    const root = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + root;
    const r2 = -zeta * omega - root;
    const c2 = (v - r1 * x) / (r2 - r1);
    const c1 = x - c2;
    const e1 = c1 * Math.exp(r1 * dt);
    const e2 = c2 * Math.exp(r2 * dt);

    state.value = target + e1 + e2;
    state.velocity = r1 * e1 + r2 * e2;
  } else {
    // Critically damped: the repeated-root case.
    const decay = Math.exp(-omega * dt);
    const c1 = x;
    const c2 = v + omega * x;

    state.value = target + (c1 + c2 * dt) * decay;
    state.velocity = (v - c2 * omega * dt) * decay;
  }

  return state;
}

/**
 * Nudge a spring's velocity directly. This is how impacts are applied — a
 * landing does not move the hips, it *kicks* them and lets the spring resolve
 * the squash-and-recover on its own.
 */
export const impulse = (state: SpringState, amount: number): void => {
  state.velocity += amount;
};

export const resetSpring = (state: SpringState, value = 0): void => {
  state.value = value;
  state.velocity = 0;
};

/** True once a spring has effectively settled, so it can be skipped. */
export const isSettled = (
  state: SpringState,
  target: number,
  valueEpsilon = 1e-4,
  velocityEpsilon = 1e-3,
): boolean =>
  Math.abs(state.value - target) < valueEpsilon &&
  Math.abs(state.velocity) < velocityEpsilon;

export interface Spring2State {
  value: Vec2;
  velocity: Vec2;
}

export const spring2 = (x = 0, y = 0): Spring2State => ({
  value: { x, y },
  velocity: { x: 0, y: 0 },
});

// Scratch objects so the per-frame path never allocates.
const scratchX: SpringState = { value: 0, velocity: 0 };
const scratchY: SpringState = { value: 0, velocity: 0 };

/** Vector form of {@link stepSpring}; each axis is solved independently. */
export function stepSpring2(
  state: Spring2State,
  targetX: number,
  targetY: number,
  config: SpringConfig,
  dt: number,
): Spring2State {
  scratchX.value = state.value.x;
  scratchX.velocity = state.velocity.x;
  stepSpring(scratchX, targetX, config, dt);
  state.value.x = scratchX.value;
  state.velocity.x = scratchX.velocity;

  scratchY.value = state.value.y;
  scratchY.velocity = state.velocity.y;
  stepSpring(scratchY, targetY, config, dt);
  state.value.y = scratchY.value;
  state.velocity.y = scratchY.velocity;

  return state;
}

/** Named presets so tuning stays consistent across the whole character rig. */
export const SPRING_PRESETS = {
  /** Heavy actuator settle — knees, hips, chassis. */
  chassis: { frequency: 3.2, damping: 0.75 } satisfies SpringConfig,
  /** Loose hanging cables and straps; visibly swings. */
  cable: { frequency: 2.1, damping: 0.34 } satisfies SpringConfig,
  /** Light antenna / thin trailing elements. */
  antenna: { frequency: 4.6, damping: 0.22 } satisfies SpringConfig,
  /** Camera framing — must never overshoot or it reads as a bug. */
  camera: { frequency: 2.6, damping: 1.0 } satisfies SpringConfig,
  /** Snappy UI element motion. */
  ui: { frequency: 6.0, damping: 0.85 } satisfies SpringConfig,
  /** Landing squash: fast, with a deliberate single overshoot. */
  impact: { frequency: 5.5, damping: 0.45 } satisfies SpringConfig,
} as const;
