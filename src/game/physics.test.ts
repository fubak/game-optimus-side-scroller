import { describe, it, expect } from 'vitest';
import { PhysicsWorld, createMoveResult, SolidKind } from './physics.ts';
import { aabb } from '../core/math/aabb.ts';

/**
 * These tests exist because collision failures are invisible in a screenshot.
 *
 * A character resting exactly on a floor computed a sweep entry time of
 * -1.1e-16 rather than 0, was rejected as "contact began behind the motion",
 * sank a fraction of a millimetre into the ground, and then fell through the
 * world for ever — while every still frame looked completely fine.
 */

function makeGround(): PhysicsWorld {
  const world = new PhysicsWorld();
  // Top surface at y = 0.
  world.addSolid(0, 3, 40, 6);
  return world;
}

/** A body 1.66 m tall and 0.52 m wide, with its feet at `feetY`. */
const body = (x: number, feetY: number) => aabb(x, feetY - 0.83, 0.26, 0.83);
const feetOf = (box: { y: number; hh: number }): number => box.y + box.hh;

describe('PhysicsWorld', () => {
  it('keeps a body resting exactly on a surface grounded', () => {
    const world = makeGround();
    const box = body(0, 0);
    const result = createMoveResult();

    let vy = 0;
    for (let i = 0; i < 240; i++) {
      vy += 24 / 120;
      world.move(box, 0, vy, 1 / 120, result);
      vy = result.velocityY;
    }

    expect(result.grounded).toBe(true);
    // Two seconds of gravity must not have moved it anywhere.
    expect(feetOf(box)).toBeCloseTo(0, 2);
  });

  it('stops a falling body at the surface', () => {
    const world = makeGround();
    const box = body(0, -5);
    const result = createMoveResult();

    let vy = 0;
    for (let i = 0; i < 240; i++) {
      vy += 24 / 120;
      world.move(box, 0, vy, 1 / 120, result);
      vy = result.velocityY;
      if (result.grounded) break;
    }

    expect(result.grounded).toBe(true);
    expect(feetOf(box)).toBeCloseTo(0, 2);
  });

  it('does not tunnel through a thin platform at dash speed', () => {
    const world = new PhysicsWorld();
    // A wall 10 cm thick, well under the distance covered in one step at speed.
    world.addSolid(5, 0, 0.1, 6);
    const box = aabb(0, 0, 0.26, 0.83);
    const result = createMoveResult();

    // 21 m/s is the dash speed; at 120 Hz that is 17.5 cm per step, well over
    // the wall's thickness. Drive well past the wall's position.
    let blocked = false;
    for (let i = 0; i < 120; i++) {
      world.move(box, 21, 0, 1 / 120, result);
      if (result.wall !== 0) blocked = true;
    }

    // The wall spans 4.95 to 5.05, so a 0.26-half-width body stops at 4.69.
    expect(box.x).toBeLessThan(4.75);
    expect(blocked).toBe(true);
  });

  it('resolves an existing overlap by the shallowest axis', () => {
    const world = makeGround();
    // Sunk 20 cm into the floor.
    const box = body(0, 0.2);
    const result = createMoveResult();

    world.move(box, 0, 0, 1 / 120, result);

    // Lifted out vertically, not ejected sideways off the platform.
    expect(feetOf(box)).toBeLessThanOrEqual(0.001);
    expect(box.x).toBeCloseTo(0, 3);
    expect(result.grounded).toBe(true);
  });

  it('lets a body pass upward through a one-way platform', () => {
    const world = new PhysicsWorld();
    world.addSolid(0, 0, 6, 0.7, SolidKind.OneWay);
    // Starting below it, moving up.
    const box = body(0, 3);
    const result = createMoveResult();

    for (let i = 0; i < 60; i++) {
      world.move(box, 0, -12, 1 / 120, result);
    }

    // It should have risen straight past without being blocked.
    expect(feetOf(box)).toBeLessThan(-1);
  });

  it('lands a body on top of a one-way platform', () => {
    const world = new PhysicsWorld();
    // Top surface at y = -0.35.
    world.addSolid(0, 0, 6, 0.7, SolidKind.OneWay);
    const box = body(0, -4);
    const result = createMoveResult();

    let vy = 0;
    for (let i = 0; i < 300; i++) {
      vy += 24 / 120;
      world.move(box, 0, vy, 1 / 120, result);
      vy = result.velocityY;
      if (result.grounded) break;
    }

    expect(result.grounded).toBe(true);
    expect(feetOf(box)).toBeCloseTo(-0.35, 1);
  });

  it('reports the wall side when pressed against geometry', () => {
    const world = new PhysicsWorld();
    world.addSolid(3, 0, 1, 8);
    const box = aabb(0, 0, 0.26, 0.83);
    const result = createMoveResult();

    for (let i = 0; i < 120; i++) world.move(box, 8, 0, 1 / 120, result);

    expect(result.wall).toBe(1);
    expect(box.x).toBeLessThan(2.5);
  });

  it('slides along a floor instead of stopping on contact', () => {
    const world = makeGround();
    const box = body(0, 0);
    const result = createMoveResult();

    // Moving diagonally into the ground should preserve the horizontal motion.
    for (let i = 0; i < 120; i++) {
      world.move(box, 6, 10, 1 / 120, result);
    }

    expect(result.grounded).toBe(true);
    expect(box.x).toBeGreaterThan(5);
    expect(feetOf(box)).toBeCloseTo(0, 2);
  });

  it('probes for nearby ground below a body', () => {
    const world = makeGround();
    const box = body(0, -0.15);
    const probe = world.probeGround(box, 0.25);
    expect(probe.hit).toBe(true);
    expect(probe.y).toBeCloseTo(0, 4);
  });

  it('is deterministic across identical runs', () => {
    const run = (): number[] => {
      const world = makeGround();
      world.addSolid(6, -1, 3, 0.7);
      const box = body(0, 0);
      const result = createMoveResult();
      const trace: number[] = [];
      let vy = -12;
      for (let i = 0; i < 200; i++) {
        vy += 24 / 120;
        world.move(box, 7, vy, 1 / 120, result);
        vy = result.velocityY;
        trace.push(box.x, box.y);
      }
      return trace;
    };

    expect(run()).toEqual(run());
  });
});
