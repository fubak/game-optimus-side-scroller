import type { LevelDef } from '../levelParser';
import { DEV_PLAYGROUND_LEVEL } from './dev';
import { LEVEL_1 } from './level1';
import { LEVEL_2 } from './level2';
import { LEVEL_3 } from './level3';

/**
 * Level registry.
 *
 * `LEVELS` is the campaign, in play order. The sandbox is registered separately so it can be loaded
 * with `?level=dev` without appearing in progression.
 */
export const LEVELS: readonly LevelDef[] = [LEVEL_1, LEVEL_2, LEVEL_3];

export const SANDBOX_LEVELS: readonly LevelDef[] = [DEV_PLAYGROUND_LEVEL];

export const ALL_LEVELS: readonly LevelDef[] = [...LEVELS, ...SANDBOX_LEVELS];

export function findLevel(id: string): LevelDef | undefined {
  return ALL_LEVELS.find((level) => level.id === id);
}

export function levelIndex(id: string): number {
  return LEVELS.findIndex((level) => level.id === id);
}

export function nextLevelId(id: string): string | null {
  const index = levelIndex(id);
  if (index < 0 || index + 1 >= LEVELS.length) return null;
  return LEVELS[index + 1]?.id ?? null;
}
