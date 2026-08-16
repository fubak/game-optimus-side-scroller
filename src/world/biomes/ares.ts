/**
 * Ares Basin — the surface canyons, at golden hour.
 *
 * Art direction: a low, hard sun raking across layered mesas; monumental dust
 * hanging in the air; an ochre-and-rust palette held deliberately narrow so
 * that Optimus's cyan is the only cool, saturated thing in the frame.
 *
 * The layer stack is built to produce a strict value ramp from bright, flat sky
 * at the back to near-black silhouettes at the front. That ramp is what the
 * automated aerial-perspective metric measures, and it is the property that
 * most distinguishes the reference games from a flat 2D scene.
 */

import type { AtlasSource } from '../../art/atlas.ts';
import type { ParallaxLayer } from '../../scene/parallax.ts';
import type { Atmosphere } from '../../render/pipeline.ts';
import { Depth } from '../../core/config.ts';
import { BlendMode } from '../../gfx/device.ts';
import { makeSky, makeRidge, makeForegroundRock, makeGroundSlab, ARES } from '../../art/terrain.ts';
import { makeDustSheet } from '../../art/library.ts';

/** Where the sun sits on the sky texture, in normalised coordinates. */
export const ARES_SUN_U = 0.2;
export const ARES_SUN_V = 0.62;

/**
 * The sun's world position.
 *
 * Placed far away and high so god rays radiate from a plausible off-screen
 * source. God rays only appear where the source is roughly on-screen, so this
 * is kept within the view's reach rather than at true astronomical distance.
 */
export const ARES_SUN_WORLD = { x: -26, y: -13 };

export function buildAresAtlasSources(): AtlasSource[] {
  return [
    {
      name: 'ares.sky',
      surface: makeSky(512, 288, ARES_SUN_U, ARES_SUN_V, 0x5417),
      widthMetres: 40,
    },
    {
      // Furthest mesas: barely more than a tint on the sky. Almost fully hazed,
      // almost no internal detail.
      name: 'ares.ridgeFar',
      surface: makeRidge(768, 256, 0x9001, {
        baseHeight: 0.30,
        amplitude: 0.34,
        frequency: 1.4,
        mesaFactor: 0.62,
        color: ARES.mesaFar,
        hazeColor: ARES.hazeFar,
        hazeAmount: 0.80,
        detail: 0.12,
        hazeGradient: 0.35,
      }),
      widthMetres: 96,
    },
    {
      name: 'ares.ridgeMid',
      surface: makeRidge(768, 288, 0x9002, {
        baseHeight: 0.26,
        amplitude: 0.44,
        frequency: 2.1,
        mesaFactor: 0.55,
        color: ARES.mesaMid,
        hazeColor: ARES.hazeFar,
        hazeAmount: 0.52,
        detail: 0.35,
        hazeGradient: 0.6,
      }),
      widthMetres: 72,
    },
    {
      name: 'ares.ridgeNear',
      surface: makeRidge(768, 320, 0x9003, {
        baseHeight: 0.22,
        amplitude: 0.52,
        frequency: 3.0,
        mesaFactor: 0.42,
        color: ARES.cliffNear,
        hazeColor: ARES.hazeFar,
        hazeAmount: 0.24,
        detail: 0.65,
        hazeGradient: 0.85,
      }),
      widthMetres: 54,
    },
    {
      name: 'ares.ground',
      surface: makeGroundSlab(512, 256, 0x9101),
      widthMetres: 16,
    },
    {
      // Ledges are the surfaces the player actually lands on, so they get a
      // pronounced lit top edge. Atmospheric lighting very easily swallows the
      // one piece of information a platformer player most needs.
      name: 'ares.ledge',
      surface: makeGroundSlab(256, 48, 0x9102),
      widthMetres: 4,
    },
    {
      name: 'ares.pillar',
      surface: makeGroundSlab(64, 320, 0x9103),
      widthMetres: 1,
    },
    {
      name: 'ares.foreground',
      surface: makeForegroundRock(768, 256, 0x9201),
      widthMetres: 34,
    },
    {
      name: 'ares.dustFar',
      surface: makeDustSheet(768, 192, 0x9301),
      widthMetres: 60,
    },
    {
      name: 'ares.dustNear',
      surface: makeDustSheet(768, 160, 0x9302),
      widthMetres: 36,
    },
  ];
}

/**
 * The parallax stack.
 *
 * Ten layers, with depth values chosen so the reciprocal scroll falloff spaces
 * them perceptually evenly rather than numerically evenly.
 */
export function buildAresLayers(): ParallaxLayer[] {
  return [
    {
      sprite: 'ares.sky',
      depth: Depth.Sky,
      y: 0,
      heightMetres: 1,
      lockToCamera: true,
      // Fully emissive: the sky is a light source, and running it through the
      // diffuse lighting path would darken it and collapse the frame's range.
      emissive: 1,
    },
    {
      sprite: 'ares.dustFar',
      depth: 9,
      y: -3.5,
      heightMetres: 15,
      driftX: 0.22,
      bobAmplitude: 0.35,
      bobSpeed: 0.13,
      tint: [1.0, 0.82, 0.68],
      opacity: 0.30,
      emissive: 0.55,
      blend: BlendMode.Additive,
    },
    {
      sprite: 'ares.ridgeFar',
      depth: 8,
      y: -1.5,
      heightMetres: 32,
      tint: [1.0, 0.97, 0.96],
      opacity: 1,
    },
    {
      sprite: 'ares.ridgeMid',
      depth: 5.5,
      y: 0.5,
      heightMetres: 27,
      tint: [1.0, 0.98, 0.97],
      opacity: 1,
    },
    {
      sprite: 'ares.dustNear',
      depth: 4.2,
      y: -0.5,
      heightMetres: 11,
      driftX: 0.55,
      bobAmplitude: 0.22,
      bobSpeed: 0.21,
      tint: [1.0, 0.78, 0.60],
      opacity: 0.24,
      emissive: 0.5,
      blend: BlendMode.Additive,
    },
    {
      sprite: 'ares.ridgeNear',
      depth: 3,
      y: 2.2,
      heightMetres: 22,
      tint: [1, 1, 1],
      opacity: 1,
    },
    {
      sprite: 'ares.foreground',
      depth: Depth.Foreground,
      y: 7.4,
      heightMetres: 13,
      tint: [1, 1, 1],
      opacity: 1,
    },
  ];
}

/**
 * Atmosphere settings for the biome.
 *
 * Tuned around a warm key light and a cool violet ambient. The large gap
 * between the two is what gives surfaces a readable form: a warm lit side and a
 * cool shadow side is far more legible, and far more filmic, than the same
 * colour at two brightnesses.
 */
export function buildAresAtmosphere(): Atmosphere {
  return {
    // Cool violet skylight, so shadows read blue against the warm sun.
    ambientSky: [0.42, 0.40, 0.62],
    ambientSkyIntensity: 0.40,
    // Warm bounce off the dusty ground.
    ambientGround: [0.52, 0.28, 0.18],
    ambientGroundIntensity: 0.26,
    rimColor: [1.0, 0.74, 0.48],
    rimStrength: 0.55,

    fogColor: [0.72, 0.50, 0.42],
    fogDensity: 0.30,
    fogHeightFalloff: 0.75,
    fogNoiseStrength: 0.35,
    fogWindX: 0.85,
    fogWindY: -0.06,

    godRayX: ARES_SUN_WORLD.x,
    godRayY: ARES_SUN_WORLD.y,
    godRayColor: [1.0, 0.70, 0.42],
    godRayDensity: 0.85,
    godRayDecay: 0.955,
    godRayWeight: 0.55,
    godRayExposure: 0.62,

    bloomThreshold: 0.80,
    bloomKnee: 0.30,
    bloomIntensity: 0.62,
    emissiveScale: 1.0,

    exposure: 1.08,
    contrast: 1.10,
    saturation: 1.12,
    lift: 0.004,
    vignette: 0.46,
    chromaticAberration: 0.0026,
    barrelDistortion: 0.010,
    grainAmount: 0.030,
    gradeMix: 0,
  };
}
