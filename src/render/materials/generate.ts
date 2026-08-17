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
 *  3. Pack albedo/normal/params into their shared atlas byte buffers at this material's rect, plus
 *     a small wrapped border around it (see {@link ATLAS_PADDING}) so linear-filtered sampling at
 *     high render-target resolutions (the 4K overhaul's supersampled deferred pipeline) does not
 *     bleed into the next material over.
 */

import type { Rng } from '../../core/rng';
import { createRng, hashSeed } from '../../core/rng';
import { ALL_MATERIAL_IDS, MaterialId } from './types';
import type { AtlasLayout, AtlasRect, MaterialAtlas, MaterialSample } from './types';

/**
 * Gameplay tiles are 16px; materials are painted at 6x that density — high enough that every
 * painted feature (streaks, rivets, cracks) spans many texels, so linear-filtered upsampling
 * reads as smooth surface detail rather than the single-texel "TV static" noise a lower-res atlas
 * would produce once magnified.
 */
export const MATERIAL_TILE_PX = 96;

/** Default seed for the whole atlas — override via the CLI script or callers that need variety. */
export const DEFAULT_MATERIAL_SEED = 0x0b71c0de;

const ATLAS_COLUMNS = 4;

/**
 * Border (in texels) painted around every material's logical tile, wrapped from its own opposite
 * edge (see {@link wrapCoord}). The 4K overhaul samples this atlas with linear filtering once the
 * render target is supersampled well past 480×270 (see `GlWorldRenderer`'s tile-filter logic); a
 * bilinear tap right at a tile's UV edge would otherwise blend in whichever unrelated material
 * sits in the neighbouring atlas cell. Padding with a wrapped copy of the tile's own far edge
 * instead reproduces exactly what sampling *another instance of the same material* placed next to
 * it would look like — seamless, since every painter's noise already tiles at this period.
 */
const ATLAS_PADDING = 2;

function buildLayout(): AtlasLayout {
  const rows = Math.ceil(ALL_MATERIAL_IDS.length / ATLAS_COLUMNS);
  const cellSize = MATERIAL_TILE_PX + ATLAS_PADDING * 2;
  const rects: Partial<Record<MaterialId, AtlasRect>> = {};
  ALL_MATERIAL_IDS.forEach((id, index) => {
    const column = index % ATLAS_COLUMNS;
    const row = Math.floor(index / ATLAS_COLUMNS);
    rects[id] = {
      x: column * cellSize + ATLAS_PADDING,
      y: row * cellSize + ATLAS_PADDING,
      width: MATERIAL_TILE_PX,
      height: MATERIAL_TILE_PX,
    };
  });
  return {
    tileSize: MATERIAL_TILE_PX,
    columns: ATLAS_COLUMNS,
    rows,
    width: ATLAS_COLUMNS * cellSize,
    height: rows * cellSize,
    rects: rects as Record<MaterialId, AtlasRect>,
  };
}

/** Wraps a padded-region coordinate back into `[0, size)` — see {@link ATLAS_PADDING}. */
function wrapCoord(value: number, size: number): number {
  return ((value % size) + size) % size;
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

/**
 * GLSL-style smoothstep between two edges (rather than a pre-clamped `t`). Widening
 * `edge1 - edge0` is the main lever for turning a hard, high-frequency-looking threshold into a
 * soft blotch/gradient — every painter below prefers a wide edge range over a sharp one.
 */
function softStep(value: number, edge0: number, edge1: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  return smoothstep(clamp01((value - edge0) / (edge1 - edge0)));
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

interface LineSegment {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Shortest distance from point `(px, py)` to the segment `(x0,y0)-(x1,y1)`. */
function distanceToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? clamp01(((px - x0) * dx + (py - y0) * dy) / lenSq) : 0;
  const cx = x0 + t * dx;
  const cy = y0 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Distance from `(x, y)` to a segment, treating both as living on a `size`-periodic torus (the
 * same wrap every painter's noise already tiles at). Checking the segment's eight neighbouring
 * copies as well as itself is what makes a crack drawn near one tile edge reappear seamlessly at
 * the opposite edge, instead of getting clipped.
 */
function distanceToSegmentWrapped(x: number, y: number, seg: LineSegment, size: number): number {
  let best = Infinity;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const d = distanceToSegment(x, y, seg.x0 + ox * size, seg.y0 + oy * size, seg.x1 + ox * size, seg.y1 + oy * size);
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * A handful of short, jointed crack polylines (a slow random walk of 2-4 segments each) rather
 * than a noise field — this is what keeps concrete's cracking reading as a few distinct thin
 * fractures instead of a field of noise-threshold speckle ("noise soup").
 */
function makeCracks(rng: Rng, size: number, count: number): LineSegment[] {
  const segments: LineSegment[] = [];
  for (let c = 0; c < count; c += 1) {
    let x = rng.range(0, size);
    let y = rng.range(0, size);
    let angle = rng.range(0, Math.PI * 2);
    const steps = rng.int(2, 4);
    for (let i = 0; i < steps; i += 1) {
      angle += rng.signedRange(1.1);
      const len = rng.range(size * 0.12, size * 0.22);
      const nx = x + Math.cos(angle) * len;
      const ny = y + Math.sin(angle) * len;
      segments.push({ x0: x, y0: y, x1: nx, y1: ny });
      x = nx;
      y = ny;
    }
  }
  return segments;
}

/** Nearest distance from `(x, y)` to any of `segments`, wrapped at `size` (see {@link makeCracks}). */
function distanceToCracks(x: number, y: number, segments: readonly LineSegment[], size: number): number {
  let best = Infinity;
  for (const seg of segments) {
    const d = distanceToSegmentWrapped(x, y, seg, size);
    if (d < best) best = d;
  }
  return best;
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

/**
 * A bolt head's height profile: a flat-ish cap out to `radius * 0.55`, then a soft bevelled
 * shoulder down to the plate by `radius`. Two clearly-separated zones (flat cap, smooth shoulder)
 * is what reads as "a bolt head with a soft bevel" once lit, rather than a single sharp cone.
 */
function rivetBump(x: number, y: number, positions: readonly (readonly [number, number])[], radius: number): number {
  let bump = 0;
  const capRadius = radius * 0.55;
  for (const [rx, ry] of positions) {
    const dist = Math.hypot(x - rx, y - ry);
    if (dist >= radius) continue;
    const value = dist <= capRadius ? 1 : softStep(dist, radius, capRadius);
    bump = Math.max(bump, value);
  }
  return bump;
}

const paintBrushedSteel: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  const seamY = size * 0.5;
  return (x, y) => {
    // Long, soft anisotropic streaks: very slow variation along x (the brush direction), gentler
    // variation along y than before so streaks read as long soft bands instead of scratches.
    const streaks = fbm(seed, x * 0.012, y * 0.22, size, 2);
    // A single low-frequency wear pass — large soft patches of duller/brighter metal, not per-texel grain.
    const wear = fbm(seed + 41, x * 0.02, y * 0.02, size, 2);
    let height = 0.5 + (streaks - 0.5) * 0.1 + (wear - 0.5) * 0.04;
    const rivet = rivetBump(x, y, rivets, size * 0.07);
    height += rivet * 0.3;
    const nearSeam = Math.abs(y - seamY) < size * 0.02;
    if (nearSeam) height -= 0.15;

    const tone = mixColor(STEEL_DARK, STEEL_LIGHT, clamp01(streaks * 0.65 + wear * 0.15 + 0.15));
    const albedo = mixColor(tone, STEEL_LIGHT, rivet * 0.55);
    const roughness = clamp01(0.34 + (1 - streaks) * 0.12 - rivet * 0.2);
    const ao = clamp01(0.88 + wear * 0.1 - (nearSeam ? 0.2 : 0));
    const metallic = clamp01(0.88 - rivet * 0.1);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintPaintedSteel: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  return (x, y) => {
    // Low-frequency fbm plus a very wide soft threshold: a handful of large flake-shaped chips
    // with blurry edges, rather than a dense per-texel salt-and-pepper speckle.
    const wear = fbm(seed, x * 0.035, y * 0.035, size, 2);
    const chipMask = softStep(wear, 0.52, 0.72);
    const rivet = rivetBump(x, y, rivets, size * 0.05);
    const height = 0.5 + (wear - 0.5) * 0.06 - chipMask * 0.1 + rivet * 0.3;

    const paint = mixColor(PAINT_TEAL_DARK, PAINT_TEAL, clamp01(0.4 + wear * 0.5));
    const steelBeneath = mixColor(STEEL_DARK, STEEL_LIGHT, 0.4);
    const albedo = mixColor(paint, steelBeneath, chipMask);
    const roughness = clamp01(0.55 - chipMask * 0.2 - rivet * 0.15);
    const ao = clamp01(0.9 - chipMask * 0.2);
    const metallic = clamp01(0.08 + chipMask * 0.55 + rivet * 0.2);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintGrating: PainterFactory = () => {
  const size = MATERIAL_TILE_PX;
  const cell = size / 8;
  return (x, y) => {
    const u = bandDistance(x + y, cell * 2, cell * 0.9);
    const v = bandDistance(x - y, cell * 2, cell * 0.9);
    const onBar = Math.max(u, v) < 0;
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
    // Soft AO gradient into the hole: darkest at its centre, lightening smoothly toward the bars
    // it opens onto — a gentle occlusion falloff rather than flat shade plus per-texel grain.
    // Outside the bar, u/v (the distance-past-the-band-edge) is >= 0 and grows the further into
    // the hole you go, so it — not its negation — is what should drive the depth gradient.
    const depthIntoHole = clamp01(Math.max(u, v) / (cell * 0.7));
    const softDepth = smoothstep(depthIntoHole);
    const dark = mixColor(STEEL_SHADOW, [0, 0, 0], 0.6);
    return {
      albedo: [dark[0], dark[1], dark[2], clamp01(0.32 - softDepth * 0.14)],
      height: clamp01(0.1 - softDepth * 0.06),
      roughness: 0.7,
      ao: clamp01(0.32 - softDepth * 0.22),
      metallic: 0,
    };
  };
};

const paintRustedPlate: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  return (x, y) => {
    // Low-frequency mask with a wide soft edge: a few big rust islands, not a speckled threshold.
    const rustMask = softStep(fbm(seed, x * 0.03, y * 0.03, size, 3), 0.4, 0.62);
    // Pitting inside the islands, one octave lower than before and blended in softly so it reads
    // as blotchy corrosion rather than per-texel pit speckle.
    const pit = fbm(seed + 7, x * 0.09, y * 0.09, size, 2);
    const pitting = rustMask * softStep(pit, 0.45, 0.75);
    const streaks = fbm(seed + 19, x * 0.015, y * 0.25, size, 2);
    const rivet = rivetBump(x, y, rivets, size * 0.07);

    const height = 0.5 + (streaks - 0.5) * 0.08 - pitting * 0.25 + rivet * 0.3 * (1 - rustMask);
    const steel = mixColor(STEEL_DARK, STEEL_LIGHT, clamp01(streaks));
    const rust = mixColor(RUST_DARK, RUST, clamp01(pit));
    const albedo = mixColor(steel, rust, rustMask);
    const roughness = clamp01(0.35 + rustMask * 0.45 + pitting * 0.15);
    const ao = clamp01(0.85 - pitting * 0.4);
    const metallic = clamp01(0.85 - rustMask * 0.75);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintConcrete: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const cracks = makeCracks(rng, size, 2);
  const crackCore = size * 0.012;
  const crackHalo = size * 0.05;
  return (x, y) => {
    // Soft low-frequency blotches instead of fine aggregate speckle.
    const aggregate = fbm(seed, x * 0.045, y * 0.045, size, 3);
    // Cracks are a handful of explicit thin polylines (see makeCracks), not a noise threshold —
    // this is what keeps them reading as distinct fractures rather than noise soup. A crisp thin
    // core plus a much wider, softer penumbra keeps the crack itself hairline while still giving
    // linear-filtered sampling something gradual to interpolate around it.
    const crackDist = distanceToCracks(x, y, cracks, size);
    const crackLine = 1 - softStep(crackDist, 0, crackCore);
    const crackShadow = 1 - softStep(crackDist, 0, crackHalo);
    const height = clamp01(0.5 + (aggregate - 0.5) * 0.14 - crackLine * 0.35 - crackShadow * 0.08);

    const albedo = mixColor(CONCRETE_DARK, CONCRETE, clamp01(aggregate));
    const roughness = clamp01(0.82 + (1 - aggregate) * 0.08);
    const ao = clamp01(0.9 - crackLine * 0.5 - crackShadow * 0.15);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height, roughness, ao, metallic: 0.02 };
  };
};

const paintConveyorRubber: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const cell = size / 6;
  return (x, y) => {
    const ridgeDist = bandDistance(x + y, cell, cell * 0.45);
    // A soft cosine-shaped rib profile instead of a linear ramp — reads as a rounded rubber ridge.
    const ridgeT = clamp01(1 - Math.abs(ridgeDist) / (cell * 0.45));
    const ribProfile = smoothstep(ridgeT);
    const wear = fbm(seed, x * 0.05, y * 0.05, size, 2);
    const height = clamp01(0.35 + ribProfile * 0.35 + (wear - 0.5) * 0.03);
    const albedo = mixColor(RUBBER, RUBBER_LIGHT, ribProfile * 0.55 + wear * 0.08);
    const roughness = clamp01(0.85 - ribProfile * 0.3);
    const ao = clamp01(0.7 + ribProfile * 0.25);
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
    const wear = fbm(seed, x * 0.03, y * 0.03, size, 2);
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
    const facetNoise = fbm(seed, x * 0.08, y * 0.08, size, 2);
    const nick = fbm(seed + 11, x * 0.15, y * 0.15, size, 2);
    const height = clamp01(tipFactor ** 1.6 + (facetNoise - 0.5) * 0.05 - softStep(nick, 0.6, 0.85) * 0.15);

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
    const grain = fbm(seed, x * 0.06, y * 0.06, size, 2);
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
    const flicker = fbm(seed, x * 0.03, y * 0.09, size, 2);
    const casingGrain = fbm(seed + 29, x * 0.05, y * 0.05, size, 2);

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
    const shimmer = fbm(seed, x * 0.025, y * 0.08, size, 2);
    const casingGrain = fbm(seed + 61, x * 0.05, y * 0.05, size, 2);

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

/**
 * Bump strength for the height→normal central difference, tuned per material for readable
 * relief. Every painter above now spreads its height variation over a lower-frequency, wider
 * footprint (soft blotches/streaks instead of per-texel noise), which on its own would flatten
 * the central-difference gradient at any single texel — these are pulled up from their old
 * (64px-tile) values to compensate, so features stay clearly readable as normals once lit.
 */
const NORMAL_STRENGTH: Record<MaterialId, number> = {
  [MaterialId.BrushedSteel]: 26,
  [MaterialId.PaintedSteel]: 22,
  [MaterialId.Grating]: 10,
  [MaterialId.RustedPlate]: 20,
  [MaterialId.Concrete]: 16,
  [MaterialId.ConveyorRubber]: 14,
  [MaterialId.WarningChevrons]: 16,
  [MaterialId.HazardSpike]: 7,
  [MaterialId.Catwalk]: 10,
  [MaterialId.EmissiveEnergy]: 18,
  [MaterialId.EmissiveGoal]: 16,
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
      height[y * size + x] = painter(x, y).height;
    }
  }

  // Paint the logical tile plus its wrapped padding border in one sweep (see ATLAS_PADDING) —
  // every coordinate is wrapped into [0, size) first, so the border repeats this material's own
  // opposite edge instead of whatever sits in the next atlas cell.
  for (let ly = -ATLAS_PADDING; ly < size + ATLAS_PADDING; ly += 1) {
    for (let lx = -ATLAS_PADDING; lx < size + ATLAS_PADDING; lx += 1) {
      const wx = wrapCoord(lx, size);
      const wy = wrapCoord(ly, size);
      const sample = painter(wx, wy);
      const atlasIndex = ((rect.y + ly) * layout.width + (rect.x + lx)) * 4;
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
  for (let ly = -ATLAS_PADDING; ly < size + ATLAS_PADDING; ly += 1) {
    for (let lx = -ATLAS_PADDING; lx < size + ATLAS_PADDING; lx += 1) {
      const wx = wrapCoord(lx, size);
      const wy = wrapCoord(ly, size);
      const [nx, ny, nz] = sampleNormalRgb(height, size, wx, wy, strength);
      const atlasIndex = ((rect.y + ly) * layout.width + (rect.x + lx)) * 4;
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
