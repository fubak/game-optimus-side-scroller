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

export interface EnemyClipOptions {
  readonly telegraph?: boolean;
  /** Overseer only — false selects the sealed-core sheet. */
  readonly vulnerable?: boolean;
}

/** Resolve a clip id for an enemy kind + combat state. */
export function enemyClipId(kind: EnemyKind, options: EnemyClipOptions = {}): ClipId {
  const telegraph = options.telegraph === true;
  switch (kind) {
    case 'walker':
      return 'enemy:walker';
    case 'drone':
      return 'enemy:drone';
    case 'turret':
      return telegraph ? 'enemy:turretTelegraph' : 'enemy:turret';
    case 'crusher':
      return telegraph ? 'enemy:crusherTelegraph' : 'enemy:crusher';
    case 'overseer':
      return options.vulnerable === false ? 'enemy:overseerSealed' : 'enemy:overseer';
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled enemy kind in enemyClipId: ${String(exhaustive)}`);
    }
  }
}

/** Canonical enemy kind for sizing a clip (state suffixes share the same body). */
export function enemyKindFromClipId(clipId: ClipId): EnemyKind {
  if (clipId.startsWith('enemy:turret')) return 'turret';
  if (clipId.startsWith('enemy:crusher')) return 'crusher';
  if (clipId.startsWith('enemy:overseer')) return 'overseer';
  if (clipId === 'enemy:walker') return 'walker';
  if (clipId === 'enemy:drone') return 'drone';
  throw new Error(`Not an enemy clip id: ${clipId}`);
}
