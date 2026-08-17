export type {
  AtlasRect,
  CharacterAtlas,
  ClipDesc,
  ClipId,
  EnemyClipId,
  OptimusClipId,
} from './types';
export { frameKey } from './types';

export {
  CELL_HEIGHT,
  CELL_WIDTH,
  ENEMY_CLIPS,
  ENEMY_DRAW_PAD,
  ENEMY_VISUAL_SCALE,
  OPTIMUS_CLIPS,
  WORLD_DRAW_HEIGHT,
  WORLD_DRAW_WIDTH,
  buildCharacterAtlas,
  enemyCanonicalSize,
  hashCharacterAtlas,
} from './bake';

export { enemyClipId, enemyKindFromClipId, optimusClipId, sampleClipFrame } from './playback';
