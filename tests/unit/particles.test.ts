import { describe, expect, it } from 'vitest';
import { ParticleSystem } from '../../src/render/particles';
import { createRng } from '../../src/core/rng';

describe('ParticleSystem', () => {
  it('spawns, ages and retires particles', () => {
    const system = new ParticleSystem(16);
    expect(system.activeCount).toBe(0);
    system.spawn({ kind: 'spark', x: 10, y: 10, vx: 60, vy: -60, life: 0.2 });
    expect(system.activeCount).toBe(1);
    // 0.2 s of life is 12 fixed steps; the 13th retires it.
    for (let frame = 0; frame < 13; frame += 1) system.update(1 / 60);
    expect(system.activeCount).toBe(0);
  });

  it('moves particles with velocity, gravity and drag', () => {
    const system = new ParticleSystem(4);
    system.spawn({ kind: 'debris', x: 0, y: 0, vx: 100, vy: 0, life: 5, gravity: 400, drag: 0 });
    system.update(0.1);
    // x advances by v·dt, y accelerates downwards.
    const snapshot = JSON.stringify(system);
    expect(snapshot).toContain('"x":10');
    expect(snapshot).toContain('"vy":40');
  });

  it('never exceeds its capacity and recycles the oldest particles', () => {
    const system = new ParticleSystem(8);
    for (let i = 0; i < 40; i += 1) {
      system.spawn({ kind: 'spark', x: i, y: 0, life: 10 });
    }
    expect(system.activeCount).toBe(8);
    expect(system.capacity).toBe(8);
  });

  it('bursts deterministically for a given seed', () => {
    const capture = (): string => {
      const system = new ParticleSystem(32);
      system.burst('spark', 50, 40, 8, createRng(99), { speed: 100 });
      system.update(1 / 60);
      return JSON.stringify(system);
    };
    expect(capture()).toEqual(capture());
  });

  it('landing dust scales with impact strength', () => {
    const soft = new ParticleSystem(64);
    soft.landingDust(0, 0, 0.2, createRng(1));
    const hard = new ParticleSystem(64);
    hard.landingDust(0, 0, 1, createRng(1));
    expect(hard.activeCount).toBeGreaterThan(soft.activeCount);
  });

  it('clear removes everything', () => {
    const system = new ParticleSystem(8);
    system.burst('debris', 0, 0, 6, createRng(2));
    expect(system.activeCount).toBeGreaterThan(0);
    system.clear();
    expect(system.activeCount).toBe(0);
  });
});
