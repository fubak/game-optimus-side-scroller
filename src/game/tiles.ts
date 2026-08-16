/**
 * Tile vocabulary.
 *
 * Tiles are stored as bytes in a typed array (see {@link TileMap}), so the "union" is a set of
 * numeric literals rather than objects. Behaviour is derived through {@link tileFlags}, whose
 * exhaustive switch means adding a tile kind fails to compile until every rule is handled.
 */

export const TILE_SIZE = 16;

export const TileKind = {
  Empty: 0,
  /** Full-block collision. */
  Solid: 1,
  /** Collides only when falling onto it from above; can be dropped through. */
  OneWay: 2,
  /** Damages on contact (uses a shrunken hitbox so grazing the edge is survivable). */
  Spike: 3,
  /** Solid floor that pushes whatever stands on it to the left. */
  ConveyorLeft: 4,
  /** Solid floor that pushes whatever stands on it to the right. */
  ConveyorRight: 5,
  /** Sets the respawn point when touched. */
  Checkpoint: 6,
  /** Completes the level when touched. */
  Goal: 7,
  /** Decorative background block: never collides. */
  Scenery: 8,
} as const;

export type TileKind = (typeof TileKind)[keyof typeof TileKind];

export const ALL_TILE_KINDS: readonly TileKind[] = Object.values(TileKind);

export interface TileFlags {
  /** Blocks movement from every direction. */
  readonly solid: boolean;
  /** Blocks only downward movement. */
  readonly oneWay: boolean;
  /** Hurts the player on contact. */
  readonly hazard: boolean;
  /** Horizontal push applied to bodies standing on it, in px/s. */
  readonly conveyor: number;
  /** Triggers a world event on overlap rather than colliding. */
  readonly trigger: boolean;
}

export const CONVEYOR_SPEED = 55;

const EMPTY_FLAGS: TileFlags = { solid: false, oneWay: false, hazard: false, conveyor: 0, trigger: false };
const SOLID_FLAGS: TileFlags = { solid: true, oneWay: false, hazard: false, conveyor: 0, trigger: false };
const ONE_WAY_FLAGS: TileFlags = { solid: false, oneWay: true, hazard: false, conveyor: 0, trigger: false };
const SPIKE_FLAGS: TileFlags = { solid: false, oneWay: false, hazard: true, conveyor: 0, trigger: false };
const CONVEYOR_LEFT_FLAGS: TileFlags = {
  solid: true,
  oneWay: false,
  hazard: false,
  conveyor: -CONVEYOR_SPEED,
  trigger: false,
};
const CONVEYOR_RIGHT_FLAGS: TileFlags = {
  solid: true,
  oneWay: false,
  hazard: false,
  conveyor: CONVEYOR_SPEED,
  trigger: false,
};
const TRIGGER_FLAGS: TileFlags = { solid: false, oneWay: false, hazard: false, conveyor: 0, trigger: true };

export function tileFlags(kind: TileKind): TileFlags {
  switch (kind) {
    case TileKind.Empty:
    case TileKind.Scenery:
      return EMPTY_FLAGS;
    case TileKind.Solid:
      return SOLID_FLAGS;
    case TileKind.OneWay:
      return ONE_WAY_FLAGS;
    case TileKind.Spike:
      return SPIKE_FLAGS;
    case TileKind.ConveyorLeft:
      return CONVEYOR_LEFT_FLAGS;
    case TileKind.ConveyorRight:
      return CONVEYOR_RIGHT_FLAGS;
    case TileKind.Checkpoint:
    case TileKind.Goal:
      return TRIGGER_FLAGS;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled tile kind: ${String(exhaustive)}`);
    }
  }
}

export function isSolid(kind: TileKind): boolean {
  return tileFlags(kind).solid;
}

export function isOneWay(kind: TileKind): boolean {
  return tileFlags(kind).oneWay;
}

export function isHazard(kind: TileKind): boolean {
  return tileFlags(kind).hazard;
}

export function conveyorSpeed(kind: TileKind): number {
  return tileFlags(kind).conveyor;
}

export function isTrigger(kind: TileKind): boolean {
  return tileFlags(kind).trigger;
}

/**
 * Spikes only hurt near their base plate, and triggers only fire around their core, so overlap
 * tests use these per-tile insets instead of the full 16×16 cell. Keeps deaths feeling fair.
 */
export function tileHitboxInset(kind: TileKind): { top: number; side: number } {
  switch (kind) {
    case TileKind.Spike:
      return { top: 6, side: 3 };
    case TileKind.Checkpoint:
    case TileKind.Goal:
      return { top: 0, side: 2 };
    case TileKind.Empty:
    case TileKind.Solid:
    case TileKind.OneWay:
    case TileKind.ConveyorLeft:
    case TileKind.ConveyorRight:
    case TileKind.Scenery:
      return { top: 0, side: 0 };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled tile kind: ${String(exhaustive)}`);
    }
  }
}
