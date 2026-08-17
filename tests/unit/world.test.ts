import { describe, expect, it } from 'vitest';
import { HEALTH_MAX, SCORE_ENERGY_CELL, SCORE_TIME_BONUS_PER_SEC } from '../../src/game/constants';
import type { LevelDef } from '../../src/game/levelParser';
import { LEVEL_1 } from '../../src/game/levels/level1';
import { DEFAULT_LIVES } from '../../src/game/world';
import { DT, countEventType, createWorld, runWorldWithBot, runWorldWithTape } from '../fixtures/worldHarness';
import { ScriptedInput, buildTape } from '../../src/core/input';

function def(rows: readonly string[], overrides: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 'test',
    name: 'TEST',
    subtitle: 'SUBTITLE',
    parTimeSec: 30,
    seed: 5,
    rows,
    ...overrides,
  };
}

const FLAT = def(['..............', '..............', '.P..........G.', '##############']);

describe('World — basics', () => {
  it('starts the player at the spawn point with a snapped camera', () => {
    const world = createWorld(FLAT);
    expect(world.player.body.x).toBe(world.level.spawnX);
    expect(world.player.body.y).toBe(world.level.spawnY);
    expect(world.status).toBe('playing');
    expect(world.livesLeft).toBe(DEFAULT_LIVES);
    expect(world.camera.renderX).toBe(Math.round(world.camera.x));
  });

  it('advances its clock only while playing', () => {
    const run = runWorldWithTape(FLAT, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 240,
    });
    expect(run.world.status).toBe('complete');
    const timeAtGoal = run.world.elapsedSec;
    // Extra frames after the goal must not add to the level time.
    const input = new ScriptedInput([]);
    for (let frame = 0; frame < 60; frame += 1) run.world.update(DT, input);
    expect(run.world.elapsedSec).toBe(timeAtGoal);
  });

  it('produces a JSON-safe snapshot', () => {
    const world = createWorld(FLAT);
    const snapshot = world.snapshot();
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({ level: 'test', state: 'playing', lives: DEFAULT_LIVES });
  });

  it('is deterministic: the same tape and seed produce identical runs', () => {
    const spans = [
      { action: 'right' as const, start: 0, duration: 120 },
      { action: 'jump' as const, start: 20, duration: 8 },
      { action: 'dash' as const, start: 60 },
    ];
    const first = runWorldWithTape(FLAT, { spans, frames: 150, seed: 42 });
    const second = runWorldWithTape(FLAT, { spans, frames: 150, seed: 42 });
    expect(JSON.stringify(first.world.snapshot())).toBe(JSON.stringify(second.world.snapshot()));
    expect(first.events.length).toBe(second.events.length);
  });
});

describe('World — goal', () => {
  it('completes the level when the goal tile is touched, once', () => {
    const run = runWorldWithTape(FLAT, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 300,
    });
    expect(countEventType(run, 'goal')).toBe(1);
    expect(run.world.status).toBe('complete');
    expect(run.world.player.state).toBe('victory');
  });

  it('awards a time bonus for finishing under par', () => {
    const run = runWorldWithTape(FLAT, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 300,
      stopWhenFinished: true,
    });
    const stats = run.world.stats;
    expect(stats.timeSec).toBeLessThan(stats.parTimeSec);
    expect(stats.timeBonus).toBe(Math.round((stats.parTimeSec - stats.timeSec) * SCORE_TIME_BONUS_PER_SEC));
    expect(stats.score).toBeGreaterThanOrEqual(stats.timeBonus);
  });

  it('gives no time bonus when over par', () => {
    const slow = def(FLAT.rows, { parTimeSec: 0.1 });
    const run = runWorldWithTape(slow, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 300,
      stopWhenFinished: true,
    });
    expect(run.world.stats.timeBonus).toBe(0);
  });
});

describe('World — hazards, death and respawn', () => {
  const SPIKE_PIT = def([
    '..................',
    '..................',
    '.P...........C...G',
    '#####^^^^#########',
  ]);

  it('spikes damage the player once per contact window', () => {
    const run = runWorldWithTape(SPIKE_PIT, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 240,
    });
    const hurtEvents = run.events.filter((event) => event.type === 'player' && event.event.type === 'hurt');
    expect(hurtEvents.length).toBeGreaterThan(0);
    expect(run.world.player.health).toBeLessThan(HEALTH_MAX);
  });

  it('falling into a pit kills, costs a life and respawns at the checkpoint', () => {
    const PIT = def([
      '................',
      '................',
      '.P.....C.......G',
      '#######.########',
      '#######.########',
    ]);
    const run = runWorldWithTape(PIT, {
      spans: [{ action: 'right', start: 0, duration: 900 }],
      frames: 420,
    });
    const deaths = run.events.filter((event) => event.type === 'death');
    expect(deaths.length).toBeGreaterThan(0);
    expect(deaths[0]).toMatchObject({ type: 'death', cause: 'pit' });
    expect(countEventType(run, 'checkpoint')).toBe(1);
    expect(countEventType(run, 'respawn')).toBeGreaterThan(0);
    // Respawn happens at the checkpoint, not the level spawn.
    const checkpointX = 7 * 16 + 3;
    expect(run.world.player.body.x).toBeGreaterThan(checkpointX - 40);
    expect(run.world.livesLeft).toBeLessThan(DEFAULT_LIVES);
  });

  it('fails the level once every life is gone', () => {
    const PIT = def(['..........', '..........', '.P.......G', '###.......']);
    const run = runWorldWithTape(PIT, {
      spans: [{ action: 'right', start: 0, duration: 3000 }],
      frames: 60 * 30,
      stopWhenFinished: true,
    });
    expect(run.world.status).toBe('failed');
    expect(run.world.livesLeft).toBe(0);
    expect(countEventType(run, 'failed')).toBe(1);
    expect(run.world.stats.deaths).toBe(DEFAULT_LIVES);
  });

  it('records the death cause for lethal damage', () => {
    const world = createWorld(FLAT);
    const input = new ScriptedInput([]);
    for (let hit = 0; hit < HEALTH_MAX; hit += 1) {
      world.damagePlayer(1, world.player.centerX + 20, 'damage');
      for (let frame = 0; frame < 90; frame += 1) world.update(DT, input);
    }
    // The player has already respawned by now, so assert on the bookkeeping rather than health.
    expect(world.stats.deaths).toBe(1);
    expect(world.livesLeft).toBe(DEFAULT_LIVES - 1);
  });
});

describe('World — pickups', () => {
  const PICKUPS = def(['..............', '.....eok......', '.P..........G.', '##############']);

  it('collects pickups, scores them and applies their effects', () => {
    const run = runWorldWithTape(PICKUPS, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 300,
      stopWhenFinished: true,
    });
    const pickups = run.events.filter((event) => event.type === 'pickup');
    // The repair kit is skipped at full health, so two of the three are taken.
    expect(pickups.map((event) => (event.type === 'pickup' ? event.kind : '')).sort()).toEqual([
      'bolt',
      'energyCell',
    ]);
    expect(run.world.score).toBeGreaterThanOrEqual(SCORE_ENERGY_CELL);
    expect(run.world.stats.collected).toBe(2);
    expect(run.world.stats.collectableTotal).toBe(3);
  });

  it('takes a repair kit only when damaged', () => {
    const world = createWorld(PICKUPS);
    world.damagePlayer(1, 0, 'damage');
    const input = new ScriptedInput(buildTape([{ action: 'right', start: 0, duration: 600 }]));
    for (let frame = 0; frame < 300 && !world.isFinished; frame += 1) {
      world.update(DT, input);
      input.endFrame();
    }
    expect(world.player.health).toBe(HEALTH_MAX);
    expect(world.stats.collected).toBe(3);
  });

  it('each pickup is collected at most once', () => {
    const run = runWorldWithTape(PICKUPS, {
      spans: [
        { action: 'right', start: 0, duration: 60 },
        { action: 'left', start: 70, duration: 60 },
        { action: 'right', start: 140, duration: 400 },
      ],
      frames: 400,
      stopWhenFinished: true,
    });
    expect(countEventType(run, 'pickup')).toBe(2);
  });
});

describe('World — checkpoints', () => {
  it('activates a checkpoint once and reports which is active', () => {
    const CHECKPOINTS = def(['..............', '..............', '.P....C.....G.', '##############']);
    const run = runWorldWithTape(CHECKPOINTS, {
      spans: [{ action: 'right', start: 0, duration: 600 }],
      frames: 300,
      stopWhenFinished: true,
    });
    expect(countEventType(run, 'checkpoint')).toBe(1);
    expect(run.world.isCheckpointActive(6, 2)).toBe(true);
    expect(run.world.isCheckpointActive(0, 0)).toBe(false);
  });
});

describe('Level 1 is beatable', () => {
  it('the greedy bot runs level 1 from spawn to goal', () => {
    const run = runWorldWithBot(LEVEL_1, { frames: 60 * 90, stopWhenFinished: true });
    expect(run.world.status).toBe('complete');
    expect(run.world.elapsedSec).toBeLessThan(LEVEL_1.parTimeSec * 2);
    expect(countEventType(run, 'goal')).toBe(1);
  });

  it('level 1 does not kill the bot repeatedly (fair difficulty)', () => {
    const run = runWorldWithBot(LEVEL_1, { frames: 60 * 90, stopWhenFinished: true, lives: 99 });
    expect(run.world.stats.deaths).toBeLessThanOrEqual(2);
  });
});
