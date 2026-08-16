import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../core/canvas';
import type { Input } from '../core/input';
import { createRng } from '../core/rng';
import type { Rng } from '../core/rng';
import { ParticleSystem } from '../render/particles';
import { Camera } from './camera';
import {
  LANDING_SHAKE_SPEED,
  PLAYER_HEIGHT,
  SCORE_TIME_BONUS_PER_SEC,
  SHAKE_DEATH,
  SHAKE_HURT,
  SHAKE_LANDING,
} from './constants';
import type { Level } from './levelParser';
import { spawnPositionFor } from './levelParser';
import { PICKUP_EFFECTS, createPickup, findCollidingPickup, isPickupKind, pickupBob } from './pickups';
import type { Pickup, PickupKind } from './pickups';
import { Player } from './player';
import type { PlayerEvent } from './player';
import { TileKind } from './tiles';
import type { TileMap } from './tilemap';

/**
 * The simulation container.
 *
 * `World` owns everything that moves — the player, the pickups, the camera, the particle pool — and
 * advances them one fixed step at a time. It reports what happened as a list of {@link WorldEvent},
 * which the presentation layer turns into sound, HUD toasts and scene changes. World never touches
 * the DOM, so the whole game can be run headless in tests.
 */

export type DeathCause = 'pit' | 'hazard' | 'damage' | 'crushed';

export type WorldEvent =
  | { readonly type: 'player'; readonly event: PlayerEvent }
  | {
      readonly type: 'pickup';
      readonly kind: PickupKind;
      readonly x: number;
      readonly y: number;
      readonly score: number;
    }
  | { readonly type: 'checkpoint'; readonly tx: number; readonly ty: number }
  | { readonly type: 'goal'; readonly timeSec: number; readonly score: number }
  | { readonly type: 'death'; readonly cause: DeathCause; readonly livesLeft: number }
  | { readonly type: 'respawn' }
  | { readonly type: 'failed' };

export type WorldState = 'playing' | 'dying' | 'complete' | 'failed';

export const DEFAULT_LIVES = 3;

export interface WorldOptions {
  readonly seed?: number;
  readonly lives?: number;
}

export interface WorldStats {
  readonly timeSec: number;
  readonly score: number;
  readonly collected: number;
  readonly collectableTotal: number;
  readonly deaths: number;
  readonly livesLeft: number;
  readonly parTimeSec: number;
  /** Bonus points for finishing under par (0 when over par). */
  readonly timeBonus: number;
}

export class World {
  readonly level: Level;
  readonly map: TileMap;
  readonly player: Player;
  readonly camera: Camera;
  readonly particles = new ParticleSystem(512);
  readonly rng: Rng;
  readonly pickups: Pickup[] = [];

  private state: WorldState = 'playing';
  private elapsed = 0;
  private scoreValue = 0;
  private collectedCount = 0;
  private deathCount = 0;
  private livesRemaining: number;
  private checkpointX: number;
  private checkpointY: number;
  private readonly playerEvents: PlayerEvent[] = [];
  private readonly events: WorldEvent[] = [];
  /** Cause attributed to the next fatal hit — set by whatever dealt the damage. */
  private pendingDeathCause: DeathCause = 'damage';

  constructor(level: Level, options: WorldOptions = {}) {
    this.level = level;
    this.map = level.map;
    this.rng = createRng(options.seed ?? level.seed);
    this.livesRemaining = options.lives ?? DEFAULT_LIVES;
    this.checkpointX = level.spawnX;
    this.checkpointY = level.spawnY;
    this.player = new Player(level.spawnX, level.spawnY);
    this.camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    this.camera.snapTo(this.player.body, this.map);

    let pickupIndex = 0;
    for (const spawn of level.entities) {
      if (!isPickupKind(spawn.kind)) continue;
      this.pickups.push(createPickup(spawn, spawn.kind, pickupIndex));
      pickupIndex += 1;
    }
  }

  get status(): WorldState {
    return this.state;
  }

  get elapsedSec(): number {
    return this.elapsed;
  }

  get score(): number {
    return this.scoreValue;
  }

  get livesLeft(): number {
    return this.livesRemaining;
  }

  get isFinished(): boolean {
    return this.state === 'complete' || this.state === 'failed';
  }

  get stats(): WorldStats {
    return {
      timeSec: this.elapsed,
      score: this.scoreValue,
      collected: this.collectedCount,
      collectableTotal: this.level.collectableCount,
      deaths: this.deathCount,
      livesLeft: this.livesRemaining,
      parTimeSec: this.level.parTimeSec,
      timeBonus: this.timeBonus(),
    };
  }

  /** Is this checkpoint tile the one the player will respawn at? */
  isCheckpointActive(tx: number, ty: number): boolean {
    const position = spawnPositionFor(tx, ty);
    return position.x === this.checkpointX && position.y === this.checkpointY;
  }

  /** Bob offset used by the renderer, kept here so visuals follow the simulation clock. */
  pickupOffset(pickup: Pickup): number {
    return pickupBob(pickup, this.elapsed);
  }

  update(dtSec: number, input: Input): readonly WorldEvent[] {
    this.events.length = 0;
    // `playerEvents` is *not* cleared here: damage dealt from outside `update` (a hazard resolved
    // by the caller, an enemy in the previous step) leaves events in the queue that still need
    // forwarding. It is cleared once they have been handled, at the end of this method.
    if (this.state === 'playing') {
      this.elapsed += dtSec;
    }

    // Order matters: move, then resolve what the move touched (which may add more player events),
    // and only then forward the whole batch so visuals and death handling see everything at once.
    this.player.update(dtSec, input, this.map, this.playerEvents);
    if (this.state === 'playing') {
      this.checkTileTriggers();
      this.checkPickups();
      this.checkPitFall();
    }
    this.forwardPlayerEvents();
    this.playerEvents.length = 0;

    if (this.state === 'dying' && this.player.deathAnimationFinished) {
      this.respawnOrFail();
    }

    this.particles.update(dtSec);
    this.camera.update(dtSec, this.player.body, this.player.body.vx, this.map, this.rng);
    return this.events;
  }

  /** Snapshot for tests, the browser test hooks and debugging. JSON-safe. */
  snapshot(): Record<string, unknown> {
    return {
      level: this.level.id,
      state: this.state,
      timeSec: Number(this.elapsed.toFixed(3)),
      score: this.scoreValue,
      lives: this.livesRemaining,
      deaths: this.deathCount,
      collected: this.collectedCount,
      player: {
        x: Number(this.player.body.x.toFixed(3)),
        y: Number(this.player.body.y.toFixed(3)),
        vx: Number(this.player.body.vx.toFixed(3)),
        vy: Number(this.player.body.vy.toFixed(3)),
        state: this.player.state,
        health: this.player.health,
        energy: Number(this.player.energy.toFixed(2)),
      },
    };
  }

  private timeBonus(): number {
    const spare = this.level.parTimeSec - this.elapsed;
    return spare <= 0 ? 0 : Math.round(spare * SCORE_TIME_BONUS_PER_SEC);
  }

  private forwardPlayerEvents(): void {
    for (const event of this.playerEvents) {
      this.events.push({ type: 'player', event });
      switch (event.type) {
        case 'land': {
          const strength = Math.min(1, Math.abs(event.impactSpeed) / LANDING_SHAKE_SPEED);
          this.particles.landingDust(
            this.player.centerX,
            this.player.body.y + PLAYER_HEIGHT,
            strength,
            this.rng,
          );
          if (strength > 0.8) this.camera.addShake(SHAKE_LANDING);
          break;
        }
        case 'jump':
          this.particles.landingDust(this.player.centerX, this.player.body.y + PLAYER_HEIGHT, 0.45, this.rng);
          break;
        case 'dash':
          this.particles.burst('spark', this.player.centerX, this.player.centerY, 10, this.rng, {
            speed: 110,
          });
          break;
        case 'footstep':
          this.particles.spawn({
            kind: 'dust',
            x: this.player.centerX - this.player.facing * 3,
            y: this.player.body.y + PLAYER_HEIGHT,
            vx: -this.player.facing * 14,
            vy: -8,
            life: 0.22,
          });
          break;
        case 'hurt':
          this.camera.addShake(SHAKE_HURT);
          this.particles.burst('spark', this.player.centerX, this.player.centerY, 14, this.rng, {
            speed: 130,
          });
          break;
        case 'die':
          this.beginDeath(this.pendingDeathCause);
          break;
        case 'thrustStart':
        case 'thrustStop':
        case 'energyEmpty':
        case 'ceilingBonk':
          break;
        default: {
          const exhaustive: never = event;
          throw new Error(`Unhandled player event: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  }

  private checkTileTriggers(): void {
    let hazardHit = false;
    for (const overlap of this.player.lastCollision.overlaps) {
      switch (overlap.kind) {
        case TileKind.Spike:
          hazardHit = true;
          break;
        case TileKind.Checkpoint:
          this.activateCheckpoint(overlap.tx, overlap.ty);
          break;
        case TileKind.Goal:
          this.completeLevel();
          break;
        case TileKind.Empty:
        case TileKind.Solid:
        case TileKind.OneWay:
        case TileKind.ConveyorLeft:
        case TileKind.ConveyorRight:
        case TileKind.Scenery:
          break;
        default: {
          const exhaustive: never = overlap.kind;
          throw new Error(`Unhandled overlap tile: ${String(exhaustive)}`);
        }
      }
    }
    if (hazardHit && this.state === 'playing') {
      this.damagePlayer(1, this.player.centerX, 'hazard');
    }
  }

  /**
   * Apply damage from a hazard or an enemy.
   *
   * The resulting hurt/die events land in the same batch as the player's own events for this step,
   * so `forwardPlayerEvents` handles the feedback and the death bookkeeping in one place.
   */
  damagePlayer(amount: number, sourceX: number, cause: DeathCause): boolean {
    this.pendingDeathCause = cause;
    return this.player.damage(amount, sourceX, this.playerEvents);
  }

  private beginDeath(cause: DeathCause): void {
    if (this.state === 'dying' || this.state === 'failed') return;
    this.state = 'dying';
    this.deathCount += 1;
    this.livesRemaining = Math.max(0, this.livesRemaining - 1);
    this.camera.addShake(SHAKE_DEATH);
    this.particles.burst('debris', this.player.centerX, this.player.centerY, 20, this.rng, {
      speed: 150,
      life: 0.8,
    });
    this.events.push({ type: 'death', cause, livesLeft: this.livesRemaining });
  }

  private checkPitFall(): void {
    if (this.player.body.y <= this.map.pixelHeight + 24) return;
    this.pendingDeathCause = 'pit';
    this.player.kill(this.playerEvents);
  }

  private respawnOrFail(): void {
    if (this.livesRemaining <= 0) {
      this.state = 'failed';
      this.events.push({ type: 'failed' });
      return;
    }
    this.state = 'playing';
    this.player.respawn(this.checkpointX, this.checkpointY);
    this.camera.snapTo(this.player.body, this.map);
    this.particles.clear();
    this.events.push({ type: 'respawn' });
  }

  private activateCheckpoint(tx: number, ty: number): void {
    const position = spawnPositionFor(tx, ty);
    if (position.x === this.checkpointX && position.y === this.checkpointY) return;
    this.checkpointX = position.x;
    this.checkpointY = position.y;
    this.particles.burst('ring', tx * this.map.tileSize + 8, ty * this.map.tileSize + 8, 3, this.rng, {
      speed: 10,
      life: 0.6,
    });
    this.events.push({ type: 'checkpoint', tx, ty });
  }

  private checkPickups(): void {
    const pickup = findCollidingPickup(this.pickups, this.player.body);
    if (pickup === null) return;
    const effect = PICKUP_EFFECTS[pickup.kind];
    if (pickup.kind === 'repairKit' && this.player.health >= 3) {
      // Leave full-health repair kits on the ground so they are not wasted.
      return;
    }
    pickup.collected = true;
    this.collectedCount += 1;
    this.scoreValue += effect.score;
    if (effect.energy > 0) this.player.addEnergy(effect.energy);
    if (effect.health > 0) this.player.heal(effect.health);
    this.particles.burst('pickup', pickup.x + pickup.width / 2, pickup.y + pickup.height / 2, 8, this.rng, {
      speed: 70,
      life: 0.5,
    });
    this.events.push({
      type: 'pickup',
      kind: pickup.kind,
      x: pickup.x,
      y: pickup.y,
      score: effect.score,
    });
  }

  private completeLevel(): void {
    if (this.state !== 'playing') return;
    this.state = 'complete';
    this.scoreValue += this.timeBonus();
    this.player.celebrate();
    this.particles.burst('ring', this.player.centerX, this.player.centerY, 4, this.rng, {
      speed: 8,
      life: 0.9,
    });
    this.events.push({ type: 'goal', timeSec: this.elapsed, score: this.scoreValue });
  }
}
