/**
 * Tile → material mapping.
 *
 * Stage 4 will sample the generated atlas per gameplay tile; this module is the (deliberately
 * tiny) glue that decides *which* material a tile kind uses, plus the per-position hash that
 * drives cosmetic variation between otherwise-identical tiles (which steel skin, which chevron
 * phase, etc.) — nothing here reads pixels or touches the renderer.
 */

import { TileKind } from '../../game/tiles';
import { MaterialId } from './types';

/**
 * Deterministic per-tile hash, identical to the private `tileHash` in `src/render/tiles.ts`.
 * Duplicated rather than imported so this module has no dependency on the Canvas2D tile painter;
 * the two must be kept in algorithmic lock-step (see `tests/unit/materials.test.ts`), but neither
 * owns the other.
 */
export function tileVariation(tx: number, ty: number): number {
  let hash = (tx * 73856093) ^ (ty * 19349663);
  hash = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995);
  return (hash ^ (hash >>> 15)) >>> 0;
}

/** The canonical material for a tile kind — one answer per kind, no positional variation. */
export function materialForTile(kind: TileKind): MaterialId {
  switch (kind) {
    case TileKind.Empty:
    case TileKind.Scenery:
      return MaterialId.Concrete;
    case TileKind.Solid:
      return MaterialId.BrushedSteel;
    case TileKind.OneWay:
      return MaterialId.Catwalk;
    case TileKind.Spike:
      return MaterialId.HazardSpike;
    case TileKind.ConveyorLeft:
    case TileKind.ConveyorRight:
      return MaterialId.ConveyorRubber;
    case TileKind.Checkpoint:
      return MaterialId.EmissiveEnergy;
    case TileKind.Goal:
      return MaterialId.EmissiveGoal;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled tile kind: ${String(exhaustive)}`);
    }
  }
}

/** Alternate skins {@link TileKind.Solid} may pick between, keyed by {@link tileVariation}. */
const SOLID_VARIANTS: readonly MaterialId[] = [
  MaterialId.BrushedSteel,
  MaterialId.PaintedSteel,
  MaterialId.RustedPlate,
  MaterialId.Grating,
];

/**
 * Material for a specific tile instance, folding in {@link tileVariation} so large masses of the
 * same tile kind do not all render as the exact same skin. Falls back to
 * {@link materialForTile} for kinds without a variant set.
 */
export function materialForTileAt(kind: TileKind, tx: number, ty: number): MaterialId {
  const hash = tileVariation(tx, ty);
  switch (kind) {
    case TileKind.Solid: {
      const variant = SOLID_VARIANTS[hash % SOLID_VARIANTS.length];
      return variant ?? MaterialId.BrushedSteel;
    }
    case TileKind.Spike:
      return (hash & 3) === 0 ? MaterialId.WarningChevrons : MaterialId.HazardSpike;
    case TileKind.Empty:
    case TileKind.Scenery:
    case TileKind.OneWay:
    case TileKind.ConveyorLeft:
    case TileKind.ConveyorRight:
    case TileKind.Checkpoint:
    case TileKind.Goal:
      return materialForTile(kind);
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled tile kind: ${String(exhaustive)}`);
    }
  }
}
