import { describe, expect, it } from 'vitest';
import {
  createBody,
  createCollisionResult,
  groundKindBelow,
  isGrounded,
  moveAndCollide,
  overlapsHazard,
} from '../../src/game/physics';
import type { Body, CollisionResult, MoveOptions } from '../../src/game/physics';
import { TileKind } from '../../src/game/tiles';
import type { TileMap } from '../../src/game/tilemap';
import { mapFromAscii } from '../fixtures/maps';

const DT = 1 / 60;
const GRAVITY = 900;

function step(
  body: Body,
  map: TileMap,
  options: MoveOptions = {},
  result: CollisionResult = createCollisionResult(),
  gravity = GRAVITY,
): CollisionResult {
  body.vy += gravity * DT;
  return moveAndCollide(body, DT, map, result, options);
}

describe('moveAndCollide — floors', () => {
  it('lands exactly on the tile surface and stays there without jitter', () => {
    const map = mapFromAscii(['....', '....', '####']);
    const body = createBody(16, 0, 10, 14);
    let result = createCollisionResult();
    for (let frame = 0; frame < 300; frame += 1) {
      result = step(body, map, {}, result);
    }
    // Floor top is at y = 32, so a 14 px tall body rests at y = 18 — exactly, every frame.
    expect(body.y).toBe(18);
    expect(body.vy).toBe(0);
    expect(result.onGround).toBe(true);
    expect(result.groundKind).toBe(TileKind.Solid);
  });

  it('reports ground while standing still (no vertical motion at all)', () => {
    const map = mapFromAscii(['....', '####']);
    const body = createBody(16, 2, 10, 14);
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(result.onGround).toBe(true);
    expect(result.movedX).toBe(0);
    expect(result.movedY).toBe(0);
  });

  it('does not tunnel through a one-tile floor at extreme speed', () => {
    const map = mapFromAscii(['....', '####', '....', '....']);
    const body = createBody(16, 0, 10, 14);
    body.vy = 2000;
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(result.onGround).toBe(true);
    expect(body.y).toBe(2);
    expect(body.vy).toBe(0);
  });

  it('falls freely through a pit below the level', () => {
    const map = mapFromAscii(['..', '..']);
    const body = createBody(0, 0, 10, 14);
    for (let frame = 0; frame < 60; frame += 1) step(body, map);
    expect(body.y).toBeGreaterThan(map.pixelHeight);
  });
});

describe('moveAndCollide — walls and ceilings', () => {
  it('stops against a wall on the right and zeroes horizontal velocity', () => {
    const map = mapFromAscii(['..#', '###']);
    const body = createBody(0, 2, 10, 14);
    let result = createCollisionResult();
    for (let frame = 0; frame < 60; frame += 1) {
      body.vx = 200;
      result = step(body, map, {}, result);
    }
    // Wall column starts at x = 32, so the 10 px wide body stops at x = 22 — exactly, and stays.
    expect(body.x).toBe(22);
    expect(body.vx).toBe(0);
    expect(result.hitWallRight).toBe(true);
    expect(result.hitWallLeft).toBe(false);
  });

  it('stops against a wall on the left', () => {
    const map = mapFromAscii(['#..', '###']);
    const body = createBody(20, 2, 10, 14);
    let result = createCollisionResult();
    for (let frame = 0; frame < 60; frame += 1) {
      body.vx = -200;
      result = step(body, map, {}, result);
    }
    expect(body.x).toBe(16);
    expect(body.vx).toBe(0);
    expect(result.hitWallLeft).toBe(true);
  });

  it('does not tunnel horizontally at extreme speed', () => {
    const map = mapFromAscii(['..#..', '#####']);
    const body = createBody(0, 2, 10, 14);
    body.vx = 3000;
    moveAndCollide(body, DT, map, createCollisionResult());
    expect(body.x).toBe(22);
  });

  it('treats the level sides as invisible walls', () => {
    const map = mapFromAscii(['....', '####']);
    const body = createBody(2, 2, 10, 14);
    body.vx = -400;
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(body.x).toBe(0);
    expect(result.hitWallLeft).toBe(true);
  });

  it('bonks a ceiling and cancels upward velocity', () => {
    const map = mapFromAscii(['####', '....', '....', '####']);
    const body = createBody(16, 20, 10, 14);
    body.vy = -400;
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(body.y).toBe(16);
    expect(body.vy).toBe(0);
    expect(result.onCeiling).toBe(true);
  });

  it('resolves a floor and a wall reached in the same step', () => {
    const map = mapFromAscii(['...#', '...#', '####']);
    const body = createBody(20, 8, 10, 14);
    // A single fat step drives the body diagonally into the inside corner.
    body.vx = 1500;
    body.vy = 900;
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(result.hitWallRight).toBe(true);
    expect(result.onGround).toBe(true);
    expect(body.x).toBe(38);
    expect(body.y).toBe(18);
    expect(body.vx).toBe(0);
    expect(body.vy).toBe(0);
  });

  it('slides along a floor while running into it', () => {
    const map = mapFromAscii(['......', '######']);
    const body = createBody(0, 2, 10, 14);
    for (let frame = 0; frame < 30; frame += 1) {
      body.vx = 120;
      step(body, map);
    }
    expect(body.y).toBe(2);
    expect(body.x).toBeCloseTo(60, 5);
  });
});

describe('moveAndCollide — one-way platforms', () => {
  it('lands on a one-way platform when falling onto it', () => {
    const map = mapFromAscii(['....', '====', '....']);
    const body = createBody(16, 0, 10, 14);
    let result = createCollisionResult();
    for (let frame = 0; frame < 30; frame += 1) result = step(body, map, {}, result);
    expect(body.y).toBe(2);
    expect(result.onGround).toBe(true);
    expect(result.groundKind).toBe(TileKind.OneWay);
  });

  it('passes upward through a one-way platform', () => {
    const map = mapFromAscii(['....', '====', '....', '####']);
    const body = createBody(16, 34, 10, 14);
    body.vy = -300;
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(result.onCeiling).toBe(false);
    expect(body.y).toBeLessThan(34);
    expect(body.vy).toBe(-300);
  });

  it('does not pop the body up when it is already overlapping from below', () => {
    const map = mapFromAscii(['....', '====', '....', '####']);
    // Body straddles the platform row while still moving up: it must keep going, not snap on top.
    const body = createBody(16, 12, 10, 14);
    body.vy = -60;
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(result.onGround).toBe(false);
    expect(body.y).toBeLessThan(12);
  });

  it('does not catch the body when it is rising through the platform', () => {
    const map = mapFromAscii(['....', '....', '====', '....', '####']);
    const body = createBody(16, 36, 10, 14);
    body.vy = -400;
    // Multiple steps: the body crosses the platform row entirely without ever landing.
    for (let frame = 0; frame < 4; frame += 1) {
      const result = moveAndCollide(body, DT, map, createCollisionResult());
      expect(result.onGround).toBe(false);
    }
    // Ends up above the platform row (which starts at y = 32), still rising.
    expect(body.y).toBeLessThan(18);
    expect(body.vy).toBeLessThan(0);
  });

  it('drops through when asked (holding down)', () => {
    const map = mapFromAscii(['....', '====', '....', '####']);
    const body = createBody(16, 2, 10, 14);
    let result = createCollisionResult();
    for (let frame = 0; frame < 40; frame += 1) {
      result = step(body, map, { dropThroughOneWay: true }, result);
    }
    // Ends up resting on the solid floor below instead of the platform.
    expect(body.y).toBe(34);
    expect(result.groundKind).toBe(TileKind.Solid);
  });

  it('ignores one-way platforms entirely for bodies that opt out (projectiles)', () => {
    const map = mapFromAscii(['....', '====', '....']);
    const body = createBody(16, 0, 6, 6);
    body.vy = 200;
    const result = moveAndCollide(body, DT, map, createCollisionResult(), { useOneWay: false });
    expect(result.onGround).toBe(false);
  });
});

describe('moveAndCollide — special tiles', () => {
  it('reports hazard and trigger overlaps using inset hitboxes', () => {
    const map = mapFromAscii(['..G.', '#^##']);
    // Standing on the floor row next to the spike: no hazard contact yet.
    const body = createBody(0, 2, 10, 14);
    let result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(result.overlaps).toEqual([]);
    expect(overlapsHazard(body, map)).toBe(false);

    // Sink into the spike tile: its hitbox starts 6 px below the cell top, so contact registers.
    body.x = 18;
    body.y = 12;
    result = moveAndCollide(body, DT, map, result);
    expect(result.overlaps.some((overlap) => overlap.kind === TileKind.Spike)).toBe(true);
    expect(overlapsHazard(body, map)).toBe(true);

    // Touch the goal tile.
    const goalBody = createBody(34, 2, 10, 14);
    const goalResult = moveAndCollide(goalBody, DT, map, createCollisionResult());
    expect(goalResult.overlaps).toEqual([{ kind: TileKind.Goal, tx: 2, ty: 0 }]);
  });

  it('reports the conveyor tile the body stands on', () => {
    const map = mapFromAscii(['....', '>><<']);
    const body = createBody(0, 2, 10, 14);
    const result = step(body, map);
    expect(result.onGround).toBe(true);
    expect(result.groundKind).toBe(TileKind.ConveyorRight);
    body.x = 40;
    const left = step(body, map);
    expect(left.groundKind).toBe(TileKind.ConveyorLeft);
  });

  it('never collides with scenery tiles', () => {
    const map = mapFromAscii([':::', ':::']);
    const body = createBody(0, 0, 10, 14);
    for (let frame = 0; frame < 20; frame += 1) step(body, map);
    expect(body.y).toBeGreaterThan(20);
  });
});

describe('ground probes', () => {
  it('detects ground within the probe distance only', () => {
    const map = mapFromAscii(['....', '####']);
    const resting = createBody(16, 2, 10, 14);
    expect(isGrounded(resting, map)).toBe(true);
    expect(groundKindBelow(resting, map)).toBe(TileKind.Solid);

    const airborne = createBody(16, -10, 10, 14);
    expect(isGrounded(airborne, map)).toBe(false);
    expect(groundKindBelow(airborne, map)).toBeNull();
  });

  it('detects a one-way platform underfoot', () => {
    const map = mapFromAscii(['....', '====']);
    const body = createBody(16, 2, 10, 14);
    expect(groundKindBelow(body, map)).toBe(TileKind.OneWay);
  });

  it('reports no ground over a gap the body has cleared', () => {
    const map = mapFromAscii(['....', '#..#']);
    const body = createBody(20, 2, 10, 14);
    expect(isGrounded(body, map)).toBe(false);
  });
});

describe('collision result reuse', () => {
  it('resets the shared result object between moves (no allocation churn)', () => {
    const map = mapFromAscii(['..#', '###']);
    const result = createCollisionResult();
    const overlapsArray = result.overlaps;

    const body = createBody(0, 2, 10, 14);
    body.vx = 2000;
    moveAndCollide(body, DT, map, result);
    expect(result.hitWallRight).toBe(true);

    const fresh = createBody(0, 2, 10, 14);
    moveAndCollide(fresh, DT, map, result);
    expect(result.hitWallRight).toBe(false);
    expect(result.overlaps).toBe(overlapsArray);
    expect(result.overlaps.length).toBe(0);
  });

  it('records how far the body actually moved', () => {
    const map = mapFromAscii(['....', '####']);
    const body = createBody(0, 2, 10, 14);
    body.vx = 60;
    const result = moveAndCollide(body, DT, map, createCollisionResult());
    expect(result.movedX).toBeCloseTo(1, 6);
    expect(result.movedY).toBe(0);
  });
});
