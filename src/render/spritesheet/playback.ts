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
  /** Death collapse one-shot — takes priority over telegraph / sealed. */
  readonly dying?: boolean;
}

/** Resolve a clip id for an enemy kind + combat state. */
export function enemyClipId(kind: EnemyKind, options: EnemyClipOptions = {}): ClipId {
  if (options.dying === true) {
    switch (kind) {
      case 'walker':
        return 'enemy:walkerDying';
      case 'drone':
        return 'enemy:droneDying';
      case 'turret':
        return 'enemy:turretDying';
      case 'crusher':
        return 'enemy:crusherDying';
      case 'overseer':
        return 'enemy:overseerDying';
      default: {
        const exhaustive: never = kind;
        throw new Error(`Unhandled enemy kind in enemyClipId(dying): ${String(exhaustive)}`);
      }
    }
  }
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
  if (clipId.startsWith('enemy:walker')) return 'walker';
  if (clipId.startsWith('enemy:drone')) return 'drone';
  throw new Error(`Not an enemy clip id: ${clipId}`);
}

/** True when the clip is a one-shot death collapse. */
export function isEnemyDyingClip(clipId: ClipId): boolean {
  return clipId.endsWith('Dying');
}

/**
 * Map death progress 0..1 onto a one-shot dying clip's animTime so frame 0 is intact and the
 * last frame is fully collapsed.
 */
export function dyingClipAnimTime(clip: ClipDesc, dyingProgress: number): number {
  if (clip.frameCount <= 1) return 0;
  const progress = Math.max(0, Math.min(1, dyingProgress));
  return (progress * (clip.frameCount - 1)) / clip.fps;
}
