import { TileMap } from './tilemap';
import { TileKind } from './tiles';

/**
 * ASCII level format.
 *
 * Levels are authored as arrays of strings in TypeScript source — readable in a diff, trivially
 * editable, and validated on load. This module owns the glyph vocabulary and turns rows of text
 * into a {@link TileMap}. Entity spawns are layered on top of the same grid in a later phase.
 */

export const TILE_GLYPHS: Readonly<Record<string, TileKind>> = {
  ' ': TileKind.Empty,
  '.': TileKind.Empty,
  '#': TileKind.Solid,
  '=': TileKind.OneWay,
  '^': TileKind.Spike,
  '<': TileKind.ConveyorLeft,
  '>': TileKind.ConveyorRight,
  C: TileKind.Checkpoint,
  G: TileKind.Goal,
  ':': TileKind.Scenery,
};

export class LevelParseError extends Error {
  readonly row: number;
  readonly column: number;

  constructor(message: string, row: number, column: number) {
    super(`${message} (row ${String(row)}, column ${String(column)})`);
    this.name = 'LevelParseError';
    this.row = row;
    this.column = column;
  }
}

export interface TileParseResult {
  readonly map: TileMap;
  /** Glyphs that are not tiles (entity spawns), with their tile coordinates. */
  readonly markers: readonly { readonly glyph: string; readonly tx: number; readonly ty: number }[];
}

/**
 * Convert ASCII rows into a tile map.
 *
 * Unknown glyphs are *not* an error here: they are returned as markers so the level loader can map
 * them to entity spawns. Rows may be ragged; short rows are padded with empty space.
 */
export function parseTileRows(rows: readonly string[]): TileParseResult {
  if (rows.length === 0) {
    throw new LevelParseError('Level has no rows', 0, 0);
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) {
    throw new LevelParseError('Level rows are all empty', 0, 0);
  }
  const map = new TileMap(width, rows.length);
  const markers: { glyph: string; tx: number; ty: number }[] = [];

  rows.forEach((row, ty) => {
    for (let tx = 0; tx < row.length; tx += 1) {
      const glyph = row[tx] ?? ' ';
      const kind = TILE_GLYPHS[glyph];
      if (kind === undefined) {
        markers.push({ glyph, tx, ty });
        continue;
      }
      map.set(tx, ty, kind);
    }
  });

  return { map, markers };
}
