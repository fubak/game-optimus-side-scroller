/**
 * The Foundry — biome definition.
 *
 * Enclosed, cold, and lit from inside the frame. Where the Ares Basin is a warm
 * exterior raked by a distant sun, the Foundry's light comes from molten
 * channels below and magenta signage in the middle distance, so surfaces are
 * under-lit and the value ramp runs the opposite way: dark at the top, hot at
 * the bottom.
 *
 * Inverting that ramp is what stops the two biomes reading as the same place
 * recoloured — it changes the composition of every frame, not just its hue.
 */

import type { AtlasSource } from '../../art/atlas.ts';
import type { ParallaxLayer } from '../../scene/parallax.ts';
import type { Atmosphere } from '../../render/pipeline.ts';
import { Depth } from '../../core/config.ts';
import { BlendMode } from '../../gfx/device.ts';
import {
  makeFoundryVoid,
  makeMachinery,
  makeDeckPlate,
  makeMoltenChannel,
  makeHangingChassis,
  FOUNDRY,
} from '../../art/foundry.ts';
import { makeDustSheet } from '../../art/library.ts';

export function buildFoundryAtlasSources(): AtlasSource[] {
  return [
    {
      name: 'foundry.void',
      surface: makeFoundryVoid(384, 216, 0xf0d1),
      widthMetres: 40,
    },
    {
      // Furthest machinery: almost entirely hazed out, with only its lit
      // windows still reading.
      name: 'foundry.machineryFar',
      surface: makeMachinery(1024, 320, 0xf101, {
        baseHeight: 0.24,
        amplitude: 0.42,
        bays: 9,
        color: FOUNDRY.structureFar,
        hazeColor: [0.14, 0.13, 0.19],
        hazeAmount: 0.72,
        lightDensity: 0.42,
        lightColor: FOUNDRY.magenta,
        detail: 0.15,
      }),
      widthMetres: 88,
    },
    {
      name: 'foundry.machineryMid',
      surface: makeMachinery(1024, 352, 0xf102, {
        baseHeight: 0.20,
        amplitude: 0.52,
        bays: 6,
        color: FOUNDRY.structureMid,
        hazeColor: [0.14, 0.13, 0.19],
        hazeAmount: 0.40,
        lightDensity: 0.30,
        lightColor: FOUNDRY.amber,
        detail: 0.5,
      }),
      widthMetres: 64,
    },
    {
      name: 'foundry.machineryNear',
      surface: makeMachinery(1024, 384, 0xf103, {
        baseHeight: 0.16,
        amplitude: 0.58,
        bays: 4,
        color: FOUNDRY.structureNear,
        hazeColor: [0.12, 0.11, 0.16],
        hazeAmount: 0.12,
        lightDensity: 0.20,
        lightColor: FOUNDRY.magenta,
        detail: 0.8,
      }),
      widthMetres: 46,
    },
    {
      name: 'foundry.deck',
      surface: makeDeckPlate(512, 256, 0xf201),
      widthMetres: 15,
    },
    {
      name: 'foundry.ledge',
      surface: makeDeckPlate(256, 48, 0xf202),
      widthMetres: 4,
    },
    {
      name: 'foundry.pillar',
      surface: makeDeckPlate(64, 320, 0xf203),
      widthMetres: 1,
    },
    {
      name: 'foundry.molten',
      surface: makeMoltenChannel(384, 64, 0xf301),
      widthMetres: 12,
    },
    {
      name: 'foundry.chassis',
      surface: makeHangingChassis(128, 256, 0xf401),
      widthMetres: 1.6,
    },
    {
      // Steam rather than dust: the same generator, but tinted cold and drawn
      // rising instead of drifting.
      name: 'foundry.steam',
      surface: makeDustSheet(768, 160, 0xf501),
      widthMetres: 34,
    },
  ];
}

export function buildFoundryLayers(): ParallaxLayer[] {
  return [
    {
      sprite: 'foundry.void',
      depth: Depth.Sky,
      y: 0,
      heightMetres: 1,
      lockToCamera: true,
      emissive: 1,
    },
    {
      sprite: 'foundry.machineryFar',
      depth: 8,
      y: -2.0,
      heightMetres: 30,
      tint: [1, 1, 1],
      opacity: 1,
    },
    {
      // Warm haze pooling in the middle distance, lit from the molten channels.
      sprite: 'foundry.steam',
      depth: 6.2,
      y: 1.0,
      heightMetres: 14,
      driftX: 0.18,
      bobAmplitude: 0.4,
      bobSpeed: 0.11,
      tint: [1.0, 0.52, 0.30],
      opacity: 0.085,
      emissive: 0.6,
      blend: BlendMode.Additive,
    },
    {
      sprite: 'foundry.machineryMid',
      depth: 5.0,
      y: 0.2,
      heightMetres: 25,
      tint: [1, 1, 1],
      opacity: 1,
    },
    {
      sprite: 'foundry.machineryNear',
      depth: 2.8,
      y: 1.8,
      heightMetres: 20,
      tint: [1, 1, 1],
      opacity: 1,
    },
    {
      sprite: 'foundry.steam',
      depth: 1.6,
      y: 2.4,
      heightMetres: 9,
      driftX: 0.5,
      bobAmplitude: 0.25,
      bobSpeed: 0.19,
      tint: [0.85, 0.55, 0.42],
      opacity: 0.055,
      emissive: 0.5,
      blend: BlendMode.Additive,
    },
    {
      sprite: 'ares.foreground',
      depth: Depth.Foreground,
      y: 0,
      heightMetres: 10,
      anchorTop: 0.56,
      // Reused geometry, tinted to the Foundry's cold structure colour rather
      // than Ares's rust. A foreground silhouette is almost pure black anyway,
      // so its shape carries far more than its origin.
      tint: [0.55, 0.58, 0.72],
      opacity: 1,
    },
  ];
}

/**
 * Atmosphere for the Foundry.
 *
 * Ambient is near-black: in an enclosed industrial space essentially all the
 * light is practical, and letting ambient fill the shadows would erase the
 * hard pools of light the whole biome is composed around.
 */
export function buildFoundryAtmosphere(): Atmosphere {
  return {
    // Cold blue from the far machinery.
    ambientSky: [0.18, 0.22, 0.38],
    ambientSkyIntensity: 0.10,
    // Warm bounce off the molten channels below — the light is under the
    // player here, not above.
    ambientGround: [0.70, 0.30, 0.10],
    ambientGroundIntensity: 0.15,
    rimColor: [1.0, 0.42, 0.62],
    rimStrength: 0.75,

    fogColor: [0.16, 0.13, 0.20],
    fogDensity: 0.34,
    fogHeightFalloff: 0.5,
    fogNoiseStrength: 0.55,
    fogWindX: 0.30,
    fogWindY: -0.14,

    // Shafts break downward through torn ceiling plate, so the source sits
    // above rather than off to the side.
    godRayX: 0,
    godRayY: -14,
    godRayColor: [1.0, 0.55, 0.30],
    godRayDensity: 0.68,
    godRayDecay: 0.968,
    godRayWeight: 0.48,
    godRayExposure: 0.40,

    // A biome lit almost entirely by emissives needs a *higher* threshold than
    // one lit by a sun, not a lower one. At 0.46 every lit window, the molten
    // crust, and the deck plate's lit edge all crossed it at once and the whole
    // frame turned to white soup.
    bloomThreshold: 0.58,
    bloomKnee: 0.20,
    bloomIntensity: 0.95,
    emissiveScale: 1.0,

    exposure: 0.92,
    contrast: 1.26,
    saturation: 1.18,
    lift: -0.006,
    vignette: 0.68,
    chromaticAberration: 0.0034,
    barrelDistortion: 0.012,
    grainAmount: 0.036,
    gradeMix: 0,
  };
}
