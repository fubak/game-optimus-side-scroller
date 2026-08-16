import { PLAYER_HEIGHT, PLAYER_WIDTH } from './constants';
import { TileMap } from './tilemap';
import { TILE_SIZE, TileKind, tileFlags } from './tiles';

/**
 * ASCII level format.
 *
 * Levels are authored as arrays of strings in TypeScript source: readable in a diff, trivial to
 * edit, and validated at load time so a typo fails loudly instead of producing an unplayable level.
 *
 * ```
 * # solid   = one-way   ^ spike   < > conveyor   C checkpoint   G goal   : scenery
 * P spawn   w walker    d drone   t turret       x crusher      B overseer (boss)
 * e energy cell         o bolt    k repair kit
 * ```
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

export const SPAWN_GLYPH = 'P';

export type EntitySpawnKind =
  'walker' | 'drone' | 'turret' | 'crusher' | 'overseer' | 'energyCell' | 'bolt' | 'repairKit';

export const ENTITY_GLYPHS: Readonly<Record<string, EntitySpawnKind>> = {
  w: 'walker',
  d: 'drone',
  t: 'turret',
  x: 'crusher',
  B: 'overseer',
  e: 'energyCell',
  o: 'bolt',
  k: 'repairKit',
};

export interface LevelDef {
  readonly id: string;
  readonly name: string;
  /** Short line shown on the level intro card. */
  readonly subtitle: string;
  readonly rows: readonly string[];
  /** Target completion time in seconds (drives the time bonus and the "par" rating). */
  readonly parTimeSec: number;
  /** Seed for decorative randomness (parallax, debris) so a level always looks the same. */
  readonly seed?: number;
}

export interface EntitySpawn {
  readonly kind: EntitySpawnKind;
  /** Tile coordinates of the glyph. */
  readonly tx: number;
  readonly ty: number;
  /** World position of the tile's centre-bottom (entities sit on the tile below). */
  readonly x: number;
  readonly y: number;
}

export interface TilePosition {
  readonly tx: number;
  readonly ty: number;
}

export interface Level {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly map: TileMap;
  /** Player body top-left at level start. */
  readonly spawnX: number;
  readonly spawnY: number;
  readonly checkpoints: readonly TilePosition[];
  readonly goals: readonly TilePosition[];
  readonly entities: readonly EntitySpawn[];
  readonly parTimeSec: number;
  readonly seed: number;
  /** Total collectables, for the end-of-level tally. */
  readonly collectableCount: number;
}

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
  /** Glyphs that are not tiles, with their tile coordinates. */
  readonly markers: readonly { readonly glyph: string; readonly tx: number; readonly ty: number }[];
}

/**
 * Convert ASCII rows into a tile map.
 *
 * Non-tile glyphs are returned as markers rather than rejected, so the level loader can turn them
 * into entity spawns. Ragged rows are padded with empty space.
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

/** Player body position for a spawn/checkpoint tile: horizontally centred, feet on the tile floor. */
export function spawnPositionFor(tx: number, ty: number): { x: number; y: number } {
  return {
    x: tx * TILE_SIZE + (TILE_SIZE - PLAYER_WIDTH) / 2,
    y: (ty + 1) * TILE_SIZE - PLAYER_HEIGHT,
  };
}

/**
 * Parse and validate a level definition.
 *
 * Validation catches the mistakes that actually happen when hand-editing ASCII: a missing or
 * duplicated spawn, no goal, an unknown glyph, or a spawn point buried inside a wall.
 */
export function parseLevel(def: LevelDef): Level {
  const { map, markers } = parseTileRows(def.rows);

  const spawns = markers.filter((marker) => marker.glyph === SPAWN_GLYPH);
  const entities: EntitySpawn[] = [];

  for (const marker of markers) {
    if (marker.glyph === SPAWN_GLYPH) continue;
    const kind = ENTITY_GLYPHS[marker.glyph];
    if (kind === undefined) {
      throw new LevelParseError(`Unknown glyph '${marker.glyph}' in level '${def.id}'`, marker.ty, marker.tx);
    }
    entities.push({
      kind,
      tx: marker.tx,
      ty: marker.ty,
      x: marker.tx * TILE_SIZE + TILE_SIZE / 2,
      y: (marker.ty + 1) * TILE_SIZE,
    });
  }

  if (spawns.length === 0) {
    throw new LevelParseError(`Level '${def.id}' has no '${SPAWN_GLYPH}' spawn point`, 0, 0);
  }
  if (spawns.length > 1) {
    const extra = spawns[1];
    throw new LevelParseError(
      `Level '${def.id}' has ${String(spawns.length)} spawn points, expected 1`,
      extra?.ty ?? 0,
      extra?.tx ?? 0,
    );
  }

  const checkpoints: TilePosition[] = [];
  const goals: TilePosition[] = [];
  for (let ty = 0; ty < map.height; ty += 1) {
    for (let tx = 0; tx < map.width; tx += 1) {
      const kind = map.tileAt(tx, ty);
      if (kind === TileKind.Checkpoint) checkpoints.push({ tx, ty });
      if (kind === TileKind.Goal) goals.push({ tx, ty });
    }
  }
  if (goals.length === 0) {
    throw new LevelParseError(`Level '${def.id}' has no 'G' goal tile`, 0, 0);
  }

  const spawn = spawns[0];
  if (spawn === undefined) {
    throw new LevelParseError(`Level '${def.id}' spawn point vanished`, 0, 0);
  }
  const { x: spawnX, y: spawnY } = spawnPositionFor(spawn.tx, spawn.ty);
  assertClearOfSolids(def.id, map, spawnX, spawnY, spawn.ty, spawn.tx, 'spawn point');
  for (const checkpoint of checkpoints) {
    const position = spawnPositionFor(checkpoint.tx, checkpoint.ty);
    assertClearOfSolids(def.id, map, position.x, position.y, checkpoint.ty, checkpoint.tx, 'checkpoint');
  }

  const collectableCount = entities.filter(
    (entity) => entity.kind === 'energyCell' || entity.kind === 'bolt' || entity.kind === 'repairKit',
  ).length;

  return {
    id: def.id,
    name: def.name,
    subtitle: def.subtitle,
    map,
    spawnX,
    spawnY,
    checkpoints,
    goals,
    entities,
    parTimeSec: def.parTimeSec,
    seed: def.seed ?? 1,
    collectableCount,
  };
}

/** A respawn point must not drop the player inside a wall. */
function assertClearOfSolids(
  levelId: string,
  map: TileMap,
  x: number,
  y: number,
  ty: number,
  tx: number,
  label: string,
): void {
  const body = { x: x + 0.5, y: y + 0.5, width: PLAYER_WIDTH - 1, height: PLAYER_HEIGHT - 1 };
  if (!map.overlapsSolid(body)) return;
  throw new LevelParseError(`Level '${levelId}' ${label} is inside a solid tile`, ty, tx);
}

/** All tile kinds actually used by a level — handy for tests and level linting. */
export function tileKindsUsed(map: TileMap): Set<TileKind> {
  const used = new Set<TileKind>();
  for (let ty = 0; ty < map.height; ty += 1) {
    for (let tx = 0; tx < map.width; tx += 1) {
      used.add(map.tileAt(tx, ty));
    }
  }
  return used;
}

/** True when a tile is standable, i.e. something can patrol on top of it. */
export function isStandable(map: TileMap, tx: number, ty: number): boolean {
  const flags = tileFlags(map.tileAt(tx, ty));
  return flags.solid || flags.oneWay;
}
