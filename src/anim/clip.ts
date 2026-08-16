/**
 * Animation clips.
 *
 * A clip is a sparse set of curves: only the channels an animation actually
 * moves are stored, and everything else falls through to the rest pose. That
 * keeps clips small to author and makes additive layering natural, since an
 * additive clip is simply one that omits every channel it does not affect.
 *
 * Clips are sampled by *time*, not by frame index, so playback rate is
 * continuous. A run cycle played at 1.37x speed is genuinely interpolated at
 * that rate rather than snapping to the nearest authored frame.
 */

import { Curve, smoothCurve, clampedCurve } from '../core/math/curve.ts';
import type { Pose, Skeleton } from './skeleton.ts';

export const enum Channel {
  X = 0,
  Y = 1,
  Rotation = 2,
  ScaleX = 3,
  ScaleY = 4,
}

interface ClipTrack {
  boneIndex: number;
  channel: Channel;
  curve: Curve;
}

/** Keyframes for one channel: `[timeSeconds, value]` pairs. */
export type ChannelKeys = readonly (readonly [number, number])[];

/**
 * Per-bone channel keys.
 *
 * Rotations are in *degrees* when authored, because reasoning about a knee bend
 * of 42 degrees is far easier than 0.733 radians, and a rig with thirty bones
 * is authored by hand. They are converted on load.
 */
export interface BoneKeys {
  rot?: ChannelKeys;
  x?: ChannelKeys;
  y?: ChannelKeys;
  scaleX?: ChannelKeys;
  scaleY?: ChannelKeys;
}

export interface ClipDefinition {
  name: string;
  duration: number;
  loop: boolean;
  bones: Record<string, BoneKeys>;
  /**
   * Clamped channels never overshoot their authored extremes. Essential for
   * joints with hard mechanical stops — a knee that Hermite-overshoots past
   * straight looks broken.
   */
  clamped?: boolean;
}

const DEG = Math.PI / 180;

export class Clip {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  private readonly tracks: ClipTrack[] = [];

  constructor(skeleton: Skeleton, definition: ClipDefinition) {
    this.name = definition.name;
    this.duration = definition.duration;
    this.loop = definition.loop;

    const build = definition.clamped ? clampedCurve : smoothCurve;

    for (const [boneName, keys] of Object.entries(definition.bones)) {
      const boneIndex = skeleton.index(boneName);

      if (keys.rot) {
        const radians = keys.rot.map(([t, v]) => [t, v * DEG] as const);
        this.tracks.push({ boneIndex, channel: Channel.Rotation, curve: build(radians) });
      }
      if (keys.x) this.tracks.push({ boneIndex, channel: Channel.X, curve: build(keys.x) });
      if (keys.y) this.tracks.push({ boneIndex, channel: Channel.Y, curve: build(keys.y) });
      if (keys.scaleX) {
        this.tracks.push({ boneIndex, channel: Channel.ScaleX, curve: build(keys.scaleX) });
      }
      if (keys.scaleY) {
        this.tracks.push({ boneIndex, channel: Channel.ScaleY, curve: build(keys.scaleY) });
      }
    }
  }

  /**
   * Samples the clip into `out`, which must already hold the rest pose.
   *
   * Channels the clip does not touch are left as they are, which is what makes
   * sparse clips and additive layering work.
   */
  sample(out: Pose, time: number, restPose: Pose): void {
    const t = this.loop
      ? // Positive modulo: a negative time (from a reversed transition) must
        // still land inside the clip rather than clamping to its start.
        ((time % this.duration) + this.duration) % this.duration
      : Math.min(Math.max(time, 0), this.duration);

    for (const track of this.tracks) {
      const value = track.curve.evaluate(t);
      switch (track.channel) {
        case Channel.X:
          out.x[track.boneIndex] = restPose.x[track.boneIndex]! + value;
          break;
        case Channel.Y:
          out.y[track.boneIndex] = restPose.y[track.boneIndex]! + value;
          break;
        case Channel.Rotation:
          out.rotation[track.boneIndex] = restPose.rotation[track.boneIndex]! + value;
          break;
        case Channel.ScaleX:
          out.scaleX[track.boneIndex] = value;
          break;
        case Channel.ScaleY:
          out.scaleY[track.boneIndex] = value;
          break;
        default: {
          const never: never = track.channel;
          throw new Error(`Unhandled animation channel: ${never}`);
        }
      }
    }
  }

  /**
   * Adds the clip's values on top of whatever is already in `out`.
   *
   * Used for layered motion: a flinch, a breathing cycle, or a lean applied on
   * top of whatever locomotion is playing underneath.
   */
  sampleAdditive(out: Pose, time: number, weight: number): void {
    if (weight <= 0) return;
    const t = this.loop
      ? ((time % this.duration) + this.duration) % this.duration
      : Math.min(Math.max(time, 0), this.duration);

    for (const track of this.tracks) {
      const value = track.curve.evaluate(t) * weight;
      switch (track.channel) {
        case Channel.X:
          out.x[track.boneIndex] += value;
          break;
        case Channel.Y:
          out.y[track.boneIndex] += value;
          break;
        case Channel.Rotation:
          out.rotation[track.boneIndex] += value;
          break;
        case Channel.ScaleX:
          out.scaleX[track.boneIndex] += value;
          break;
        case Channel.ScaleY:
          out.scaleY[track.boneIndex] += value;
          break;
        default: {
          const never: never = track.channel;
          throw new Error(`Unhandled animation channel: ${never}`);
        }
      }
    }
  }

  /** Resets every curve's sequential-sampling cursor. Call on loop or seek. */
  resetCursors(): void {
    for (const track of this.tracks) track.curve.resetCursor();
  }
}

/**
 * Blends two poses by simple interpolation.
 *
 * Used for *blendspaces* — walk against run at a given speed, or the rise/fall
 * pair driven by vertical velocity — where the two inputs are deliberately
 * similar and averaging them is meaningful. State *transitions* must not use
 * this; they go through the inertializer instead.
 */
export function blendPoses(out: Pose, a: Pose, b: Pose, t: number): void {
  const count = out.boneCount;
  for (let i = 0; i < count; i++) {
    out.x[i] = a.x[i]! + (b.x[i]! - a.x[i]!) * t;
    out.y[i] = a.y[i]! + (b.y[i]! - a.y[i]!) * t;
    // Interpolate along the shorter arc so limbs never spin the long way.
    let delta = b.rotation[i]! - a.rotation[i]!;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    out.rotation[i] = a.rotation[i]! + delta * t;
    out.scaleX[i] = a.scaleX[i]! + (b.scaleX[i]! - a.scaleX[i]!) * t;
    out.scaleY[i] = a.scaleY[i]! + (b.scaleY[i]! - a.scaleY[i]!) * t;
  }
}
