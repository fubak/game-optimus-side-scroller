import { describe, expect, it } from 'vitest';
import { ScriptedInput } from '../../src/core/input';
import {
  OVERSEER_HIT_POINTS,
  OVERSEER_VULNERABLE_TIME,
  contactDamages,
  damageEnemy,
  isOverseerVulnerable,
  isStompContact,
} from '../../src/game/enemies';
import type { Enemy } from '../../src/game/enemies';
import { LEVEL_4 } from '../../src/game/levels/level4';
import { DT, countEventType, createWorld, runWorldWithBot } from '../fixtures/worldHarness';

/**
 * The Overseer encounter.
 *
 * The fight is a rhythm: it patrols and shoots, slams, opens its core for a moment, then retracts.
 * These tests pin that rhythm down, along with the two fairness rules that make it playable — the
 * boss is inert while open or retracting, and the extraction hatch stays sealed until it is dead.
 */

function bossOf(world: ReturnType<typeof createWorld>): Enemy {
  const boss = world.boss;
  if (boss === null) throw new Error('Level 4 has no boss.');
  return boss;
}

/** Advance the world until a predicate holds, returning the frame count (or throwing). */
function advanceUntil(
  world: ReturnType<typeof createWorld>,
  predicate: () => boolean,
  limit = 60 * 60,
): number {
  const input = new ScriptedInput([]);
  for (let frame = 0; frame < limit; frame += 1) {
    if (predicate()) return frame;
    world.update(DT, input);
  }
  throw new Error('Condition never became true.');
}

describe('Overseer phases', () => {
  it('cycles patrol → slam → exposed → rise', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    // Put the player inside the bay so the boss engages.
    world.player.body.x = boss.patrolMinX + 60;
    expect(boss.bossPhase).toBe('patrol');

    advanceUntil(world, () => boss.bossPhase === 'slam');
    expect(boss.lethal).toBe(true);

    advanceUntil(world, () => boss.bossPhase === 'exposed');
    expect(boss.lethal).toBe(false);
    expect(isOverseerVulnerable(boss)).toBe(true);

    advanceUntil(world, () => boss.bossPhase === 'rise');
    expect(isOverseerVulnerable(boss)).toBe(false);

    advanceUntil(world, () => boss.bossPhase === 'patrol');
    expect(boss.body.y).toBeCloseTo(boss.homeY, 1);
  });

  it('fires volleys at a player inside the bay, and holds fire outside it', () => {
    const inside = createWorld(LEVEL_4, { lives: 99 });
    const insideBoss = bossOf(inside);
    inside.player.body.x = insideBoss.patrolMinX + 80;
    const input = new ScriptedInput([]);
    let shotsInside = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      shotsInside += inside.update(DT, input).filter((event) => event.type === 'enemyShot').length;
    }
    expect(shotsInside).toBeGreaterThan(0);

    const outside = createWorld(LEVEL_4, { lives: 99 });
    const outsideBoss = bossOf(outside);
    outside.player.body.x = outsideBoss.patrolMinX - 140;
    let shotsOutside = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      shotsOutside += outside.update(DT, input).filter((event) => event.type === 'enemyShot').length;
    }
    expect(shotsOutside).toBe(0);
  });

  it('tracks the player along its gantry without leaving the bay', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    const input = new ScriptedInput([]);
    world.player.body.x = boss.patrolMinX + 4;
    for (let frame = 0; frame < 300; frame += 1) world.update(DT, input);
    expect(boss.body.x).toBeGreaterThanOrEqual(boss.patrolMinX - 1);
    expect(boss.body.x + boss.body.width).toBeLessThanOrEqual(boss.patrolMaxX + 1);
    // It moved towards the player's side of the arena.
    expect(boss.body.x).toBeLessThan(boss.homeX);
  });
});

describe('Overseer damage rules', () => {
  it('can only be hurt while its core is exposed', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    world.player.body.x = boss.patrolMinX + 60;

    expect(damageEnemy(boss, [])).toBe(false);
    expect(boss.hitPoints).toBe(OVERSEER_HIT_POINTS);

    advanceUntil(world, () => isOverseerVulnerable(boss));
    const events: Parameters<typeof damageEnemy>[1] = [];
    expect(damageEnemy(boss, events)).toBe(false); // survives, but takes the hit
    expect(boss.hitPoints).toBe(OVERSEER_HIT_POINTS - 1);
    expect(events.some((event) => event.type === 'enemyHurt')).toBe(true);
    // Being hit closes it up immediately.
    expect(boss.bossPhase).toBe('rise');
    expect(isOverseerVulnerable(boss)).toBe(false);
  });

  it('dies after three hits', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    world.player.body.x = boss.patrolMinX + 60;
    for (let hit = 0; hit < OVERSEER_HIT_POINTS - 1; hit += 1) {
      advanceUntil(world, () => isOverseerVulnerable(boss));
      damageEnemy(boss, []);
    }
    expect(boss.hitPoints).toBe(1);
    advanceUntil(world, () => isOverseerVulnerable(boss));
    expect(damageEnemy(boss, [])).toBe(true);
    expect(boss.state).toBe('dying');
  });

  it('is only stompable while open, and is deadly while slamming', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    const above = { x: boss.body.x + 10, y: boss.body.y - 24, width: 10, height: 22 };

    expect(isStompContact(above, 200, boss)).toBe(false);
    expect(contactDamages(boss)).toBe(true);

    world.player.body.x = boss.patrolMinX + 60;
    advanceUntil(world, () => isOverseerVulnerable(boss));
    const openTarget = { x: boss.body.x + 10, y: boss.body.y - 24, width: 10, height: 22 };
    expect(isStompContact(openTarget, 200, boss)).toBe(true);
    // While open (and while retracting) touching it is harmless.
    expect(contactDamages(boss)).toBe(false);
  });

  it('keeps its exposed window roughly as long as advertised', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    world.player.body.x = boss.patrolMinX + 60;
    advanceUntil(world, () => isOverseerVulnerable(boss));
    const frames = advanceUntil(world, () => !isOverseerVulnerable(boss));
    expect(frames / 60).toBeGreaterThan(OVERSEER_VULNERABLE_TIME * 0.7);
    expect(frames / 60).toBeLessThan(OVERSEER_VULNERABLE_TIME * 1.4);
  });
});

describe('the extraction hatch', () => {
  it('stays sealed while the Overseer lives', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    expect(world.isGoalLocked).toBe(true);

    // Teleport onto the hatch: it must refuse and say so.
    const goal = world.level.goals[0];
    expect(goal).toBeDefined();
    world.player.body.x = (goal?.tx ?? 0) * 16 + 3;
    world.player.body.y = ((goal?.ty ?? 0) + 1) * 16 - 22;
    const input = new ScriptedInput([]);
    let locked = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      locked += world.update(DT, input).filter((event) => event.type === 'goalLocked').length;
    }
    expect(locked).toBeGreaterThan(0);
    expect(world.status).toBe('playing');

    // Kill the boss and try again.
    boss.state = 'dead';
    expect(world.isGoalLocked).toBe(false);
    for (let frame = 0; frame < 10 && world.status === 'playing'; frame += 1) {
      world.update(DT, input);
    }
    expect(world.status).toBe('complete');
  });

  it('is not locked on levels without a boss', () => {
    const world = createWorld(
      {
        id: 'no-boss',
        name: 'NO BOSS',
        subtitle: 'TEST',
        parTimeSec: 10,
        rows: ['..........', '.P.......G', '##########'],
      },
      {},
    );
    expect(world.boss).toBeNull();
    expect(world.isGoalLocked).toBe(false);
  });
});

describe('boss HUD gating', () => {
  it('only counts the fight as engaged once the player is at the bay', () => {
    const world = createWorld(LEVEL_4, { lives: 99 });
    const boss = bossOf(world);
    expect(world.isBossEngaged).toBe(false);
    world.player.body.x = boss.patrolMinX + 40;
    expect(world.isBossEngaged).toBe(true);
    boss.state = 'dead';
    expect(world.isBossEngaged).toBe(false);
  });
});

describe('the finale is winnable', () => {
  it('the autopilot beats the Overseer and reaches the hatch', () => {
    const run = runWorldWithBot(LEVEL_4, { frames: 60 * 240, stopWhenFinished: true, lives: 99 });
    expect(run.world.status).toBe('complete');
    expect(run.world.boss?.state).not.toBe('active');
    expect(countEventType(run, 'goal')).toBe(1);
    // Killing the boss is worth reporting.
    const kills = run.events.filter((event) => event.type === 'enemyKilled' && event.kind === 'overseer');
    expect(kills).toHaveLength(1);
  });
});
