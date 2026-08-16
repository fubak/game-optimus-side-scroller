/**
 * The Foundry — art generation.
 *
 * The buried assembly complex that built Optimus. Where the Ares Basin is open,
 * warm, and dusty, the Foundry is enclosed, cold, and lit almost entirely by
 * artificial sources: magenta and amber signage, the orange glow of molten
 * channels, and hard shafts of light through torn ceiling plate.
 *
 * ## Reading as a different place
 *
 * Two biomes built from the same generators very easily read as the same place
 * recoloured. The Foundry avoids that by changing the *structure* as well as
 * the palette:
 *
 * - Its silhouettes are **manufactured** — straight edges, repeated bays,
 *   right angles — against Ares's eroded organic profiles.
 * - Its light comes from **inside the frame**, so surfaces are lit from below
 *   and the side rather than raked by a distant sun.
 * - It is **enclosed**: a ceiling means vertical framing, which changes the
 *   composition of every shot rather than merely its colour.
 */

import { NoiseField } from '../core/math/noise.ts';
import { clamp01, smoothstep, lerp } from '../core/math/scalar.ts';
import { createSurface, setPixel, type Surface } from './texgen.ts';
import { PALETTE } from './library.ts';

/**
 * The Foundry palette.
 *
 * Cold blue-grey structure, so the warm emissives — magenta signage, amber
 * molten metal — carry all the saturation. The player's cyan still has to
 * survive against that, which is why the signage sits at magenta rather than
 * anywhere near cyan on the wheel.
 */
export const FOUNDRY = {
  voidHigh: [0.045, 0.05, 0.075] as const,
  voidMid: [0.075, 0.08, 0.115] as const,
  voidLow: [0.13, 0.115, 0.145] as const,

  structureFar: [0.085, 0.092, 0.125] as const,
  structureMid: [0.10, 0.105, 0.135] as const,
  structureNear: [0.062, 0.066, 0.088] as const,
  deckPlate: [0.115, 0.12, 0.145] as const,
  rust: [0.26, 0.15, 0.10] as const,

  magenta: [1.0, 0.24, 0.62] as const,
  amber: [1.0, 0.52, 0.14] as const,
  molten: [1.0, 0.42, 0.10] as const,
} as const;

/**
 * The enclosed backdrop.
 *
 * Not a sky: a dark interior void with a faint warm glow rising from below,
 * as though from molten channels out of frame. That upward gradient is the
 * opposite of Ares's downward one, and it is most of what makes the two biomes
 * feel structurally different rather than merely differently coloured.
 */
export function makeFoundryVoid(width: number, height: number, seed = 0xf0d1): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    let r: number;
    let g: number;
    let b: number;
    if (v < 0.6) {
      const t = smoothstep(0, 0.6, v);
      r = lerp(FOUNDRY.voidHigh[0], FOUNDRY.voidMid[0], t);
      g = lerp(FOUNDRY.voidHigh[1], FOUNDRY.voidMid[1], t);
      b = lerp(FOUNDRY.voidHigh[2], FOUNDRY.voidMid[2], t);
    } else {
      const t = smoothstep(0.6, 1, v);
      r = lerp(FOUNDRY.voidMid[0], FOUNDRY.voidLow[0], t);
      g = lerp(FOUNDRY.voidMid[1], FOUNDRY.voidLow[1], t);
      b = lerp(FOUNDRY.voidMid[2], FOUNDRY.voidLow[2], t);
    }

    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      // Two pools of heat rising from below, at incommensurate positions so
      // they never look like a symmetric vignette.
      const heatA = Math.pow(clamp01(1 - Math.hypot((u - 0.28) * 1.6, (v - 1.15) * 1.1) / 0.55), 2.2);
      const heatB = Math.pow(clamp01(1 - Math.hypot((u - 0.74) * 1.6, (v - 1.22) * 1.1) / 0.48), 2.4);
      const heat = clamp01(heatA * 0.55 + heatB * 0.45);

      const haze = noise.fbm2(u * 4.2, v * 6.5, 4) * 0.5 + 0.5;

      const outR = clamp01(lerp(r, FOUNDRY.molten[0] * 0.5, heat) + (haze - 0.5) * 0.035);
      const outG = clamp01(lerp(g, FOUNDRY.molten[1] * 0.42, heat) + (haze - 0.5) * 0.03);
      const outB = clamp01(lerp(b, FOUNDRY.molten[2] * 0.4, heat) + (haze - 0.5) * 0.028);

      setPixel(surface, x, y, outR, outG, outB, 1);
      const index = y * width + x;
      // Emissive so the lighting pass passes it through unchanged, exactly as
      // the Ares sky is handled.
      surface.emissive[index] = 1;
      surface.roughness[index] = 1;
    }
  }
  return surface;
}

export interface MachineryOptions {
  /** Base height of the skyline, as a fraction. */
  baseHeight: number;
  amplitude: number;
  /** Number of structural bays across the tile. */
  bays: number;
  color: readonly [number, number, number];
  hazeColor: readonly [number, number, number];
  hazeAmount: number;
  /** Density of emissive window and signage lights. */
  lightDensity: number;
  lightColor: readonly [number, number, number];
  detail: number;
}

/**
 * A tileable band of industrial machinery silhouette.
 *
 * Built from stacked rectangular bays with pipes and lit windows rather than
 * from noise. Manufactured structures need right angles and repetition; noise
 * produces organic profiles no matter how it is tuned, which is why the Ares
 * ridge generator cannot be reused here with a different palette.
 */
export function makeMachinery(
  width: number,
  height: number,
  seed: number,
  options: MachineryOptions,
): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  const bayWidth = width / options.bays;

  /** Deterministic pseudo-random in [0,1) for bay `i`, stream `k`. */
  const bayRandom = (i: number, k: number): number => {
    const n = Math.sin((i + 1) * 12.9898 + k * 78.233 + seed * 0.017) * 43758.5453;
    return n - Math.floor(n);
  };

  for (let bay = 0; bay < options.bays; bay++) {
    const x0 = Math.floor(bay * bayWidth);
    const x1 = Math.floor((bay + 1) * bayWidth);

    // Stepped heights, so the skyline is a series of plateaus.
    const step = Math.round(bayRandom(bay, 0) * 4) / 4;
    const top = Math.floor((1 - options.baseHeight - step * options.amplitude) * height);

    // The main block.
    for (let y = Math.max(0, top); y < height; y++) {
      for (let x = x0; x < x1; x++) {
        const index = y * width + x;
        const depthIn = (y - top) / height;
        const grain = noise.fbm2(x * 0.09, y * 0.09, 3) * 0.5 + 0.5;

        // Vertical panel seams every few pixels: the manufactured read.
        const seam = (x - x0) % Math.max(4, Math.floor(bayWidth / 6)) === 0 ? 0.72 : 1;
        const shade = (0.8 + grain * 0.4) * seam * (1 - options.detail * 0.2 + options.detail * grain * 0.3);

        const haze = clamp01(options.hazeAmount * (1 - depthIn * 0.5));
        const r = lerp(options.color[0] * shade, options.hazeColor[0], haze);
        const g = lerp(options.color[1] * shade, options.hazeColor[1], haze);
        const b = lerp(options.color[2] * shade, options.hazeColor[2], haze);

        setPixel(surface, x, y, r, g, b, 1);
        surface.heightField[index] = 0.4 + grain * 0.3;
        surface.roughness[index] = 0.55;
        surface.metallic[index] = 0.85;
      }
    }

    // A pipe running up the side of some bays.
    if (bayRandom(bay, 1) > 0.55) {
      const pipeX = x0 + Math.floor(bayWidth * (0.15 + bayRandom(bay, 2) * 0.6));
      const pipeW = Math.max(2, Math.floor(bayWidth * 0.07));
      for (let y = Math.max(0, top - Math.floor(height * 0.06)); y < height; y++) {
        for (let x = pipeX; x < pipeX + pipeW; x++) {
          if (x < 0 || x >= width) continue;
          const index = y * width + x;
          const haze = clamp01(options.hazeAmount * 0.9);
          setPixel(
            surface,
            x,
            y,
            lerp(options.color[0] * 1.5, options.hazeColor[0], haze),
            lerp(options.color[1] * 1.5, options.hazeColor[1], haze),
            lerp(options.color[2] * 1.5, options.hazeColor[2], haze),
            1,
          );
          surface.heightField[index] = 0.85;
          surface.roughness[index] = 0.35;
        }
      }
    }

    // Lit windows: the emissive grid that makes distant machinery read as
    // *occupied* rather than as a dark shape.
    const rows = 3 + Math.floor(bayRandom(bay, 3) * 3);
    const columns = 2 + Math.floor(bayRandom(bay, 4) * 3);
    const windowW = Math.max(2, Math.floor(bayWidth / (columns * 5.0)));
    const windowH = Math.max(2, Math.floor(height * 0.014));

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        if (bayRandom(bay, 10 + row * 7 + col) > options.lightDensity) continue;

        const wx = x0 + Math.floor(bayWidth * (0.2 + (col / columns) * 0.6));
        const wy = top + Math.floor(height * 0.05) + row * Math.floor(height * 0.045);
        if (wy < 0 || wy + windowH >= height) continue;

        for (let y = wy; y < wy + windowH; y++) {
          for (let x = wx; x < wx + windowW; x++) {
            if (x < 0 || x >= width) continue;
            const index = y * width + x;
            // Held below full brightness so signage reads as a lit window
            // rather than a lamp pointed at the camera.
            const brightness = 0.62;
            setPixel(
              surface,
              x,
              y,
              options.lightColor[0] * brightness,
              options.lightColor[1] * brightness,
              options.lightColor[2] * brightness,
              1,
            );
            // Distant lights are dimmed by haze along with everything else, or
            // they punch through the atmosphere and destroy the depth read.
            surface.emissive[index] = clamp01(1 - options.hazeAmount * 0.7);
            surface.roughness[index] = 0.2;
            surface.metallic[index] = 0;
          }
        }
      }
    }
  }

  return surface;
}

/**
 * A deck-plate floor slab.
 *
 * Ribbed metal with a lit leading edge, the manufactured counterpart to Ares's
 * dusty crust. The bright top edge does the same job in both biomes: it is the
 * line the player reads as "this is where I stand", and atmospheric lighting
 * swallows it very easily.
 */
export function makeDeckPlate(width: number, height: number, seed: number): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);
  const crust = Math.max(3, Math.floor(height * 0.09));
  const ribSpacing = Math.max(6, Math.floor(width / 12));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const depth = y / height;
      const grain = noise.fbm2(x * 0.11, y * 0.11, 4) * 0.5 + 0.5;

      // Vertical ribs, the structural read of a deck plate.
      const rib = x % ribSpacing < 2 ? 1.35 : 1;
      // Rust weeping downward from the ribs.
      const rustAmount = clamp01(noise.fbm2(x * 0.05, y * 0.012 + 30, 3) * 0.5 + 0.5 - 0.35) * depth;

      const depthShade = lerp(1.0, 0.34, smoothstep(0, 0.6, depth));
      const shade = depthShade * (0.82 + grain * 0.32) * rib;

      let r = FOUNDRY.deckPlate[0] * shade;
      let g = FOUNDRY.deckPlate[1] * shade;
      let b = FOUNDRY.deckPlate[2] * shade;
      r = lerp(r, FOUNDRY.rust[0], rustAmount * 0.6);
      g = lerp(g, FOUNDRY.rust[1], rustAmount * 0.6);
      b = lerp(b, FOUNDRY.rust[2], rustAmount * 0.6);

      const inCrust = y < crust;
      if (inCrust) {
        const t = 1 - y / crust;
        // A leading edge catching the molten light from below. Kept under the
        // bloom threshold: it is a lit surface, not a light source. Its job is
        // to mark where the player stands, so it needs contrast against the
        // slab beneath it rather than absolute brightness.
        r = lerp(r, 0.36, t * 0.85);
        g = lerp(g, 0.33, t * 0.8);
        b = lerp(b, 0.38, t * 0.75);
      }

      setPixel(surface, x, y, r, g, b, 1);
      surface.heightField[index] = inCrust ? 0.85 : 0.3 + grain * 0.4 + (rib > 1 ? 0.25 : 0);
      surface.roughness[index] = 0.38 + grain * 0.2 + rustAmount * 0.3;
      surface.metallic[index] = 0.92 - rustAmount * 0.5;
    }
  }
  return surface;
}

/**
 * A molten channel: the Foundry's practical light source.
 *
 * Fully emissive with a hot core and a cooling crust, so it drives the bloom
 * chain and casts real light on everything around it.
 */
export function makeMoltenChannel(width: number, height: number, seed: number): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const v = y / (height - 1);

      // Hot in the middle, crusting toward both edges.
      const core = 1 - Math.abs(v - 0.5) * 2;
      const flow = noise.fbm2(x * 0.035, y * 0.12, 4) * 0.5 + 0.5;
      const heat = clamp01(Math.pow(core, 0.7) * (0.6 + flow * 0.7));

      // Solidified crust floating on the surface, which is what stops it
      // reading as a flat orange stripe.
      const crust = clamp01(noise.fbm2(x * 0.06 + 90, y * 0.2, 3) * 0.5 + 0.5 - 0.42) * (1 - heat);

      let r = lerp(0.16, 1.0, heat);
      let g = lerp(0.06, 0.62, Math.pow(heat, 1.5));
      let b = lerp(0.05, 0.22, Math.pow(heat, 3));

      r = lerp(r, 0.11, crust * 2.2);
      g = lerp(g, 0.07, crust * 2.2);
      b = lerp(b, 0.07, crust * 2.2);

      setPixel(surface, x, y, clamp01(r), clamp01(g), clamp01(b), 1);
      surface.emissive[index] = clamp01(heat * 1.2 - crust * 1.5);
      surface.roughness[index] = 0.7;
      surface.metallic[index] = 0;
      surface.heightField[index] = 0.2 + crust * 0.5;
    }
  }
  return surface;
}

/**
 * A hanging chassis on a dead conveyor.
 *
 * Narrative furniture: half-built Optimus units, still on the line. These are
 * the clearest statement the environment makes about what this place is, and
 * they use the same shell palette as the player so the connection is explicit.
 */
export function makeHangingChassis(width: number, height: number, seed: number): Surface {
  const surface = createSurface(width, height);
  const noise = new NoiseField(seed);
  const cx = width / 2;

  // Suspension cable.
  const cableW = Math.max(1, Math.floor(width * 0.03));
  for (let y = 0; y < height * 0.22; y++) {
    for (let x = Math.floor(cx - cableW / 2); x < cx + cableW / 2; x++) {
      if (x < 0 || x >= width) continue;
      const index = y * width + x;
      setPixel(surface, x, y, 0.16, 0.16, 0.18, 1);
      surface.heightField[index] = 0.6;
      surface.metallic[index] = 1;
      surface.roughness[index] = 0.4;
    }
  }

  // Torso block, hanging.
  const topY = Math.floor(height * 0.22);
  const bodyH = Math.floor(height * 0.52);
  const bodyW = Math.floor(width * 0.62);
  for (let y = topY; y < topY + bodyH; y++) {
    for (let x = Math.floor(cx - bodyW / 2); x < cx + bodyW / 2; x++) {
      if (x < 0 || x >= width) continue;
      const index = y * width + x;
      const t = (y - topY) / bodyH;
      const grain = noise.fbm2(x * 0.15, y * 0.15, 3) * 0.5 + 0.5;
      // Unfinished: the shell is dull and unpainted compared to the player's.
      const shade = (0.62 + grain * 0.3) * lerp(1, 0.7, t);
      setPixel(
        surface,
        x,
        y,
        PALETTE.shellMid[0] * shade,
        PALETTE.shellMid[1] * shade,
        PALETTE.shellMid[2] * shade,
        1,
      );
      surface.heightField[index] = 0.55 + grain * 0.3;
      surface.roughness[index] = 0.45;
      surface.metallic[index] = 0.75;
    }
  }

  // Dangling legs, incomplete.
  const legTop = topY + bodyH;
  for (const side of [-1, 1]) {
    const legX = Math.floor(cx + side * width * 0.16);
    const legW = Math.max(2, Math.floor(width * 0.11));
    const legH = Math.floor(height * 0.2);
    for (let y = legTop; y < legTop + legH; y++) {
      for (let x = legX - legW / 2; x < legX + legW / 2; x++) {
        const xi = Math.floor(x);
        if (xi < 0 || xi >= width || y >= height) continue;
        const index = y * width + xi;
        const grain = noise.fbm2(xi * 0.2, y * 0.2, 2) * 0.5 + 0.5;
        const shade = 0.45 + grain * 0.25;
        setPixel(surface, xi, y, 0.3 * shade, 0.3 * shade, 0.33 * shade, 1);
        surface.heightField[index] = 0.5;
        surface.metallic[index] = 0.9;
        surface.roughness[index] = 0.5;
      }
    }
  }

  // A single dead optic, unlit — these units never came online.
  const eyeY = topY + Math.floor(bodyH * 0.18);
  for (let y = eyeY; y < eyeY + Math.max(1, Math.floor(height * 0.02)); y++) {
    for (let x = Math.floor(cx - bodyW * 0.22); x < cx + bodyW * 0.22; x++) {
      if (x < 0 || x >= width) continue;
      setPixel(surface, x, y, 0.07, 0.07, 0.08, 1);
    }
  }

  return surface;
}
