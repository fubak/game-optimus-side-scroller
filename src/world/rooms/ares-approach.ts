/**
 * Ares Basin — "Approach", the opening room.
 *
 * Designed as a teaching space before it is a set piece. The left third is flat
 * ground where movement can be learned without risk; the middle introduces gaps
 * and height; the right is a staircase climb that opens onto a vista.
 *
 * ## Sized against measured capability
 *
 * The character's jump envelope, solved from the movement constants:
 *
 * ```
 *   peak height          3.83 m
 *   total air time       1.21 s
 *   horizontal range    10.15 m at run speed (12.10 m with a dash)
 * ```
 *
 * Every step up here is at most **1.6 m** and every gap at most **3.2 m** —
 * comfortably inside half the available envelope. That margin is deliberate:
 * a layout that only works with frame-perfect input is a layout that feels
 * unfair, and it also makes automated traversal (used for recording and as a
 * smoke test) unreliable.
 *
 * Level geometry and its visual representation are authored together, so a
 * platform the player can see is always a platform they can stand on.
 */

import { SolidKind } from '../../game/physics.ts';

export interface PlatformDefinition {
  /** Centre position in metres. */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: SolidKind;
  sprite: string;
  castsShadow: boolean;
}

export interface PropDefinition {
  x: number;
  y: number;
  width: number;
  height: number;
  sprite: string;
  rotation: number;
  emissive: number;
  castsShadow: boolean;
}

export interface LightDefinition {
  x: number;
  y: number;
  radius: number;
  color: [number, number, number];
  intensity: number;
  shadowStrength: number;
  /** Amplitude of the idle flicker, as a fraction of intensity. */
  flicker: number;
}

export interface RoomDefinition {
  name: string;
  /** Camera confiner, in metres. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  spawn: { x: number; y: number };
  /** X position that counts as completing the room. */
  exitX: number;
  platforms: PlatformDefinition[];
  props: PropDefinition[];
  lights: LightDefinition[];
}

export function buildAresApproach(): RoomDefinition {
  const platforms: PlatformDefinition[] = [];
  const props: PropDefinition[] = [];
  const lights: LightDefinition[] = [];

  /**
   * Adds a floor section spanning `[x0, x1]` whose walkable surface is `topY`.
   *
   * Specifying the span rather than a centre and width is what keeps the level
   * readable as a sequence of surfaces and gaps.
   */
  const floor = (x0: number, x1: number, topY: number, sprite = 'ares.ground'): void => {
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

  /** Adds a thin floating ledge. */
  const ledge = (x0: number, x1: number, topY: number, oneWay = false): void => {
    const thickness = 0.75;
    platforms.push({
      x: (x0 + x1) / 2,
      y: topY + thickness / 2,
      width: x1 - x0,
      height: thickness,
      kind: oneWay ? SolidKind.OneWay : SolidKind.Solid,
      sprite: 'ares.ledge',
      castsShadow: true,
    });
  };

  // --- Act 1: flat, safe ground -------------------------------------------
  // Long enough to reach full running speed before anything is asked of the
  // player.
  floor(-34, -9, 0);

  // --- Act 2: gaps ---------------------------------------------------------
  // A 3.0 m gap, well inside the 10 m range, so the first jump is unmissable.
  floor(-6, 5, -1.1);
  // A 3.2 m gap onto a step 1.4 m higher: gap and climb combined.
  floor(8.2, 20, -1.4);

  // --- Act 3: the wall -----------------------------------------------------
  // A 2.6 m gap onto ground beneath a tall pillar, which teaches the wall
  // slide and wall jump without punishing a player who ignores them.
  floor(22.6, 34, -2.6);

  // A 2.2 m barrier standing *on* the floor. It is low enough to clear with a
  // normal jump, so it never blocks progress, but tall enough that a player who
  // runs at it without jumping will slide down its face and discover the wall
  // slide. An earlier version of this pillar was 6.6 m tall with its base
  // floating half a metre above the ground: it sealed the route completely,
  // since the character could neither fit underneath nor jump over.
  const barrierTop = -2.6 - 2.2;
  platforms.push({
    x: 26.0,
    y: (barrierTop + -2.6) / 2,
    width: 0.9,
    height: 2.2,
    kind: SolidKind.Solid,
    sprite: 'ares.pillar',
    castsShadow: true,
  });

  // Optional high ledge, above the main route. Reachable with a well-timed jump
  // from the barrier, and carries a reward for the player who spots it.
  ledge(28.5, 32.5, -6.4, true);

  // --- Act 4: the climb ----------------------------------------------------
  // A staircase of 1.4 m rises with 2.5 m gaps, opening onto the vista.
  //
  // The treads are 6 m wide rather than the 3.6 m first tried. At a running
  // 8.3 m/s a 3.6 m ledge is crossed in 0.43 s, so a jump that arrives even
  // slightly long sails straight over it and into the next gap. Landing zones
  // have to be sized against the speed the player actually arrives at.
  ledge(36.5, 42.5, -4.0);
  ledge(45.0, 51.0, -5.4);
  ledge(53.5, 59.5, -6.8);
  floor(62.0, 78, -8.2);

  // --- Props ---------------------------------------------------------------
  // Sparse and deliberate: clutter fights the silhouette reading the
  // composition depends on.
  const crates: [number, number, number][] = [
    [-26.4, 0, 1.05],
    [-25.5, 0, 0.72],
    [-15.2, 0, 0.9],
    [1.6, -1.1, 0.85],
    [16.4, -1.4, 1.1],
    [31.0, -2.6, 0.95],
    [69.0, -8.2, 1.15],
    [70.1, -8.2, 0.78],
  ];
  for (const [x, surfaceY, size] of crates) {
    props.push({
      x,
      y: surfaceY - size / 2,
      width: size,
      height: size,
      sprite: 'panel',
      rotation: 0,
      emissive: 0,
      castsShadow: true,
    });
  }

  // Lit consoles: the room's practical light sources, and waypoints that draw
  // the eye along the intended route.
  const consoles: [number, number][] = [
    [-20.0, 0],
    [-2.5, -1.1],
    [12.0, -1.4],
    [29.5, -2.6],
    [65.0, -8.2],
  ];
  for (const [x, surfaceY] of consoles) {
    props.push({
      x,
      y: surfaceY - 0.4,
      width: 1.2,
      height: 0.8,
      sprite: 'panelLit',
      rotation: 0,
      emissive: 0.65,
      castsShadow: true,
    });
    lights.push({
      x,
      y: surfaceY - 0.55,
      radius: 5.6,
      color: [0.247, 0.914, 1.0],
      intensity: 1.35,
      shadowStrength: 0.8,
      flicker: 0.08,
    });
  }

  return {
    name: 'ares.approach',
    bounds: { minX: -40, minY: -20, maxX: 80, maxY: 8 },
    spawn: { x: -30, y: 0 },
    exitX: 74,
    platforms,
    props,
    lights,
  };
}
