import { TileMap } from '../../src/game/tilemap';
import { TileKind } from '../../src/game/tiles';

/**
 * Tile-only ASCII maps for physics/camera tests. (Full levels, including entity spawns, go through
 * the real level parser — see `src/game/levelParser.ts`.)
 */
const LEGEND: Record<string, TileKind> = {
  '.': TileKind.Empty,
  ' ': TileKind.Empty,
  '#': TileKind.Solid,
  '=': TileKind.OneWay,
  '^': TileKind.Spike,
  '<': TileKind.ConveyorLeft,
  '>': TileKind.ConveyorRight,
  C: TileKind.Checkpoint,
  G: TileKind.Goal,
  ':': TileKind.Scenery,
};

export function mapFromAscii(rows: readonly string[]): TileMap {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const map = new TileMap(Math.max(1, width), Math.max(1, rows.length));
  rows.forEach((row, ty) => {
    for (let tx = 0; tx < row.length; tx += 1) {
      const glyph = row[tx] ?? '.';
      const kind = LEGEND[glyph];
      if (kind === undefined) {
        throw new Error(`Unknown test map glyph '${glyph}' at ${String(tx)},${String(ty)}`);
      }
      map.set(tx, ty, kind);
    }
  });
  return map;
}
