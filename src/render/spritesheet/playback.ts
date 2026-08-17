/**
 * Dead Cells–smooth clip playback helpers.
 *
 * High FPS + dense frame counts; looping clips wrap, one-shots clamp to the last frame.
 */

import type { EnemyKind } from '../../game/enemies';
import type { PlayerState } from '../../game/player';
import type { ClipDesc, ClipId } from './types';

/** Frame index for a clip at `animTime` seconds since clip start (Player.animTime / enemy.animTime). */
export function sampleClipFrame(clip: ClipDesc, animTime: number): number {
  if (clip.frameCount <= 1) return 0;
  const t = Math.max(0, animTime);
  const raw = t * clip.fps;
  if (clip.loop) {
    const wrapped = raw % clip.frameCount;
    return Math.floor(wrapped);
  }
  return Math.min(clip.frameCount - 1, Math.floor(raw));
}

/** Resolve a clip id for Optimus from gameplay state. */
export function optimusClipId(state: PlayerState): ClipId {
  switch (state) {
    case 'idle':
    case 'run':
    case 'jump':
    case 'fall':
    case 'thrust':
    case 'dash':
    case 'hurt':
    case 'dead':
    case 'victory':
      return `optimus:${state}`;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled player state in optimusClipId: ${String(exhaustive)}`);
    }
  }
}

/** Resolve a clip id for an enemy kind. */
export function enemyClipId(kind: EnemyKind): ClipId {
  switch (kind) {
    case 'walker':
    case 'drone':
    case 'turret':
    case 'crusher':
    case 'overseer':
      return `enemy:${kind}`;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled enemy kind in enemyClipId: ${String(exhaustive)}`);
    }
  }
}
