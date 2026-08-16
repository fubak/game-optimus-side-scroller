/**
 * Sentry drone.
 *
 * A hovering patroller that closes on the player when they come near. Simple by
 * design: the first enemy exists to make combat legible, so its behaviour has
 * to be readable at a glance rather than clever.
 *
 * ## Telegraphing
 *
 * Every state change is visible before it matters. The drone brightens and
 * pulls back a moment before it lunges, so a player who is paying attention can
 * always react. An enemy that acts without warning is not difficult, it is
 * merely unfair, and it is the fastest way to make combat feel arbitrary.
 */

import { aabb, type AABB } from '../../core/math/aabb.ts';
import { clamp, clamp01, damp } from '../../core/math/scalar.ts';
import { Rng } from '../../core/rng.ts';
import type { Hurtbox } from '../combat.ts';
import { Faction } from '../combat.ts';

export const enum DroneState {
  /** Drifting along its patrol path. */
  Patrol,
  /** Player spotted: rises, brightens, pulls back. */
  Alert,
  /** Committed to a lunge. */
  Lunge,
  /** Recovering after a lunge. */
  Recover,
  /** Struck: knocked back, briefly stunned. */
  Stagger,
  /** Dissolving. */
  Dying,
}

export const DRONE = {
  maxHealth: 32,
  size: 0.85,
  /** Distance at which the player is noticed. */
  detectRange: 6.5,
  /** Distance at which a lunge is committed. */
  lungeRange: 3.2,
  patrolSpeed: 1.5,
  lungeSpeed: 11.0,
  alertDuration: 0.55,
  lungeDuration: 0.34,
  recoverDuration: 0.7,
  staggerDuration: 0.34,
  deathDuration: 0.55,
  contactDamage: 8,
} as const;

export class Drone {
  readonly id: number;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  health = DRONE.maxHealth;
  state: DroneState = DroneState.Patrol;
  stateTime = 0;
  facing = 1;

  /** 0..1, drives the white flash on being struck. */
  flash = 0;
  /** 0..1, drives the dissolve shader on death. */
  dissolve = 0;
  /** Extra emissive on the optic, raised while alert. */
  charge = 0;

  readonly hurtbox: Hurtbox;

  /** Patrol anchor and extent. */
  private readonly homeX: number;
  private readonly homeY: number;
  private readonly patrolRange: number;
  private patrolPhase: number;
  private readonly bobPhase: number;
  private lungeDirX = 0;
  private lungeDirY = 0;

  constructor(id: number, x: number, y: number, patrolRange: number, rng: Rng) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.homeX = x;
    this.homeY = y;
    this.patrolRange = patrolRange;
    this.patrolPhase = rng.range(0, Math.PI * 2);
    this.bobPhase = rng.range(0, Math.PI * 2);

    this.hurtbox = {
      id,
      faction: Faction.Enemy,
      box: aabb(x, y, DRONE.size * 0.44, DRONE.size * 0.34),
      invulnerable: false,
      alive: true,
    };
  }

  get alive(): boolean {
    return this.state !== DroneState.Dying || this.dissolve < 1;
  }

  get box(): AABB {
    return this.hurtbox.box;
  }

  /** Applies damage and knockback. Returns true if this blow was fatal. */
  takeHit(damage: number, knockbackX: number, knockbackY: number): boolean {
    if (this.state === DroneState.Dying) return false;

    this.health -= damage;
    this.flash = 1;
    this.vx = knockbackX;
    this.vy = knockbackY;

    if (this.health <= 0) {
      this.state = DroneState.Dying;
      this.stateTime = 0;
      this.hurtbox.alive = false;
      return true;
    }

    this.state = DroneState.Stagger;
    this.stateTime = 0;
    return false;
  }

  update(dt: number, playerX: number, playerY: number): void {
    this.stateTime += dt;
    // The flash decays fast: it marks the instant of contact, and lingering
    // turns it into a health bar.
    this.flash = Math.max(0, this.flash - dt * 4.5);

    const dx = playerX - this.x;
    const dy = playerY - 0.9 - this.y;
    const distance = Math.hypot(dx, dy);

    switch (this.state) {
      case DroneState.Patrol: {
        this.patrolPhase += dt * 0.7;
        const targetX = this.homeX + Math.sin(this.patrolPhase) * this.patrolRange;
        this.vx = damp(this.vx, (targetX - this.x) * 2.2, 0.25, dt);
        // A slow bob, so it reads as hovering rather than sliding on rails.
        const targetY = this.homeY + Math.sin(this.stateTime * 1.3 + this.bobPhase) * 0.22;
        this.vy = damp(this.vy, (targetY - this.y) * 3.0, 0.2, dt);
        this.charge = damp(this.charge, 0, 0.3, dt);
        if (Math.abs(this.vx) > 0.1) this.facing = Math.sign(this.vx);

        if (distance < DRONE.detectRange) {
          this.state = DroneState.Alert;
          this.stateTime = 0;
        }
        break;
      }

      case DroneState.Alert: {
        // Pull back and rise while brightening: the telegraph.
        this.facing = Math.sign(dx) || this.facing;
        const retreatX = -Math.sign(dx) * 0.55;
        this.vx = damp(this.vx, retreatX, 0.2, dt);
        this.vy = damp(this.vy, -1.1, 0.22, dt);
        this.charge = clamp01(this.stateTime / DRONE.alertDuration);

        if (distance > DRONE.detectRange * 1.4) {
          this.state = DroneState.Patrol;
          this.stateTime = 0;
        } else if (this.stateTime >= DRONE.alertDuration && distance < DRONE.lungeRange * 2.2) {
          // Commit: the direction is locked now, so the lunge is dodgeable.
          const length = Math.hypot(dx, dy) || 1;
          this.lungeDirX = dx / length;
          this.lungeDirY = dy / length;
          this.state = DroneState.Lunge;
          this.stateTime = 0;
        }
        break;
      }

      case DroneState.Lunge: {
        this.vx = this.lungeDirX * DRONE.lungeSpeed;
        this.vy = this.lungeDirY * DRONE.lungeSpeed;
        this.charge = 1;
        if (this.stateTime >= DRONE.lungeDuration) {
          this.state = DroneState.Recover;
          this.stateTime = 0;
        }
        break;
      }

      case DroneState.Recover: {
        // Wide open during recovery — this is the punish window.
        const drag = Math.pow(0.06, dt);
        this.vx *= drag;
        this.vy *= drag;
        this.charge = damp(this.charge, 0.15, 0.25, dt);
        if (this.stateTime >= DRONE.recoverDuration) {
          this.state = distance < DRONE.detectRange ? DroneState.Alert : DroneState.Patrol;
          this.stateTime = 0;
        }
        break;
      }

      case DroneState.Stagger: {
        const drag = Math.pow(0.12, dt);
        this.vx *= drag;
        this.vy *= drag;
        this.charge = 0;
        if (this.stateTime >= DRONE.staggerDuration) {
          this.state = DroneState.Alert;
          this.stateTime = 0;
        }
        break;
      }

      case DroneState.Dying: {
        const drag = Math.pow(0.3, dt);
        this.vx *= drag;
        // Falls as it dies, rather than hanging in the air.
        this.vy = this.vy * drag + 7 * dt;
        this.dissolve = clamp01(this.stateTime / DRONE.deathDuration);
        break;
      }

      default: {
        const never: never = this.state;
        throw new Error(`Unhandled drone state: ${never}`);
      }
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Keep it near its post, so a chased drone does not end up across the level.
    this.x = clamp(this.x, this.homeX - this.patrolRange - 6, this.homeX + this.patrolRange + 6);

    this.hurtbox.box.x = this.x;
    this.hurtbox.box.y = this.y;
  }

  /** True while the drone's body should damage the player on contact. */
  get isDangerous(): boolean {
    return this.state === DroneState.Lunge;
  }
}
