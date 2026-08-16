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
 *
 * Everything lives in a flat array of `Enemy` records with a discriminated `kind`, updated by one
 * exhaustive switch, so adding an archetype is a compile error until it is handled everywhere.
 */

export type EnemyKind = 'walker' | 'drone' | 'turret' | 'crusher';

export type EnemyState = 'active' | 'dying' | 'dead';

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
  readonly phase: number;
  /** Remaining hits before dying (drones take one stomp, crushers are invincible). */
  hitPoints: number;
  /** Time left in the death animation. */
  deathTimer: number;
  /** Set while a crusher is slamming — its contact is lethal. */
  lethal: boolean;
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
  readonly type: 'enemyKilled' | 'enemyShot' | 'crusherSlam' | 'crusherImpact';
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
export const PROJECTILE_LIFE = 3.2;
export const CRUSHER_SIZE = { width: 30, height: 22 } as const;
export const CRUSHER_REST_TIME = 1.5;
export const CRUSHER_WINDUP_TIME = 0.45;
export const CRUSHER_SLAM_SPEED = 420;
export const CRUSHER_RETURN_SPEED = 46;
export const CRUSHER_MAX_DROP = 96;
export const ENEMY_DEATH_TIME = 0.4;
/** Vertical band, measured from an enemy's top edge, in which a falling player counts as stomping. */
export const STOMP_TOLERANCE = 8;

export function isEnemyKind(kind: string): kind is EnemyKind {
  return kind === 'walker' || kind === 'drone' || kind === 'turret' || kind === 'crusher';
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
    phase: (index % 8) * 0.85,
    hitPoints: kind === 'turret' ? 1 : 1,
    deathTimer: 0,
    lethal: false,
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
    enemy.homeY + Math.sin(enemy.animTime * DRONE_HOVER_SPEED + enemy.phase) * DRONE_HOVER_AMPLITUDE;
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
  enemy.hitPoints -= 1;
  if (enemy.hitPoints > 0) return false;
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
