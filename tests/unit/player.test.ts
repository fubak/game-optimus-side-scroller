import { describe, expect, it } from 'vitest';
import { ScriptedInput, buildTape } from '../../src/core/input';
import type { Action, Input } from '../../src/core/input';
import { Player } from '../../src/game/player';
import type { PlayerEvent } from '../../src/game/player';
import {
  COYOTE_TIME,
  DASH_COOLDOWN,
  DASH_ENERGY_COST,
  ENERGY_MAX,
  HEALTH_MAX,
  JUMP_BUFFER_TIME,
  PLAYER_HEIGHT,
  RUN_MAX_SPEED,
} from '../../src/game/constants';
import { mapFromAscii } from '../fixtures/maps';
import { DT, countEvents, peakHeight, runPlayer } from '../fixtures/playerHarness';

describe('Player — running', () => {
  it('accelerates to the run speed cap and stops when input is released', () => {
    const run = runPlayer({ spans: [{ action: 'right', start: 0, duration: 60 }], frames: 120 });
    const atCap = run.samples[59]!;
    expect(atCap.vx).toBeCloseTo(RUN_MAX_SPEED, 3);
    expect(atCap.state).toBe('run');
    const settled = run.samples[119]!;
    expect(settled.vx).toBe(0);
    expect(settled.state).toBe('idle');
    expect(settled.x).toBeGreaterThan(run.samples[0]!.x + 100);
  });

  it('faces the direction of travel', () => {
    const run = runPlayer({
      spans: [
        { action: 'right', start: 0, duration: 20 },
        { action: 'left', start: 25, duration: 20 },
      ],
      frames: 60,
    });
    expect(run.samples[10]!.vx).toBeGreaterThan(0);
    expect(run.player.facing).toBe(-1);
  });

  it('emits footsteps only while running on the ground', () => {
    const running = runPlayer({ spans: [{ action: 'right', start: 0, duration: 120 }], frames: 120 });
    expect(countEvents(running, 'footstep')).toBeGreaterThan(4);
    const still = runPlayer({ frames: 120 });
    expect(countEvents(still, 'footstep')).toBe(0);
  });
});

describe('Player — jumping feel', () => {
  it('jumps higher when the button is held (variable jump height)', () => {
    const tapped = runPlayer({ spans: [{ action: 'jump', start: 5, duration: 2 }], frames: 120 });
    const held = runPlayer({ spans: [{ action: 'jump', start: 5, duration: 40 }], frames: 120 });
    const tappedHeight = tapped.samples[0]!.y - peakHeight(tapped);
    const heldHeight = held.samples[0]!.y - peakHeight(held);
    expect(heldHeight).toBeGreaterThan(tappedHeight + 8);
    // A full jump clears three 16 px tiles; a tap clears at least one.
    expect(heldHeight).toBeGreaterThan(46);
    expect(tappedHeight).toBeGreaterThan(16);
  });

  it('lands back on the floor and reports the landing', () => {
    const run = runPlayer({ spans: [{ action: 'jump', start: 5, duration: 20 }], frames: 120 });
    expect(countEvents(run, 'jump')).toBe(1);
    expect(countEvents(run, 'land')).toBe(1);
    const landing = run.events.find((event) => event.type === 'land');
    expect(landing?.type === 'land' && landing.impactSpeed > 100).toBe(true);
    const final = run.samples[119]!;
    expect(final.grounded).toBe(true);
    expect(final.y).toBe(run.samples[0]!.y);
  });

  it('allows a jump inside the coyote window after leaving a ledge', () => {
    // Ledge ends at tile x=3; the player runs right and falls into the gap.
    const rows = ['..........', '..........', '..........', '..........', '####......'];
    const withinWindow = runPlayer({
      rows,
      spawnTile: [1, 3],
      spans: [
        { action: 'right', start: 0, duration: 40 },
        // Ledge is left around frame 22; press jump 3 frames later (< 0.1 s coyote time).
        { action: 'jump', start: 25, duration: 10 },
      ],
      frames: 60,
    });
    expect(countEvents(withinWindow, 'jump')).toBe(1);

    const tooLate = runPlayer({
      rows,
      spawnTile: [1, 3],
      spans: [
        { action: 'right', start: 0, duration: 40 },
        { action: 'jump', start: 45, duration: 10 },
      ],
      frames: 60,
    });
    expect(countEvents(tooLate, 'jump')).toBe(0);
  });

  it('coyote time matches the tuning constant', () => {
    const rows = ['..........', '..........', '..........', '..........', '####......'];
    const coyoteFrames = Math.round(COYOTE_TIME / DT);
    // Find the frame the player actually leaves the ground, then jump exactly at the window edge.
    const probe = runPlayer({
      rows,
      spawnTile: [1, 3],
      spans: [{ action: 'right', start: 0, duration: 60 }],
      frames: 60,
    });
    const leaveFrame = probe.samples.findIndex((sample) => !sample.grounded);
    expect(leaveFrame).toBeGreaterThan(0);

    const insideEdge = runPlayer({
      rows,
      spawnTile: [1, 3],
      spans: [
        { action: 'right', start: 0, duration: 60 },
        { action: 'jump', start: leaveFrame + coyoteFrames - 1, duration: 6 },
      ],
      frames: 80,
    });
    expect(countEvents(insideEdge, 'jump')).toBe(1);

    const outsideEdge = runPlayer({
      rows,
      spawnTile: [1, 3],
      spans: [
        { action: 'right', start: 0, duration: 60 },
        { action: 'jump', start: leaveFrame + coyoteFrames + 2, duration: 6 },
      ],
      frames: 80,
    });
    expect(countEvents(outsideEdge, 'jump')).toBe(0);
  });

  it('buffers a jump pressed just before landing', () => {
    // Fall from a height; tap jump a few frames before touchdown — it must fire on landing.
    const rows = [
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '##########',
    ];
    const probe = runPlayer({ rows, spawnTile: [1, 0], frames: 90 });
    const landFrame = probe.samples.findIndex((sample) => sample.grounded);
    expect(landFrame).toBeGreaterThan(2);

    const bufferFrames = Math.floor(JUMP_BUFFER_TIME / DT);
    const buffered = runPlayer({
      rows,
      spawnTile: [1, 0],
      spans: [{ action: 'jump', start: landFrame - bufferFrames + 1, duration: 3 }],
      frames: 90,
    });
    expect(countEvents(buffered, 'jump')).toBe(1);

    const tooEarly = runPlayer({
      rows,
      spawnTile: [1, 0],
      spans: [{ action: 'jump', start: landFrame - bufferFrames - 6, duration: 2 }],
      frames: 90,
    });
    // The early press arms the jetpack instead of queuing a jump.
    expect(countEvents(tooEarly, 'jump')).toBe(0);
  });

  it('a press just before touchdown becomes a jump, not a puff of jetpack', () => {
    const rows = [
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '##########',
    ];
    const run = runPlayer({
      rows,
      spawnTile: [1, 0],
      // Pressed while still airborne but within a buffer window of the floor, then held.
      spans: [{ action: 'jump', start: 18, duration: 40 }],
      frames: 90,
    });
    expect(countEvents(run, 'jump')).toBe(1);
    expect(countEvents(run, 'thrustStart')).toBe(0);
    expect(run.samples.every((sample) => sample.energy === ENERGY_MAX)).toBe(true);
  });

  it('a press high above the ground engages the jetpack immediately', () => {
    const rows = [
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '##########',
    ];
    const run = runPlayer({
      rows,
      spawnTile: [1, 0],
      spans: [{ action: 'jump', start: 2, duration: 20 }],
      frames: 90,
    });
    expect(countEvents(run, 'thrustStart')).toBe(1);
    expect(countEvents(run, 'jump')).toBe(0);
  });

  it('cannot double jump without energy-driven thrust', () => {
    const run = runPlayer({
      spans: [
        { action: 'jump', start: 5, duration: 4 },
        { action: 'jump', start: 15, duration: 4 },
      ],
      frames: 120,
    });
    expect(countEvents(run, 'jump')).toBe(1);
  });

  it('bonks its head on a low ceiling', () => {
    const rows = ['####', '....', '....', '####'];
    const run = runPlayer({
      rows,
      spawnTile: [1, 1],
      spans: [{ action: 'jump', start: 2, duration: 30 }],
      frames: 60,
    });
    expect(countEvents(run, 'ceilingBonk')).toBeGreaterThan(0);
  });
});

describe('Player — dash', () => {
  it('covers ground quickly, costs energy and respects the cooldown', () => {
    const run = runPlayer({
      spans: [
        { action: 'right', start: 0, duration: 200 },
        { action: 'dash', start: 10 },
        { action: 'dash', start: 14 },
      ],
      frames: 60,
    });
    expect(countEvents(run, 'dash')).toBe(1);
    expect(run.samples[12]!.state).toBe('dash');
    expect(run.samples[12]!.vx).toBeGreaterThan(RUN_MAX_SPEED * 2);
    expect(run.samples[20]!.energy).toBeCloseTo(ENERGY_MAX - DASH_ENERGY_COST, 5);

    const cooldownFrames = Math.ceil(DASH_COOLDOWN / DT);
    const second = runPlayer({
      spans: [
        { action: 'right', start: 0, duration: 200 },
        { action: 'dash', start: 10 },
        { action: 'dash', start: 10 + cooldownFrames + 1 },
      ],
      frames: 90,
    });
    expect(countEvents(second, 'dash')).toBe(2);
  });

  it('moves further than running for the same number of frames', () => {
    const dashing = runPlayer({
      spans: [
        { action: 'right', start: 0, duration: 40 },
        { action: 'dash', start: 20 },
      ],
      frames: 40,
    });
    const running = runPlayer({ spans: [{ action: 'right', start: 0, duration: 40 }], frames: 40 });
    expect(dashing.samples[39]!.x).toBeGreaterThan(running.samples[39]!.x + 12);
  });

  it('ignores gravity for its duration then falls again', () => {
    const run = runPlayer({
      spans: [
        { action: 'right', start: 0, duration: 60 },
        { action: 'jump', start: 4, duration: 10 },
        { action: 'dash', start: 12 },
      ],
      frames: 60,
    });
    const dashSamples = run.samples.filter((sample) => sample.state === 'dash');
    expect(dashSamples.length).toBeGreaterThan(5);
    expect(dashSamples.every((sample) => sample.vy === 0)).toBe(true);
    expect(run.samples[59]!.grounded).toBe(true);
  });

  it('refuses to dash without enough energy', () => {
    const map = mapFromAscii(['....', '....', '####']);
    const player = new Player(16, 10);
    const input = new ScriptedInput(buildTape([{ action: 'dash', start: 1 }]));
    const events: PlayerEvent[] = [];
    // Drain the battery first.
    while (player.energy > 0) player.addEnergy(-ENERGY_MAX);
    for (let frame = 0; frame < 4; frame += 1) {
      player.update(DT, input, map, events);
      input.endFrame();
    }
    expect(events.some((event) => event.type === 'dash')).toBe(false);
    expect(events.some((event) => event.type === 'energyEmpty')).toBe(true);
  });
});

describe('Player — thrust (jetpack)', () => {
  it('holds altitude while draining energy, and stops when empty', () => {
    const run = runPlayer({
      rows: [
        '..........',
        '..........',
        '..........',
        '..........',
        '..........',
        '..........',
        '..........',
        '..........',
        '##########',
      ],
      spawnTile: [1, 7],
      spans: [
        { action: 'jump', start: 5, duration: 6 },
        // Second press in mid-air arms the jetpack, then it is held down.
        { action: 'jump', start: 14, duration: 300 },
      ],
      frames: 300,
    });
    expect(countEvents(run, 'thrustStart')).toBe(1);
    const thrusting = run.samples.filter((sample) => sample.state === 'thrust');
    expect(thrusting.length).toBeGreaterThan(20);
    // Energy drains to empty…
    expect(run.samples.some((sample) => sample.energy === 0)).toBe(true);
    expect(countEvents(run, 'energyEmpty')).toBeGreaterThan(0);
    // …and once empty the player falls back to the floor, even with the button still held.
    expect(run.samples[299]!.grounded).toBe(true);
    expect(run.samples[299]!.state).not.toBe('thrust');
  });

  it('gains height compared with a plain jump', () => {
    const rows = [
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '..........',
      '##########',
    ];
    const plain = runPlayer({
      rows,
      spawnTile: [1, 7],
      spans: [{ action: 'jump', start: 5, duration: 40 }],
      frames: 120,
    });
    const boosted = runPlayer({
      rows,
      spawnTile: [1, 7],
      spans: [
        { action: 'jump', start: 5, duration: 6 },
        { action: 'jump', start: 14, duration: 60 },
      ],
      frames: 120,
    });
    expect(peakHeight(boosted)).toBeLessThan(peakHeight(plain) - 10);
  });

  it('does not thrust while standing on the ground', () => {
    const run = runPlayer({ spans: [{ action: 'jump', start: 0, duration: 200 }], frames: 200 });
    expect(countEvents(run, 'thrustStart')).toBe(0);
    expect(run.samples[199]!.energy).toBe(ENERGY_MAX);
  });

  it('recharges energy on the ground after a delay', () => {
    const run = runPlayer({
      rows: [
        '..........',
        '..........',
        '..........',
        '..........',
        '..........',
        '..........',
        '##########',
      ],
      spawnTile: [1, 5],
      spans: [
        { action: 'jump', start: 5, duration: 6 },
        { action: 'jump', start: 14, duration: 30 },
      ],
      frames: 240,
    });
    const drained = Math.min(...run.samples.map((sample) => sample.energy));
    expect(drained).toBeLessThan(ENERGY_MAX);
    expect(run.samples[239]!.energy).toBe(ENERGY_MAX);
  });
});

describe('Player — damage, death and respawn', () => {
  it('takes damage with knockback, then is briefly invulnerable', () => {
    const events: PlayerEvent[] = [];
    const map = mapFromAscii(['....', '....', '####']);
    const player = new Player(20, 10);
    const input = new ScriptedInput([]);
    player.update(DT, input, map, events);

    expect(player.damage(1, player.centerX + 20, events)).toBe(true);
    expect(player.health).toBe(HEALTH_MAX - 1);
    expect(player.state).toBe('hurt');
    expect(player.body.vx).toBeLessThan(0); // knocked away from the source
    expect(player.body.vy).toBeLessThan(0);
    expect(player.isInvulnerable).toBe(true);

    // A second hit in the invulnerability window is ignored.
    expect(player.damage(1, player.centerX - 20, events)).toBe(false);
    expect(player.health).toBe(HEALTH_MAX - 1);
  });

  it('knocks back away from the damage source on either side', () => {
    const map = mapFromAscii(['....', '....', '####']);
    const events: PlayerEvent[] = [];
    const fromLeft = new Player(20, 10);
    fromLeft.damage(1, 0, events);
    expect(fromLeft.body.vx).toBeGreaterThan(0);
    const fromRight = new Player(20, 10);
    fromRight.damage(1, 200, events);
    expect(fromRight.body.vx).toBeLessThan(0);
    expect(map.width).toBe(4);
  });

  it('regains control after the hurt lock expires', () => {
    const run = runPlayer({
      spans: [{ action: 'right', start: 0, duration: 200 }],
      frames: 90,
      onFrame: (run, frame) => {
        if (frame === 10) run.player.damage(1, run.player.centerX + 30, run.events);
      },
    });
    expect(run.samples[12]!.state).toBe('hurt');
    expect(run.samples[40]!.state).toBe('run');
  });

  it('dies when health runs out and finishes its death animation', () => {
    const events: PlayerEvent[] = [];
    const map = mapFromAscii(['....', '....', '####']);
    const player = new Player(20, 10);
    const input = new ScriptedInput([]);
    for (let hit = 0; hit < HEALTH_MAX; hit += 1) {
      player.damage(1, 0, events);
      // Wait out invulnerability before the next hit.
      for (let frame = 0; frame < 90; frame += 1) player.update(DT, input, map, events);
    }
    expect(player.health).toBe(0);
    expect(player.state).toBe('dead');
    expect(events.filter((event) => event.type === 'die').length).toBe(1);
    expect(player.deathAnimationFinished).toBe(true);
    // Dead players ignore further damage and input.
    expect(player.damage(1, 0, events)).toBe(false);
  });

  it('respawn restores state at the checkpoint', () => {
    const events: PlayerEvent[] = [];
    const player = new Player(20, 10);
    player.damage(1, 0, events);
    player.addEnergy(-50);
    player.respawn(64, 32);
    expect(player.body.x).toBe(64);
    expect(player.body.y).toBe(32);
    expect(player.health).toBe(HEALTH_MAX);
    expect(player.energy).toBe(ENERGY_MAX);
    expect(player.state).toBe('idle');
    expect(player.isInvulnerable).toBe(false);

    player.damage(1, 0, events);
    player.respawn(0, 0, { keepHealth: true });
    expect(player.health).toBe(HEALTH_MAX - 1);
  });

  it('heals up to the maximum only', () => {
    const player = new Player(0, 0);
    const events: PlayerEvent[] = [];
    expect(player.heal(1)).toBe(false);
    player.damage(1, 0, events);
    expect(player.heal(1)).toBe(true);
    expect(player.health).toBe(HEALTH_MAX);
  });

  it('bounces off a stomped enemy', () => {
    const player = new Player(0, 0);
    player.bounce(200);
    expect(player.body.vy).toBe(-200);
    expect(player.state).toBe('jump');
  });

  it('freezes for the victory celebration', () => {
    const run = runPlayer({
      spans: [{ action: 'right', start: 0, duration: 200 }],
      frames: 60,
      onFrame: (run, frame) => {
        if (frame === 20) run.player.celebrate();
      },
    });
    expect(run.samples[30]!.state).toBe('victory');
    expect(Math.abs(run.samples[59]!.vx)).toBeLessThan(1);
  });
});

describe('Player — conveyors', () => {
  it('drifts with the belt while standing still, and can walk against it', () => {
    const rows = ['..........', '..........', '>>>>>>>>>>'];
    const drifting = runPlayer({ rows, spawnTile: [1, 1], frames: 60 });
    expect(drifting.samples[59]!.x).toBeGreaterThan(drifting.samples[0]!.x + 20);

    const walkingBack = runPlayer({
      rows,
      spawnTile: [4, 1],
      spans: [{ action: 'left', start: 0, duration: 60 }],
      frames: 60,
    });
    expect(walkingBack.samples[59]!.x).toBeLessThan(walkingBack.samples[0]!.x);
  });

  it('belt drift does not change the player run speed', () => {
    const belt = runPlayer({
      rows: [
        '..............................',
        '..............................',
        '>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>',
      ],
      spawnTile: [1, 1],
      spans: [{ action: 'right', start: 0, duration: 60 }],
      frames: 40,
    });
    // Self-propelled velocity stays at the run cap; the belt is added only for the move itself.
    expect(belt.samples[39]!.vx).toBeCloseTo(RUN_MAX_SPEED, 3);
    // …and the ground actually covered is run speed + belt speed.
    const travelled = belt.samples[39]!.x - belt.samples[30]!.x;
    expect(travelled / (9 / 60)).toBeGreaterThan(RUN_MAX_SPEED + 40);
  });
});

describe('Player — robustness', () => {
  it('survives 2000 frames of random input without breaking invariants', () => {
    const rows = [
      '....................',
      '....^....=====......',
      '..........#####.....',
      '...>>>>....^........',
      '....................',
      '#####..######..#####',
    ];
    const map = mapFromAscii(rows);
    const player = new Player(16, 16);
    const events: PlayerEvent[] = [];
    // A crude deterministic input source: cycles through button combinations.
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const held = new Set<Action>();
    const input: Input = {
      isDown: (action) => held.has(action),
      justPressed: (action) => held.has(action) && random() < 0.2,
      justReleased: () => false,
      anyJustPressed: () => false,
      endFrame: () => {
        /* no-op */
      },
    };

    for (let frame = 0; frame < 2000; frame += 1) {
      held.clear();
      for (const action of ['left', 'right', 'jump', 'dash', 'down'] as const) {
        if (random() < 0.35) held.add(action);
      }
      player.update(DT, input, map, events);
      events.length = 0;
      if (!player.isAlive) player.respawn(16, 16);

      expect(Number.isFinite(player.body.x)).toBe(true);
      expect(Number.isFinite(player.body.y)).toBe(true);
      expect(Number.isFinite(player.body.vx)).toBe(true);
      expect(Number.isFinite(player.body.vy)).toBe(true);
      expect(player.energy).toBeGreaterThanOrEqual(0);
      expect(player.energy).toBeLessThanOrEqual(ENERGY_MAX);
      expect(player.body.x).toBeGreaterThanOrEqual(0);
      expect(player.body.x).toBeLessThanOrEqual(map.pixelWidth);
      expect(player.body.y).toBeGreaterThan(-400);
    }
  });

  it('never intersects a solid tile after a move', () => {
    const rows = ['..........', '...####...', '..........', '##########'];
    const map = mapFromAscii(rows);
    const run = runPlayer({
      rows,
      spawnTile: [1, 2],
      spans: [
        { action: 'right', start: 0, duration: 300 },
        { action: 'jump', start: 10, duration: 8 },
        { action: 'jump', start: 40, duration: 8 },
        { action: 'dash', start: 60 },
      ],
      frames: 300,
    });
    for (const sample of run.samples) {
      expect(
        map.overlapsSolid({
          x: sample.x + 0.01,
          y: sample.y + 0.01,
          width: 10 - 0.02,
          height: PLAYER_HEIGHT - 0.02,
        }),
      ).toBe(false);
    }
  });
});
