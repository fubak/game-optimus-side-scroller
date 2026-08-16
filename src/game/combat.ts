/**
 * Combat resolution.
 *
 * ## What makes a hit feel like a hit
 *
 * The damage number is the least important part. What the player actually
 * perceives, in rough order of contribution:
 *
 * 1. **Hitstop** — the world freezes for 40–140 ms on contact. Without it,
 *    attacks read as passing *through* enemies rather than striking them. This
 *    single effect does more for weight than everything else combined.
 * 2. **Knockback** — the victim moves, so the blow visibly transferred force.
 * 3. **Flash** — the victim goes momentarily white, which reads as the moment
 *    of contact even when the hit lands off-screen-centre.
 * 4. **Screen shake** — directional, scaled to damage, decaying quadratically.
 * 5. **Particles** — sparks along the impact normal, debris, a shockwave ring.
 *
 * All five are driven from one place here, so they cannot drift out of sync
 * with each other — which is the usual failure mode when impact effects are
 * scattered across the codebase.
 *
 * ## Boxes
 *
 * Attacks are **hitboxes** active for a window of an animation. Characters have
 * **hurtboxes**. Both are AABBs in world space. A hitbox may only damage a
 * given hurtbox once per activation, tracked by a hit id, so a lingering
 * attack cannot tick damage every frame.
 */

import { type AABB, aabb, overlaps } from '../core/math/aabb.ts';
import { clamp01 } from '../core/math/scalar.ts';

export const enum Faction {
  Player = 0,
  Enemy = 1,
}

export interface Hurtbox {
  /** Owner identity, so a hit can be attributed and de-duplicated. */
  id: number;
  faction: Faction;
  box: AABB;
  /** Set while invulnerable — dashes, i-frames after a hit. */
  invulnerable: boolean;
  alive: boolean;
}

export interface Hitbox {
  /** Identity of this specific activation, for once-per-swing de-duplication. */
  activationId: number;
  faction: Faction;
  box: AABB;
  damage: number;
  /** Knockback impulse in metres per second. */
  knockbackX: number;
  knockbackY: number;
  /** Seconds of hitstop applied on a successful hit. */
  hitstop: number;
  /** Screen-shake trauma added on a successful hit, in [0, 1]. */
  trauma: number;
  /** Seconds remaining before this activation expires. */
  remaining: number;
  /** Whether the attack can hit more than one target in a single activation. */
  multiHit: boolean;
}

export interface HitEvent {
  attacker: Faction;
  targetId: number;
  damage: number;
  /** World position of the contact, for spawning effects. */
  x: number;
  y: number;
  /** Unit vector along which force was transferred. */
  normalX: number;
  normalY: number;
  knockbackX: number;
  knockbackY: number;
  hitstop: number;
  trauma: number;
}

/** Scratch box, so resolution never allocates. */
const scratch = aabb();

export class CombatSystem {
  private readonly hitboxes: Hitbox[] = [];
  private readonly hurtboxes: Hurtbox[] = [];
  /** `activationId * 100000 + targetId` for every hit already applied. */
  private readonly consumed = new Set<number>();
  private nextActivationId = 1;

  /** Hits produced by the most recent {@link resolve}. */
  readonly events: HitEvent[] = [];

  registerHurtbox(hurtbox: Hurtbox): void {
    this.hurtboxes.push(hurtbox);
  }

  removeHurtbox(id: number): void {
    const index = this.hurtboxes.findIndex((h) => h.id === id);
    if (index >= 0) this.hurtboxes.splice(index, 1);
  }

  /**
   * Activates an attack.
   *
   * @returns The activation id, so the caller can move the box as the
   *   animation plays.
   */
  spawnHitbox(options: {
    faction: Faction;
    x: number;
    y: number;
    halfWidth: number;
    halfHeight: number;
    damage: number;
    knockbackX: number;
    knockbackY: number;
    hitstop?: number;
    trauma?: number;
    duration: number;
    multiHit?: boolean;
  }): number {
    const activationId = this.nextActivationId++;
    this.hitboxes.push({
      activationId,
      faction: options.faction,
      box: aabb(options.x, options.y, options.halfWidth, options.halfHeight),
      damage: options.damage,
      knockbackX: options.knockbackX,
      knockbackY: options.knockbackY,
      // Scaled to damage so a light jab and a heavy blow feel genuinely
      // different rather than sharing one canned freeze.
      hitstop: options.hitstop ?? clamp01(options.damage / 40) * 0.10 + 0.035,
      trauma: options.trauma ?? clamp01(options.damage / 35) * 0.35,
      remaining: options.duration,
      multiHit: options.multiHit ?? false,
    });
    return activationId;
  }

  /** Repositions a live hitbox, so it can follow a swinging limb. */
  moveHitbox(activationId: number, x: number, y: number): void {
    for (const hitbox of this.hitboxes) {
      if (hitbox.activationId === activationId) {
        hitbox.box.x = x;
        hitbox.box.y = y;
        return;
      }
    }
  }

  cancelHitbox(activationId: number): void {
    const index = this.hitboxes.findIndex((h) => h.activationId === activationId);
    if (index >= 0) this.hitboxes.splice(index, 1);
  }

  /**
   * Ages hitboxes and produces hit events for this step.
   *
   * Events are collected rather than dispatched through callbacks so the caller
   * controls exactly when damage, effects, and hitstop are applied — which
   * matters because hitstop must be applied once for the frame, not once per
   * simultaneous hit.
   */
  resolve(dt: number): void {
    this.events.length = 0;

    for (let i = this.hitboxes.length - 1; i >= 0; i--) {
      const hitbox = this.hitboxes[i]!;
      hitbox.remaining -= dt;

      for (const hurtbox of this.hurtboxes) {
        if (!hurtbox.alive || hurtbox.invulnerable) continue;
        if (hurtbox.faction === hitbox.faction) continue;

        const key = hitbox.activationId * 100000 + hurtbox.id;
        if (this.consumed.has(key)) continue;
        if (!overlaps(hitbox.box, hurtbox.box)) continue;

        this.consumed.add(key);

        // Contact point is the centre of the overlap, which puts effects where
        // the blow actually landed rather than at either box's centre.
        const contactX = (hitbox.box.x + hurtbox.box.x) / 2;
        const contactY = (hitbox.box.y + hurtbox.box.y) / 2;

        const dx = hurtbox.box.x - hitbox.box.x;
        const dy = hurtbox.box.y - hitbox.box.y;
        const length = Math.hypot(dx, dy) || 1;

        this.events.push({
          attacker: hitbox.faction,
          targetId: hurtbox.id,
          damage: hitbox.damage,
          x: contactX,
          y: contactY,
          normalX: dx / length,
          normalY: dy / length,
          knockbackX: hitbox.knockbackX,
          knockbackY: hitbox.knockbackY,
          hitstop: hitbox.hitstop,
          trauma: hitbox.trauma,
        });

        if (!hitbox.multiHit) break;
      }

      if (hitbox.remaining <= 0) {
        this.hitboxes.splice(i, 1);
      }
    }

    // The consumed set only needs to outlive its hitboxes. Clearing it once
    // every activation has expired keeps it from growing without bound over a
    // long session.
    if (this.hitboxes.length === 0 && this.consumed.size > 0) this.consumed.clear();
  }

  /** Largest hitstop among this step's events; applied once for the frame. */
  get peakHitstop(): number {
    let peak = 0;
    for (const event of this.events) peak = Math.max(peak, event.hitstop);
    return peak;
  }

  /** Largest trauma among this step's events. */
  get peakTrauma(): number {
    let peak = 0;
    for (const event of this.events) peak = Math.max(peak, event.trauma);
    return peak;
  }

  get liveHitboxes(): readonly Hitbox[] {
    return this.hitboxes;
  }

  clear(): void {
    this.hitboxes.length = 0;
    this.hurtboxes.length = 0;
    this.consumed.clear();
    this.events.length = 0;
  }
}

/** Updates a hurtbox to follow its owner. */
export function syncHurtbox(hurtbox: Hurtbox, x: number, y: number): void {
  hurtbox.box.x = x;
  hurtbox.box.y = y;
}

export { scratch as combatScratchBox };
