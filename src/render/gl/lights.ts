/**
 * Dynamic light collection for the deferred lighting pass.
 *
 * {@link LightList} is a preallocated, fixed-capacity store of point lights plus one ambient
 * sky/ground tint — packed as flat `Float32Array`s so the lighting pass can upload them straight
 * to uniform arrays with no per-frame allocation. {@link collectLights} fills it from a
 * {@link World} snapshot every frame: it only *reads* world state (player/enemy/pickup/tile
 * positions, particle snapshots) and never mutates it, so it is safe to call from a read-only
 * renderer.
 *
 * Lights are added in priority order — ambient, then the player's own emissives, then nearby
 * world emissives — and silently dropped past {@link LightList.capacity}, so the highest-value
 * lights (the ones attached to the player, always on screen) are never the ones that get cut when
 * a level is busy.
 */

import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../game/constants';
import { TileKind } from '../../game/tiles';
import type { World } from '../../game/world';
import { parseColor } from '../color';
import { palette } from '../palette';
import type { ParticleView } from '../particles';
import type { QualityPreset, RenderSettings } from '../settings';

/** Hard cap on simultaneous point lights; also the size of the shader's uniform arrays. */
export const MAX_LIGHTS = 24;

/** How many point lights a frame may use, by quality preset (ambient is always free). */
function lightBudgetForQuality(quality: QualityPreset): number {
  switch (quality) {
    case 'low':
      return 6;
    case 'medium':
      return 12;
    case 'high':
      return 20;
    case 'ultra':
      return MAX_LIGHTS;
    default: {
      const exhaustive: never = quality;
      throw new Error(`Unhandled quality preset: ${String(exhaustive)}`);
    }
  }
}

/**
 * Preallocated point-light store plus one ambient term.
 *
 * `posRadiusHeight` and `colorIntensity` are laid out as `MAX_LIGHTS` groups of 4 floats each
 * (`[x, y, radius, height]` and `[r, g, b, intensity]` respectively) so the lighting pass can hand
 * them to `uniform4fv` directly. Positions are *world-space*; the lighting pass subtracts the
 * camera when it builds the final screen-space uniforms, so light collection never needs to know
 * about the current view.
 */
export class LightList {
  readonly capacity: number;
  readonly posRadiusHeight: Float32Array;
  readonly colorIntensity: Float32Array;
  count = 0;

  ambientSky: readonly [number, number, number] = [0, 0, 0];
  ambientGround: readonly [number, number, number] = [0, 0, 0];
  ambientIntensity = 0;

  constructor(capacity: number = MAX_LIGHTS) {
    this.capacity = capacity;
    this.posRadiusHeight = new Float32Array(capacity * 4);
    this.colorIntensity = new Float32Array(capacity * 4);
  }

  reset(): void {
    this.count = 0;
  }

  setAmbient(
    ground: readonly [number, number, number],
    sky: readonly [number, number, number],
    intensity: number,
  ): void {
    this.ambientGround = ground;
    this.ambientSky = sky;
    this.ambientIntensity = intensity;
  }

  /**
   * Add one point light in world space. `height` is the assumed distance of the light above the
   * 2D plane, used only to keep the Lambert term well-defined for lights that sit directly over a
   * flat surface (see the lighting pass shader). Returns `false` (dropping the light) once
   * {@link capacity} lights have already been added this frame.
   */
  add(
    x: number,
    y: number,
    radius: number,
    height: number,
    r: number,
    g: number,
    b: number,
    intensity: number,
  ): boolean {
    if (this.count >= this.capacity) return false;
    const base = this.count * 4;
    this.posRadiusHeight[base] = x;
    this.posRadiusHeight[base + 1] = y;
    this.posRadiusHeight[base + 2] = radius;
    this.posRadiusHeight[base + 3] = height;
    this.colorIntensity[base] = r;
    this.colorIntensity[base + 1] = g;
    this.colorIntensity[base + 2] = b;
    this.colorIntensity[base + 3] = intensity;
    this.count += 1;
    return true;
  }
}

export interface CollectLightsParams {
  readonly world: World;
  readonly settings: RenderSettings;
  readonly reducedMotion: boolean;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly viewWidth: number;
  readonly viewHeight: number;
}

/** Margin (world px) added around the camera rect before a light is considered "visible". */
const VIEW_MARGIN = 24;

function inView(params: CollectLightsParams, x: number, y: number): boolean {
  const { cameraX, cameraY, viewWidth, viewHeight } = params;
  return (
    x >= cameraX - VIEW_MARGIN &&
    x <= cameraX + viewWidth + VIEW_MARGIN &&
    y >= cameraY - VIEW_MARGIN &&
    y <= cameraY + viewHeight + VIEW_MARGIN
  );
}

/**
 * Ambient hemisphere tints: bright enough that unlit terrain reads at roughly the same brightness
 * as Classic's flat-painted materials (which assume "fully lit", not "lit by a dim night sky") —
 * `palette.skyTop`/`skyBottom` are deliberately near-black background *atmosphere* colours and
 * would crush every material to near-invisibility if used as a multiplicative light. `plateLight`
 * (bright, cool — stands in for factory ceiling light hitting up-facing surfaces) and `plateFace`
 * (the tiles' own mid-tone — stands in for bounced light reaching down-facing surfaces/undersides)
 * are already tuned to sit near "normal" material brightness, so multiplying by them keeps terrain
 * legible while still giving {@link LightingPass}'s hemisphere term something to shade with.
 */
const AMBIENT_SKY = parseColor(palette.plateLight);
const AMBIENT_GROUND = parseColor(palette.plateFace);

/** Fills `out` from `params.world`'s current state. Never mutates the world. */
export function collectLights(params: CollectLightsParams, out: LightList): void {
  out.reset();

  out.setAmbient(
    [AMBIENT_GROUND[0], AMBIENT_GROUND[1], AMBIENT_GROUND[2]],
    [AMBIENT_SKY[0], AMBIENT_SKY[1], AMBIENT_SKY[2]],
    0.42,
  );

  const budget = lightBudgetForQuality(params.settings.quality);
  if (budget <= 0) return;

  addPlayerLights(params, out, budget);
  if (out.count >= budget) return;
  addPickupLights(params, out, budget);
  if (out.count >= budget) return;
  addTileLights(params, out, budget);
  if (out.count >= budget) return;
  addEnemyLights(params, out, budget);
  if (out.count >= budget) return;
  addParticleLights(params, out, budget);
}

function addPlayerLights(params: CollectLightsParams, out: LightList, budget: number): void {
  const { player } = params.world;
  if (!player.isAlive) return;
  const centerX = player.body.x + PLAYER_WIDTH / 2;

  // Small radii relative to the 10x22 player box: these are meant to accent the visor/core as
  // bright details, not wash the whole silhouette in colour (the shell's own light grey albedo —
  // see `drawPlayer` — needs to stay legible under them).
  const visor = parseColor(palette.visor);
  out.add(centerX, player.body.y + 4, 18, 8, visor[0], visor[1], visor[2], 1.1);
  if (out.count >= budget) return;

  const coreColor = parseColor(player.energyRatio > 0.25 ? palette.energy : palette.uiWarn);
  out.add(centerX, player.body.y + 10, 16, 7, coreColor[0], coreColor[1], coreColor[2], 0.85);
  if (out.count >= budget) return;

  if (player.state === 'thrust') {
    const flame = parseColor(palette.flame);
    out.add(centerX, player.body.y + PLAYER_HEIGHT + 6, 56, 16, flame[0], flame[1], flame[2], 1.8);
    if (out.count >= budget) return;
  }

  if (player.state === 'dash') {
    const dash = parseColor(palette.visorGlow);
    out.add(centerX, player.body.y + PLAYER_HEIGHT / 2, 26, 12, dash[0], dash[1], dash[2], 0.8);
  }
}

function addPickupLights(params: CollectLightsParams, out: LightList, budget: number): void {
  const energyColor = parseColor(palette.energy);
  for (const pickup of params.world.pickups) {
    if (out.count >= budget) return;
    if (pickup.collected || pickup.kind !== 'energyCell') continue;
    const x = pickup.x + pickup.width / 2;
    const y = pickup.y + pickup.height / 2;
    if (!inView(params, x, y)) continue;
    out.add(x, y, 22, 10, energyColor[0], energyColor[1], energyColor[2], 0.55);
  }
}

/** Cap on how many spike-tile rim lights are added, so a hazard field never eats the whole budget. */
const MAX_SPIKE_LIGHTS = 3;

function addTileLights(params: CollectLightsParams, out: LightList, budget: number): void {
  const { world } = params;
  const { map } = world;
  const tileSize = map.tileSize;
  const minTx = Math.max(0, Math.floor(params.cameraX / tileSize));
  const maxTx = Math.min(map.width - 1, Math.floor((params.cameraX + params.viewWidth) / tileSize));
  const minTy = Math.max(0, Math.floor(params.cameraY / tileSize));
  const maxTy = Math.min(map.height - 1, Math.floor((params.cameraY + params.viewHeight) / tileSize));

  const goalColor = parseColor(palette.visorGlow);
  const checkpointColor = parseColor(palette.energy);
  const hazardColor = parseColor(palette.hazard);
  let spikeLights = 0;

  for (let ty = minTy; ty <= maxTy; ty += 1) {
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      if (out.count >= budget) return;
      const kind = map.tileAt(tx, ty);
      const cx = tx * tileSize + tileSize / 2;
      const cy = ty * tileSize + tileSize / 2;
      switch (kind) {
        case TileKind.Goal:
          out.add(cx, cy, 34, 12, goalColor[0], goalColor[1], goalColor[2], 1);
          break;
        case TileKind.Checkpoint:
          if (world.isCheckpointActive(tx, ty)) {
            out.add(cx, cy, 20, 8, checkpointColor[0], checkpointColor[1], checkpointColor[2], 0.6);
          }
          break;
        case TileKind.Spike:
          if (spikeLights < MAX_SPIKE_LIGHTS) {
            spikeLights += 1;
            out.add(cx, cy + 4, 14, 4, hazardColor[0], hazardColor[1], hazardColor[2], 0.4);
          }
          break;
        case TileKind.Empty:
        case TileKind.Solid:
        case TileKind.OneWay:
        case TileKind.ConveyorLeft:
        case TileKind.ConveyorRight:
        case TileKind.Scenery:
          break;
        default: {
          const exhaustive: never = kind;
          throw new Error(`Unhandled tile kind in collectLights: ${String(exhaustive)}`);
        }
      }
    }
  }
}

function addEnemyLights(params: CollectLightsParams, out: LightList, budget: number): void {
  const { world } = params;
  const hazardColor = parseColor(palette.hazard);
  const coreColor = parseColor(palette.visorGlow);

  for (const enemy of world.enemies) {
    if (out.count >= budget) return;
    if (enemy.state !== 'active') continue;
    const centerX = enemy.body.x + enemy.body.width / 2;
    const centerY = enemy.body.y + enemy.body.height / 2;
    if (!inView(params, centerX, centerY)) continue;

    if (enemy.kind === 'turret') {
      // Matches the charge-light pulse `drawTurret` uses in Classic — same frequency, well under
      // the 3 Hz reduced-motion ceiling, so it is left on even with `reducedMotion` set.
      const charge = 0.35 + 0.35 * Math.sin(enemy.animTime * 6);
      out.add(centerX, centerY, 18, 6, hazardColor[0], hazardColor[1], hazardColor[2], charge * 0.5);
      continue;
    }
    if (enemy.kind === 'overseer' && world.isBossVulnerable(enemy)) {
      out.add(centerX, centerY, 30, 10, coreColor[0], coreColor[1], coreColor[2], 1.1);
    }
  }
}

/** Cap on how many particle-derived lights are added — sparks/debris are numerous but tiny. */
const MAX_PARTICLE_LIGHTS = 3;

function addParticleLights(params: CollectLightsParams, out: LightList, budget: number): void {
  const { particles } = params.world;
  let added = 0;
  const sparkColor = parseColor(palette.spark);
  for (let i = 0; i < particles.capacity && added < MAX_PARTICLE_LIGHTS; i += 1) {
    if (out.count >= budget) return;
    const particle: ParticleView | null = particles.particleAt(i);
    if (particle === null) continue;
    if (particle.kind !== 'spark' && particle.kind !== 'debris') continue;
    if (!inView(params, particle.x, particle.y)) continue;
    const progress = particle.life / particle.maxLife;
    out.add(particle.x, particle.y, 12, 4, sparkColor[0], sparkColor[1], sparkColor[2], progress * 0.5);
    added += 1;
  }
}
