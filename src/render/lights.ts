/**
 * Light definitions and the per-frame light list.
 *
 * Lights are authored in world space and metres; the pipeline projects them
 * into the screen space the lighting shader works in. Keeping the authoring
 * side in world units means a lamp is "2 metres of reach" rather than "0.13 of
 * a screen", so it behaves identically at any zoom — which matters because the
 * camera pulls back for vistas and pushes in for boss fights.
 */

import { BUDGETS } from '../core/config.ts';
import type { Camera } from '../scene/camera.ts';

export const enum LightType {
  Point = 0,
  Directional = 1,
  Cone = 2,
}

export interface Light {
  type: LightType;
  /** World position in metres. Ignored for directional lights. */
  x: number;
  y: number;
  /** Reach in metres. Ignored for directional lights. */
  radius: number;
  r: number;
  g: number;
  b: number;
  intensity: number;
  /** Direction in radians, for directional and cone lights. */
  angle: number;
  /** Half-width of the cone in radians. */
  coneAngle: number;
  /** 0 casts no shadow, 1 casts a fully opaque one. */
  shadowStrength: number;
  /** Falloff curve exponent. Higher concentrates light near the source. */
  falloffExponent: number;
  /** Parallax depth the light lives at, so background lights do not lift the foreground. */
  depth: number;
  enabled: boolean;
}

export const createLight = (overrides: Partial<Light> = {}): Light => ({
  type: LightType.Point,
  x: 0,
  y: 0,
  radius: 5,
  r: 1,
  g: 1,
  b: 1,
  intensity: 1,
  angle: 0,
  coneAngle: Math.PI / 6,
  shadowStrength: 0,
  falloffExponent: 2,
  depth: 0,
  enabled: true,
  ...overrides,
});

/**
 * Collects the lights visible this frame and packs them into the flat
 * `Float32Array`s the shader expects.
 *
 * Lights are sorted by importance so that when there are more than the budget
 * allows, the ones dropped are the ones least likely to be noticed — a distant
 * dim background lamp rather than the muzzle flash in front of the player.
 */
export class LightList {
  private readonly lights: Light[] = [];

  readonly positionData: Float32Array;
  readonly colorData: Float32Array;
  readonly paramData: Float32Array;
  count = 0;

  /** How many lights were dropped this frame because of the budget. */
  culled = 0;

  constructor(readonly maxLights = BUDGETS.maxDynamicLights) {
    this.positionData = new Float32Array(maxLights * 4);
    this.colorData = new Float32Array(maxLights * 4);
    this.paramData = new Float32Array(maxLights * 4);
  }

  clear(): void {
    this.lights.length = 0;
    this.count = 0;
    this.culled = 0;
  }

  add(light: Light): void {
    if (light.enabled) this.lights.push(light);
  }

  /**
   * Projects world-space lights into screen space and packs the arrays.
   *
   * @param shadowCasterBudget Maximum number of lights permitted to raymarch
   *   shadows this frame. Shadow tracing dominates the cost of the lighting
   *   pass, so this is the main quality-tier lever.
   */
  pack(camera: Camera, shadowCasterBudget: number): void {
    const visible = camera.getVisibleBounds(2);
    const scratch = { x: 0, y: 0 };

    // Score each light so the most visually significant survive culling.
    const scored: { light: Light; score: number }[] = [];
    for (const light of this.lights) {
      if (light.type === LightType.Directional) {
        // The sun is never culled.
        scored.push({ light, score: Number.POSITIVE_INFINITY });
        continue;
      }

      // Skip lights whose reach cannot touch the view at all.
      if (
        light.x + light.radius < visible.minX ||
        light.x - light.radius > visible.maxX ||
        light.y + light.radius < visible.minY ||
        light.y - light.radius > visible.maxY
      ) {
        continue;
      }

      const centreDistance = Math.hypot(light.x - camera.x, light.y - camera.y);
      // Bright, close, wide lights matter most; depth pushes a light down the
      // list because background lights contribute little to the final image.
      const score =
        (light.intensity * light.radius) / (1 + centreDistance * 0.25) / (1 + light.depth * 0.5);
      scored.push({ light, score });
    }

    scored.sort((a, b) => b.score - a.score);

    const limit = Math.min(scored.length, this.maxLights);
    this.culled = Math.max(0, scored.length - limit);

    let shadowCastersUsed = 0;

    for (let i = 0; i < limit; i++) {
      const light = scored[i]!.light;
      const base = i * 4;

      camera.worldToScreen(light.x, light.y, scratch);

      // Screen-space radius: convert metres to a fraction of the view height.
      const screenRadius = light.radius / camera.viewHeightMetres;

      this.positionData[base] = scratch.x;
      this.positionData[base + 1] = scratch.y;
      this.positionData[base + 2] = screenRadius;
      this.positionData[base + 3] = light.intensity;

      this.colorData[base] = light.r;
      this.colorData[base + 1] = light.g;
      this.colorData[base + 2] = light.b;
      this.colorData[base + 3] = light.type;

      let shadowStrength = light.shadowStrength;
      if (shadowStrength > 0) {
        if (shadowCastersUsed < shadowCasterBudget) {
          shadowCastersUsed++;
        } else {
          // Over budget: keep the light, drop only its shadow. Losing the light
          // entirely would be far more obvious than losing its shadow.
          shadowStrength = 0;
        }
      }

      this.paramData[base] = light.angle;
      this.paramData[base + 1] = light.coneAngle;
      this.paramData[base + 2] = shadowStrength;
      this.paramData[base + 3] = light.falloffExponent;
    }

    this.count = limit;
  }

  get all(): readonly Light[] {
    return this.lights;
  }
}
