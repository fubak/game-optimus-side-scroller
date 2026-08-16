import { describe, expect, it } from 'vitest';
import { Camera } from '../../src/game/camera';
import { createRng } from '../../src/core/rng';
import { TileMap } from '../../src/game/tilemap';
import { TileKind } from '../../src/game/tiles';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../../src/core/canvas';

const DT = 1 / 60;

function solidMap(widthTiles: number, heightTiles: number): TileMap {
  const map = new TileMap(widthTiles, heightTiles);
  for (let tx = 0; tx < widthTiles; tx += 1) {
    map.set(tx, heightTiles - 1, TileKind.Solid);
  }
  return map;
}

function body(x: number, y: number): { x: number; y: number; width: number; height: number } {
  return { x, y, width: 10, height: 14 };
}

describe('Camera', () => {
  it('centres on the target after snapping', () => {
    const map = solidMap(100, 40);
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    const target = body(800, 400);
    camera.snapTo(target, map);
    expect(camera.x + INTERNAL_WIDTH / 2).toBeCloseTo(target.x + target.width / 2, 5);
    expect(camera.renderX).toBe(Math.round(camera.x));
    expect(Number.isInteger(camera.renderX)).toBe(true);
  });

  it('clamps to the level bounds instead of showing the void', () => {
    const map = solidMap(60, 30);
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);

    camera.snapTo(body(0, 0), map);
    expect(camera.x).toBe(0);
    expect(camera.y).toBe(0);

    camera.snapTo(body(map.pixelWidth - 20, map.pixelHeight - 20), map);
    expect(camera.x).toBe(map.pixelWidth - INTERNAL_WIDTH);
    expect(camera.y).toBe(map.pixelHeight - INTERNAL_HEIGHT);
  });

  it('centres levels smaller than the view', () => {
    const map = solidMap(20, 10); // 320x160 px, smaller than the 480x270 view
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    camera.snapTo(body(100, 80), map);
    expect(camera.x).toBe((map.pixelWidth - INTERNAL_WIDTH) / 2);
    expect(camera.y).toBe((map.pixelHeight - INTERNAL_HEIGHT) / 2);
  });

  it('ignores target motion inside the deadzone', () => {
    const map = solidMap(200, 40);
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT, { deadzoneWidth: 48, lookAhead: 0 });
    const rng = createRng(1);
    const target = body(1000, 400);
    camera.snapTo(target, map);
    const before = camera.x;
    // Nudge the target 10 px — well inside the 48 px deadzone — and let the camera settle.
    const nudged = body(1010, 400);
    for (let frame = 0; frame < 30; frame += 1) {
      camera.update(DT, nudged, 0, map, rng);
    }
    expect(camera.x).toBeCloseTo(before, 5);
  });

  it('follows the target once it leaves the deadzone', () => {
    const map = solidMap(200, 40);
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT, { deadzoneWidth: 48, lookAhead: 0 });
    const rng = createRng(1);
    camera.snapTo(body(1000, 400), map);
    const start = camera.x;
    const target = body(1200, 400);
    for (let frame = 0; frame < 60; frame += 1) {
      camera.update(DT, target, 150, map, rng);
    }
    expect(camera.x).toBeGreaterThan(start + 150);
    // Settles with the target parked on the deadzone edge.
    const targetCenter = target.x + target.width / 2;
    expect(Math.abs(camera.x + INTERNAL_WIDTH / 2 - (targetCenter - 24))).toBeLessThan(2);
  });

  it('looks ahead in the direction of travel', () => {
    const map = solidMap(300, 40);
    const rng = createRng(2);
    const target = body(2000, 400);

    const rightward = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    rightward.snapTo(target, map);
    const leftward = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    leftward.snapTo(target, map);
    const still = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    still.snapTo(target, map);

    for (let frame = 0; frame < 60; frame += 1) {
      rightward.update(DT, target, 150, map, rng);
      leftward.update(DT, target, -150, map, rng);
      still.update(DT, target, 0, map, rng);
    }
    // The deadzone eats part of the look-ahead, so the shift is smaller than the raw look-ahead
    // value — what matters is that the view leads the direction of travel.
    expect(rightward.x).toBeGreaterThan(still.x + 10);
    expect(leftward.x).toBeLessThan(still.x - 10);
    expect(rightward.x - leftward.x).toBeGreaterThan(20);
  });

  it('shakes deterministically for a given seed and decays back to rest', () => {
    const map = solidMap(200, 40);
    const target = body(1000, 400);

    const runShake = (): number[] => {
      const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
      const rng = createRng(1234);
      camera.snapTo(target, map);
      camera.addShake(6);
      const offsets: number[] = [];
      for (let frame = 0; frame < 40; frame += 1) {
        camera.update(DT, target, 0, map, rng);
        offsets.push(camera.renderX);
      }
      return offsets;
    };

    const first = runShake();
    const second = runShake();
    expect(first).toEqual(second);
    // Shake is visible early…
    expect(first.slice(0, 6).some((value) => value !== first[first.length - 1])).toBe(true);
    // …and gone by the end.
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    const rng = createRng(1234);
    camera.snapTo(target, map);
    camera.addShake(6);
    for (let frame = 0; frame < 90; frame += 1) camera.update(DT, target, 0, map, rng);
    expect(camera.shake).toBe(0);
    expect(camera.renderX).toBe(Math.round(camera.x));
  });

  it('keeps the strongest shake when several land at once', () => {
    const map = solidMap(200, 40);
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    camera.snapTo(body(1000, 400), map);
    camera.addShake(2);
    camera.addShake(7);
    camera.addShake(3);
    expect(camera.shake).toBe(7);
  });

  it('does not drift when the target never moves', () => {
    const map = solidMap(200, 40);
    const camera = new Camera(INTERNAL_WIDTH, INTERNAL_HEIGHT);
    const rng = createRng(5);
    const target = body(1000, 400);
    camera.snapTo(target, map);
    const before = { x: camera.x, y: camera.y };
    for (let frame = 0; frame < 120; frame += 1) camera.update(DT, target, 0, map, rng);
    expect(camera.x).toBeCloseTo(before.x, 6);
    expect(camera.y).toBeCloseTo(before.y, 6);
  });
});
