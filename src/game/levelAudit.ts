import {
  GRAVITY_FALLING,
  GRAVITY_RISING,
  JUMP_SPEED,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  RUN_MAX_SPEED,
} from './constants';
import type { Level } from './levelParser';
import { TILE_SIZE, tileFlags } from './tiles';
import type { TileKind } from './tiles';

/**
 * Level layout audit.
 *
 * Hand-authored ASCII levels are easy to get subtly wrong: one missing character shifts a row, and
 * a pit two tiles too wide turns a level into a dead end. These checks derive the *actual* movement
 * limits from the tuning constants and flag anything the player could not clear, so bad layouts fail
 * in tests rather than in someone's face.
 */

/** Peak height of a full jump, in tiles (v²/2g, converted to tiles and rounded down). */
export const MAX_JUMP_TILES = Math.floor((JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY_RISING) / TILE_SIZE);

/**
 * Horizontal distance cleared by a running jump, in tiles.
 *
 * Airtime is the rise plus the fall back to the same height; a small safety margin is subtracted so
 * a "just barely possible" gap is not considered acceptable design.
 */
export const MAX_GAP_TILES = (() => {
  const rise = JUMP_SPEED / GRAVITY_RISING;
  const fall = JUMP_SPEED / GRAVITY_FALLING;
  const airtime = rise + fall;
  const reach = (RUN_MAX_SPEED * airtime + PLAYER_WIDTH) / TILE_SIZE;
  return Math.max(1, Math.floor(reach) - 1);
})();

/** Tallest step up that can be climbed from a standstill. */
export const MAX_STEP_TILES = Math.max(1, MAX_JUMP_TILES - 1);

export interface LevelAudit {
  readonly problems: string[];
  /** Surface height (tile row of the topmost floor) per column, or null for bottomless columns. */
  readonly surface: (number | null)[];
  readonly widestGap: number;
  readonly tallestStep: number;
}

function isStandableTile(kind: TileKind): boolean {
  const flags = tileFlags(kind);
  return flags.solid || flags.oneWay;
}

/**
 * Audit a parsed level.
 *
 * The floor profile is sampled per column: the topmost standable tile at or below the "walkable
 * band" (everything from the spawn row downwards), which is what the player actually runs along.
 */
export function auditLevel(level: Level): LevelAudit {
  const { map } = level;
  const problems: string[] = [];

  /*
   * Surface profile = the top of the *lowest* stack of standable tiles in each column.
   *
   * Scanning from the top would treat a decorative catwalk five tiles up as "the floor" and report
   * imaginary cliffs. Scanning from the bottom follows the route a runner actually takes, and a
   * catwalk that bridges a pit correctly counts as floor for that column.
   */
  const surface: (number | null)[] = [];
  for (let tx = 0; tx < map.width; tx += 1) {
    let top: number | null = null;
    for (let ty = map.height - 1; ty >= 0; ty -= 1) {
      if (isStandableTile(map.tileAt(tx, ty))) {
        top = ty;
      } else if (top !== null) {
        break;
      }
    }
    surface.push(top);
  }

  /*
   * Only the route up to the last goal is audited. Past the goal a level is free to end in an
   * unclimbable wall (the extraction bay does exactly that) and those columns are never traversed.
   */
  const routeEnd = level.goals.reduce((max, goal) => Math.max(max, goal.tx), 0);

  // Widest bottomless run.
  let widestGap = 0;
  let currentGap = 0;
  for (let tx = 0; tx <= routeEnd; tx += 1) {
    if (surface[tx] === null) {
      currentGap += 1;
      widestGap = Math.max(widestGap, currentGap);
    } else {
      currentGap = 0;
    }
  }
  if (widestGap > MAX_GAP_TILES) {
    problems.push(
      `bottomless gap of ${String(widestGap)} tiles exceeds the ${String(MAX_GAP_TILES)}-tile jump reach`,
    );
  }

  // Tallest upward step between neighbouring columns that both have floor.
  let tallestStep = 0;
  for (let tx = 1; tx <= routeEnd; tx += 1) {
    const previous = surface[tx - 1];
    const current = surface[tx];
    if (previous === null || current === null || previous === undefined || current === undefined) continue;
    const rise = previous - current;
    if (rise <= 0) continue;
    tallestStep = Math.max(tallestStep, rise);
    if (rise > MAX_STEP_TILES) {
      problems.push(
        `step up of ${String(rise)} tiles at column ${String(tx)} exceeds the ${String(MAX_STEP_TILES)}-tile climb`,
      );
    }
  }

  // Pickups and entities must not be buried.
  for (const entity of level.entities) {
    const box = { x: entity.x - 5, y: entity.y - 15, width: 10, height: 14 };
    if (map.overlapsSolid(box)) {
      problems.push(
        `entity '${entity.kind}' at tile (${String(entity.tx)}, ${String(entity.ty)}) is inside a wall`,
      );
    }
  }

  // Goals must be reachable in the sense of standing on something within a jump of the goal tile.
  for (const goal of level.goals) {
    const floorBelow = surface[goal.tx];
    if (floorBelow === null || floorBelow === undefined || floorBelow <= goal.ty) {
      problems.push(`goal at tile (${String(goal.tx)}, ${String(goal.ty)}) has no floor beneath it`);
    }
  }

  // The player must fit where they spawn.
  const spawnBox = { x: level.spawnX, y: level.spawnY, width: PLAYER_WIDTH, height: PLAYER_HEIGHT };
  if (map.overlapsSolid(spawnBox)) {
    problems.push('spawn overlaps a solid tile');
  }

  return { problems, surface, widestGap, tallestStep };
}

/** Row-length check performed on the raw definition (the parser pads, hiding typos). */
export function findRaggedRows(rows: readonly string[]): { index: number; length: number }[] {
  const expected = rows[0]?.length ?? 0;
  const ragged: { index: number; length: number }[] = [];
  rows.forEach((row, index) => {
    if (row.length !== expected) ragged.push({ index, length: row.length });
  });
  return ragged;
}
