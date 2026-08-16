/**
 * Scenario definitions.
 *
 * A scenario is a reproducible recipe for a recording: which seed, which
 * quality tier, how long, which inputs to play, and which moments deserve a
 * full-resolution still. Because they are pure data and the game runs on a
 * virtual clock, re-running a scenario after a code change produces a directly
 * comparable result — which is what turns the critique loop into a regression
 * test rather than a vibe check.
 *
 * The library grows every round as new systems become capturable.
 */

import type { TapeEntry } from '../../../src/harness.ts';
import { Quality } from '../../../src/core/config.ts';

export interface Scenario {
  name: string;
  description: string;
  seed: number;
  quality: Quality;
  durationSeconds: number;
  /** Frames to run before recording starts, to let ambient motion settle. */
  warmupFrames?: number;
  /** Times, in seconds from the recording start, to grab a hero still. */
  heroFrames?: number[];
  /** Scripted input, if the scenario needs the player to do something. */
  tape?: TapeEntry[];
  /** Non-zero renders an intermediate pipeline buffer instead of the final image. */
  debugView?: number;
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'ares_vista',
    description:
      'Static framing of the Ares Basin test scene. Exercises the full lighting ' +
      'and post stack: raking sun, shadowed cyan console lights, god rays, ' +
      'drifting dust, bloom on emissive strips.',
    seed: 1001,
    quality: Quality.Ultra,
    durationSeconds: 6,
    warmupFrames: 45,
    heroFrames: [0],
  },
  {
    name: 'ares_vista_high',
    description: 'The same framing at the High tier, to verify tier parity.',
    seed: 1001,
    quality: Quality.High,
    durationSeconds: 2,
    warmupFrames: 45,
    heroFrames: [0],
  },
];

/** Debug scenarios that dump individual pipeline buffers for inspection. */
export const DEBUG_SCENARIOS: Scenario[] = [
  { name: 'debug_albedo', description: 'G-buffer albedo', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 1, heroFrames: [0] },
  { name: 'debug_normal', description: 'G-buffer normals', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 2, heroFrames: [0] },
  { name: 'debug_material', description: 'G-buffer material', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 3, heroFrames: [0] },
  { name: 'debug_depth', description: 'G-buffer depth', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 4, heroFrames: [0] },
  { name: 'debug_occluder', description: 'Occluder mask', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 5, heroFrames: [0] },
  { name: 'debug_light', description: 'HDR light accumulation', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 6, heroFrames: [0] },
  { name: 'debug_godrays', description: 'God-ray buffer', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 7, heroFrames: [0] },
  { name: 'debug_bloom', description: 'Bloom chain level 0', seed: 1001, quality: Quality.Ultra, durationSeconds: 0.2, debugView: 8, heroFrames: [0] },
];
