/**
 * The generated art library.
 *
 * Each entry defines a surface parametrically. Because they all draw on the
 * same primitives and the same palette constants, the whole set shares a
 * coherent visual language — panels bevel the same way, wear falls in the same
 * places, and emissive accents use the same cyan.
 */

import { NoiseField } from '../core/math/noise.ts';
import { clamp01, smoothstep, lerp } from '../core/math/scalar.ts';
import { OPTIMUS_CYAN } from '../core/config.ts';
import {
  createSurface,
  bevelledRect,
  addSurfaceNoise,
  addEdgeWear,
  setPixel,
  radialFalloff,
  type Surface,
} from './texgen.ts';
import { metresToTexels, type AtlasSource } from './atlas.ts';

/**
 * Shared palette.
 *
 * Ares Basin is built from oxidised iron reds and dust ochres, deliberately
 * desaturated so the cyan of Optimus's own lighting is the only truly saturated
 * thing on screen. That single decision does most of the work of making the
 * character read as the focal point in every frame.
 */
export const PALETTE = {
  rockLight: [0.42, 0.26, 0.19] as const,
  rockDark: [0.19, 0.115, 0.09] as const,
  rockShadow: [0.11, 0.07, 0.06] as const,
  dust: [0.55, 0.36, 0.25] as const,

  shellLight: [0.86, 0.87, 0.89] as const,
  shellMid: [0.62, 0.64, 0.68] as const,
  shellDark: [0.22, 0.23, 0.26] as const,
  frame: [0.13, 0.135, 0.15] as const,
  joint: [0.07, 0.072, 0.08] as const,

  cyan: [OPTIMUS_CYAN.r, OPTIMUS_CYAN.g, OPTIMUS_CYAN.b] as const,
  amber: [1.0, 0.62, 0.22] as const,
} as const;

/**
 * A tileable rock face.
 *
 * Built from ridged noise, which produces sharp creases rather than soft blobs
 * and so reads as fractured stone instead of clay. Horizontal strata are laid
 * over the top, because sedimentary banding is the visual cue that instantly
 * says "canyon" — it is what makes the Ares Basin look like a place rather than
 * a pile of textured rock.
 */
export function makeRock(size: number, seed: number, strataStrength = 0.35): Surface {
  const surface = createSurface(size, size);
  const noise = new NoiseField(seed);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;

      const ridge = noise.ridged(x * 0.028, y * 0.028, 5);
      const detail = noise.fbm2(x * 0.11, y * 0.11, 4) * 0.5 + 0.5;

      // Horizontal banding, warped so the strata are not suspiciously straight.
      const warp = noise.fbm2(x * 0.014, y * 0.02, 3) * 12;
      const strata = Math.sin((y + warp) * 0.22) * 0.5 + 0.5;

      let relief = ridge * 0.62 + detail * 0.24 + strata * strataStrength * 0.5;
      relief = clamp01(relief);
      surface.heightField[index] = relief;

      // Colour tracks relief: recesses are darker and cooler, exposed faces
      // catch dust and lighten.
      const shade = smoothstep(0.15, 0.85, relief);
      const dusting = clamp01(noise.fbm2(x * 0.05 + 100, y * 0.05, 3) * 0.5 + 0.5);

      let r = lerp(PALETTE.rockShadow[0], PALETTE.rockLight[0], shade);
      let g = lerp(PALETTE.rockShadow[1], PALETTE.rockLight[1], shade);
      let b = lerp(PALETTE.rockShadow[2], PALETTE.rockLight[2], shade);

      const dustAmount = dusting * shade * 0.4;
      r = lerp(r, PALETTE.dust[0], dustAmount);
      g = lerp(g, PALETTE.dust[1], dustAmount);
      b = lerp(b, PALETTE.dust[2], dustAmount);

      setPixel(surface, x, y, r, g, b, 1);

      // Rock is entirely dielectric and rough; only the dust film varies.
      surface.roughness[index] = 0.82 + dusting * 0.14;
      surface.metallic[index] = 0.0;
    }
  }
  return surface;
}

/**
 * A mechanical panel in the Optimus design language.
 *
 * Rounded-rectangle shell plate, recessed border, a seam line, and an optional
 * cyan emissive strip. Every mechanical object in the game — the character's
 * armour, crates, doors, machinery — is assembled from this vocabulary, which
 * is what makes the world feel manufactured by the same hand that built the
 * robot.
 */
export function makePanel(
  width: number,
  height: number,
  seed: number,
  options: { emissiveStrip?: boolean; cornerRadius?: number; wear?: number } = {},
): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);
  const cornerRadius = options.cornerRadius ?? Math.min(width, height) * 0.16;
  const inset = Math.max(2, Math.min(width, height) * 0.07);

  // Dark structural frame beneath the shell.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      setPixel(surface, x, y, PALETTE.frame[0], PALETTE.frame[1], PALETTE.frame[2], 1);
      surface.roughness[index] = 0.55;
      surface.metallic[index] = 0.85;
      surface.heightField[index] = 0.25;
    }
  }

  // The raised shell plate.
  bevelledRect(
    surface,
    inset,
    inset,
    width - inset,
    height - inset,
    cornerRadius,
    Math.max(2.5, inset * 1.3),
    1,
  );

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const relief = surface.heightField[index]!;
      if (relief <= 0.26) continue;

      // Subtle vertical gradient across the plate so it is never flat colour.
      const gradient = y / height;
      const shade = lerp(1.0, 0.82, gradient);
      const plate = smoothstep(0.3, 0.85, relief);

      const r = lerp(PALETTE.shellDark[0], PALETTE.shellLight[0] * shade, plate);
      const g = lerp(PALETTE.shellDark[1], PALETTE.shellLight[1] * shade, plate);
      const b = lerp(PALETTE.shellDark[2], PALETTE.shellLight[2] * shade, plate);

      setPixel(surface, x, y, r, g, b, 1);
      surface.roughness[index] = 0.34 + noise.fbm2(x * 0.2, y * 0.2, 2) * 0.06;
      surface.metallic[index] = 0.72;
    }
  }

  // Panel seam: a thin recessed line, the signature detail of the whole set.
  const seamY = Math.floor(height * 0.62);
  const seamThickness = Math.max(1, Math.round(height * 0.018));
  for (let y = seamY; y < seamY + seamThickness; y++) {
    for (let x = Math.floor(inset * 2); x < width - inset * 2; x++) {
      const index = y * width + x;
      if (surface.heightField[index]! <= 0.26) continue;
      surface.heightField[index] = surface.heightField[index]! * 0.55;
      setPixel(surface, x, y, PALETTE.joint[0], PALETTE.joint[1], PALETTE.joint[2], 1);
      surface.roughness[index] = 0.7;
    }
  }

  if (options.emissiveStrip) {
    const stripY = Math.floor(height * 0.28);
    const stripThickness = Math.max(1, Math.round(height * 0.035));
    const stripX0 = Math.floor(width * 0.22);
    const stripX1 = Math.floor(width * 0.78);
    for (let y = stripY; y < stripY + stripThickness; y++) {
      for (let x = stripX0; x < stripX1; x++) {
        const index = y * width + x;
        if (index < 0 || index >= surface.emissive.length) continue;
        setPixel(surface, x, y, PALETTE.cyan[0], PALETTE.cyan[1], PALETTE.cyan[2], 1);
        surface.emissive[index] = 1;
        surface.roughness[index] = 0.2;
        surface.metallic[index] = 0;
      }
    }
  }

  addSurfaceNoise(surface, noise, 0.35, 0.03, 2);
  addEdgeWear(surface, noise, options.wear ?? 0.45);
  return surface;
}

/**
 * A wind-blown dust sheet.
 *
 * Long horizontal streaks of soft alpha, used in layers at different parallax
 * depths and drift rates to build the constantly-moving Martian air. Motion in
 * the background is a large part of why a scene feels alive rather than
 * painted.
 */
export function makeDustSheet(width: number, height: number, seed: number): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      // Stretched sampling makes the noise streak horizontally, as wind-driven
      // dust actually behaves.
      const streak = noise.fbm2(x * 0.006, y * 0.05, 4) * 0.5 + 0.5;
      const breakUp = noise.fbm2(x * 0.02 + 50, y * 0.02, 3) * 0.5 + 0.5;

      // Fade at the top and bottom edges so tiled sheets have no visible seam.
      const edgeFade = smoothstep(0, 0.25, y / height) * (1 - smoothstep(0.75, 1, y / height));
      const alpha = clamp01((streak * breakUp - 0.35) * 2.1) * edgeFade;

      setPixel(surface, x, y, PALETTE.dust[0], PALETTE.dust[1], PALETTE.dust[2], alpha);
      surface.heightField[index] = alpha * 0.15;
      surface.roughness[index] = 1;
      surface.translucency[index] = 0.85;
    }
  }
  return surface;
}

/** Builds the initial atlas source list. */
export function buildCoreAtlasSources(): AtlasSource[] {
  const sources: AtlasSource[] = [];

  // Four rock variants, so tiled ground never shows an obvious repeat.
  for (let i = 0; i < 4; i++) {
    sources.push({
      name: `rock${i}`,
      surface: makeRock(metresToTexels(1), 0x400 + i * 977),
      widthMetres: 1,
    });
  }

  sources.push({
    name: 'panel',
    surface: makePanel(metresToTexels(1), metresToTexels(1), 0x811),
    widthMetres: 1,
  });

  sources.push({
    name: 'panelLit',
    surface: makePanel(metresToTexels(1.2), metresToTexels(0.8), 0x822, {
      emissiveStrip: true,
    }),
    widthMetres: 1.2,
  });

  sources.push({
    name: 'glow',
    surface: radialFalloff(128, 2.4, 0.3),
    widthMetres: 2,
  });

  sources.push({
    name: 'mote',
    surface: radialFalloff(32, 1.8, 0.5),
    widthMetres: 0.08,
  });

  sources.push({
    name: 'dustSheet',
    surface: makeDustSheet(512, 128, 0x9a1),
    widthMetres: 16,
  });

  return sources;
}
