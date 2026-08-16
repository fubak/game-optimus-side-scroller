/**
 * The biome registry.
 *
 * A biome bundles everything that makes a place feel like itself: its atlas
 * sources, its parallax stack, its atmosphere, and the rooms built from it.
 * Keeping them together means adding a biome is a single registration rather
 * than edits scattered across the renderer, the world, and the game shell.
 *
 * All biomes' atlas sources are baked into one atlas at load. That costs a
 * little memory but means a biome transition is a change of layer list and
 * atmosphere with no texture upload at all — so moving between areas can be
 * seamless rather than a loading pause.
 */

import type { AtlasSource } from '../../art/atlas.ts';
import type { ParallaxLayer } from '../../scene/parallax.ts';
import type { Atmosphere } from '../../render/pipeline.ts';
import type { RoomDefinition } from '../rooms/ares-approach.ts';

import {
  buildAresAtlasSources,
  buildAresLayers,
  buildAresAtmosphere,
} from './ares.ts';
import {
  buildFoundryAtlasSources,
  buildFoundryLayers,
  buildFoundryAtmosphere,
} from './foundry.ts';
import { buildAresApproach } from '../rooms/ares-approach.ts';
import { buildFoundryDescent } from '../rooms/foundry-descent.ts';

export const enum BiomeId {
  Ares = 0,
  Foundry = 1,
}

export interface Biome {
  id: BiomeId;
  name: string;
  atlasSources(): AtlasSource[];
  layers(): ParallaxLayer[];
  atmosphere(): Atmosphere;
  room(): RoomDefinition;
  /** Direction of the key light, in radians. */
  sunAngle: number;
  /** Colour of the key light. */
  sunColor: [number, number, number];
  sunIntensity: number;
  /** Whether the key light casts shadows, and how strongly. */
  sunShadow: number;
  /** Warm and cool tints for the ambient dust field. */
  dustWarm: [number, number, number];
  dustCool: [number, number, number];
  /** Sprite used for the ambient particle field. */
  moteSprite: string;
  /**
   * A broad, shadowless fill from the key light's direction.
   *
   * Open exteriors need one, or the sun's shadows go pitch black. Enclosed
   * interiors must not have one: it washes every surface to the same pale value
   * and erases the pools of practical light the space is built around.
   */
  fill: { radius: number; color: [number, number, number]; intensity: number } | null;
}

export const BIOMES: Record<BiomeId, Biome> = {
  [BiomeId.Ares]: {
    id: BiomeId.Ares,
    name: 'Ares Basin',
    atlasSources: buildAresAtlasSources,
    layers: buildAresLayers,
    atmosphere: buildAresAtmosphere,
    room: buildAresApproach,
    // Low and raking, from up and to the left.
    sunAngle: -(Math.PI - 0.38),
    sunColor: [1.0, 0.72, 0.46],
    sunIntensity: 1.5,
    sunShadow: 0.82,
    dustWarm: [1.0, 0.72, 0.44],
    dustCool: [0.58, 0.54, 0.72],
    moteSprite: 'mote',
    fill: { radius: 46, color: [1.0, 0.66, 0.42], intensity: 0.8 },
  },
  [BiomeId.Foundry]: {
    id: BiomeId.Foundry,
    name: 'The Foundry',
    atlasSources: buildFoundryAtlasSources,
    layers: buildFoundryLayers,
    atmosphere: buildFoundryAtmosphere,
    room: buildFoundryDescent,
    // Almost straight down, through torn ceiling plate.
    sunAngle: -Math.PI / 2 - 0.22,
    sunColor: [1.0, 0.58, 0.34],
    sunIntensity: 0.85,
    sunShadow: 0.9,
    // Embers rather than dust: hot orange against cold blue-grey.
    dustWarm: [1.0, 0.48, 0.16],
    dustCool: [0.42, 0.46, 0.68],
    moteSprite: 'mote',
    fill: null,
  },
};

export function allBiomeAtlasSources(): AtlasSource[] {
  return Object.values(BIOMES).flatMap((biome) => biome.atlasSources());
}
