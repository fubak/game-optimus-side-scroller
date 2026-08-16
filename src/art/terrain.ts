/**
 * Terrain and sky generation for the Ares Basin.
 *
 * ## The value hierarchy
 *
 * The single most important decision in this file is not the shapes but the
 * *values* they are drawn at. The reference games all build a frame the same
 * way:
 *
 * ```
 *   sky            brightest        low contrast, low saturation
 *   far mesas      light, hazy      barely more than a tint on the sky
 *   mid cliffs     mid              some detail, still soft
 *   playfield      mid-dark         full detail and contrast
 *   foreground     near-black       pure silhouette
 * ```
 *
 * That monotonic ramp from bright-and-flat at the back to dark-and-detailed at
 * the front *is* the illusion of depth. A scene where every layer sits at a
 * similar value reads as flat no matter how many parallax layers it has, which
 * is precisely what the automated aerial-perspective metric measures.
 *
 * Atmospheric perspective is baked into the generated colours rather than
 * applied only as a runtime tint, so distant layers keep the right relationship
 * even before fog is applied.
 */

import { NoiseField } from '../core/math/noise.ts';
import { clamp01, smoothstep, lerp } from '../core/math/scalar.ts';
import { createSurface, setPixel, type Surface } from './texgen.ts';

/**
 * The Ares Basin palette.
 *
 * Deliberately narrow: oxidised iron, rust, and dust ochre, with a cool
 * violet-blue for the atmospheric haze. The cool haze against the warm rock is
 * what makes distance read, and keeping every environment hue in the warm
 * red-orange band leaves the player's cyan as the only cool saturated element
 * in the frame.
 */
export const ARES = {
  // Sky values are deliberately held below the bloom threshold. The sky is the
  // largest area in any frame, so if it blooms, the entire image blooms — and
  // a golden-hour sky away from the sun is not, in fact, blindingly bright.
  // Only the sun disc and emissive props are authored above the threshold.
  skyHigh: [0.20, 0.17, 0.28] as const,
  skyMid: [0.44, 0.27, 0.22] as const,
  skyHorizon: [0.63, 0.42, 0.26] as const,
  sunCore: [1.0, 0.94, 0.80] as const,

  hazeFar: [0.44, 0.32, 0.34] as const,
  mesaFar: [0.36, 0.26, 0.30] as const,
  mesaMid: [0.30, 0.19, 0.19] as const,
  cliffNear: [0.22, 0.13, 0.11] as const,
  playfield: [0.30, 0.18, 0.13] as const,
  foreground: [0.04, 0.026, 0.03] as const,
} as const;

/**
 * A vertical sky gradient with a sun bloom baked in.
 *
 * Marked fully emissive so the lighting pass leaves it alone — the sky is a
 * light *source*, not a lit surface, and running it through the normal-mapped
 * diffuse path would darken it and destroy the frame's dynamic range.
 */
export function makeSky(
  width: number,
  height: number,
  sunU: number,
  sunV: number,
  seed = 0x5417,
): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);

    // Two-stage gradient: deep violet aloft, warming through rust to a bright
    // ochre horizon. A single linear ramp reads as a cheap backdrop; the
    // mid-stop is what makes it look like an atmosphere.
    let r: number;
    let g: number;
    let b: number;
    if (v < 0.55) {
      const t = smoothstep(0, 0.55, v);
      r = lerp(ARES.skyHigh[0], ARES.skyMid[0], t);
      g = lerp(ARES.skyHigh[1], ARES.skyMid[1], t);
      b = lerp(ARES.skyHigh[2], ARES.skyMid[2], t);
    } else {
      const t = smoothstep(0.55, 1, v);
      r = lerp(ARES.skyMid[0], ARES.skyHorizon[0], t);
      g = lerp(ARES.skyMid[1], ARES.skyHorizon[1], t);
      b = lerp(ARES.skyMid[2], ARES.skyHorizon[2], t);
    }

    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);

      // Sun glow. Two falloffs stacked: a tight core and a very wide halo, the
      // combination that makes a light source feel genuinely bright rather than
      // like a pasted-on circle.
      const dx = (u - sunU) * 2.4;
      const dy = v - sunV;
      const distance = Math.hypot(dx, dy);
      const core = Math.pow(clamp01(1 - distance / 0.075), 2.5);
      const halo = Math.pow(clamp01(1 - distance / 0.40), 2.6) * 0.34;
      const glow = clamp01(core + halo);

      // Thin high dust bands, stretched horizontally.
      const band = noise.fbm2(u * 3.1, v * 9.0, 4) * 0.5 + 0.5;
      const bandStrength = smoothstep(0.25, 0.85, v) * 0.10;

      let outR = lerp(r, ARES.sunCore[0], glow);
      let outG = lerp(g, ARES.sunCore[1], glow);
      let outB = lerp(b, ARES.sunCore[2], glow);

      outR = clamp01(outR + (band - 0.5) * bandStrength);
      outG = clamp01(outG + (band - 0.5) * bandStrength * 0.9);
      outB = clamp01(outB + (band - 0.5) * bandStrength * 0.7);

      setPixel(surface, x, y, outR, outG, outB, 1);

      const index = y * width + x;
      // Fully emissive: the sky is a light source, so the lighting pass must
      // pass it through at exactly its authored value rather than shading it.
      // Only the sun disc is bright enough to cross the bloom threshold.
      surface.emissive[index] = 1;
      surface.roughness[index] = 1;
      surface.metallic[index] = 0;
      surface.heightField[index] = 0;
    }
  }
  return surface;
}

export interface RidgeOptions {
  /** Base height of the skyline as a fraction of the surface height. */
  baseHeight: number;
  /** Vertical amplitude of the skyline, as a fraction. */
  amplitude: number;
  /** Horizontal frequency of the large forms. */
  frequency: number;
  /** How much the profile is snapped into flat-topped mesas, in [0, 1]. */
  mesaFactor: number;
  /** Base colour before atmospheric tinting. */
  color: readonly [number, number, number];
  /** Haze colour blended in by `hazeAmount`. */
  hazeColor: readonly [number, number, number];
  /** 0 keeps the base colour, 1 is fully hazed out. */
  hazeAmount: number;
  /** Internal detail contrast; distant layers should use very little. */
  detail: number;
  /** Vertical falloff of haze; higher hazes the base of the form more. */
  hazeGradient: number;
}

/**
 * Generates a horizontally-tileable ridge silhouette.
 *
 * The skyline profile is fbm noise passed through a flattening function that
 * pulls it toward discrete plateaus. That is what turns generic rolling hills
 * into the flat-topped, layered mesas that read specifically as *Mars* rather
 * than as a generic mountain range — and the brief's requirement is
 * environments that feel thematically right, not merely competent.
 */
export function makeRidge(width: number, height: number, seed: number, options: RidgeOptions): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  /** Skyline height at column x, in pixels from the top. */
  const profile = (x: number): number => {
    const u = x / width;
    // Sampling on a circle keeps the profile seamless when tiled.
    const angle = u * Math.PI * 2;
    const sampleX = Math.cos(angle) * options.frequency;
    const sampleY = Math.sin(angle) * options.frequency;

    let n = noise.fbm3(sampleX, sampleY, seed * 0.017, 5) * 0.5 + 0.5;

    // Flatten toward plateaus. Quantising and blending back keeps the terraced
    // read while leaving the edges organic.
    if (options.mesaFactor > 0) {
      const steps = 5;
      const quantised = Math.round(n * steps) / steps;
      n = lerp(n, quantised, options.mesaFactor);
    }

    const top = (1 - options.baseHeight - n * options.amplitude) * height;
    return top;
  };

  for (let x = 0; x < width; x++) {
    const top = profile(x);

    for (let y = 0; y < height; y++) {
      const index = y * width + x;

      // Antialias the skyline edge over one pixel; a hard edge on a distant
      // ridge shimmers badly as the camera pans.
      const coverage = clamp01(y - top + 0.5);
      if (coverage <= 0) continue;

      const depthIntoForm = (y - top) / height;

      // Internal relief, kept subtle. Distant forms must stay low-contrast or
      // they compete with the foreground for attention.
      const relief =
        noise.fbm2(x * 0.012, y * 0.03, 4) * 0.5 + 0.5 + noise.ridged(x * 0.05, y * 0.05, 3) * 0.35;

      const shade = lerp(0.78, 1.12, clamp01(relief)) * (1 - options.detail * 0.5 + options.detail * clamp01(relief));

      // Haze thickens toward the base of the form, matching how real
      // atmospheric scattering accumulates along a longer sight line.
      const haze = clamp01(
        options.hazeAmount * (1 - depthIntoForm * options.hazeGradient),
      );

      const baseR = options.color[0] * shade;
      const baseG = options.color[1] * shade;
      const baseB = options.color[2] * shade;

      const r = lerp(baseR, options.hazeColor[0], haze);
      const g = lerp(baseG, options.hazeColor[1], haze);
      const b = lerp(baseB, options.hazeColor[2], haze);

      setPixel(surface, x, y, r, g, b, coverage);

      surface.heightField[index] = clamp01(relief) * (1 - haze) * 0.8;
      surface.roughness[index] = 0.88;
      surface.metallic[index] = 0;
      // Distant hazed forms scatter light rather than reflecting it
      // directionally, so a little translucency keeps them from going dead flat.
      surface.translucency[index] = haze * 0.4;
    }
  }
  return surface;
}

/**
 * A solid foreground silhouette.
 *
 * Near-black, no internal detail, used to frame the bottom and edges of the
 * screen. Foreground framing is one of the most reliable ways to make a 2D
 * scene feel like a photographed space rather than a flat backdrop, and it
 * costs almost nothing to draw.
 */
export function makeForegroundRock(width: number, height: number, seed: number): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  for (let x = 0; x < width; x++) {
    const u = x / width;
    const angle = u * Math.PI * 2;
    const n = noise.fbm3(Math.cos(angle) * 1.6, Math.sin(angle) * 1.6, seed * 0.013, 4) * 0.5 + 0.5;
    const top = (0.35 - n * 0.32) * height;

    for (let y = 0; y < height; y++) {
      const coverage = clamp01(y - top + 0.5);
      if (coverage <= 0) continue;
      const index = y * width + x;

      // A whisper of internal variation stops the silhouette reading as a flat
      // vector shape, without making it compete for attention.
      const grain = noise.fbm2(x * 0.04, y * 0.04, 3) * 0.5 + 0.5;
      const shade = lerp(0.75, 1.25, grain);

      setPixel(
        surface,
        x,
        y,
        ARES.foreground[0] * shade,
        ARES.foreground[1] * shade,
        ARES.foreground[2] * shade,
        coverage,
      );
      surface.heightField[index] = grain * 0.5;
      surface.roughness[index] = 0.95;
    }
  }
  return surface;
}

/**
 * A ground platform surface with a distinct lit top edge.
 *
 * The bright rim along the top is doing real work: it is the visual line the
 * player reads as "this is where I stand". Platforms without a defined top edge
 * are a common readability failure in atmospheric 2D games, where the mood
 * lighting swallows the very information the player needs to jump accurately.
 */
export function makeGroundSlab(width: number, height: number, seed: number): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  const crustHeight = Math.max(3, Math.floor(height * 0.10));

  for (let x = 0; x < width; x++) {
    // Slight undulation so the top edge is not mechanically straight.
    const edgeNoise = noise.fbm2(x * 0.03, 0, 3) * 0.5 + 0.5;
    const edgeOffset = Math.floor(edgeNoise * height * 0.05);

    for (let y = 0; y < height; y++) {
      const index = y * width + x;
      if (y < edgeOffset) continue;

      const depth = (y - edgeOffset) / height;

      const ridge = noise.ridged(x * 0.03, y * 0.035, 5);
      const grain = noise.fbm2(x * 0.09, y * 0.09, 4) * 0.5 + 0.5;
      const relief = clamp01(ridge * 0.6 + grain * 0.4);

      // Darken with depth into the slab, so the mass reads as solid.
      const depthShade = lerp(1.0, 0.42, smoothstep(0, 0.55, depth));
      const reliefShade = lerp(0.72, 1.18, relief);

      let r = ARES.playfield[0] * depthShade * reliefShade;
      let g = ARES.playfield[1] * depthShade * reliefShade;
      let b = ARES.playfield[2] * depthShade * reliefShade;

      // The dusty, sun-catching crust along the top.
      const inCrust = y - edgeOffset < crustHeight;
      if (inCrust) {
        const crustT = 1 - (y - edgeOffset) / crustHeight;
        const dusting = clamp01(crustT * (0.55 + grain * 0.45));
        r = lerp(r, 0.72, dusting * 0.75);
        g = lerp(g, 0.50, dusting * 0.75);
        b = lerp(b, 0.34, dusting * 0.75);
      }

      setPixel(surface, x, y, r, g, b, 1);

      surface.heightField[index] = inCrust ? clamp01(relief * 0.5 + 0.5) : relief * 0.85;
      surface.roughness[index] = 0.86 - grain * 0.1;
      surface.metallic[index] = 0;
    }
  }
  return surface;
}
