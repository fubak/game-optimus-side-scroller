import { aabbOverlap } from '../core/math';
import type { Rect } from '../core/math';
import type { TileMap } from './tilemap';
import { tileFlags } from './tiles';
import type { TileKind } from './tiles';

/**
 * Axis-separated, sub-stepped AABB vs tilemap collision.
 *
 * Design rules that keep platforming feeling correct:
 * - **Axis separation** (resolve X fully, then Y) so sliding along a wall or a floor never wedges.
 * - **Sub-stepping** capped at half a tile per iteration, so nothing tunnels regardless of speed.
 * - **One-way platforms** only stop a body that was above the platform surface *before* the step,
 *   which lets Optimus jump up through them and drop through on demand.
 * - The function mutates the body (positions/velocities) and writes into a reusable result object,
 *   so a busy frame allocates nothing.
 */

export interface Body extends Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
}

export interface TileOverlap {
  kind: TileKind;
  tx: number;
  ty: number;
}

export interface CollisionResult {
  onGround: boolean;
  onCeiling: boolean;
  hitWallLeft: boolean;
  hitWallRight: boolean;
  /** Tile the body is standing on, if any (used for conveyors). */
  groundKind: TileKind | null;
  /** Non-solid tiles (hazards, triggers) whose hitbox the body overlaps after the move. */
  overlaps: TileOverlap[];
  movedX: number;
  movedY: number;
}

export interface MoveOptions {
  /** Pass through one-way platforms for this step (holding "down"). */
  readonly dropThroughOneWay?: boolean;
  /** Whether one-way platforms are collidable at all for this body. */
  readonly useOneWay?: boolean;
}

/** Inset used when sampling tile columns/rows so a body flush against a tile does not sample it. */
const EDGE_EPSILON = 1e-4;

/** How far below a platform top the previous bottom edge may sit and still count as "landing". */
const ONE_WAY_TOLERANCE = 1;

export function createBody(x: number, y: number, width: number, height: number): Body {
  return { x, y, width, height, vx: 0, vy: 0 };
}

export function createCollisionResult(): CollisionResult {
  return {
    onGround: false,
    onCeiling: false,
    hitWallLeft: false,
    hitWallRight: false,
    groundKind: null,
    overlaps: [],
    movedX: 0,
    movedY: 0,
  };
}

export function resetCollisionResult(result: CollisionResult): void {
  result.onGround = false;
  result.onCeiling = false;
  result.hitWallLeft = false;
  result.hitWallRight = false;
  result.groundKind = null;
  result.overlaps.length = 0;
  result.movedX = 0;
  result.movedY = 0;
}

export function moveAndCollide(
  body: Body,
  dtSec: number,
  map: TileMap,
  result: CollisionResult = createCollisionResult(),
  options: MoveOptions = {},
): CollisionResult {
  resetCollisionResult(result);

  const startX = body.x;
  const startY = body.y;
  const deltaX = body.vx * dtSec;
  const deltaY = body.vy * dtSec;

  const maxStep = map.tileSize * 0.5;
  const longest = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  const subSteps = Math.max(1, Math.ceil(longest / maxStep));
  const stepX = deltaX / subSteps;
  const stepY = deltaY / subSteps;

  for (let i = 0; i < subSteps; i += 1) {
    if (stepX !== 0 && !result.hitWallLeft && !result.hitWallRight) {
      body.x += stepX;
      resolveHorizontal(body, map, stepX > 0 ? 1 : -1, result);
    }
    if (stepY !== 0 && !result.onGround && !result.onCeiling) {
      const previousBottom = body.y + body.height;
      body.y += stepY;
      resolveVertical(body, map, stepY, previousBottom, result, options);
    }
  }

  // Standing still on a conveyor/moving platform still needs a ground kind, so probe downwards
  // whenever the vertical pass did not report a contact.
  if (!result.onGround) {
    const kind = groundKindBelow(body, map);
    if (kind !== null) {
      result.onGround = true;
      result.groundKind = kind;
    }
  }

  collectOverlaps(body, map, result.overlaps);
  result.movedX = body.x - startX;
  result.movedY = body.y - startY;
  return result;
}

function resolveHorizontal(body: Body, map: TileMap, direction: 1 | -1, result: CollisionResult): void {
  const tileSize = map.tileSize;
  const minTy = Math.floor((body.y + EDGE_EPSILON) / tileSize);
  const maxTy = Math.floor((body.y + body.height - EDGE_EPSILON) / tileSize);

  if (direction > 0) {
    const tx = Math.floor((body.x + body.width - EDGE_EPSILON) / tileSize);
    for (let ty = minTy; ty <= maxTy; ty += 1) {
      if (!tileFlags(map.tileAt(tx, ty)).solid) continue;
      body.x = tx * tileSize - body.width;
      body.vx = 0;
      result.hitWallRight = true;
      return;
    }
    return;
  }

  const tx = Math.floor((body.x + EDGE_EPSILON) / tileSize);
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    if (!tileFlags(map.tileAt(tx, ty)).solid) continue;
    body.x = (tx + 1) * tileSize;
    body.vx = 0;
    result.hitWallLeft = true;
    return;
  }
}

function resolveVertical(
  body: Body,
  map: TileMap,
  stepY: number,
  previousBottom: number,
  result: CollisionResult,
  options: MoveOptions,
): void {
  const tileSize = map.tileSize;
  const minTx = Math.floor((body.x + EDGE_EPSILON) / tileSize);
  const maxTx = Math.floor((body.x + body.width - EDGE_EPSILON) / tileSize);

  if (stepY > 0) {
    const useOneWay = options.useOneWay ?? true;
    const dropThrough = options.dropThroughOneWay ?? false;
    const ty = Math.floor((body.y + body.height - EDGE_EPSILON) / tileSize);
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      const kind = map.tileAt(tx, ty);
      const flags = tileFlags(kind);
      const platformTop = ty * tileSize;
      const landsOnOneWay =
        flags.oneWay && useOneWay && !dropThrough && previousBottom <= platformTop + ONE_WAY_TOLERANCE;
      if (!flags.solid && !landsOnOneWay) continue;
      body.y = platformTop - body.height;
      body.vy = 0;
      result.onGround = true;
      result.groundKind = kind;
      return;
    }
    return;
  }

  const ty = Math.floor((body.y + EDGE_EPSILON) / tileSize);
  for (let tx = minTx; tx <= maxTx; tx += 1) {
    if (!tileFlags(map.tileAt(tx, ty)).solid) continue;
    body.y = (ty + 1) * tileSize;
    body.vy = 0;
    result.onCeiling = true;
    return;
  }
}

/** Tile kind directly beneath the body's feet, or `null` when airborne. */
export function groundKindBelow(body: Body, map: TileMap, probe = 1): TileKind | null {
  const tileSize = map.tileSize;
  const ty = Math.floor((body.y + body.height + probe * 0.5) / tileSize);
  const bottom = body.y + body.height;
  // Only counts when the body is (nearly) flush with the tile top, not deep inside it.
  const minTx = Math.floor((body.x + EDGE_EPSILON) / tileSize);
  const maxTx = Math.floor((body.x + body.width - EDGE_EPSILON) / tileSize);
  for (let tx = minTx; tx <= maxTx; tx += 1) {
    const kind = map.tileAt(tx, ty);
    const flags = tileFlags(kind);
    if (!flags.solid && !flags.oneWay) continue;
    const top = ty * tileSize;
    if (bottom <= top + probe && bottom >= top - probe) return kind;
  }
  return null;
}

export function isGrounded(body: Body, map: TileMap, probe = 1): boolean {
  return groundKindBelow(body, map, probe) !== null;
}

/** Collect non-solid tiles (hazards, triggers) whose inset hitbox the body overlaps. */
export function collectOverlaps(body: Body, map: TileMap, out: TileOverlap[]): TileOverlap[] {
  map.forEachTileIn(body, (kind, tx, ty) => {
    const flags = tileFlags(kind);
    if (!flags.hazard && !flags.trigger) return;
    if (!aabbOverlap(body, map.tileHitbox(tx, ty, kind))) return;
    out.push({ kind, tx, ty });
  });
  return out;
}

/** Does the body currently touch a hazard tile? */
export function overlapsHazard(body: Body, map: TileMap): boolean {
  let touching = false;
  map.forEachTileIn(body, (kind, tx, ty) => {
    if (touching || !tileFlags(kind).hazard) return;
    if (aabbOverlap(body, map.tileHitbox(tx, ty, kind))) touching = true;
  });
  return touching;
}
