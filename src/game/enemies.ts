import { aabbOverlap, clamp, distance } from '../core/math';
import type { Rect } from '../core/math';
import type { Rng } from '../core/rng';
import type { EntitySpawn } from './levelParser';
import { createBody, createCollisionResult, moveAndCollide, probeGround } from './physics';
import type { Body, CollisionResult } from './physics';
import type { TileMap } from './tilemap';
import { TileKind, tileFlags } from './tiles';

/**
 * Enemies and their projectiles.
 *
 * Three archetypes, each teaching a different response:
 * - **Walker** — a patrol bot that turns at ledges and walls. Stomp it.
 * - **Drone** — hovers on a sine path and lunges horizontally when Optimus is close. Stomp it too,
 *   but it moves, so timing matters.
 * - **Turret** — bolted down, fires slow tracking bolts along its firing line. Cannot be stomped;
 *   it must be dodged or out-ranged.
 * - **Crusher** — a telegraphed slamming press. Instantly lethal at the bottom of its stroke.
 * - **Overseer** — the finale. A gantry crane that patrols overhead, rains bolts, then slams down and
 *   exposes its cooling core for exactly one stomp. Three stomps and the plant loses its manager.
 *
 * Everything lives in a flat array of `Enemy` records with a discriminated `kind`, updated by one
 * exhaustive switch, so adding an archetype is a compile error until it is handled everywhere.
 */

export type EnemyKind = 'walker' | 'drone' | 'turret' | 'crusher' | 'overseer';

export type EnemyState = 'active' | 'dying' | 'dead';

/** Overseer phases: patrol overhead → slam → sit exposed → winch back up. */
export type OverseerPhase = 'patrol' | 'slam' | 'exposed' | 'rise';

export interface Enemy {
  readonly kind: EnemyKind;
  readonly body: Body;
  state: EnemyState;
  /** Facing/patrol direction. */
  direction: 1 | -1;
  /** Seconds since spawn, for animation and cooldowns. */
  animTime: number;
  /** Countdown to the next shot (turrets) or the next phase (crushers). */
  timer: number;
  /** Home position, used by drones (sine centre) and crushers (rest position). */
  readonly homeX: number;
  readonly homeY: number;
  /** Sine phase offset so a row of drones does not move in lockstep. */
  readonly sinePhase: number;
  /** Remaining hits before dying (drones take one stomp, crushers are invincible). */
  hitPoints: number;
  /** Time left in the death animation. */
  deathTimer: number;
  /** Set while a crusher/boss is slamming — its contact is lethal. */
  lethal: boolean;
  /** Boss only: current phase of the encounter. */
  bossPhase: OverseerPhase;
  /** Boss only: seconds until the next volley. */
  volleyTimer: number;
  /** Boss only: patrol bounds in world pixels. */
  patrolMinX: number;
  patrolMaxX: number;
}

export interface Projectile {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export interface EnemyEvent {
  readonly type: 'enemyKilled' | 'enemyHurt' | 'enemyShot' | 'crusherSlam' | 'crusherImpact';
  readonly x: number;
  readonly y: number;
  readonly kind: EnemyKind;
}

// ── Tuning ──────────────────────────────────────────────────────────────────────────────────────
export const WALKER_SIZE = { width: 14, height: 12 } as const;
export const WALKER_SPEED = 42;
export const DRONE_SIZE = { width: 14, height: 10 } as const;
export const DRONE_HOVER_AMPLITUDE = 14;
export const DRONE_HOVER_SPEED = 1.8;
export const DRONE_CHASE_RANGE = 132;
export const DRONE_CHASE_SPEED = 62;
export const TURRET_SIZE = { width: 14, height: 14 } as const;
export const TURRET_RANGE = 176;
export const TURRET_COOLDOWN = 1.7;
export const TURRET_WINDUP = 0.45;
export const PROJECTILE_SPEED = 118;
export const PROJECTILE_SIZE = 5;
export const PROJECTILE_LIFE = 2;
export const CRUSHER_SIZE = { width: 30, height: 22 } as const;
export const CRUSHER_REST_TIME = 1.5;
export const CRUSHER_WINDUP_TIME = 0.45;
export const CRUSHER_SLAM_SPEED = 420;
export const CRUSHER_RETURN_SPEED = 46;
export const CRUSHER_MAX_DROP = 96;
export const ENEMY_DEATH_TIME = 0.4;

// ── Overseer (boss) ─────────────────────────────────────────────────────────────────────────────
export const OVERSEER_SIZE = { width: 46, height: 26 } as const;
export const OVERSEER_HIT_POINTS = 3;
/** Horizontal patrol speed; each hit taken makes it angrier (and faster). */
export const OVERSEER_PATROL_SPEED = 40;
export const OVERSEER_PATROL_SPEED_PER_HIT = 16;
export const OVERSEER_PATROL_TIME = 3.4;
export const OVERSEER_VOLLEY_INTERVAL = 1.15;
export const OVERSEER_SLAM_SPEED = 360;
export const OVERSEER_RISE_SPEED = 70;
/** How long the core stays exposed (and stompable) after a slam. */
export const OVERSEER_VULNERABLE_TIME = 3;
export const OVERSEER_MAX_DROP = 118;
/** Vertical band, measured from an enemy's top edge, in which a falling player counts as stomping. */
export const STOMP_TOLERANCE = 8;

export function isEnemyKind(kind: string): kind is EnemyKind {
  return (
    kind === 'walker' || kind === 'drone' || kind === 'turret' || kind === 'crusher' || kind === 'overseer'
  );
}

export function createEnemy(spawn: EntitySpawn, kind: EnemyKind, index: number): Enemy {
  const size = sizeFor(kind);
  // Spawn markers sit at the bottom-centre of their tile.
  const x = spawn.x - size.width / 2;
  const y = kind === 'crusher' ? spawn.y - size.height : spawn.y - size.height;
  const body = createBody(x, y, size.width, size.height);
  return {
    kind,
    body,
    state: 'active',
    direction: index % 2 === 0 ? 1 : -1,
    animTime: 0,
    // Turrets stagger their first shot so a bank of them does not fire in unison.
    timer: kind === 'turret' ? TURRET_WINDUP + (index % 4) * 0.25 : CRUSHER_REST_TIME,
    homeX: x,
    homeY: y,
    sinePhase: (index % 8) * 0.85,
    hitPoints: kind === 'overseer' ? OVERSEER_HIT_POINTS : 1,
    deathTimer: 0,
    lethal: false,
    bossPhase: 'patrol',
    volleyTimer: OVERSEER_VOLLEY_INTERVAL,
    // Patrol bounds are widened by the world once the arena is known; a sensible default keeps the
    // boss oscillating around its spawn if nobody sets them.
    patrolMinX: x - 60,
    patrolMaxX: x + 60,
  };
}

export function sizeFor(kind: EnemyKind): { readonly width: number; readonly height: number } {
  switch (kind) {
    case 'walker':
      return WALKER_SIZE;
    case 'drone':
      return DRONE_SIZE;
    case 'turret':
      return TURRET_SIZE;
    case 'crusher':
      return CRUSHER_SIZE;
    case 'overseer':
      return OVERSEER_SIZE;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled enemy kind: ${String(exhaustive)}`);
    }
  }
}

/** Can this enemy be killed by landing on it? */
export function isStompable(kind: EnemyKind): boolean {
  switch (kind) {
    case 'walker':
    case 'drone':
      return true;
    case 'turret':
    case 'crusher':
      return false;
    // The boss *is* stompable, but only while its core is exposed — see `isStompContact`.
    case 'overseer':
      return true;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled enemy kind: ${String(exhaustive)}`);
    }
  }
}

export interface EnemyUpdateContext {
  readonly map: TileMap;
  readonly playerBody: Rect;
  readonly playerAlive: boolean;
  readonly rng: Rng;
  readonly projectiles: ProjectilePool;
  readonly events: EnemyEvent[];
}

const scratchCollision: CollisionResult = createCollisionResult();

export function updateEnemy(enemy: Enemy, dtSec: number, context: EnemyUpdateContext): void {
  enemy.animTime += dtSec;

  if (enemy.state === 'dying') {
    enemy.deathTimer -= dtSec;
    // Dying enemies drop out of the world.
    enemy.body.vy += 900 * dtSec;
    enemy.body.y += enemy.body.vy * dtSec;
    if (enemy.deathTimer <= 0) enemy.state = 'dead';
    return;
  }
  if (enemy.state === 'dead') return;

  switch (enemy.kind) {
    case 'walker':
      updateWalker(enemy, dtSec, context);
      break;
    case 'drone':
      updateDrone(enemy, dtSec, context);
      break;
    case 'turret':
      updateTurret(enemy, dtSec, context);
      break;
    case 'crusher':
      updateCrusher(enemy, dtSec, context);
      break;
    case 'overseer':
      updateOverseer(enemy, dtSec, context);
      break;
    default: {
      const exhaustive: never = enemy.kind;
      throw new Error(`Unhandled enemy kind: ${String(exhaustive)}`);
    }
  }
}

function updateWalker(enemy: Enemy, dtSec: number, context: EnemyUpdateContext): void {
  const { map } = context;
  enemy.body.vx = enemy.direction * WALKER_SPEED;
  enemy.body.vy += 900 * dtSec;
  moveAndCollide(enemy.body, dtSec, map, scratchCollision);

  // Turn at a wall…
  if (scratchCollision.hitWallLeft || scratchCollision.hitWallRight) {
    enemy.direction = enemy.direction === 1 ? -1 : 1;
    return;
  }
  // …or at a ledge, so a patrol bot never walks off its platform.
  if (scratchCollision.onGround) {
    const probeX = enemy.direction === 1 ? enemy.body.x + enemy.body.width + 1 : enemy.body.x - 1;
    const groundAhead = probeGround({ ...enemy.body, x: probeX - 1, width: 2 }, map, map.tileSize).kind;
    // Spikes sit *on* the floor, so the dangerous tile is at body level ahead, not underfoot.
    const hazardAhead =
      map.tileAtPixel(probeX, enemy.body.y + enemy.body.height - 2) === TileKind.Spike ||
      map.tileAtPixel(probeX, enemy.body.y + enemy.body.height + 2) === TileKind.Spike;
    if (groundAhead === null || hazardAhead) {
      enemy.direction = enemy.direction === 1 ? -1 : 1;
    }
  }
}

function updateDrone(enemy: Enemy, dtSec: number, context: EnemyUpdateContext): void {
  const { map, playerBody, playerAlive } = context;
  const centerX = enemy.body.x + enemy.body.width / 2;
  const centerY = enemy.body.y + enemy.body.height / 2;
  const playerCenterX = playerBody.x + playerBody.width / 2;
  const playerCenterY = playerBody.y + playerBody.height / 2;
  const inRange =
    playerAlive && distance(centerX, centerY, playerCenterX, playerCenterY) <= DRONE_CHASE_RANGE;

  if (inRange) {
    // Lunge horizontally towards the player, keep bobbing vertically.
    enemy.direction = playerCenterX < centerX ? -1 : 1;
    enemy.body.vx = enemy.direction * DRONE_CHASE_SPEED;
  } else {
    // Drift back home.
    const towardsHome = enemy.homeX + enemy.body.width / 2 - centerX;
    enemy.body.vx = clamp(towardsHome * 2, -DRONE_CHASE_SPEED, DRONE_CHASE_SPEED);
  }

  const hoverY =
    enemy.homeY + Math.sin(enemy.animTime * DRONE_HOVER_SPEED + enemy.sinePhase) * DRONE_HOVER_AMPLITUDE;
  enemy.body.vy = (hoverY - enemy.body.y) / Math.max(dtSec, 1e-6);
  moveAndCollide(enemy.body, dtSec, map, scratchCollision, { useOneWay: false });
  if (scratchCollision.hitWallLeft || scratchCollision.hitWallRight) {
    enemy.direction = enemy.direction === 1 ? -1 : 1;
  }
}

/**
 * Turrets fire *aimed* bolts.
 *
 * Aiming is what makes turrets work as level furniture: they can be bolted to ledges and gantries
 * off the walking route — where the player can never be forced to touch them, since they cannot be
 * stomped — and still threaten. Straight horizontal fire would sail harmlessly over the player's
 * head from anywhere but their own floor.
 */
function updateTurret(enemy: Enemy, dtSec: number, context: EnemyUpdateContext): void {
  const { playerBody, playerAlive, projectiles, events, map } = context;
  enemy.timer -= dtSec;
  const centerX = enemy.body.x + enemy.body.width / 2;
  const centerY = enemy.body.y + enemy.body.height / 2;
  const playerCenterX = playerBody.x + playerBody.width / 2;
  const playerCenterY = playerBody.y + playerBody.height / 2;

  const dx = playerCenterX - centerX;
  const dy = playerCenterY - centerY;
  const distanceToPlayer = Math.hypot(dx, dy);
  const inRange = distanceToPlayer <= TURRET_RANGE;
  if (inRange && playerAlive) {
    enemy.direction = dx < 0 ? -1 : 1;
  }
  if (!inRange || !playerAlive || distanceToPlayer < 1) {
    enemy.timer = Math.max(enemy.timer, TURRET_WINDUP);
    return;
  }
  if (!hasLineOfSight(map, centerX, centerY, playerCenterX, playerCenterY)) {
    return;
  }
  if (enemy.timer > 0) return;

  enemy.timer = TURRET_COOLDOWN;
  const aimX = dx / distanceToPlayer;
  const aimY = dy / distanceToPlayer;
  projectiles.spawn(centerX + aimX * 9, centerY + aimY * 9, aimX * PROJECTILE_SPEED, aimY * PROJECTILE_SPEED);
  events.push({ type: 'enemyShot', x: centerX, y: centerY, kind: 'turret' });
}

/**
 * Crusher cycle: rest → windup → slam → return → rest.
 *
 * The timer is only consumed while parked at the top; the return stroke resets it. (It used to tick
 * during the slam and the return, so after its first cycle a press slammed the instant it finished
 * winching back up — no rest, no telegraph, and nothing could ever walk underneath.)
 */
function updateCrusher(enemy: Enemy, dtSec: number, context: EnemyUpdateContext): void {
  const { events } = context;
  const restY = enemy.homeY;
  const bottomLimit = restY + CRUSHER_MAX_DROP;

  if (enemy.lethal) {
    // Slamming down until it hits the floor or its limit.
    enemy.body.y += CRUSHER_SLAM_SPEED * dtSec;
    const hitFloor = context.map.overlapsSolid({
      x: enemy.body.x + 1,
      y: enemy.body.y + enemy.body.height,
      width: enemy.body.width - 2,
      height: 2,
    });
    if (enemy.body.y >= bottomLimit || hitFloor) {
      enemy.body.y = Math.min(enemy.body.y, bottomLimit);
      enemy.lethal = false;
      // Rest is counted from the moment it is parked again, not from the impact.
      enemy.timer = CRUSHER_REST_TIME;
      events.push({
        type: 'crusherImpact',
        x: enemy.body.x + enemy.body.width / 2,
        y: enemy.body.y + enemy.body.height,
        kind: 'crusher',
      });
    }
    return;
  }

  if (enemy.body.y > restY) {
    // Winching back up; the rest timer restarts once it is home.
    enemy.body.y = Math.max(restY, enemy.body.y - CRUSHER_RETURN_SPEED * dtSec);
    if (enemy.body.y <= restY) enemy.timer = CRUSHER_REST_TIME;
    return;
  }
  enemy.timer -= dtSec;
  if (enemy.timer <= -CRUSHER_WINDUP_TIME) {
    enemy.lethal = true;
    enemy.timer = 0;
    events.push({
      type: 'crusherSlam',
      x: enemy.body.x + enemy.body.width / 2,
      y: enemy.body.y,
      kind: 'crusher',
    });
  }
}

/**
 * The Overseer: the finale encounter.
 *
 * A four-phase loop built from the same primitives as the rest of the cast:
 * 1. **patrol** — tracks the player along its gantry, dropping aimed volleys (turret behaviour).
 * 2. **slam** — drops like a press; contact is lethal (crusher behaviour).
 * 3. **exposed** — sits on the floor with its cooling core open: the only window to stomp it.
 * 4. **rise** — winches back up and starts again, faster and angrier for each hit taken.
 *
 * The player is never required to touch it outside the exposed window, so the fight is about
 * reading the telegraph rather than trading damage.
 */
function updateOverseer(enemy: Enemy, dtSec: number, context: EnemyUpdateContext): void {
  const { playerBody, playerAlive, projectiles, events, map, rng } = context;
  const hitsTaken = OVERSEER_HIT_POINTS - enemy.hitPoints;
  const centerX = enemy.body.x + enemy.body.width / 2;

  switch (enemy.bossPhase) {
    case 'patrol': {
      enemy.lethal = false;
      // Chase the player horizontally within the gantry limits.
      const playerCenterX = playerBody.x + playerBody.width / 2;
      const speed = OVERSEER_PATROL_SPEED + hitsTaken * OVERSEER_PATROL_SPEED_PER_HIT;
      const towards = Math.sign(playerCenterX - centerX);
      enemy.direction = towards < 0 ? -1 : 1;
      enemy.body.x = clamp(
        enemy.body.x + towards * speed * dtSec,
        enemy.patrolMinX,
        Math.max(enemy.patrolMinX, enemy.patrolMaxX - enemy.body.width),
      );
      enemy.body.y = enemy.homeY;

      /*
       * The Overseer only engages targets inside its bay.
       *
       * Firing at the doorway from across the room made the approach a coin-flip: there is no cover
       * on the threshold, so the only counterplay was luck. Now stepping out of the bay is a real
       * option, which is what makes the "wait for the slam, then rush the core" rhythm readable.
       */
      const playerInBay =
        playerBody.x + playerBody.width > enemy.patrolMinX && playerBody.x < enemy.patrolMaxX;
      enemy.volleyTimer -= dtSec;
      if (enemy.volleyTimer <= 0 && playerAlive && playerInBay) {
        enemy.volleyTimer = Math.max(0.55, OVERSEER_VOLLEY_INTERVAL - hitsTaken * 0.18);
        // A short spread of aimed bolts from the underside of the gantry.
        const muzzleY = enemy.body.y + enemy.body.height;
        const spread = 0.22;
        const baseAngle = Math.atan2(
          playerBody.y + playerBody.height / 2 - muzzleY,
          playerBody.x + playerBody.width / 2 - centerX,
        );
        for (let i = -1; i <= 1; i += 1) {
          const angle = baseAngle + i * spread + rng.signedRange(0.04);
          projectiles.spawn(
            centerX + i * 12,
            muzzleY + 2,
            Math.cos(angle) * PROJECTILE_SPEED,
            Math.sin(angle) * PROJECTILE_SPEED,
          );
        }
        events.push({ type: 'enemyShot', x: centerX, y: muzzleY, kind: 'overseer' });
      }

      enemy.timer -= dtSec;
      if (enemy.timer <= 0) {
        enemy.bossPhase = 'slam';
        enemy.lethal = true;
        // The slam is a reset beat: it clears the air so the stomp window is a clean sprint rather
        // than a run through leftover bolts.
        projectiles.clear();
        events.push({ type: 'crusherSlam', x: centerX, y: enemy.body.y, kind: 'overseer' });
      }
      break;
    }
    case 'slam': {
      enemy.body.y += OVERSEER_SLAM_SPEED * dtSec;
      const hitFloor = map.overlapsSolid({
        x: enemy.body.x + 2,
        y: enemy.body.y + enemy.body.height,
        width: enemy.body.width - 4,
        height: 2,
      });
      if (enemy.body.y >= enemy.homeY + OVERSEER_MAX_DROP || hitFloor) {
        enemy.bossPhase = 'exposed';
        enemy.lethal = false;
        enemy.timer = OVERSEER_VULNERABLE_TIME;
        events.push({
          type: 'crusherImpact',
          x: centerX,
          y: enemy.body.y + enemy.body.height,
          kind: 'overseer',
        });
      }
      break;
    }
    case 'exposed': {
      enemy.timer -= dtSec;
      if (enemy.timer <= 0) {
        enemy.bossPhase = 'rise';
      }
      break;
    }
    case 'rise': {
      enemy.body.y = Math.max(enemy.homeY, enemy.body.y - OVERSEER_RISE_SPEED * dtSec);
      if (enemy.body.y <= enemy.homeY) {
        enemy.bossPhase = 'patrol';
        enemy.timer = Math.max(1.4, OVERSEER_PATROL_TIME - hitsTaken * 0.6);
        enemy.volleyTimer = 0.4;
      }
      break;
    }
    default: {
      const exhaustive: never = enemy.bossPhase;
      throw new Error(`Unhandled overseer phase: ${String(exhaustive)}`);
    }
  }
}

/** Is the boss' core exposed, i.e. can it be hurt right now? */
export function isOverseerVulnerable(enemy: Enemy): boolean {
  return enemy.kind === 'overseer' && enemy.bossPhase === 'exposed' && enemy.state === 'active';
}

/**
 * Does touching this enemy hurt?
 *
 * The boss is inert while its core is open and while it retracts: landing a stomp and then being
 * punished for standing next to the thing you just hit is the kind of unfairness that makes a fight
 * feel broken rather than hard.
 */
export function contactDamages(enemy: Enemy): boolean {
  if (enemy.state !== 'active') return false;
  if (enemy.kind !== 'overseer') return true;
  return enemy.bossPhase === 'patrol' || enemy.bossPhase === 'slam';
}

/** Set the gantry the boss patrols along (called by the world once the arena is known). */
export function setOverseerPatrolBounds(enemy: Enemy, minX: number, maxX: number): void {
  enemy.patrolMinX = minX;
  enemy.patrolMaxX = maxX;
}

/** Is the crusher winding up (shaking) rather than resting? */
export function isCrusherWindingUp(enemy: Enemy): boolean {
  return enemy.kind === 'crusher' && !enemy.lethal && enemy.timer <= 0 && enemy.body.y <= enemy.homeY;
}

/** Straight horizontal line-of-sight check along a row of tiles. */
export function hasLineOfSight(
  map: TileMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const steps = Math.ceil(Math.abs(toX - fromX) / (map.tileSize / 2));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const x = fromX + (toX - fromX) * t;
    const y = fromY + (toY - fromY) * t;
    if (tileFlags(map.tileAtPixel(x, y)).solid) return false;
  }
  return true;
}

/** Kill an enemy (stomp, projectile, scripted event). Returns false if it was already dying. */
export function damageEnemy(enemy: Enemy, events: EnemyEvent[]): boolean {
  if (enemy.state !== 'active') return false;
  if (!isStompable(enemy.kind)) return false;
  if (enemy.kind === 'overseer' && !isOverseerVulnerable(enemy)) return false;
  enemy.hitPoints -= 1;
  if (enemy.hitPoints > 0) {
    // Survived: the boss recoils, closes up and immediately starts winching away.
    if (enemy.kind === 'overseer') {
      enemy.bossPhase = 'rise';
      enemy.timer = 0;
      events.push({
        type: 'enemyHurt',
        x: enemy.body.x + enemy.body.width / 2,
        y: enemy.body.y,
        kind: enemy.kind,
      });
    }
    return false;
  }
  enemy.state = 'dying';
  enemy.deathTimer = ENEMY_DEATH_TIME;
  enemy.body.vx = 0;
  enemy.body.vy = -90;
  enemy.lethal = false;
  events.push({
    type: 'enemyKilled',
    x: enemy.body.x + enemy.body.width / 2,
    y: enemy.body.y + enemy.body.height / 2,
    kind: enemy.kind,
  });
  return true;
}

/**
 * Did the player land on this enemy?
 *
 * Requires downward motion and feet near the enemy's top edge; anything else is a side hit. The
 * tolerance band stops fast falls from "phasing" past the top of a short enemy in a single step.
 */
export function isStompContact(playerBody: Rect, playerVy: number, enemy: Enemy): boolean {
  if (playerVy <= 0) return false;
  if (!isStompable(enemy.kind)) return false;
  // The boss is only stompable during its exposed window; at any other time it is solid death.
  if (enemy.kind === 'overseer' && !isOverseerVulnerable(enemy)) return false;
  const feet = playerBody.y + playerBody.height;
  return feet <= enemy.body.y + STOMP_TOLERANCE;
}

export function enemyHitbox(enemy: Enemy): Rect {
  return enemy.body;
}

export function overlapsEnemy(playerBody: Rect, enemy: Enemy): boolean {
  if (enemy.state !== 'active') return false;
  return aabbOverlap(playerBody, enemy.body);
}

/** Fixed-capacity projectile pool: turret bolts never allocate mid-fight. */
export class ProjectilePool {
  private readonly pool: Projectile[];

  constructor(capacity = 48) {
    this.pool = Array.from({ length: capacity }, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
    }));
  }

  get all(): readonly Projectile[] {
    return this.pool;
  }

  get activeCount(): number {
    return this.pool.reduce((count, projectile) => count + (projectile.active ? 1 : 0), 0);
  }

  spawn(x: number, y: number, vx: number, vy: number): void {
    const projectile = this.pool.find((candidate) => !candidate.active);
    if (projectile === undefined) return;
    projectile.active = true;
    projectile.x = x;
    projectile.y = y;
    projectile.vx = vx;
    projectile.vy = vy;
    projectile.life = PROJECTILE_LIFE;
  }

  clear(): void {
    for (const projectile of this.pool) projectile.active = false;
  }

  update(dtSec: number, map: TileMap): void {
    for (const projectile of this.pool) {
      if (!projectile.active) continue;
      projectile.life -= dtSec;
      projectile.x += projectile.vx * dtSec;
      projectile.y += projectile.vy * dtSec;
      const hitsWall = tileFlags(map.tileAtPixel(projectile.x, projectile.y)).solid;
      if (projectile.life <= 0 || hitsWall) {
        projectile.active = false;
      }
    }
  }

  /** Rect of a projectile, for collision tests and rendering. */
  static rectOf(projectile: Projectile): Rect {
    return {
      x: projectile.x - PROJECTILE_SIZE / 2,
      y: projectile.y - PROJECTILE_SIZE / 2,
      width: PROJECTILE_SIZE,
      height: PROJECTILE_SIZE,
    };
  }

  /** First active projectile overlapping `body`, or null. */
  findHit(body: Rect): Projectile | null {
    for (const projectile of this.pool) {
      if (!projectile.active) continue;
      if (aabbOverlap(body, ProjectilePool.rectOf(projectile))) return projectile;
    }
    return null;
  }
}
