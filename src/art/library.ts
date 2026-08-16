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

  // Optimus is white, but a near-white albedo under a strong key light plus
  // fill plus rim saturates to a featureless silhouette with a bloom halo and
  // no material read at all. These values keep the character reading as the
  // brightest thing on screen while leaving headroom for the lighting to
  // actually describe its surfaces.
  shellLight: [0.63, 0.645, 0.675] as const,
  shellMid: [0.44, 0.455, 0.49] as const,
  shellDark: [0.17, 0.18, 0.21] as const,
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

/**
 * A shipping crate.
 *
 * Deliberately dark and matte, with corner brackets and a single small
 * indicator. The earlier prop reused the bright shell-plate panel, which at
 * gameplay scale read unmistakably as a wall-mounted screen: large, white, and
 * flat-fronted. Containers need to sit *below* the character in value, or they
 * compete with him for attention in every frame.
 */
export function makeCrate(size: number, seed: number): Surface {
  const surface = createSurface(size, size);
  const noise = new NoiseField(seed);
  const inset = size * 0.055;

  // Dark body.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      const grain = noise.fbm2(x * 0.14, y * 0.14, 3) * 0.5 + 0.5;
      const vertical = 1 - (y / size) * 0.35;
      const shade = (0.72 + grain * 0.28) * vertical;
      setPixel(surface, x, y, 0.20 * shade, 0.185 * shade, 0.175 * shade, 1);
      surface.heightField[index] = 0.35 + grain * 0.12;
      surface.roughness[index] = 0.62 + grain * 0.14;
      surface.metallic[index] = 0.75;
    }
  }

  // Raised centre panel, so the face is not a flat rectangle.
  bevelledRect(
    surface,
    inset * 2.4,
    inset * 2.4,
    size - inset * 2.4,
    size - inset * 2.4,
    size * 0.05,
    Math.max(2, size * 0.035),
    0.72,
  );
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      if (surface.heightField[index]! <= 0.48) continue;
      const grain = noise.fbm2(x * 0.2, y * 0.2, 2) * 0.5 + 0.5;
      const shade = 0.85 + grain * 0.3;
      setPixel(surface, x, y, 0.30 * shade, 0.28 * shade, 0.265 * shade, 1);
      surface.roughness[index] = 0.5;
    }
  }

  // Corner brackets in a lighter alloy: the detail that says "container".
  const bracket = Math.round(size * 0.24);
  for (const [cx, cy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const x0 = cx === 0 ? 0 : size - bracket;
    const y0 = cy === 0 ? 0 : size - bracket;
    for (let y = y0; y < y0 + bracket; y++) {
      for (let x = x0; x < x0 + bracket; x++) {
        // Only the outer L of the bracket, not a solid square.
        const nearX = cx === 0 ? x < bracket * 0.34 : x > size - bracket * 0.34;
        const nearY = cy === 0 ? y < bracket * 0.34 : y > size - bracket * 0.34;
        if (!nearX && !nearY) continue;
        const index = y * size + x;
        const grain = noise.fbm2(x * 0.3, y * 0.3, 2) * 0.5 + 0.5;
        const shade = 0.8 + grain * 0.35;
        setPixel(surface, x, y, 0.46 * shade, 0.44 * shade, 0.43 * shade, 1);
        surface.heightField[index] = 0.82;
        surface.roughness[index] = 0.34;
        surface.metallic[index] = 0.95;
      }
    }
  }

  // A single small cyan status light.
  const lightX = Math.round(size * 0.5);
  const lightY = Math.round(size * 0.30);
  const lightR = Math.max(1, Math.round(size * 0.035));
  for (let y = lightY - lightR; y <= lightY + lightR; y++) {
    for (let x = lightX - lightR * 2; x <= lightX + lightR * 2; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const index = y * size + x;
      setPixel(surface, x, y, PALETTE.cyan[0], PALETTE.cyan[1], PALETTE.cyan[2], 1);
      surface.emissive[index] = 1;
      surface.roughness[index] = 0.2;
      surface.metallic[index] = 0;
    }
  }

  addEdgeWear(surface, noise, 0.5, 0.09);
  return surface;
}

/**
 * A hovering sentry drone.
 *
 * Deliberately built from a different vocabulary to Optimus: an angular
 * chassis, an amber optic, and no white shell plating. Enemies must be
 * distinguishable from the player at a glance and at speed, and colour is the
 * fastest channel for that — amber against the player's cyan, on opposite sides
 * of the wheel.
 */
export function makeDrone(size: number, seed: number): Surface {
  const surface = createSurface(size, size);
  const noise = new NoiseField(seed);
  const cx = size / 2;
  const cy = size / 2;

  // Angular chassis: a wide hexagonal body.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x - cx) / (size * 0.46);
      const ny = (y - cy) / (size * 0.34);
      // A superellipse gives hard shoulders without literal corners.
      const d = Math.pow(Math.abs(nx), 2.6) + Math.pow(Math.abs(ny), 2.6);
      if (d > 1) continue;

      const index = y * size + x;
      const relief = clamp01(1 - d) ;
      const grain = noise.fbm2(x * 0.16, y * 0.16, 3) * 0.5 + 0.5;
      const shade = (0.55 + relief * 0.55) * (0.82 + grain * 0.3);

      setPixel(surface, x, y, 0.24 * shade, 0.225 * shade, 0.235 * shade, 1);
      surface.heightField[index] = 0.35 + relief * 0.55;
      surface.roughness[index] = 0.42 + grain * 0.16;
      surface.metallic[index] = 0.9;
    }
  }

  // Armour ridge along the top.
  bevelledRect(
    surface,
    size * 0.18,
    size * 0.30,
    size * 0.82,
    size * 0.44,
    size * 0.05,
    Math.max(2, size * 0.03),
    0.95,
  );
  for (let y = Math.floor(size * 0.30); y < Math.floor(size * 0.44); y++) {
    for (let x = Math.floor(size * 0.18); x < Math.floor(size * 0.82); x++) {
      const index = y * size + x;
      if (surface.albedo[index * 4 + 3]! < 128) continue;
      setPixel(surface, x, y, 0.40, 0.38, 0.39, 1);
      surface.roughness[index] = 0.3;
    }
  }

  // The amber optic: a single bright horizontal slit.
  const eyeY = Math.round(size * 0.54);
  const eyeH = Math.max(1, Math.round(size * 0.055));
  for (let y = eyeY; y < eyeY + eyeH; y++) {
    for (let x = Math.round(size * 0.30); x < Math.round(size * 0.70); x++) {
      const index = y * size + x;
      if (index < 0 || index >= surface.emissive.length) continue;
      setPixel(surface, x, y, PALETTE.amber[0], PALETTE.amber[1], PALETTE.amber[2], 1);
      surface.emissive[index] = 1;
      surface.roughness[index] = 0.2;
      surface.metallic[index] = 0;
    }
  }

  addEdgeWear(surface, noise, 0.4, 0.09);
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

  for (let i = 0; i < 3; i++) {
    sources.push({
      name: `crate${i}`,
      surface: makeCrate(metresToTexels(1, 2), 0x8c0 + i * 613),
      widthMetres: 1,
    });
  }

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
    // Written additively into the contact-occlusion buffer, so this is a
    // *density* map: white with a soft radial alpha, not a dark sprite.
    name: 'drone',
    surface: makeDrone(metresToTexels(0.85, 3), 0xd40e),
    widthMetres: 0.85,
  });

  sources.push({
    name: 'aoBlob',
    surface: radialFalloff(128, 1.5, 0.35),
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
