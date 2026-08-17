import { aabbOverlap } from '../core/math';
import type { Rect } from '../core/math';
import { SCORE_BOLT, SCORE_ENERGY_CELL } from './constants';
import type { EntitySpawn } from './levelParser';

/**
 * Collectables.
 *
 * Three kinds with distinct *shapes* as well as colours (energy cell = tall canister, bolt = small
 * hex nut, repair kit = cross), so they stay readable for colour-blind players.
 */

export type PickupKind = 'energyCell' | 'bolt' | 'repairKit';

export interface Pickup {
  readonly kind: PickupKind;
  /** Collision box in world space. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  collected: boolean;
  /** Animation phase offset so a row of pickups bobs out of sync. */
  readonly phase: number;
}

export interface PickupEffect {
  readonly energy: number;
  readonly health: number;
  readonly score: number;
}

const SIZES: Record<PickupKind, { readonly width: number; readonly height: number }> = {
  energyCell: { width: 8, height: 11 },
  bolt: { width: 7, height: 7 },
  repairKit: { width: 10, height: 9 },
};

export const PICKUP_EFFECTS: Record<PickupKind, PickupEffect> = {
  energyCell: { energy: 34, health: 0, score: SCORE_ENERGY_CELL },
  bolt: { energy: 0, health: 0, score: SCORE_BOLT },
  repairKit: { energy: 0, health: 1, score: 0 },
};

export function isPickupKind(kind: string): kind is PickupKind {
  return kind === 'energyCell' || kind === 'bolt' || kind === 'repairKit';
}

/** Build a pickup from a level spawn marker (which sits at the tile's bottom centre). */
export function createPickup(spawn: EntitySpawn, kind: PickupKind, index: number): Pickup {
  const size = SIZES[kind];
  return {
    kind,
    x: spawn.x - size.width / 2,
    // Floats in the middle of its tile rather than sitting on the floor.
    y: spawn.y - 16 + (16 - size.height) / 2,
    width: size.width,
    height: size.height,
    collected: false,
    phase: (index % 8) * 0.7,
  };
}

/** Vertical bob offset for rendering (pure function of time so it never desyncs). */
export function pickupBob(pickup: Pickup, timeSec: number): number {
  return Math.sin(timeSec * 3 + pickup.phase) * 1.5;
}

/** First uncollected pickup overlapping `body`, or `null`. */
export function findCollidingPickup(pickups: readonly Pickup[], body: Rect): Pickup | null {
  for (const pickup of pickups) {
    if (pickup.collected) continue;
    if (aabbOverlap(body, pickup)) return pickup;
  }
  return null;
}
