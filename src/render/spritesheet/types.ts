/**
 * Procedural character sprite-sheet types.
 *
 * Frames are baked from skeletal rigs (`src/render/rig/`) into RGBA atlases at Enhanced load —
 * no hand-authored binary assets. Playback is Dead Cells–smooth: dense frame counts at high FPS.
 */

export type OptimusClipId =
  | 'idle'
  | 'run'
  | 'jump'
  | 'fall'
  | 'thrust'
  | 'dash'
  | 'hurt'
  | 'dead'
  | 'victory';

/** Base enemy idle loops plus telegraph / sealed-core state clips. */
export type EnemyClipId =
  | 'walker'
  | 'drone'
  | 'turret'
  | 'turretTelegraph'
  | 'crusher'
  | 'crusherTelegraph'
  | 'overseer'
  | 'overseerSealed';

export type ClipId = `optimus:${OptimusClipId}` | `enemy:${EnemyClipId}`;

export interface ClipDesc {
  readonly id: ClipId;
  readonly frameCount: number;
  /** Playback rate in frames per second — high for Dead Cells–smooth motion. */
  readonly fps: number;
  readonly loop: boolean;
}

export interface AtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CharacterAtlas {
  readonly width: number;
  readonly height: number;
  /** RGBA8 albedo (+ soft alpha silhouette). */
  readonly albedo: Uint8Array;
  /** RGBA8 emissive RGB (A unused); bloom source for visor/core/eyes. */
  readonly emissive: Uint8Array;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** World-space draw size for one cell (maps atlas cell → gameplay units). */
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** Feet origin inside the cell, in cell pixels (from top-left). */
  readonly feetX: number;
  readonly feetY: number;
  readonly clips: ReadonlyMap<ClipId, ClipDesc>;
  /** Packed as `${clipId}#${frame}` → rect. */
  readonly rects: ReadonlyMap<string, AtlasRect>;
  /** World-space draw size used when the clip was baked (scale at runtime for enemy bodies). */
  readonly drawSizes: ReadonlyMap<ClipId, { readonly width: number; readonly height: number }>;
}

export function frameKey(clipId: ClipId, frame: number): string {
  return `${clipId}#${String(frame)}`;
}
