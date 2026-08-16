import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  CRUSHER_MAX_DROP,
  CRUSHER_REST_TIME,
  DRONE_CHASE_RANGE,
  ENEMY_DEATH_TIME,
  ProjectilePool,
  TURRET_COOLDOWN,
  TURRET_RANGE,
  WALKER_SPEED,
  createEnemy,
  damageEnemy,
  hasLineOfSight,
  isEnemyKind,
  isStompContact,
  isStompable,
  overlapsEnemy,
  sizeFor,
  updateEnemy,
} from '../../src/game/enemies';
import type { Enemy, EnemyEvent, EnemyKind } from '../../src/game/enemies';
import type { EntitySpawn } from '../../src/game/levelParser';
import { TILE_SIZE } from '../../src/game/tiles';
import type { TileMap } from '../../src/game/tilemap';
import { mapFromAscii } from '../fixtures/maps';

const DT = 1 / 60;

function spawnAt(tx: number, ty: number, kind: EnemyKind): EntitySpawn {
  return { kind, tx, ty, x: tx * TILE_SIZE + TILE_SIZE / 2, y: (ty + 1) * TILE_SIZE };
}

function makeEnemy(kind: EnemyKind, tx: number, ty: number, index = 0): Enemy {
  return createEnemy(spawnAt(tx, ty, kind), kind, index);
}

interface StepOptions {
  readonly playerBody?: { x: number; y: number; width: number; height: number };
  readonly playerAlive?: boolean;
  readonly projectiles?: ProjectilePool;
  readonly events?: EnemyEvent[];
  readonly frames?: number;
}

function stepEnemy(enemy: Enemy, map: TileMap, options: StepOptions = {}): EnemyEvent[] {
  const events = options.events ?? [];
  const projectiles = options.projectiles ?? new ProjectilePool(8);
  const playerBody = options.playerBody ?? { x: -1000, y: -1000, width: 10, height: 22 };
  const frames = options.frames ?? 1;
  for (let frame = 0; frame < frames; frame += 1) {
    updateEnemy(enemy, DT, {
      map,
      playerBody,
      playerAlive: options.playerAlive ?? true,
      rng: createRng(1),
      projectiles,
      events,
    });
    projectiles.update(DT, map);
  }
  return events;
}

describe('enemy basics', () => {
  it('recognises its kinds and sizes', () => {
    expect(isEnemyKind('walker')).toBe(true);
    expect(isEnemyKind('energyCell')).toBe(false);
    for (const kind of ['walker', 'drone', 'turret', 'crusher'] as const) {
      const size = sizeFor(kind);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
    expect(() => sizeFor('nope' as EnemyKind)).toThrow(/Unhandled enemy kind/);
  });

  it('spawns sitting on the tile below its marker', () => {
    const walker = makeEnemy('walker', 3, 5);
    expect(walker.body.x + walker.body.width / 2).toBe(3 * TILE_SIZE + TILE_SIZE / 2);
    expect(walker.body.y + walker.body.height).toBe(6 * TILE_SIZE);
  });

  it('only walkers and drones can be stomped', () => {
    expect(isStompable('walker')).toBe(true);
    expect(isStompable('drone')).toBe(true);
    expect(isStompable('turret')).toBe(false);
    expect(isStompable('crusher')).toBe(false);
  });
});

describe('walker', () => {
  const PLATFORM = mapFromAscii(['..........', '..........', '..........', '.########.', '.########.']);

  it('patrols and turns around at a ledge without walking off', () => {
    const walker = makeEnemy('walker', 5, 2);
    const startDirection = walker.direction;
    let turned = false;
    for (let frame = 0; frame < 600; frame += 1) {
      stepEnemy(walker, PLATFORM);
      if (walker.direction !== startDirection) turned = true;
      // Never leaves the platform (tiles 1..8) or falls.
      expect(walker.body.x).toBeGreaterThanOrEqual(TILE_SIZE - 1);
      expect(walker.body.x + walker.body.width).toBeLessThanOrEqual(9 * TILE_SIZE + 1);
      expect(walker.body.y + walker.body.height).toBeLessThanOrEqual(3 * TILE_SIZE + 1);
    }
    expect(turned).toBe(true);
  });

  it('moves at its patrol speed', () => {
    const walker = makeEnemy('walker', 4, 2);
    const startX = walker.body.x;
    stepEnemy(walker, PLATFORM, { frames: 30 });
    expect(Math.abs(walker.body.x - startX)).toBeCloseTo((WALKER_SPEED * 30) / 60, 0);
  });

  it('turns at a wall', () => {
    const WALLED = mapFromAscii(['..........', '.#......#.', '.#......#.', '.########.']);
    const walker = makeEnemy('walker', 2, 2);
    walker.direction = -1;
    stepEnemy(walker, WALLED, { frames: 60 });
    expect(walker.direction).toBe(1);
  });

  it('turns before walking into spikes', () => {
    const SPIKY = mapFromAscii(['..........', '..........', '....^.....', '.########.']);
    const walker = makeEnemy('walker', 2, 1);
    walker.direction = 1;
    let sawSpikeTurn = false;
    for (let frame = 0; frame < 240; frame += 1) {
      stepEnemy(walker, SPIKY);
      // Read through a widened local: TypeScript narrows the literal type after the assignment
      // above, but `updateEnemy` flips it.
      const direction: number = walker.direction;
      if (walker.body.x + walker.body.width < 4 * TILE_SIZE && direction === -1) sawSpikeTurn = true;
    }
    expect(sawSpikeTurn).toBe(true);
    // It never steps onto the spike tile.
    expect(walker.body.x).toBeLessThan(4 * TILE_SIZE);
  });
});

describe('drone', () => {
  const OPEN = mapFromAscii([
    '....................',
    '....................',
    '....................',
    '....................',
    '....................',
    '####################',
  ]);

  it('hovers around its home position when the player is far away', () => {
    const drone = makeEnemy('drone', 10, 2);
    const homeX = drone.body.x;
    stepEnemy(drone, OPEN, { frames: 240 });
    expect(Math.abs(drone.body.x - homeX)).toBeLessThan(6);
  });

  it('chases the player horizontally when in range', () => {
    const drone = makeEnemy('drone', 10, 2);
    const startX = drone.body.x;
    stepEnemy(drone, OPEN, {
      playerBody: { x: startX - 60, y: drone.body.y, width: 10, height: 22 },
      frames: 60,
    });
    expect(drone.body.x).toBeLessThan(startX - 10);
    expect(drone.direction).toBe(-1);
  });

  it('ignores a player outside its range', () => {
    const drone = makeEnemy('drone', 10, 2);
    const startX = drone.body.x;
    stepEnemy(drone, OPEN, {
      playerBody: { x: startX - DRONE_CHASE_RANGE - 60, y: drone.body.y, width: 10, height: 22 },
      frames: 60,
    });
    expect(Math.abs(drone.body.x - startX)).toBeLessThan(6);
  });

  it('ignores a dead player', () => {
    const drone = makeEnemy('drone', 10, 2);
    const startX = drone.body.x;
    stepEnemy(drone, OPEN, {
      playerBody: { x: startX - 40, y: drone.body.y, width: 10, height: 22 },
      playerAlive: false,
      frames: 60,
    });
    expect(Math.abs(drone.body.x - startX)).toBeLessThan(6);
  });
});

describe('turret', () => {
  const CORRIDOR = mapFromAscii([
    '....................',
    '....................',
    '....................',
    '####################',
  ]);

  it('fires at a player in range and respects its cooldown', () => {
    const turret = makeEnemy('turret', 3, 2);
    const projectiles = new ProjectilePool(8);
    const playerBody = { x: 8 * TILE_SIZE, y: turret.body.y, width: 10, height: 22 };
    // A short windup means no shot on the very first frame the player steps into range…
    stepEnemy(turret, CORRIDOR, { projectiles, playerBody, frames: 2 });
    expect(projectiles.activeCount).toBe(0);
    // …but one lands soon after.
    const events = stepEnemy(turret, CORRIDOR, { projectiles, playerBody, frames: 60 });
    expect(events.filter((event) => event.type === 'enemyShot').length).toBe(1);
    expect(projectiles.activeCount).toBe(1);

    // No second shot before the cooldown elapses…
    stepEnemy(turret, CORRIDOR, {
      projectiles,
      playerBody,
      events,
      frames: Math.floor((TURRET_COOLDOWN / 2) * 60),
    });
    expect(events.filter((event) => event.type === 'enemyShot').length).toBe(1);
    // …and exactly one more once it does.
    stepEnemy(turret, CORRIDOR, {
      projectiles,
      playerBody,
      events,
      frames: Math.ceil((TURRET_COOLDOWN / 2) * 60) + 4,
    });
    expect(events.filter((event) => event.type === 'enemyShot').length).toBe(2);
  });

  it('aims its bolts, so a turret on a ledge can hit the floor below', () => {
    const LEDGE = mapFromAscii([
      '....................',
      '....................',
      '..###...............',
      '....................',
      '....................',
      '####################',
    ]);
    // Turret perched at the right-hand end of the ledge, player on the floor below and to the
    // right. (Mounted mid-ledge its own platform would block the downward shot — as it should.)
    const turret = makeEnemy('turret', 4, 1);
    const projectiles = new ProjectilePool(8);
    stepEnemy(turret, LEDGE, {
      projectiles,
      playerBody: { x: 9 * TILE_SIZE, y: 5 * TILE_SIZE - 22, width: 10, height: 22 },
      frames: 60,
    });
    const bolt = projectiles.all.find((projectile) => projectile.active);
    expect(bolt).toBeDefined();
    // Travelling right and downwards, i.e. actually aimed at the player.
    expect(bolt?.vx ?? 0).toBeGreaterThan(0);
    expect(bolt?.vy ?? 0).toBeGreaterThan(0);
  });

  it('does not fire at a player out of range or with no line of sight', () => {
    const turret = makeEnemy('turret', 3, 2);
    const projectiles = new ProjectilePool(8);
    stepEnemy(turret, CORRIDOR, {
      projectiles,
      playerBody: { x: 3 * TILE_SIZE + TURRET_RANGE + 40, y: turret.body.y, width: 10, height: 22 },
      frames: 120,
    });
    expect(projectiles.activeCount).toBe(0);

    // Straight up through the level ceiling: no line of sight.
    stepEnemy(turret, CORRIDOR, {
      projectiles,
      playerBody: { x: 3 * TILE_SIZE, y: turret.body.y - 90, width: 10, height: 22 },
      frames: 120,
    });
    expect(projectiles.activeCount).toBe(0);
  });

  it('will not shoot through a wall', () => {
    const BLOCKED = mapFromAscii([
      '....................',
      '.....#..............',
      '.....#..............',
      '####################',
    ]);
    const turret = makeEnemy('turret', 3, 2);
    const projectiles = new ProjectilePool(8);
    stepEnemy(turret, BLOCKED, {
      projectiles,
      playerBody: { x: 8 * TILE_SIZE, y: turret.body.y, width: 10, height: 22 },
      frames: 120,
    });
    expect(projectiles.activeCount).toBe(0);
    expect(hasLineOfSight(BLOCKED, 3 * TILE_SIZE, 2.5 * TILE_SIZE, 8 * TILE_SIZE, 2.5 * TILE_SIZE)).toBe(
      false,
    );
    expect(hasLineOfSight(CORRIDOR, 3 * TILE_SIZE, 2.5 * TILE_SIZE, 8 * TILE_SIZE, 2.5 * TILE_SIZE)).toBe(
      true,
    );
  });

  it('cannot be stomped', () => {
    const turret = makeEnemy('turret', 3, 2);
    const events: EnemyEvent[] = [];
    expect(damageEnemy(turret, events)).toBe(false);
    expect(turret.state).toBe('active');
    expect(events).toEqual([]);
  });
});

describe('projectiles', () => {
  const OPEN = mapFromAscii(['..........', '..........', '##########']);

  it('travel, expire and stop at walls', () => {
    const pool = new ProjectilePool(4);
    pool.spawn(10, 10, 100, 0);
    expect(pool.activeCount).toBe(1);
    pool.update(DT, OPEN);
    const first = pool.all.find((projectile) => projectile.active);
    expect(first?.x).toBeCloseTo(10 + 100 / 60, 5);

    // Into the floor: absorbed.
    pool.spawn(20, 20, 0, 400);
    for (let frame = 0; frame < 10; frame += 1) pool.update(DT, OPEN);
    expect(pool.all.filter((projectile) => projectile.active && projectile.vy > 0).length).toBe(0);
  });

  it('has a bounded capacity and can be cleared', () => {
    const pool = new ProjectilePool(3);
    for (let i = 0; i < 10; i += 1) pool.spawn(i, 0, 10, 0);
    expect(pool.activeCount).toBe(3);
    pool.clear();
    expect(pool.activeCount).toBe(0);
  });

  it('detects hits against a body', () => {
    const pool = new ProjectilePool(4);
    pool.spawn(50, 50, 0, 0);
    expect(pool.findHit({ x: 48, y: 48, width: 6, height: 6 })).not.toBeNull();
    expect(pool.findHit({ x: 200, y: 200, width: 6, height: 6 })).toBeNull();
  });
});

describe('crusher', () => {
  const SHAFT = mapFromAscii([
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '..........',
    '##########',
  ]);

  it('rests, telegraphs, slams and winches back up', () => {
    const crusher = makeEnemy('crusher', 4, 1);
    const restY = crusher.body.y;
    const events: EnemyEvent[] = [];

    // Rest phase: stays put and is harmless.
    stepEnemy(crusher, SHAFT, { events, frames: Math.floor(CRUSHER_REST_TIME * 60) - 4 });
    expect(crusher.body.y).toBe(restY);
    expect(crusher.lethal).toBe(false);

    // Windup then slam.
    stepEnemy(crusher, SHAFT, { events, frames: 60 });
    expect(events.some((event) => event.type === 'crusherSlam')).toBe(true);
    expect(crusher.body.y).toBeGreaterThan(restY);

    // Bottoms out, reports an impact, then returns.
    stepEnemy(crusher, SHAFT, { events, frames: 120 });
    expect(events.some((event) => event.type === 'crusherImpact')).toBe(true);
    expect(crusher.lethal).toBe(false);
    stepEnemy(crusher, SHAFT, { events, frames: 300 });
    expect(crusher.body.y).toBeLessThanOrEqual(restY + CRUSHER_MAX_DROP);
  });

  it('cannot be destroyed', () => {
    const crusher = makeEnemy('crusher', 4, 1);
    expect(damageEnemy(crusher, [])).toBe(false);
    expect(crusher.state).toBe('active');
  });
});

describe('stomp resolution', () => {
  it('counts as a stomp only when descending onto the crown', () => {
    const walker = makeEnemy('walker', 5, 5);
    const above = { x: walker.body.x, y: walker.body.y - 20, width: 10, height: 22 };
    const beside = { x: walker.body.x - 8, y: walker.body.y + 2, width: 10, height: 22 };
    expect(isStompContact(above, 200, walker)).toBe(true);
    // Rising into it from below is not a stomp.
    expect(isStompContact(above, -200, walker)).toBe(false);
    // Walking into its side is not a stomp.
    expect(isStompContact(beside, 200, walker)).toBe(false);
    // Turrets are never stompable.
    const turret = makeEnemy('turret', 5, 5);
    expect(isStompContact({ ...above, y: turret.body.y - 20 }, 200, turret)).toBe(false);
  });

  it('kills a stomped enemy once and reports it', () => {
    const walker = makeEnemy('walker', 5, 5);
    const events: EnemyEvent[] = [];
    expect(damageEnemy(walker, events)).toBe(true);
    expect(walker.state).toBe('dying');
    expect(events).toEqual([
      {
        type: 'enemyKilled',
        kind: 'walker',
        x: walker.body.x + walker.body.width / 2,
        y: walker.body.y + walker.body.height / 2,
      },
    ]);
    // A second hit does nothing.
    expect(damageEnemy(walker, events)).toBe(false);
    expect(events.length).toBe(1);
  });

  it('dying enemies drop away and stop colliding', () => {
    const walker = makeEnemy('walker', 5, 5);
    const map = mapFromAscii([
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '##########',
    ]);
    damageEnemy(walker, []);
    const body = { x: walker.body.x, y: walker.body.y, width: 10, height: 10 };
    expect(overlapsEnemy(body, walker)).toBe(false);
    stepEnemy(walker, map, { frames: Math.ceil(ENEMY_DEATH_TIME * 60) + 2 });
    expect(walker.state).toBe('dead');
  });
});

describe('performance', () => {
  it('updates 200 enemies for 600 frames within budget', () => {
    const map = mapFromAscii([
      '................................................................',
      '................................................................',
      '................................................................',
      '................................................................',
      '################################################################',
      '################################################################',
    ]);
    const enemies: Enemy[] = [];
    for (let i = 0; i < 200; i += 1) {
      const kind: EnemyKind = i % 3 === 0 ? 'walker' : i % 3 === 1 ? 'drone' : 'turret';
      enemies.push(makeEnemy(kind, (i % 60) + 1, 3, i));
    }
    const projectiles = new ProjectilePool(64);
    const events: EnemyEvent[] = [];
    const playerBody = { x: 300, y: 40, width: 10, height: 22 };
    const rng = createRng(3);

    const started = performance.now();
    for (let frame = 0; frame < 600; frame += 1) {
      for (const enemy of enemies) {
        updateEnemy(enemy, DT, { map, playerBody, playerAlive: true, rng, projectiles, events });
      }
      projectiles.update(DT, map);
      events.length = 0;
    }
    const elapsedMs = performance.now() - started;
    // 120 000 enemy updates; generous ceiling so CI noise cannot make this flaky.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
