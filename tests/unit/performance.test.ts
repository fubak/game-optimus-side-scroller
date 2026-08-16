import { describe, expect, it } from 'vitest';
import { ScriptedInput } from '../../src/core/input';
import { Autopilot } from '../../src/game/autopilot';
import { LEVELS } from '../../src/game/levels/index';
import { parseLevel } from '../../src/game/levelParser';
import { World } from '../../src/game/world';

/**
 * Simulation performance budget.
 *
 * The renderer is measured in the browser (F3 overlay), but the *simulation* has to fit comfortably
 * inside a 16.6 ms frame with room left for drawing. These budgets are deliberately generous — they
 * exist to catch an accidental O(n²) or a per-frame allocation storm, not to micro-benchmark CI.
 */

const DT = 1 / 60;

describe('world simulation cost', () => {
  it.each(LEVELS.map((level) => [level.id, level] as const))(
    '%s simulates 10 seconds well inside the frame budget',
    (_id, def) => {
      const world = new World(parseLevel(def), { lives: 99 });
      const input = new ScriptedInput([]);
      const frames = 600;

      const started = performance.now();
      for (let frame = 0; frame < frames; frame += 1) {
        world.update(DT, input);
      }
      const elapsedMs = performance.now() - started;
      const perFrameMs = elapsedMs / frames;
      // A fixed step is 16.6 ms; the simulation should be a small fraction of it.
      expect(perFrameMs).toBeLessThan(2);
    },
  );

  it('a busy autopilot run stays within budget and does not leak entities', () => {
    const def = LEVELS[0];
    expect(def).toBeDefined();
    const world = new World(parseLevel(def!), { lives: 99 });
    const pilot = new Autopilot(world);
    const frames = 1800;

    const started = performance.now();
    for (let frame = 0; frame < frames; frame += 1) {
      world.update(DT, pilot);
      pilot.endFrame();
      if (world.isFinished) break;
    }
    const elapsedMs = performance.now() - started;
    expect(elapsedMs / frames).toBeLessThan(2);

    // Pools are fixed-size: particles and projectiles can never grow without bound.
    expect(world.particles.activeCount).toBeLessThanOrEqual(world.particles.capacity);
    expect(world.projectiles.activeCount).toBeLessThanOrEqual(48);
  });

  it('hundreds of simultaneous particles stay cheap', () => {
    const def = LEVELS[0];
    const world = new World(parseLevel(def!), { lives: 99 });
    const input = new ScriptedInput([]);
    for (let burst = 0; burst < 40; burst += 1) {
      world.particles.burst('debris', 100 + burst, 100, 16, world.rng, { speed: 160, life: 5 });
    }
    expect(world.particles.activeCount).toBeGreaterThan(200);

    const started = performance.now();
    for (let frame = 0; frame < 600; frame += 1) world.update(DT, input);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs / 600).toBeLessThan(2);
  });
});
