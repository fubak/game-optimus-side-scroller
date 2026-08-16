/**
 * Scenario definitions.
 *
 * A scenario is a reproducible recipe for a recording: seed, quality tier,
 * duration, scripted input, and which moments deserve a full-resolution still.
 * Because they are pure data and the game runs on a virtual clock, re-running a
 * scenario after a code change produces a directly comparable result — which is
 * what turns the critique loop into a regression test rather than a vibe check.
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
  /** Scripted input, for scenarios that need exact button timing. */
  tape?: TapeEntry[];
  /**
   * Autopilot target X. Preferred over a tape for traversal: hand-timed tapes
   * are tied to the exact geometry they were authored against and break
   * silently whenever a ledge moves.
   */
  autopilotTargetX?: number;
  autopilotDirection?: number;
  autopilotSprint?: boolean;
  /** Non-zero renders an intermediate pipeline buffer instead of the final image. */
  debugView?: number;
  /** Optional starting position, in metres. */
  spawn?: { x: number; y: number };
  /** Optional fixed camera framing: [offsetX, offsetY, viewHeightMetres]. */
  camera?: [number, number, number];
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'ares_traversal',
    description:
      'A full run through the opening Ares Basin room: walking, sprinting, ' +
      'jumping gaps, dashing, landing, and fighting four sentry drones. ' +
      'Exercises the whole locomotion set, its transitions, and the melee ' +
      'combo with hitstop and impact VFX, in one continuous take.',
    seed: 1001,
    quality: Quality.High,
    durationSeconds: 28,
    warmupFrames: 30,
    heroFrames: [0],
    autopilotTargetX: 72,
    autopilotSprint: true,
  },
  {
    name: 'ares_vista',
    description:
      'Static wide framing of the Ares Basin. Judges the environment alone: ' +
      'parallax depth, aerial perspective, sun and god rays, dust, and the ' +
      'value ramp from sky to foreground.',
    seed: 1001,
    quality: Quality.Ultra,
    durationSeconds: 5,
    warmupFrames: 60,
    heroFrames: [0],
    camera: [6, -2.2, 14],
  },
  {
    name: 'ares_closeup',
    description:
      'Close framing on Optimus at a standstill, for judging the character ' +
      'itself: proportions, silhouette, material read, and idle motion.',
    seed: 1001,
    quality: Quality.Ultra,
    durationSeconds: 4,
    warmupFrames: 45,
    heroFrames: [0],
    camera: [0.4, -1.0, 3.4],
  },
];
