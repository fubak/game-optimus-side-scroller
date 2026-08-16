/**
 * The Foundry — "Descent", the first interior room.
 *
 * Composed as a descent rather than a traverse. Ares Basin reads left-to-right
 * across an open horizon; this drops the player down through the structure, so
 * the framing is vertical and the molten channels below are visible long before
 * they are reached.
 *
 * Changing the *shape* of the level, and not only its palette, is what makes a
 * second biome feel like somewhere else rather than the first one recoloured.
 *
 * Sized against the same measured jump envelope: steps up at most 1.6 m, gaps
 * at most 3.2 m, landing zones at least 6 m wide.
 */

import { SolidKind } from '../../game/physics.ts';
import type { RoomDefinition, PlatformDefinition, PropDefinition, LightDefinition } from './ares-approach.ts';

export function buildFoundryDescent(): RoomDefinition {
  const platforms: PlatformDefinition[] = [];
  const props: PropDefinition[] = [];
  const lights: LightDefinition[] = [];

  const floor = (x0: number, x1: number, topY: number, sprite = 'foundry.deck'): void => {
    const thickness = 8;
    platforms.push({
      x: (x0 + x1) / 2,
      y: topY + thickness / 2,
      width: x1 - x0,
      height: thickness,
      kind: SolidKind.Solid,
      sprite,
      castsShadow: false,
    });
  };

  const ledge = (x0: number, x1: number, topY: number, oneWay = false): void => {
    const thickness = 0.75;
    platforms.push({
      x: (x0 + x1) / 2,
      y: topY + thickness / 2,
      width: x1 - x0,
      height: thickness,
      kind: oneWay ? SolidKind.OneWay : SolidKind.Solid,
      sprite: 'foundry.ledge',
      castsShadow: true,
    });
  };

  // --- Act 1: the entry gantry, high up -----------------------------------
  floor(-30, -8, -14.0);

  // --- Act 2: stepping down the structure ---------------------------------
  // Descending is more forgiving than climbing - gravity helps - so these can
  // be a little wider apart than the Ares staircase.
  ledge(-5.0, 2.0, -12.6);
  ledge(4.8, 11.5, -11.2);
  ledge(14.2, 21.0, -9.8);
  floor(24.0, 40.0, -8.4);

  // --- Act 3: the assembly hall -------------------------------------------
  // A wide bay with the conveyor overhead and molten channels either side.
  floor(43.0, 62.0, -8.4);

  // A support column, low enough to clear with a normal jump.
  platforms.push({
    x: 46.5,
    y: -8.4 - 1.1,
    width: 0.9,
    height: 2.2,
    kind: SolidKind.Solid,
    sprite: 'foundry.pillar',
    castsShadow: true,
  });

  // Upper catwalk, optional, reachable from the column.
  ledge(49.0, 56.0, -12.4, true);

  // --- Act 4: the exit ramp ------------------------------------------------
  ledge(65.0, 71.5, -9.8);
  floor(74.5, 92.0, -11.2);

  // --- Molten channels ------------------------------------------------------
  // Purely visual and purely emissive, sitting in the gaps between platforms
  // where they light the undersides of everything above them.
  const channels: [number, number, number][] = [
    [12.0, -7.6, 9],
    [52.0, -7.6, 14],
    [80.0, -10.4, 11],
  ];
  for (const [x, y, width] of channels) {
    props.push({
      x,
      y,
      width,
      height: 1.0,
      sprite: 'foundry.molten',
      rotation: 0,
      emissive: 1,
      castsShadow: false,
    });
    // Each channel is a real light, casting upward.
    lights.push({
      x,
      y: y - 0.4,
      radius: width * 0.85,
      color: [1.0, 0.44, 0.14],
      intensity: 1.35,
      shadowStrength: 0.35,
      // A slow uneven flicker, as a heat source behaves.
      flicker: 0.16,
    });
  }

  // --- Hanging chassis ------------------------------------------------------
  // Half-built Optimus units still on the line: the clearest statement the
  // environment makes about what this place is.
  const chassis: [number, number][] = [
    [28.0, -12.8],
    [33.5, -13.4],
    [50.0, -13.0],
    [55.5, -12.6],
  ];
  for (const [x, y] of chassis) {
    props.push({
      x,
      y,
      width: 1.6,
      height: 3.2,
      sprite: 'foundry.chassis',
      rotation: 0,
      emissive: 0,
      castsShadow: true,
    });
  }

  // --- Crates and consoles --------------------------------------------------
  const crates: [number, number, number][] = [
    [-24.0, -14.0, 1.05],
    [-23.1, -14.0, 0.72],
    [30.0, -8.4, 0.95],
    [58.0, -8.4, 1.1],
    [86.0, -11.2, 0.85],
  ];
  for (let i = 0; i < crates.length; i++) {
    const [x, surfaceY, size] = crates[i]!;
    props.push({
      x,
      y: surfaceY - size / 2,
      width: size,
      height: size,
      sprite: `crate${i % 3}`,
      rotation: 0,
      emissive: 0,
      castsShadow: true,
    });
  }

  const consoles: [number, number][] = [
    [-16.0, -14.0],
    [27.0, -8.4],
    [60.0, -8.4],
    [78.0, -11.2],
  ];
  for (const [x, surfaceY] of consoles) {
    props.push({
      x,
      y: surfaceY - 0.4,
      width: 1.2,
      height: 0.8,
      sprite: 'panelLit',
      rotation: 0,
      emissive: 0.7,
      castsShadow: true,
    });
    lights.push({
      x,
      y: surfaceY - 0.55,
      radius: 5.2,
      color: [0.247, 0.914, 1.0],
      intensity: 1.25,
      shadowStrength: 0.8,
      flicker: 0.1,
    });
  }

  return {
    name: 'foundry.descent',
    bounds: { minX: -36, minY: -30, maxX: 96, maxY: -2 },
    spawn: { x: -26, y: -14.0 },
    exitX: 88,
    platforms,
    props,
    lights,
  };
}
