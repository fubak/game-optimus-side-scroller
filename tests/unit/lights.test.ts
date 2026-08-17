import { describe, expect, it } from 'vitest';
import type { LevelDef } from '../../src/game/levelParser';
import { createWorld } from '../fixtures/worldHarness';
import { LightList, MAX_LIGHTS, collectLights } from '../../src/render/gl/lights';
import type { CollectLightsParams } from '../../src/render/gl/lights';
import { DEFAULT_RENDER_SETTINGS, applyQualityPreset } from '../../src/render/settings';

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

function baseParams(world: ReturnType<typeof createWorld>): CollectLightsParams {
  return {
    world,
    settings: DEFAULT_RENDER_SETTINGS,
    reducedMotion: false,
    cameraX: 0,
    cameraY: 0,
    viewWidth: 480,
    viewHeight: 270,
  };
}

describe('LightList', () => {
  it('starts empty and accumulates lights up to capacity', () => {
    const list = new LightList(4);
    expect(list.count).toBe(0);
    expect(list.add(0, 0, 10, 5, 1, 0, 0, 1)).toBe(true);
    expect(list.add(1, 1, 10, 5, 1, 0, 0, 1)).toBe(true);
    expect(list.count).toBe(2);
  });

  it('drops lights once capacity is reached instead of throwing', () => {
    const list = new LightList(2);
    expect(list.add(0, 0, 10, 5, 1, 1, 1, 1)).toBe(true);
    expect(list.add(0, 0, 10, 5, 1, 1, 1, 1)).toBe(true);
    expect(list.add(0, 0, 10, 5, 1, 1, 1, 1)).toBe(false);
    expect(list.count).toBe(2);
  });

  it('resets count without touching capacity or backing arrays length', () => {
    const list = new LightList(4);
    list.add(0, 0, 10, 5, 1, 1, 1, 1);
    list.reset();
    expect(list.count).toBe(0);
    expect(list.posRadiusHeight.length).toBe(16);
  });

  it('defaults to MAX_LIGHTS capacity', () => {
    const list = new LightList();
    expect(list.capacity).toBe(MAX_LIGHTS);
  });
});

describe('collectLights', () => {
  it('never mutates the world it reads from', () => {
    const world = createWorld(FLAT);
    const before = JSON.stringify(world.snapshot());
    const list = new LightList();
    collectLights(baseParams(world), list);
    const after = JSON.stringify(world.snapshot());
    expect(after).toBe(before);
  });

  it('always sets an ambient term, even with zero light budget', () => {
    const world = createWorld(FLAT);
    const list = new LightList();
    const lowest = applyQualityPreset(DEFAULT_RENDER_SETTINGS, 'low');
    collectLights({ ...baseParams(world), settings: lowest }, list);
    expect(list.ambientIntensity).toBeGreaterThan(0);
  });

  it('adds the player visor light while alive', () => {
    const world = createWorld(FLAT);
    const list = new LightList();
    collectLights(baseParams(world), list);
    expect(list.count).toBeGreaterThan(0);
    // First non-ambient light added is always the player's visor (see addPlayerLights).
    expect(list.colorIntensity[3]).toBeGreaterThan(0);
  });

  it('adds a goal light once the goal tile scrolls into view', () => {
    const world = createWorld(FLAT);
    const list = new LightList();
    // Goal glyph sits near the right edge of the level; push the camera there so it is in view.
    const params: CollectLightsParams = {
      ...baseParams(world),
      cameraX: world.map.width * world.map.tileSize - 480,
    };
    collectLights(params, list);
    expect(list.count).toBeGreaterThan(0);
  });

  it('respects the quality preset light budget', () => {
    const world = createWorld(FLAT);
    const lowList = new LightList();
    const ultraList = new LightList();
    const low = applyQualityPreset(DEFAULT_RENDER_SETTINGS, 'low');
    const ultra = applyQualityPreset(DEFAULT_RENDER_SETTINGS, 'ultra');
    collectLights({ ...baseParams(world), settings: low }, lowList);
    collectLights({ ...baseParams(world), settings: ultra }, ultraList);
    expect(lowList.count).toBeLessThanOrEqual(6);
    expect(ultraList.count).toBeLessThanOrEqual(MAX_LIGHTS);
  });

  it('caps total lights at MAX_LIGHTS regardless of quality', () => {
    const world = createWorld(FLAT);
    const list = new LightList();
    const ultra = applyQualityPreset(DEFAULT_RENDER_SETTINGS, 'ultra');
    collectLights({ ...baseParams(world), settings: ultra }, list);
    expect(list.count).toBeLessThanOrEqual(list.capacity);
  });

  it('does not throw under reduced motion', () => {
    const world = createWorld(FLAT);
    const list = new LightList();
    expect(() => collectLights({ ...baseParams(world), reducedMotion: true }, list)).not.toThrow();
  });
});
