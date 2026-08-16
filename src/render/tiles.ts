import type { TileMap } from '../game/tilemap';
import { TILE_SIZE, TileKind } from '../game/tiles';
import { palette } from './palette';

/**
 * Tile painting.
 *
 * Tiles are drawn from their neighbours: a cell only gets a bright top edge when nothing sits above
 * it, side bevels when it is at the edge of a mass, and deterministic rivets/wear derived from a
 * hash of its coordinates — so the factory looks hand-detailed without any authored texture data.
 */

/** Cheap deterministic hash → the same tile always gets the same rivets. */
function tileHash(tx: number, ty: number): number {
  let hash = (tx * 73856093) ^ (ty * 19349663);
  hash = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995);
  return (hash ^ (hash >>> 15)) >>> 0;
}

export interface TileDrawContext {
  readonly ctx: CanvasRenderingContext2D;
  readonly map: TileMap;
  readonly cameraX: number;
  readonly cameraY: number;
  /** Seconds since level start, for animated tiles (conveyors, goal, checkpoints). */
  readonly timeSec: number;
  readonly checkpointActive: (tx: number, ty: number) => boolean;
}

export function drawTiles(context: TileDrawContext, viewWidth: number, viewHeight: number): void {
  const { map, cameraX, cameraY } = context;
  const minTx = Math.max(0, Math.floor(cameraX / TILE_SIZE));
  const maxTx = Math.min(map.width - 1, Math.floor((cameraX + viewWidth) / TILE_SIZE));
  const minTy = Math.max(0, Math.floor(cameraY / TILE_SIZE));
  const maxTy = Math.min(map.height - 1, Math.floor((cameraY + viewHeight) / TILE_SIZE));

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      const kind = map.tileAt(tx, ty);
      if (kind === TileKind.Empty) continue;
      const x = tx * TILE_SIZE - cameraX;
      const y = ty * TILE_SIZE - cameraY;
      drawTile(context, kind, tx, ty, x, y);
    }
  }
}

function drawTile(
  context: TileDrawContext,
  kind: TileKind,
  tx: number,
  ty: number,
  x: number,
  y: number,
): void {
  switch (kind) {
    case TileKind.Solid:
      drawPlate(context, tx, ty, x, y);
      break;
    case TileKind.OneWay:
      drawCatwalk(context.ctx, x, y);
      break;
    case TileKind.Spike:
      drawSpikes(context.ctx, tx, ty, x, y);
      break;
    case TileKind.ConveyorLeft:
      drawConveyor(context, x, y, -1);
      break;
    case TileKind.ConveyorRight:
      drawConveyor(context, x, y, 1);
      break;
    case TileKind.Checkpoint:
      drawCheckpoint(context, tx, ty, x, y);
      break;
    case TileKind.Goal:
      drawGoal(context, x, y);
      break;
    case TileKind.Scenery:
      drawScenery(context.ctx, tx, ty, x, y);
      break;
    case TileKind.Empty:
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled tile kind in renderer: ${String(exhaustive)}`);
    }
  }
}

function isSolidAt(map: TileMap, tx: number, ty: number): boolean {
  return map.tileAt(tx, ty) === TileKind.Solid || isConveyor(map, tx, ty);
}

function isConveyor(map: TileMap, tx: number, ty: number): boolean {
  const kind = map.tileAt(tx, ty);
  return kind === TileKind.ConveyorLeft || kind === TileKind.ConveyorRight;
}

function drawPlate(context: TileDrawContext, tx: number, ty: number, x: number, y: number): void {
  const { ctx, map } = context;
  const hash = tileHash(tx, ty);
  const openAbove = !isSolidAt(map, tx, ty - 1);
  const openBelow = !isSolidAt(map, tx, ty + 1);
  const openLeft = !isSolidAt(map, tx - 1, ty);
  const openRight = !isSolidAt(map, tx + 1, ty);

  // Buried tiles are much darker than the surface: a solid mass should read as depth, not as a slab.
  ctx.fillStyle = openAbove ? palette.plateFace : palette.plateDark;
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  if (!openAbove && !openLeft && !openRight) {
    ctx.fillStyle = palette.plateShadow;
    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  }

  // Surface highlight and grime.
  if (openAbove) {
    ctx.fillStyle = palette.plateLight;
    ctx.fillRect(x, y, TILE_SIZE, 2);
    ctx.fillStyle = palette.plateFace;
    ctx.fillRect(x, y + 2, TILE_SIZE, 1);
    if ((hash & 3) === 0) {
      ctx.fillStyle = palette.rust;
      ctx.fillRect(x + (hash % 10), y + 2, 3, 1);
    }
  }
  if (openBelow) {
    ctx.fillStyle = palette.plateShadow;
    ctx.fillRect(x, y + TILE_SIZE - 2, TILE_SIZE, 2);
  }
  if (openLeft) {
    ctx.fillStyle = palette.plateShadow;
    ctx.fillRect(x, y, 1, TILE_SIZE);
  }
  if (openRight) {
    ctx.fillStyle = palette.plateShadow;
    ctx.fillRect(x + TILE_SIZE - 1, y, 1, TILE_SIZE);
  }

  // Panel seam plus rivets, so large masses do not read as flat colour.
  ctx.fillStyle = openAbove ? palette.plateDark : palette.plateShadow;
  ctx.fillRect(x + 1, y + 8, TILE_SIZE - 2, 1);
  if ((hash & 3) === 0) {
    ctx.fillStyle = openAbove ? palette.plateLight : palette.plateDark;
    ctx.fillRect(x + 3, y + 11, 1, 1);
    ctx.fillRect(x + TILE_SIZE - 4, y + 11, 1, 1);
  }
  if ((hash & 7) === 3) {
    ctx.fillStyle = palette.grate;
    ctx.fillRect(x + 4, y + 4, TILE_SIZE - 8, 3);
  }
}

function drawCatwalk(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  // Thin grated platform: visibly something you can jump up through.
  ctx.fillStyle = palette.plateLight;
  ctx.fillRect(x, y, TILE_SIZE, 2);
  ctx.fillStyle = palette.grate;
  ctx.fillRect(x, y + 2, TILE_SIZE, 2);
  ctx.fillStyle = palette.plateShadow;
  for (let i = 1; i < TILE_SIZE; i += 4) {
    ctx.fillRect(x + i, y + 4, 1, 2);
  }
}

function drawSpikes(ctx: CanvasRenderingContext2D, tx: number, ty: number, x: number, y: number): void {
  const hash = tileHash(tx, ty);
  ctx.fillStyle = palette.hazardDark;
  ctx.fillRect(x, y + 12, TILE_SIZE, 4);
  for (let i = 0; i < 4; i += 1) {
    const spikeX = x + i * 4;
    const height = 6 + ((hash >> (i * 2)) & 1) * 2;
    ctx.fillStyle = palette.hazard;
    ctx.fillRect(spikeX + 1, y + 16 - height - 4, 2, height);
    ctx.fillStyle = palette.hazardDark;
    ctx.fillRect(spikeX + 2, y + 16 - height - 4, 1, height);
  }
  ctx.fillStyle = palette.plateShadow;
  ctx.fillRect(x, y + TILE_SIZE - 1, TILE_SIZE, 1);
}

function drawConveyor(context: TileDrawContext, x: number, y: number, direction: 1 | -1): void {
  const { ctx, timeSec } = context;
  ctx.fillStyle = palette.plateDark;
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
  ctx.fillStyle = palette.grate;
  ctx.fillRect(x, y, TILE_SIZE, 4);

  // Belt cleats scrolling in the belt direction.
  const shift = Math.floor(timeSec * 60 * direction) % 8;
  ctx.fillStyle = palette.rust;
  for (let i = -8; i < TILE_SIZE + 8; i += 8) {
    const cleatX = x + ((((i + shift) % 8) + 8) % 8) + Math.floor(i / 8) * 8;
    if (cleatX < x - 4 || cleatX > x + TILE_SIZE) continue;
    ctx.fillRect(Math.max(x, cleatX), y + 1, Math.min(3, x + TILE_SIZE - cleatX), 2);
  }
  ctx.fillStyle = palette.plateShadow;
  ctx.fillRect(x, y + 4, TILE_SIZE, 1);
  ctx.fillStyle = palette.plateFace;
  ctx.fillRect(x + 2, y + 7, TILE_SIZE - 4, TILE_SIZE - 9);
}

function drawCheckpoint(context: TileDrawContext, tx: number, ty: number, x: number, y: number): void {
  const { ctx, timeSec } = context;
  const active = context.checkpointActive(tx, ty);
  const pulse = 0.5 + 0.5 * Math.sin(timeSec * (active ? 6 : 2));
  // Post.
  ctx.fillStyle = palette.plateDark;
  ctx.fillRect(x + 7, y + 2, 2, TILE_SIZE - 2);
  // Lamp.
  ctx.fillStyle = active ? palette.energy : palette.uiDim;
  ctx.fillRect(x + 5, y + 2, 6, 4);
  ctx.fillStyle = active ? palette.visorGlow : palette.plateFace;
  ctx.fillRect(x + 6, y + 3, Math.max(1, Math.round(4 * pulse)), 2);
}

function drawGoal(context: TileDrawContext, x: number, y: number): void {
  const { ctx, timeSec } = context;
  // Extraction portal: a bright shaft with a rippling core.
  const wobble = Math.sin(timeSec * 4) * 1.5;
  ctx.fillStyle = palette.energyDim;
  ctx.fillRect(x + 2, y, TILE_SIZE - 4, TILE_SIZE);
  ctx.fillStyle = palette.energy;
  ctx.fillRect(x + 4, y, TILE_SIZE - 8, TILE_SIZE);
  ctx.fillStyle = palette.visorGlow;
  ctx.fillRect(x + 6 + wobble * 0.4, y + 2, 3, TILE_SIZE - 4);
  ctx.fillStyle = palette.white;
  ctx.fillRect(x + 7, y + 6 + wobble, 1, 4);
}

/**
 * Background clutter: pipe runs that never collide.
 *
 * Drawn dark and *thin*, with no cell fill, so it cannot be mistaken for a platform — an earlier
 * version filled the whole cell in mid-grey and read exactly like a floating ledge.
 */
function drawScenery(ctx: CanvasRenderingContext2D, tx: number, ty: number, x: number, y: number): void {
  const hash = tileHash(tx, ty);
  const horizontal = (hash & 1) === 0;
  ctx.fillStyle = palette.nearStructure;
  if (horizontal) {
    ctx.fillRect(x, y + 6, TILE_SIZE, 4);
    ctx.fillStyle = palette.midStructure;
    ctx.fillRect(x, y + 9, TILE_SIZE, 1);
    if ((hash & 6) === 0) {
      // Bracket every few tiles.
      ctx.fillStyle = palette.nearStructure;
      ctx.fillRect(x + 6, y + 4, 3, 8);
    }
  } else {
    ctx.fillRect(x + 6, y, 4, TILE_SIZE);
    ctx.fillStyle = palette.midStructure;
    ctx.fillRect(x + 9, y, 1, TILE_SIZE);
  }
}
