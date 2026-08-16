import { describe, expect, it } from 'vitest';
import { ScriptedInput, buildTape } from '../../src/core/input';
import { HEALTH_MAX, SCORE_ENEMY } from '../../src/game/constants';
import type { LevelDef } from '../../src/game/levelParser';
import { DT, countEventType, createWorld, runWorldWithTape } from '../fixtures/worldHarness';

/**
 * Combat integration: the player, the enemies and the world rules together.
 */

function def(rows: readonly string[], overrides: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 'combat-test',
    name: 'COMBAT',
    subtitle: 'TEST',
    parTimeSec: 60,
    seed: 9,
    rows,
    ...overrides,
  };
}

describe('stomping', () => {
  const WALKER_LEVEL = def([
    '..................',
    '..................',
    '..................',
    '.P.......w.......G',
    '##################',
  ]);

  it('stomping a walker kills it, bounces the player and scores', () => {
    const world = createWorld(WALKER_LEVEL);
    const walker = world.enemies[0]!;
    // Drop onto the walker from above.
    world.player.body.x = walker.body.x + 2;
    world.player.body.y = walker.body.y - 30;
    world.player.body.vy = 220;
    const input = new ScriptedInput([]);
    const events: unknown[] = [];
    for (let frame = 0; frame < 40; frame += 1) {
      events.push(...world.update(DT, input));
      input.endFrame();
    }
    expect(walker.state).not.toBe('active');
    expect(world.score).toBeGreaterThanOrEqual(SCORE_ENEMY);
    expect(world.player.health).toBe(HEALTH_MAX);
    // Bounced upwards at some point after the stomp.
    expect(world.player.body.y).toBeLessThan(walker.body.y);
  });

  it('walking into a walker hurts the player instead', () => {
    const run = runWorldWithTape(WALKER_LEVEL, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 300,
      stopWhenFinished: true,
    });
    const hurt = run.events.filter((event) => event.type === 'player' && event.event.type === 'hurt');
    expect(hurt.length).toBeGreaterThan(0);
    expect(run.world.player.health).toBeLessThan(HEALTH_MAX);
  });

  it('invulnerability prevents repeated damage from the same enemy', () => {
    const world = createWorld(WALKER_LEVEL);
    const walker = world.enemies[0]!;
    world.player.body.x = walker.body.x - 6;
    world.player.body.y = walker.body.y;
    const input = new ScriptedInput([]);
    let hurtCount = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      for (const event of world.update(DT, input)) {
        if (event.type === 'player' && event.event.type === 'hurt') hurtCount += 1;
      }
      input.endFrame();
    }
    expect(hurtCount).toBe(1);
  });

  it('a held jump makes the stomp bounce higher', () => {
    const bounce = (holdJump: boolean): number => {
      const world = createWorld(WALKER_LEVEL);
      const walker = world.enemies[0]!;
      world.player.body.x = walker.body.x + 2;
      world.player.body.y = walker.body.y - 26;
      world.player.body.vy = 200;
      const input = new ScriptedInput(
        holdJump ? buildTape([{ action: 'jump', start: 0, duration: 200 }]) : [],
      );
      let peak = world.player.body.y;
      for (let frame = 0; frame < 60; frame += 1) {
        world.update(DT, input);
        input.endFrame();
        peak = Math.min(peak, world.player.body.y);
      }
      return peak;
    };
    // Holding jump reaches a higher point (smaller y).
    expect(bounce(true)).toBeLessThan(bounce(false));
  });
});

describe('turret fire', () => {
  const TURRET_LEVEL = def([
    '....................',
    '....................',
    '....................',
    '.P........t........G',
    '####################',
  ]);

  it('hits the player, damages them and consumes the bolt', () => {
    const run = runWorldWithTape(TURRET_LEVEL, { frames: 240 });
    const shots = countEventType(run, 'enemyShot');
    expect(shots).toBeGreaterThan(0);
    // The player is standing still in the firing line, so a bolt eventually connects.
    const hurt = run.events.filter((event) => event.type === 'player' && event.event.type === 'hurt');
    expect(hurt.length).toBeGreaterThan(0);
    expect(run.world.projectiles.activeCount).toBeLessThan(shots + 1);
  });

  it('bolts stop at walls without hurting anyone', () => {
    const BLOCKED = def([
      '....................',
      '....................',
      '.....#..............',
      '.P...#....t........G',
      '####################',
    ]);
    const run = runWorldWithTape(BLOCKED, { frames: 240 });
    const hurt = run.events.filter((event) => event.type === 'player' && event.event.type === 'hurt');
    expect(hurt.length).toBe(0);
  });
});

describe('crushers', () => {
  const CRUSHER_LEVEL = def([
    '..................',
    '....x.............',
    '..................',
    '..................',
    '.P...............G',
    '##################',
  ]);

  it('slams and instantly kills the player underneath', () => {
    const world = createWorld(CRUSHER_LEVEL);
    const crusher = world.enemies[0]!;
    // Park the player directly under the press.
    world.player.body.x = crusher.body.x + crusher.body.width / 2 - 5;
    const input = new ScriptedInput([]);
    let deathCause = '';
    for (let frame = 0; frame < 300; frame += 1) {
      for (const event of world.update(DT, input)) {
        if (event.type === 'death') deathCause = event.cause;
      }
      input.endFrame();
      if (deathCause !== '') break;
    }
    expect(deathCause).toBe('crushed');
  });

  it('is safe to stand next to while it slams', () => {
    const world = createWorld(CRUSHER_LEVEL);
    const crusher = world.enemies[0]!;
    world.player.body.x = crusher.body.x + crusher.body.width + 8;
    const input = new ScriptedInput([]);
    for (let frame = 0; frame < 300; frame += 1) {
      world.update(DT, input);
      input.endFrame();
    }
    expect(world.player.health).toBe(HEALTH_MAX);
    expect(world.status).toBe('playing');
  });
});

describe('drones', () => {
  const DRONE_LEVEL = def([
    '..................',
    '..................',
    '.......d..........',
    '..................',
    '.P...............G',
    '##################',
  ]);

  it('chases and hurts the player, and can be stomped', () => {
    const chasing = runWorldWithTape(DRONE_LEVEL, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 300,
      stopWhenFinished: true,
    });
    const drone = chasing.world.enemies[0]!;
    // Either the drone caught the player or the player stomped it: both are valid outcomes, but
    // something must have happened — a drone that ignores the player is a bug.
    const interacted =
      chasing.world.player.health < HEALTH_MAX ||
      drone.state !== 'active' ||
      Math.abs(drone.body.x - drone.homeX) > 12;
    expect(interacted).toBe(true);
  });

  it('stomping a drone scores and clears it', () => {
    const world = createWorld(DRONE_LEVEL);
    const drone = world.enemies[0]!;
    world.player.body.x = drone.body.x + 2;
    world.player.body.y = drone.body.y - 26;
    world.player.body.vy = 240;
    const input = new ScriptedInput([]);
    for (let frame = 0; frame < 30; frame += 1) {
      world.update(DT, input);
      input.endFrame();
    }
    expect(drone.state).not.toBe('active');
    expect(world.score).toBeGreaterThanOrEqual(SCORE_ENEMY);
  });
});

describe('hit stop', () => {
  it('freezes the simulation briefly on impact but keeps the clock honest', () => {
    const world = createWorld(
      def([
        '..................',
        '..................',
        '..................',
        '.P.......w.......G',
        '##################',
      ]),
    );
    const walker = world.enemies[0]!;
    world.player.body.x = walker.body.x + 2;
    world.player.body.y = walker.body.y - 28;
    world.player.body.vy = 240;
    const input = new ScriptedInput([]);

    let stompFrame = -1;
    const positions: number[] = [];
    for (let frame = 0; frame < 30; frame += 1) {
      const events = world.update(DT, input);
      input.endFrame();
      positions.push(world.player.body.y);
      if (events.some((event) => event.type === 'enemyKilled')) stompFrame = frame;
    }
    expect(stompFrame).toBeGreaterThanOrEqual(0);
    // The frames right after the stomp do not move the player (hit stop), then motion resumes.
    const frozen = positions[stompFrame + 1] === positions[stompFrame + 2];
    expect(frozen).toBe(true);
    expect(positions[positions.length - 1]).not.toBe(positions[stompFrame]);
  });
});
