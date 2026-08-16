import { describe, expect, it } from 'vitest';
import {
  ALL_TILE_KINDS,
  CONVEYOR_SPEED,
  TILE_SIZE,
  TileKind,
  conveyorSpeed,
  isHazard,
  isOneWay,
  isSolid,
  isTrigger,
  tileFlags,
  tileHitboxInset,
} from '../../src/game/tiles';
import { TileMap } from '../../src/game/tilemap';
import { mapFromAscii } from '../fixtures/maps';

describe('tile flags', () => {
  it('classifies every tile kind without throwing', () => {
    for (const kind of ALL_TILE_KINDS) {
      expect(() => tileFlags(kind)).not.toThrow();
      expect(() => tileHitboxInset(kind)).not.toThrow();
    }
  });

  it('rejects unknown tile kinds loudly', () => {
    expect(() => tileFlags(99 as TileKind)).toThrow(/Unhandled tile kind/);
    expect(() => tileHitboxInset(99 as TileKind)).toThrow(/Unhandled tile kind/);
  });

  it('has the expected collision semantics', () => {
    expect(isSolid(TileKind.Solid)).toBe(true);
    expect(isSolid(TileKind.OneWay)).toBe(false);
    expect(isOneWay(TileKind.OneWay)).toBe(true);
    expect(isHazard(TileKind.Spike)).toBe(true);
    expect(isSolid(TileKind.Spike)).toBe(false);
    expect(isSolid(TileKind.ConveyorLeft)).toBe(true);
    expect(isSolid(TileKind.Scenery)).toBe(false);
    expect(isTrigger(TileKind.Goal)).toBe(true);
    expect(isTrigger(TileKind.Checkpoint)).toBe(true);
    expect(conveyorSpeed(TileKind.ConveyorLeft)).toBe(-CONVEYOR_SPEED);
    expect(conveyorSpeed(TileKind.ConveyorRight)).toBe(CONVEYOR_SPEED);
    expect(conveyorSpeed(TileKind.Solid)).toBe(0);
  });

  it('gives spikes a forgiving hitbox', () => {
    const inset = tileHitboxInset(TileKind.Spike);
    expect(inset.top).toBeGreaterThan(0);
    expect(inset.side).toBeGreaterThan(0);
    expect(tileHitboxInset(TileKind.Solid)).toEqual({ top: 0, side: 0 });
  });
});

describe('TileMap', () => {
  it('reads and writes cells', () => {
    const map = new TileMap(4, 3);
    expect(map.tileAt(1, 1)).toBe(TileKind.Empty);
    map.set(1, 1, TileKind.Solid);
    expect(map.tileAt(1, 1)).toBe(TileKind.Solid);
    expect(map.pixelWidth).toBe(4 * TILE_SIZE);
    expect(map.pixelHeight).toBe(3 * TILE_SIZE);
  });

  it('validates its construction arguments', () => {
    expect(() => new TileMap(0, 5)).toThrow(/positive size/);
    expect(() => new TileMap(2, 2, new Uint8Array(3))).toThrow(/does not match/);
  });

  it('is a closed box: solid sides and ceiling, open bottom', () => {
    const map = mapFromAscii(['....', '####']);
    expect(map.tileAt(-1, 0)).toBe(TileKind.Solid);
    expect(map.tileAt(4, 0)).toBe(TileKind.Solid);
    // The ceiling is solid: with open sky, the side-wall column reads as solid at every row, which
    // is an infinite ledge a jetpack can run along out of the level. (Found by the level bot.)
    expect(map.tileAt(0, -1)).toBe(TileKind.Solid);
    expect(map.tileAt(-1, -1)).toBe(TileKind.Solid);
    // Below the level is empty: falling off the bottom is a pit death, not a collision.
    expect(map.tileAt(0, 99)).toBe(TileKind.Empty);
  });

  it('converts between world and tile coordinates', () => {
    const map = mapFromAscii(['....', '####']);
    expect(map.worldToTileX(31.9)).toBe(1);
    expect(map.worldToTileY(16)).toBe(1);
    expect(map.tileAtPixel(0, 16)).toBe(TileKind.Solid);
    expect(map.tileRect(2, 1)).toEqual({ x: 32, y: 16, width: 16, height: 16 });
  });

  it('produces inset hitboxes for spikes', () => {
    const map = mapFromAscii(['^']);
    const box = map.tileHitbox(0, 0);
    expect(box).toEqual({ x: 3, y: 6, width: 10, height: 10 });
  });

  it('computes inclusive tile ranges without bleeding into the next cell', () => {
    const map = new TileMap(8, 8);
    expect(map.tileRangeFor({ x: 0, y: 0, width: 16, height: 16 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
    });
    expect(map.tileRangeFor({ x: 8, y: 8, width: 16, height: 16 })).toEqual({
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
    });
  });

  it('detects solid overlap and iterates non-empty tiles', () => {
    const map = mapFromAscii(['.#.', '^:G']);
    expect(map.overlapsSolid({ x: 16, y: 0, width: 4, height: 4 })).toBe(true);
    expect(map.overlapsSolid({ x: 0, y: 0, width: 4, height: 4 })).toBe(false);

    const visited: string[] = [];
    map.forEachTileIn({ x: 0, y: 0, width: 48, height: 32 }, (kind, tx, ty) => {
      visited.push(`${String(kind)}@${String(tx)},${String(ty)}`);
    });
    expect(visited).toEqual([
      `${String(TileKind.Solid)}@1,0`,
      `${String(TileKind.Spike)}@0,1`,
      `${String(TileKind.Scenery)}@1,1`,
      `${String(TileKind.Goal)}@2,1`,
    ]);
  });

  it('builds from tile kind rows and exports bytes', () => {
    const map = TileMap.fromKinds([[TileKind.Empty, TileKind.Solid], [TileKind.Solid]]);
    expect(map.width).toBe(2);
    expect(map.height).toBe(2);
    expect(map.tileAt(1, 0)).toBe(TileKind.Solid);
    expect(map.tileAt(1, 1)).toBe(TileKind.Empty);
    expect([...map.toBytes()]).toEqual([0, 1, 1, 0]);
  });

  it('ignores writes outside the grid', () => {
    const map = new TileMap(2, 2);
    map.set(-1, 0, TileKind.Solid);
    map.set(0, 9, TileKind.Solid);
    expect([...map.toBytes()]).toEqual([0, 0, 0, 0]);
  });
});
