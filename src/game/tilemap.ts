import { TILE_SIZE, TileKind, tileFlags, tileHitboxInset } from './tiles';
import type { Rect } from '../core/math';

/**
 * Grid of tiles backed by a `Uint8Array`.
 *
 * Out-of-bounds policy is deliberate:
 * - above the map (`ty < 0`) is **empty**, so the player can jump past the ceiling of a level;
 * - left/right of the map is **solid**, an invisible wall that keeps bodies inside the level;
 * - below the map is **empty**, so falling off the bottom is a pit death the world can detect.
 */
export class TileMap {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  private readonly cells: Uint8Array;

  constructor(width: number, height: number, cells?: Uint8Array, tileSize: number = TILE_SIZE) {
    if (width <= 0 || height <= 0) {
      throw new Error(`TileMap needs a positive size, got ${String(width)}x${String(height)}.`);
    }
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    if (cells === undefined) {
      this.cells = new Uint8Array(width * height);
    } else {
      if (cells.length !== width * height) {
        throw new Error(
          `TileMap cell count ${String(cells.length)} does not match ${String(width)}x${String(height)}.`,
        );
      }
      this.cells = cells;
    }
  }

  static fromKinds(rows: readonly (readonly TileKind[])[]): TileMap {
    const height = rows.length;
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const map = new TileMap(Math.max(1, width), Math.max(1, height));
    rows.forEach((row, ty) => {
      row.forEach((kind, tx) => {
        map.set(tx, ty, kind);
      });
    });
    return map;
  }

  get pixelWidth(): number {
    return this.width * this.tileSize;
  }

  get pixelHeight(): number {
    return this.height * this.tileSize;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && tx < this.width && ty >= 0 && ty < this.height;
  }

  tileAt(tx: number, ty: number): TileKind {
    if (tx < 0 || tx >= this.width) {
      // Invisible side walls, but only within/below the level body — above the map is open sky.
      return ty < 0 ? TileKind.Empty : TileKind.Solid;
    }
    if (ty < 0 || ty >= this.height) return TileKind.Empty;
    return (this.cells[ty * this.width + tx] ?? TileKind.Empty) as TileKind;
  }

  tileAtPixel(x: number, y: number): TileKind {
    return this.tileAt(Math.floor(x / this.tileSize), Math.floor(y / this.tileSize));
  }

  set(tx: number, ty: number, kind: TileKind): void {
    if (!this.inBounds(tx, ty)) return;
    this.cells[ty * this.width + tx] = kind;
  }

  worldToTileX(x: number): number {
    return Math.floor(x / this.tileSize);
  }

  worldToTileY(y: number): number {
    return Math.floor(y / this.tileSize);
  }

  /** World-space rectangle of a tile cell. */
  tileRect(tx: number, ty: number): Rect {
    return { x: tx * this.tileSize, y: ty * this.tileSize, width: this.tileSize, height: this.tileSize };
  }

  /** World-space *hitbox* of a tile cell, honouring per-kind insets (e.g. spikes). */
  tileHitbox(tx: number, ty: number, kind: TileKind = this.tileAt(tx, ty)): Rect {
    const inset = tileHitboxInset(kind);
    return {
      x: tx * this.tileSize + inset.side,
      y: ty * this.tileSize + inset.top,
      width: this.tileSize - inset.side * 2,
      height: this.tileSize - inset.top,
    };
  }

  /** Inclusive tile range covered by a world-space rectangle. */
  tileRangeFor(rect: Rect): { minX: number; minY: number; maxX: number; maxY: number } {
    return {
      minX: Math.floor(rect.x / this.tileSize),
      minY: Math.floor(rect.y / this.tileSize),
      maxX: Math.floor((rect.x + rect.width - 1e-6) / this.tileSize),
      maxY: Math.floor((rect.y + rect.height - 1e-6) / this.tileSize),
    };
  }

  /** True when any tile overlapping `rect` is fully solid. */
  overlapsSolid(rect: Rect): boolean {
    const range = this.tileRangeFor(rect);
    for (let ty = range.minY; ty <= range.maxY; ty += 1) {
      for (let tx = range.minX; tx <= range.maxX; tx += 1) {
        if (tileFlags(this.tileAt(tx, ty)).solid) return true;
      }
    }
    return false;
  }

  /** Iterate the tiles overlapping `rect`, skipping empty cells. */
  forEachTileIn(rect: Rect, visit: (kind: TileKind, tx: number, ty: number) => void): void {
    const range = this.tileRangeFor(rect);
    for (let ty = range.minY; ty <= range.maxY; ty += 1) {
      for (let tx = range.minX; tx <= range.maxX; tx += 1) {
        const kind = this.tileAt(tx, ty);
        if (kind === TileKind.Empty) continue;
        visit(kind, tx, ty);
      }
    }
  }

  /** Copy of the raw cell bytes (for snapshots and debugging). */
  toBytes(): Uint8Array {
    return this.cells.slice();
  }
}
