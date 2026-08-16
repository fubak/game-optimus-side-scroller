import { describe, expect, it } from 'vitest';
import {
  LevelParseError,
  parseLevel,
  parseTileRows,
  spawnPositionFor,
  tileKindsUsed,
} from '../../src/game/levelParser';
import type { LevelDef } from '../../src/game/levelParser';
import { LEVEL_1 } from '../../src/game/levels/level1';
import { DEV_PLAYGROUND_LEVEL } from '../../src/game/levels/dev';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../src/game/constants';
import { TileKind } from '../../src/game/tiles';

function def(rows: readonly string[], overrides: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 'test',
    name: 'TEST',
    subtitle: 'TEST LEVEL',
    parTimeSec: 30,
    rows,
    ...overrides,
  };
}

describe('parseTileRows', () => {
  it('maps glyphs to tiles and pads ragged rows', () => {
    const { map } = parseTileRows(['#=^', '..', '<>']);
    expect(map.width).toBe(3);
    expect(map.height).toBe(3);
    expect(map.tileAt(0, 0)).toBe(TileKind.Solid);
    expect(map.tileAt(1, 0)).toBe(TileKind.OneWay);
    expect(map.tileAt(2, 0)).toBe(TileKind.Spike);
    expect(map.tileAt(2, 1)).toBe(TileKind.Empty);
    expect(map.tileAt(0, 2)).toBe(TileKind.ConveyorLeft);
    expect(map.tileAt(1, 2)).toBe(TileKind.ConveyorRight);
  });

  it('returns non-tile glyphs as markers', () => {
    const { markers } = parseTileRows(['.P.', '.w.']);
    expect(markers).toEqual([
      { glyph: 'P', tx: 1, ty: 0 },
      { glyph: 'w', tx: 1, ty: 1 },
    ]);
  });

  it('rejects empty input', () => {
    expect(() => parseTileRows([])).toThrow(LevelParseError);
    expect(() => parseTileRows(['', ''])).toThrow(/all empty/);
  });
});

describe('parseLevel', () => {
  it('parses spawn, goal, checkpoints and entity spawns', () => {
    const level = parseLevel(def(['....e...', '.P..w..G', '.....C..', '########']));
    expect(level.spawnX).toBe(spawnPositionFor(1, 1).x);
    expect(level.spawnY).toBe(spawnPositionFor(1, 1).y);
    expect(level.goals).toEqual([{ tx: 7, ty: 1 }]);
    expect(level.checkpoints).toEqual([{ tx: 5, ty: 2 }]);
    expect(level.entities.map((entity) => entity.kind)).toEqual(['energyCell', 'walker']);
    expect(level.collectableCount).toBe(1);
    // Entity spawn positions are the bottom-centre of their tile.
    const walker = level.entities.find((entity) => entity.kind === 'walker');
    expect(walker).toEqual({ kind: 'walker', tx: 4, ty: 1, x: 4 * 16 + 8, y: 2 * 16 });
  });

  it('places the player centred on the spawn tile with feet on its floor', () => {
    const position = spawnPositionFor(3, 4);
    expect(position.x).toBe(3 * 16 + (16 - PLAYER_WIDTH) / 2);
    expect(position.y).toBe(5 * 16 - PLAYER_HEIGHT);
  });

  it('requires exactly one spawn point', () => {
    expect(() => parseLevel(def(['....', '..G.', '####']))).toThrow(/no 'P' spawn point/);
    expect(() => parseLevel(def(['....', 'P.PG', '####']))).toThrow(/2 spawn points/);
  });

  it('requires a goal tile', () => {
    expect(() => parseLevel(def(['....', '.P..', '####']))).toThrow(/no 'G' goal tile/);
  });

  it('rejects unknown glyphs with a position', () => {
    try {
      parseLevel(def(['......', '.P.Z.G', '######']));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LevelParseError);
      const parseError = error as LevelParseError;
      expect(parseError.message).toMatch(/Unknown glyph 'Z'/);
      expect(parseError.row).toBe(1);
      expect(parseError.column).toBe(3);
    }
  });

  it('rejects a spawn with no head room (the body would clip the ceiling or a wall)', () => {
    expect(() => parseLevel(def(['####', '#P#G', '####']))).toThrow(/spawn point is inside a solid tile/);
    // A spawn on the very top row also fails: Optimus is taller than one tile.
    expect(() => parseLevel(def(['.P.G', '####']))).toThrow(/spawn point is inside a solid tile/);
  });

  it('rejects a checkpoint buried inside a wall', () => {
    expect(() => parseLevel(def(['.....', '.P..G', '..C..', '#####', '#####']))).not.toThrow();
    // The checkpoint below is walled in: the body would overlap the solid row above it.
    expect(() => parseLevel(def(['.....', '.P..G', '#####', '..C..', '#####']))).toThrow(
      /checkpoint is inside a solid tile/,
    );
  });

  it('defaults the decoration seed', () => {
    expect(parseLevel(def(['....', '.P.G', '####'])).seed).toBe(1);
    expect(parseLevel(def(['....', '.P.G', '####'], { seed: 77 })).seed).toBe(77);
  });
});

describe('shipped levels', () => {
  it.each([
    ['level-1', LEVEL_1],
    ['dev', DEV_PLAYGROUND_LEVEL],
  ])('%s parses and is well formed', (_id, levelDef) => {
    const level = parseLevel(levelDef);
    expect(level.map.width).toBeGreaterThan(20);
    expect(level.goals.length).toBeGreaterThan(0);
    expect(level.parTimeSec).toBeGreaterThan(0);
    // A level should be wider than one screen, or it is not a side-scroller.
    expect(level.map.pixelWidth).toBeGreaterThan(480);
    // Rows must be uniform after padding.
    expect(level.map.height).toBe(levelDef.rows.length);
  });

  it('level 1 teaches with a checkpoint, collectables and hazards', () => {
    const level = parseLevel(LEVEL_1);
    expect(level.checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(level.collectableCount).toBeGreaterThanOrEqual(4);
    const kinds = tileKindsUsed(level.map);
    expect(kinds.has(TileKind.Spike)).toBe(true);
    expect(kinds.has(TileKind.OneWay)).toBe(true);
  });
});
