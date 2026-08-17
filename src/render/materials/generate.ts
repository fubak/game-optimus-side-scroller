/**
 * Procedural material atlas generator.
 *
 * Everything the 4K visual overhaul needs for surface detail — albedo colour, a normal map, and
 * packed roughness/AO/metallic — is painted here from a single 32-bit seed. There are no source
 * images: each material is a pure function of pixel coordinates (plus a handful of deterministic
 * feature positions derived from the seed at generation time), so re-running this module with the
 * same seed always produces byte-identical atlases. {@link ../../../scripts/generateMaterials}
 * is the CLI that exercises this and checks that determinism holds.
 *
 * Pipeline per material:
 *  1. Paint every texel to a {@link MaterialSample} (albedo, height, roughness, ao, metallic).
 *  2. Derive the normal map from the whole material's height field via central differences
 *     (wrapping at the tile edges, since the underlying noise is already seamlessly tileable).
 *  3. Pack albedo/normal/params into their shared atlas byte buffers at this material's rect.
 */

import type { Rng } from '../../core/rng';
import { createRng, hashSeed } from '../../core/rng';
import { ALL_MATERIAL_IDS, MaterialId } from './types';
import type { AtlasLayout, AtlasRect, MaterialAtlas, MaterialSample } from './types';

/** Gameplay tiles are 16px; materials are painted at 4x that density. */
export const MATERIAL_TILE_PX = 64;

/** Default seed for the whole atlas — override via the CLI script or callers that need variety. */
export const DEFAULT_MATERIAL_SEED = 0x0b71c0de;

const ATLAS_COLUMNS = 4;

function buildLayout(): AtlasLayout {
  const rows = Math.ceil(ALL_MATERIAL_IDS.length / ATLAS_COLUMNS);
  const rects: Partial<Record<MaterialId, AtlasRect>> = {};
  ALL_MATERIAL_IDS.forEach((id, index) => {
    const column = index % ATLAS_COLUMNS;
    const row = Math.floor(index / ATLAS_COLUMNS);
    rects[id] = {
      x: column * MATERIAL_TILE_PX,
      y: row * MATERIAL_TILE_PX,
      width: MATERIAL_TILE_PX,
      height: MATERIAL_TILE_PX,
    };
  });
  return {
    tileSize: MATERIAL_TILE_PX,
    columns: ATLAS_COLUMNS,
    rows,
    width: ATLAS_COLUMNS * MATERIAL_TILE_PX,
    height: rows * MATERIAL_TILE_PX,
    rects: rects as Record<MaterialId, AtlasRect>,
  };
}

/** A material's paint function: pure in (x, y) once its factory has captured the seed. */
type MaterialPainter = (x: number, y: number) => MaterialSample;

/** Builds a {@link MaterialPainter} for one material from its own derived seed. */
type PainterFactory = (seed: number, rng: Rng) => MaterialPainter;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function toByte(value01: number): number {
  return Math.max(0, Math.min(255, Math.round(clamp01(value01) * 255)));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 32-bit integer hash of a lattice point, wrapped to `period` so the noise it drives tiles cleanly. */
function latticeHash(seed: number, x: number, y: number, period: number): number {
  const wx = ((x % period) + period) % period;
  const wy = ((y % period) + period) % period;
  let h = (Math.imul(wx, 374761393) + Math.imul(wy, 668265263) + Math.imul(seed, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

/** Bilinearly-interpolated value noise over an integer lattice, seamlessly tileable at `period`. */
function valueNoise(seed: number, x: number, y: number, period: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const n00 = latticeHash(seed, x0, y0, period);
  const n10 = latticeHash(seed, x0 + 1, y0, period);
  const n01 = latticeHash(seed, x0, y0 + 1, period);
  const n11 = latticeHash(seed, x0 + 1, y0 + 1, period);
  return lerp(lerp(n00, n10, fx), lerp(n01, n11, fx), fy);
}

/** Fractal sum of {@link valueNoise} octaves, still tileable at the base `period`. */
function fbm(seed: number, x: number, y: number, period: number, octaves: number): number {
  let amplitude = 0.5;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += valueNoise(seed + octave * 101, x * frequency, y * frequency, period * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

function readHeight(height: Float32Array, size: number, x: number, y: number): number {
  const wx = ((x % size) + size) % size;
  const wy = ((y % size) + size) % size;
  return height[wy * size + wx] ?? 0;
}

/** Central-difference normal at one texel, wrapping across tile edges. Returns packed RGB bytes. */
function sampleNormalRgb(
  height: Float32Array,
  size: number,
  x: number,
  y: number,
  strength: number,
): readonly [number, number, number] {
  const left = readHeight(height, size, x - 1, y);
  const right = readHeight(height, size, x + 1, y);
  const top = readHeight(height, size, x, y - 1);
  const bottom = readHeight(height, size, x, y + 1);
  const dx = (right - left) * strength;
  const dy = (bottom - top) * strength;
  const nx = -dx;
  const ny = -dy;
  const nz = 1;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [toByte((nx / len) * 0.5 + 0.5), toByte((ny / len) * 0.5 + 0.5), toByte((nz / len) * 0.5 + 0.5)];
}

/** Distance from `v` to the nearest edge of a periodic band of width `bandWidth`, in `period`. */
function bandDistance(v: number, period: number, bandWidth: number): number {
  const w = ((v % period) + period) % period;
  const half = bandWidth / 2;
  return Math.min(Math.abs(w), Math.abs(period - w)) - half;
}

// --- Colour palettes (0..1 RGB), themed to match src/render/palette.ts without importing its
// mutable live object into baked texture data. ---
const STEEL_LIGHT = [0.58, 0.65, 0.77] as const;
const STEEL_BASE = [0.36, 0.42, 0.53] as const;
const STEEL_DARK = [0.23, 0.27, 0.35] as const;
const STEEL_SHADOW = [0.14, 0.16, 0.22] as const;
const GRATE = [0.27, 0.32, 0.42] as const;
const RUST = [0.61, 0.39, 0.25] as const;
const RUST_DARK = [0.35, 0.22, 0.14] as const;
const PAINT_TEAL = [0.19, 0.34, 0.4] as const;
const PAINT_TEAL_DARK = [0.11, 0.21, 0.25] as const;
const CONCRETE = [0.47, 0.48, 0.52] as const;
const CONCRETE_DARK = [0.34, 0.35, 0.38] as const;
const RUBBER = [0.09, 0.1, 0.12] as const;
const RUBBER_LIGHT = [0.16, 0.17, 0.2] as const;
const HAZARD = [0.85, 0.34, 0.31] as const;
const HAZARD_DARK = [0.56, 0.22, 0.2] as const;
const WARN_YELLOW = [0.92, 0.7, 0.18] as const;
const ENERGY = [0.3, 0.88, 0.7] as const;
const ENERGY_DIM = [0.12, 0.43, 0.35] as const;
const ENERGY_CORE = [0.85, 1, 0.97] as const;
const GOAL_ENERGY = [0.35, 0.9, 1] as const;
const GOAL_DIM = [0.13, 0.4, 0.47] as const;
const GOAL_CORE = [1, 1, 1] as const;

function mixColor(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Four rivet positions inset from the corners, jittered per-material by the factory's own rng. */
function makeRivetPositions(rng: Rng, size: number): [number, number][] {
  const inset = size * 0.18;
  const jitter = size * 0.05;
  return [
    [inset + rng.signedRange(jitter), inset + rng.signedRange(jitter)],
    [size - inset + rng.signedRange(jitter), inset + rng.signedRange(jitter)],
    [inset + rng.signedRange(jitter), size - inset + rng.signedRange(jitter)],
    [size - inset + rng.signedRange(jitter), size - inset + rng.signedRange(jitter)],
  ];
}

function rivetBump(x: number, y: number, positions: readonly (readonly [number, number])[], radius: number): number {
  let bump = 0;
  for (const [rx, ry] of positions) {
    const dx = x - rx;
    const dy = y - ry;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < radius) {
      bump = Math.max(bump, smoothstep(1 - dist / radius));
    }
  }
  return bump;
}

const paintBrushedSteel: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  const seamY = size * 0.5;
  return (x, y) => {
    const brushed = fbm(seed, x * 0.06, y * 0.9, size, 2);
    const grain = fbm(seed + 41, x * 1.4, y * 1.4, size, 2);
    let height = 0.5 + (brushed - 0.5) * 0.12 + (grain - 0.5) * 0.05;
    const rivet = rivetBump(x, y, rivets, size * 0.06);
    height += rivet * 0.35;
    const nearSeam = Math.abs(y - seamY) < 1.5;
    if (nearSeam) height -= 0.18;

    const tone = mixColor(STEEL_DARK, STEEL_LIGHT, clamp01(brushed * 0.7 + 0.2));
    const albedo = mixColor(tone, STEEL_LIGHT, rivet * 0.6);
    const roughness = clamp01(0.32 + (1 - brushed) * 0.15 - rivet * 0.2);
    const ao = clamp01(0.85 + grain * 0.15 - (nearSeam ? 0.25 : 0));
    const metallic = clamp01(0.88 - rivet * 0.1);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintPaintedSteel: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  return (x, y) => {
    const wear = fbm(seed, x * 0.18, y * 0.18, size, 3);
    const chipMask = smoothstep(clamp01((wear - 0.62) * 4));
    const rivet = rivetBump(x, y, rivets, size * 0.05);
    const height = 0.5 + (wear - 0.5) * 0.08 - chipMask * 0.12 + rivet * 0.3;

    const paint = mixColor(PAINT_TEAL_DARK, PAINT_TEAL, clamp01(0.4 + wear * 0.5));
    const steelBeneath = mixColor(STEEL_DARK, STEEL_LIGHT, 0.4);
    const albedo = mixColor(paint, steelBeneath, chipMask);
    const roughness = clamp01(0.55 - chipMask * 0.2 - rivet * 0.15);
    const ao = clamp01(0.9 - chipMask * 0.2);
    const metallic = clamp01(0.08 + chipMask * 0.55 + rivet * 0.2);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintGrating: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const cell = size / 8;
  return (x, y) => {
    const u = bandDistance(x + y, cell * 2, cell * 0.9);
    const v = bandDistance(x - y, cell * 2, cell * 0.9);
    const onBar = Math.max(u, v) < 0;
    const grain = fbm(seed, x * 0.3, y * 0.3, size, 2);
    if (onBar) {
      const edge = clamp01(-Math.max(u, v) / (cell * 0.45));
      const albedo = mixColor(GRATE, STEEL_LIGHT, edge * 0.5);
      return {
        albedo: [albedo[0], albedo[1], albedo[2], 1],
        height: clamp01(0.55 + edge * 0.35),
        roughness: clamp01(0.3 - edge * 0.1),
        ao: clamp01(0.75 + edge * 0.2),
        metallic: 0.82,
      };
    }
    const dark = mixColor(STEEL_SHADOW, [0, 0, 0], 0.6);
    return {
      albedo: [dark[0], dark[1], dark[2], 0.25],
      height: clamp01(0.05 + grain * 0.03),
      roughness: 0.7,
      ao: 0.25,
      metallic: 0,
    };
  };
};

const paintRustedPlate: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  return (x, y) => {
    const rustMask = smoothstep(clamp01((fbm(seed, x * 0.09, y * 0.09, size, 3) - 0.48) * 3));
    const pit = fbm(seed + 7, x * 0.5, y * 0.5, size, 2);
    const pitting = rustMask * smoothstep(clamp01((pit - 0.6) * 3));
    const brushed = fbm(seed + 19, x * 0.06, y * 0.9, size, 2);
    const rivet = rivetBump(x, y, rivets, size * 0.06);

    const height = 0.5 + (brushed - 0.5) * 0.1 - pitting * 0.3 + rivet * 0.3 * (1 - rustMask);
    const steel = mixColor(STEEL_DARK, STEEL_LIGHT, clamp01(brushed));
    const rust = mixColor(RUST_DARK, RUST, clamp01(pit));
    const albedo = mixColor(steel, rust, rustMask);
    const roughness = clamp01(0.35 + rustMask * 0.45 + pitting * 0.15);
    const ao = clamp01(0.85 - pitting * 0.45);
    const metallic = clamp01(0.85 - rustMask * 0.75);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintConcrete: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  return (x, y) => {
    const aggregate = fbm(seed, x * 0.35, y * 0.35, size, 3);
    const crack = fbm(seed + 53, x * 0.1, y * 0.1, size, 2);
    const crackLine = 1 - smoothstep(clamp01(Math.abs(crack - 0.5) * 8));
    const height = clamp01(0.5 + (aggregate - 0.5) * 0.2 - crackLine * 0.3);

    const albedo = mixColor(CONCRETE_DARK, CONCRETE, clamp01(aggregate));
    const roughness = clamp01(0.82 + (1 - aggregate) * 0.1);
    const ao = clamp01(0.9 - crackLine * 0.5);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height, roughness, ao, metallic: 0.02 };
  };
};

const paintConveyorRubber: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const cell = size / 6;
  return (x, y) => {
    const ridgeDist = bandDistance(x + y, cell, cell * 0.45);
    const onRidge = ridgeDist < 0;
    const grain = fbm(seed, x * 0.5, y * 0.5, size, 2);
    const height = onRidge ? clamp01(0.6 + (-ridgeDist / (cell * 0.22)) * 0.3) : clamp01(0.35 + grain * 0.05);
    const albedo = mixColor(RUBBER, RUBBER_LIGHT, onRidge ? 0.6 : grain * 0.3);
    const roughness = onRidge ? 0.55 : 0.85;
    const ao = onRidge ? 0.95 : 0.7;
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height, roughness, ao, metallic: 0.03 };
  };
};

const paintWarningChevrons: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const stripe = size / 4;
  return (x, y) => {
    const diag = x + y;
    const phase = Math.floor(diag / stripe) % 2;
    const edge = bandDistance(diag, stripe * 2, stripe);
    const emboss = 1 - smoothstep(clamp01(Math.abs(edge) / (stripe * 0.25)));
    const wear = fbm(seed, x * 0.2, y * 0.2, size, 2);
    const isYellow = phase === 0;
    const base = isYellow ? WARN_YELLOW : STEEL_SHADOW;
    const albedo = mixColor(base, STEEL_DARK, emboss * 0.3 + (1 - wear) * 0.1);
    const height = clamp01(0.5 + emboss * 0.15);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], 1],
      height,
      roughness: clamp01(0.5 - emboss * 0.1),
      ao: clamp01(0.9 - emboss * 0.1),
      metallic: 0.18,
    };
  };
};

const paintHazardSpike: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const cx = size * (0.5 + rng.signedRange(0.02));
  const cy = size * (0.5 + rng.signedRange(0.02));
  const maxDist = size * 0.62;
  return (x, y) => {
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    const tipFactor = clamp01(1 - dist / maxDist);
    const facetNoise = fbm(seed, x * 0.4, y * 0.4, size, 2);
    const nick = fbm(seed + 11, x * 0.8, y * 0.8, size, 2);
    const height = clamp01(tipFactor ** 1.6 + (facetNoise - 0.5) * 0.05 - smoothstep((nick - 0.7) * 4) * 0.15);

    const albedo = mixColor(HAZARD_DARK, HAZARD, tipFactor);
    const roughness = clamp01(0.55 - tipFactor * 0.4 + (1 - tipFactor) * 0.2);
    const ao = clamp01(0.7 + tipFactor * 0.3);
    const metallic = clamp01(0.3 + tipFactor * 0.55);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height, roughness, ao, metallic };
  };
};

const paintCatwalk: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const cell = size / 5;
  return (x, y) => {
    const barX = bandDistance(x, cell, cell * 0.6);
    const onBar = barX < 0;
    const flange = onBar ? smoothstep(clamp01(1 + barX / (cell * 0.3))) : 0;
    const grain = fbm(seed, x * 0.4, y * 0.4, size, 2);
    const height = onBar ? clamp01(0.55 + flange * 0.3) : clamp01(0.08 + grain * 0.04);
    const bar = mixColor(GRATE, STEEL_BASE, 0.5);
    const albedo = onBar ? mixColor(bar, STEEL_LIGHT, flange * 0.6) : mixColor(STEEL_SHADOW, [0, 0, 0], 0.5);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], onBar ? 1 : 0.3],
      height,
      roughness: onBar ? clamp01(0.35 - flange * 0.15) : 0.7,
      ao: onBar ? clamp01(0.8 + flange * 0.15) : 0.3,
      metallic: onBar ? 0.8 : 0,
    };
  };
};

const paintEmissiveEnergy: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const coreX = size * 0.5;
  return (x, y) => {
    const distToCore = Math.abs(x - coreX);
    const channel = smoothstep(clamp01(1 - distToCore / (size * 0.22)));
    const core = smoothstep(clamp01(1 - distToCore / (size * 0.06)));
    const flicker = fbm(seed, x * 0.15, y * 0.6, size, 2);
    const casingGrain = fbm(seed + 29, x * 0.5, y * 0.5, size, 2);

    const height = clamp01(0.5 - channel * 0.25 + (casingGrain - 0.5) * 0.05);
    const casing = mixColor(STEEL_SHADOW, STEEL_DARK, casingGrain);
    const glow = mixColor(ENERGY_DIM, ENERGY, clamp01(0.5 + flicker * 0.5));
    const withCore = mixColor(glow, ENERGY_CORE, core * 0.8);
    const albedo = mixColor(casing, withCore, channel);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], 1],
      height,
      roughness: clamp01(0.6 - channel * 0.55),
      ao: clamp01(0.9 - channel * 0.4),
      metallic: clamp01(0.55 * (1 - channel)),
    };
  };
};

const paintEmissiveGoal: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const coreX = size * 0.5;
  return (x, y) => {
    const wobble = Math.sin(y * 0.25 + seed * 0.0001) * size * 0.03;
    const distToCore = Math.abs(x - coreX - wobble);
    const shaft = smoothstep(clamp01(1 - distToCore / (size * 0.32)));
    const ripple = smoothstep(clamp01(1 - distToCore / (size * 0.08)));
    const shimmer = fbm(seed, x * 0.1, y * 0.5, size, 2);
    const casingGrain = fbm(seed + 61, x * 0.5, y * 0.5, size, 2);

    const height = clamp01(0.5 - shaft * 0.3 + (casingGrain - 0.5) * 0.05);
    const casing = mixColor(STEEL_SHADOW, STEEL_DARK, casingGrain);
    const glow = mixColor(GOAL_DIM, GOAL_ENERGY, clamp01(0.5 + shimmer * 0.5));
    const withCore = mixColor(glow, GOAL_CORE, ripple * 0.85);
    const albedo = mixColor(casing, withCore, shaft);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], 1],
      height,
      roughness: clamp01(0.55 - shaft * 0.5),
      ao: clamp01(0.92 - shaft * 0.35),
      metallic: clamp01(0.5 * (1 - shaft)),
    };
  };
};

const PAINTER_FACTORIES: Record<MaterialId, PainterFactory> = {
  [MaterialId.BrushedSteel]: paintBrushedSteel,
  [MaterialId.PaintedSteel]: paintPaintedSteel,
  [MaterialId.Grating]: paintGrating,
  [MaterialId.RustedPlate]: paintRustedPlate,
  [MaterialId.Concrete]: paintConcrete,
  [MaterialId.ConveyorRubber]: paintConveyorRubber,
  [MaterialId.WarningChevrons]: paintWarningChevrons,
  [MaterialId.HazardSpike]: paintHazardSpike,
  [MaterialId.Catwalk]: paintCatwalk,
  [MaterialId.EmissiveEnergy]: paintEmissiveEnergy,
  [MaterialId.EmissiveGoal]: paintEmissiveGoal,
};

/** Per-material seed: independent of atlas layout order, stable even if materials are reordered. */
function deriveMaterialSeed(seed: number, id: MaterialId): number {
  return (seed ^ hashSeed(id)) >>> 0;
}

/** Bump strength for the height→normal central difference; tuned per material for readable relief. */
const NORMAL_STRENGTH: Record<MaterialId, number> = {
  [MaterialId.BrushedSteel]: 10,
  [MaterialId.PaintedSteel]: 12,
  [MaterialId.Grating]: 6,
  [MaterialId.RustedPlate]: 9,
  [MaterialId.Concrete]: 8,
  [MaterialId.ConveyorRubber]: 7,
  [MaterialId.WarningChevrons]: 14,
  [MaterialId.HazardSpike]: 5,
  [MaterialId.Catwalk]: 8,
  [MaterialId.EmissiveEnergy]: 10,
  [MaterialId.EmissiveGoal]: 8,
};

function paintMaterialInto(
  id: MaterialId,
  seed: number,
  rect: AtlasRect,
  layout: AtlasLayout,
  albedo: Uint8Array,
  normalOut: Uint8Array,
  params: Uint8Array,
): void {
  const size = layout.tileSize;
  const rng = createRng(seed);
  const painter = PAINTER_FACTORIES[id](seed, rng);
  const height = new Float32Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sample = painter(x, y);
      const local = y * size + x;
      height[local] = sample.height;

      const atlasIndex = ((rect.y + y) * layout.width + (rect.x + x)) * 4;
      albedo[atlasIndex] = toByte(sample.albedo[0]);
      albedo[atlasIndex + 1] = toByte(sample.albedo[1]);
      albedo[atlasIndex + 2] = toByte(sample.albedo[2]);
      albedo[atlasIndex + 3] = toByte(sample.albedo[3]);

      params[atlasIndex] = toByte(sample.roughness);
      params[atlasIndex + 1] = toByte(sample.ao);
      params[atlasIndex + 2] = toByte(sample.metallic);
      params[atlasIndex + 3] = 255;
    }
  }

  const strength = NORMAL_STRENGTH[id];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [nx, ny, nz] = sampleNormalRgb(height, size, x, y, strength);
      const atlasIndex = ((rect.y + y) * layout.width + (rect.x + x)) * 4;
      normalOut[atlasIndex] = nx;
      normalOut[atlasIndex + 1] = ny;
      normalOut[atlasIndex + 2] = nz;
      normalOut[atlasIndex + 3] = 255;
    }
  }
}

/** Flat "pointing up" normal, used to fill unused atlas cells (the grid may exceed material count). */
function fillFlatNormals(normal: Uint8Array): void {
  for (let i = 0; i < normal.length; i += 4) {
    normal[i] = 128;
    normal[i + 1] = 128;
    normal[i + 2] = 255;
    normal[i + 3] = 255;
  }
}

/**
 * Generate the full material atlas (albedo, normal, packed roughness/AO/metallic) from a seed.
 *
 * Pure function of `seed`: calling this twice with the same value produces byte-identical
 * `Uint8Array`s every time, in this process or any other (see `tests/unit/materials.test.ts` and
 * `scripts/generateMaterials.ts`).
 */
export function generateMaterialAtlas(seed: number = DEFAULT_MATERIAL_SEED): MaterialAtlas {
  const layout = buildLayout();
  const byteCount = layout.width * layout.height * 4;
  const albedo = new Uint8Array(byteCount);
  const normal = new Uint8Array(byteCount);
  const params = new Uint8Array(byteCount);
  fillFlatNormals(normal);

  for (const id of ALL_MATERIAL_IDS) {
    const rect = layout.rects[id];
    paintMaterialInto(id, deriveMaterialSeed(seed, id), rect, layout, albedo, normal, params);
  }

  return { seed, layout, albedo, normal, params };
}

/** FNV-1a over a byte buffer — small, pure JS, and stable across platforms (no crypto needed). */
export function hashBytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hex digest of an atlas's three channel buffers, for the "same seed → identical bytes" check. */
export function hashMaterialAtlas(atlas: MaterialAtlas): string {
  const albedoHash = hashBytes(atlas.albedo);
  const normalHash = hashBytes(atlas.normal);
  const paramsHash = hashBytes(atlas.params);
  return [albedoHash, normalHash, paramsHash].map((h) => h.toString(16).padStart(8, '0')).join('');
}
