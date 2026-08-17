/**
 * Bake skeletal rigs into procedural hand-drawn-style sprite atlases.
 *
 * Frame counts and FPS are deliberately high for Dead Cells–smooth motion (run ~20 @ 20fps,
 * thrust/dash ~24–30fps). All pixels are generated from `buildOptimusRig` / `buildEnemyRig` —
 * no binary art.
 */

import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../game/constants';
import type { EnemyKind } from '../../game/enemies';
import type { PlayerState } from '../../game/player';
import { parseColor } from '../color';
import { buildEnemyRig } from '../rig/enemyRigs';
import { buildOptimusRig } from '../rig/optimusRig';
import type { RigParts } from '../rig/types';
import { outlineMask, softEdgeAlpha } from './style';
import type { AtlasRect, CharacterAtlas, ClipDesc, ClipId, EnemyClipId, OptimusClipId } from './types';
import { frameKey } from './types';

/** Cell pixel size — high enough for Tesla polymer detail at Enhanced supersampling. */
export const CELL_WIDTH = 144;
export const CELL_HEIGHT = 288;
/** Padding around each cell so linear filtering never bleeds into a neighbour frame. */
const CELL_PAD = 2;
/**
 * World-space draw size for Optimus (~1.8× the 10×22 collision box). Visual only — hitbox
 * stays `PLAYER_WIDTH`×`PLAYER_HEIGHT`.
 */
export const WORLD_DRAW_WIDTH = 24;
export const WORLD_DRAW_HEIGHT = 48;
/** Extra world padding around an enemy AABB when baking/drawing its sheet cell. */
export const ENEMY_DRAW_PAD = 1.3;

/**
 * Dead Cells–smooth clip table. Dense frame counts + high FPS so short actions stay fluid
 * (comparable to DC's painted run cycles and snappy combat poses).
 */
export const OPTIMUS_CLIPS: readonly ClipDesc[] = [
  { id: 'optimus:idle', frameCount: 16, fps: 14, loop: true },
  { id: 'optimus:run', frameCount: 20, fps: 20, loop: true },
  { id: 'optimus:jump', frameCount: 10, fps: 18, loop: false },
  { id: 'optimus:fall', frameCount: 10, fps: 16, loop: false },
  { id: 'optimus:thrust', frameCount: 16, fps: 24, loop: true },
  { id: 'optimus:dash', frameCount: 10, fps: 30, loop: false },
  { id: 'optimus:hurt', frameCount: 8, fps: 20, loop: false },
  { id: 'optimus:dead', frameCount: 14, fps: 14, loop: false },
  { id: 'optimus:victory', frameCount: 12, fps: 14, loop: true },
];

export const ENEMY_CLIPS: readonly ClipDesc[] = [
  { id: 'enemy:walker', frameCount: 14, fps: 16, loop: true },
  { id: 'enemy:drone', frameCount: 14, fps: 18, loop: true },
  { id: 'enemy:turret', frameCount: 12, fps: 14, loop: true },
  { id: 'enemy:crusher', frameCount: 12, fps: 14, loop: true },
  { id: 'enemy:overseer', frameCount: 14, fps: 14, loop: true },
];

const INK: readonly [number, number, number] = [28, 32, 40];

export function enemyCanonicalSize(kind: EnemyKind): { width: number; height: number } {
  switch (kind) {
    case 'overseer':
      return { width: 40, height: 28 };
    case 'crusher':
      return { width: 24, height: 20 };
    case 'walker':
    case 'drone':
    case 'turret':
      return { width: 16, height: 14 };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled enemy kind in enemyCanonicalSize: ${String(exhaustive)}`);
    }
  }
}

function clipOptimusState(id: ClipId): PlayerState {
  const name = id.slice('optimus:'.length) as OptimusClipId;
  return name;
}

function clipEnemyKind(id: ClipId): EnemyKind {
  return id.slice('enemy:'.length) as EnemyClipId;
}

function atlasSize(frameCount: number): {
  width: number;
  height: number;
  columns: number;
  cellStrideW: number;
  cellStrideH: number;
} {
  const cellStrideW = CELL_WIDTH + CELL_PAD * 2;
  const cellStrideH = CELL_HEIGHT + CELL_PAD * 2;
  const columns = Math.max(1, Math.ceil(Math.sqrt(frameCount)));
  const rows = Math.ceil(frameCount / columns);
  return {
    width: columns * cellStrideW,
    height: rows * cellStrideH,
    columns,
    cellStrideW,
    cellStrideH,
  };
}

/** Map a world-space rig point into cell pixels (feet at bottom-centre). */
function worldToCell(
  wx: number,
  wy: number,
  feetWorldX: number,
  feetWorldY: number,
  worldW: number,
  worldH: number,
): { x: number; y: number } {
  const scaleX = CELL_WIDTH / worldW;
  const scaleY = CELL_HEIGHT / worldH;
  const localX = (wx - feetWorldX) * scaleX + CELL_WIDTH / 2;
  const localY = (wy - (feetWorldY - worldH)) * scaleY;
  return { x: localX, y: localY };
}

function fillRectAlpha(
  hard: Uint8Array,
  rgb: Uint8Array,
  emissive: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: readonly [number, number, number],
  alpha: number,
  emit: number,
): void {
  const xStart = Math.max(0, Math.floor(x0));
  const yStart = Math.max(0, Math.floor(y0));
  const xEnd = Math.min(width, Math.ceil(x0 + w));
  const yEnd = Math.min(height, Math.ceil(y0 + h));
  const aByte = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const i = y * width + x;
      hard[i] = Math.max(hard[i] ?? 0, aByte);
      const o = i * 4;
      rgb[o] = color[0];
      rgb[o + 1] = color[1];
      rgb[o + 2] = color[2];
      if (emit > 0) {
        emissive[o] = Math.min(255, Math.round(color[0] * emit));
        emissive[o + 1] = Math.min(255, Math.round(color[1] * emit));
        emissive[o + 2] = Math.min(255, Math.round(color[2] * emit));
      }
    }
  }
}

/** Soft elliptical coverage — Tesla limbs/panels read as rounded polymer, not bricks. */
function fillEllipseAlpha(
  hard: Uint8Array,
  rgb: Uint8Array,
  emissive: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: readonly [number, number, number],
  alpha: number,
  emit: number,
): void {
  if (w <= 0 || h <= 0) return;
  const cx = x0 + w * 0.5;
  const cy = y0 + h * 0.5;
  const rx = Math.max(0.5, w * 0.5);
  const ry = Math.max(0.5, h * 0.5);
  const invRx2 = 1 / (rx * rx);
  const invRy2 = 1 / (ry * ry);
  const xStart = Math.max(0, Math.floor(x0));
  const yStart = Math.max(0, Math.floor(y0));
  const xEnd = Math.min(width, Math.ceil(x0 + w));
  const yEnd = Math.min(height, Math.ceil(y0 + h));
  const aByte = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  for (let y = yStart; y < yEnd; y += 1) {
    const dy = y + 0.5 - cy;
    for (let x = xStart; x < xEnd; x += 1) {
      const dx = x + 0.5 - cx;
      if (dx * dx * invRx2 + dy * dy * invRy2 > 1) continue;
      const i = y * width + x;
      hard[i] = Math.max(hard[i] ?? 0, aByte);
      const o = i * 4;
      rgb[o] = color[0];
      rgb[o + 1] = color[1];
      rgb[o + 2] = color[2];
      if (emit > 0) {
        emissive[o] = Math.min(255, Math.round(color[0] * emit));
        emissive[o + 1] = Math.min(255, Math.round(color[1] * emit));
        emissive[o + 2] = Math.min(255, Math.round(color[2] * emit));
      }
    }
  }
}

function rasterizeParts(
  parts: RigParts,
  feetWorldX: number,
  feetWorldY: number,
  worldW: number,
  worldH: number,
): { albedo: Uint8Array; emissive: Uint8Array } {
  const hard = new Uint8Array(CELL_WIDTH * CELL_HEIGHT);
  const rgb = new Uint8Array(CELL_WIDTH * CELL_HEIGHT * 4);
  const emissive = new Uint8Array(CELL_WIDTH * CELL_HEIGHT * 4);

  for (const part of parts) {
    const alpha = part.alpha ?? 1;
    if (alpha <= 0 || part.width <= 0 || part.height <= 0) continue;
    const [r, g, b] = parseColor(part.color);
    const color: [number, number, number] = [
      Math.round(r * 255),
      Math.round(g * 255),
      Math.round(b * 255),
    ];
    const tl = worldToCell(part.x, part.y, feetWorldX, feetWorldY, worldW, worldH);
    const br = worldToCell(part.x + part.width, part.y + part.height, feetWorldX, feetWorldY, worldW, worldH);
    const x0 = Math.min(tl.x, br.x);
    const y0 = Math.min(tl.y, br.y);
    const w = Math.abs(br.x - tl.x);
    const h = Math.abs(br.y - tl.y);
    const fill = part.shape === 'ellipse' ? fillEllipseAlpha : fillRectAlpha;
    fill(hard, rgb, emissive, CELL_WIDTH, CELL_HEIGHT, x0, y0, w, h, color, alpha, part.emissive ?? 0);
  }

  // Softer fringe + lighter ink — polymer silhouette, not comic-ink armour.
  const soft = softEdgeAlpha(hard, CELL_WIDTH, CELL_HEIGHT, 2.25);
  const outline = outlineMask(hard, CELL_WIDTH, CELL_HEIGHT, 1);
  const albedo = new Uint8Array(CELL_WIDTH * CELL_HEIGHT * 4);

  for (let i = 0; i < CELL_WIDTH * CELL_HEIGHT; i += 1) {
    const o = i * 4;
    const a = soft[i] ?? 0;
    if ((outline[i] ?? 0) > 0 && (hard[i] ?? 0) === 0) {
      albedo[o] = INK[0];
      albedo[o + 1] = INK[1];
      albedo[o + 2] = INK[2];
      albedo[o + 3] = Math.min(255, Math.round(a * 0.55));
    } else {
      albedo[o] = rgb[o] ?? 0;
      albedo[o + 1] = rgb[o + 1] ?? 0;
      albedo[o + 2] = rgb[o + 2] ?? 0;
      albedo[o + 3] = a;
    }
    emissive[o + 3] = a;
  }

  return { albedo, emissive };
}

function blitCell(
  destAlbedo: Uint8Array,
  destEmissive: Uint8Array,
  destWidth: number,
  cellAlbedo: Uint8Array,
  cellEmissive: Uint8Array,
  destX: number,
  destY: number,
): void {
  for (let y = 0; y < CELL_HEIGHT; y += 1) {
    for (let x = 0; x < CELL_WIDTH; x += 1) {
      const si = (y * CELL_WIDTH + x) * 4;
      const di = ((destY + y) * destWidth + (destX + x)) * 4;
      destAlbedo[di] = cellAlbedo[si] ?? 0;
      destAlbedo[di + 1] = cellAlbedo[si + 1] ?? 0;
      destAlbedo[di + 2] = cellAlbedo[si + 2] ?? 0;
      destAlbedo[di + 3] = cellAlbedo[si + 3] ?? 0;
      destEmissive[di] = cellEmissive[si] ?? 0;
      destEmissive[di + 1] = cellEmissive[si + 1] ?? 0;
      destEmissive[di + 2] = cellEmissive[si + 2] ?? 0;
      destEmissive[di + 3] = cellEmissive[si + 3] ?? 0;
    }
  }
}

function bakeOptimusFrame(state: PlayerState, frame: number, fps: number): {
  albedo: Uint8Array;
  emissive: Uint8Array;
} {
  const animTime = frame / fps;
  const parts = buildOptimusRig({
    x: 0,
    y: 0,
    facing: 1,
    state,
    animTime,
    speedRatio: state === 'run' ? 1 : 0.35,
    energyRatio: 0.85,
  });
  const feetWorldX = PLAYER_WIDTH / 2;
  const feetWorldY = PLAYER_HEIGHT;
  return rasterizeParts(parts, feetWorldX, feetWorldY, WORLD_DRAW_WIDTH, WORLD_DRAW_HEIGHT);
}

function bakeEnemyFrame(kind: EnemyKind, frame: number, fps: number): {
  albedo: Uint8Array;
  emissive: Uint8Array;
  worldW: number;
  worldH: number;
} {
  const animTime = frame / fps;
  const { width, height } = enemyCanonicalSize(kind);
  const worldW = width * ENEMY_DRAW_PAD;
  const worldH = height * ENEMY_DRAW_PAD;
  const parts = buildEnemyRig({
    kind,
    x: 0,
    y: 0,
    width,
    height,
    facing: 1,
    animTime,
    telegraph: false,
    vulnerable: kind === 'overseer',
    hitPoints: 3,
  });
  const feetWorldX = width / 2;
  const feetWorldY = height;
  const baked = rasterizeParts(parts, feetWorldX, feetWorldY, worldW, worldH);
  return { ...baked, worldW, worldH };
}

/** Build the full Optimus + enemy character atlas (deterministic, pure). */
export function buildCharacterAtlas(): CharacterAtlas {
  const clips = new Map<ClipId, ClipDesc>();
  for (const clip of OPTIMUS_CLIPS) clips.set(clip.id, clip);
  for (const clip of ENEMY_CLIPS) clips.set(clip.id, clip);

  let totalFrames = 0;
  for (const clip of clips.values()) totalFrames += clip.frameCount;

  const { width, height, columns, cellStrideW, cellStrideH } = atlasSize(totalFrames);
  const albedo = new Uint8Array(width * height * 4);
  const emissive = new Uint8Array(width * height * 4);
  const rects = new Map<string, AtlasRect>();
  const drawSizes = new Map<ClipId, { width: number; height: number }>();

  let index = 0;
  for (const clip of clips.values()) {
    for (let frame = 0; frame < clip.frameCount; frame += 1) {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const destX = col * cellStrideW + CELL_PAD;
      const destY = row * cellStrideH + CELL_PAD;

      if (clip.id.startsWith('optimus:')) {
        const baked = bakeOptimusFrame(clipOptimusState(clip.id), frame, clip.fps);
        blitCell(albedo, emissive, width, baked.albedo, baked.emissive, destX, destY);
        if (frame === 0) {
          drawSizes.set(clip.id, { width: WORLD_DRAW_WIDTH, height: WORLD_DRAW_HEIGHT });
        }
      } else {
        const baked = bakeEnemyFrame(clipEnemyKind(clip.id), frame, clip.fps);
        blitCell(albedo, emissive, width, baked.albedo, baked.emissive, destX, destY);
        if (frame === 0) {
          drawSizes.set(clip.id, { width: baked.worldW, height: baked.worldH });
        }
      }

      rects.set(frameKey(clip.id, frame), {
        x: destX,
        y: destY,
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
      });
      index += 1;
    }
  }

  return {
    width,
    height,
    albedo,
    emissive,
    cellWidth: CELL_WIDTH,
    cellHeight: CELL_HEIGHT,
    worldWidth: WORLD_DRAW_WIDTH,
    worldHeight: WORLD_DRAW_HEIGHT,
    feetX: CELL_WIDTH / 2,
    feetY: CELL_HEIGHT,
    clips,
    rects,
    drawSizes,
  };
}

/** Simple FNV-ish hash for determinism tests. */
export function hashCharacterAtlas(atlas: CharacterAtlas): string {
  let hash = 2166136261;
  for (let i = 0; i < atlas.albedo.length; i += 97) {
    hash ^= atlas.albedo[i] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  for (let i = 0; i < atlas.emissive.length; i += 131) {
    hash ^= atlas.emissive[i] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
