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
 * Gameplay tiles are 16px; materials are painted at 8× that density so hand-authored features
 * (panel frames, weld beads, rivet plates, drip stains) span many texels and read as painted
 * HD-2D surfaces under linear filtering — not a repeating noise field.
 */
export const MATERIAL_TILE_PX = 128;

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
// Dead Cells industrial: cooler steels, saturated teal paint, warm rust drips, hot emissive cores.
// High chroma + clear value steps so large painted features read under deferred lighting.
const STEEL_LIGHT = [0.68, 0.76, 0.9] as const;
const STEEL_BASE = [0.32, 0.4, 0.55] as const;
const STEEL_DARK = [0.16, 0.2, 0.3] as const;
const STEEL_SHADOW = [0.08, 0.1, 0.15] as const;
const GRATE = [0.22, 0.28, 0.4] as const;
const RUST = [0.82, 0.4, 0.18] as const;
const RUST_DARK = [0.42, 0.16, 0.08] as const;
const RUST_WET = [0.95, 0.52, 0.22] as const;
const PAINT_TEAL = [0.12, 0.52, 0.58] as const;
const PAINT_TEAL_LIT = [0.22, 0.68, 0.72] as const;
const PAINT_TEAL_DARK = [0.05, 0.28, 0.32] as const;
const CONCRETE = [0.52, 0.52, 0.56] as const;
const CONCRETE_DARK = [0.3, 0.31, 0.35] as const;
const RUBBER = [0.07, 0.08, 0.1] as const;
const RUBBER_LIGHT = [0.2, 0.21, 0.24] as const;
const HAZARD = [0.98, 0.28, 0.22] as const;
const HAZARD_DARK = [0.45, 0.12, 0.1] as const;
const WARN_YELLOW = [1, 0.84, 0.12] as const;
const WARN_BLACK = [0.06, 0.07, 0.1] as const;
const ENERGY = [0.22, 1, 0.82] as const;
const ENERGY_DIM = [0.06, 0.42, 0.36] as const;
const ENERGY_CORE = [0.95, 1, 0.98] as const;
const GOAL_ENERGY = [0.28, 0.98, 1] as const;
const GOAL_DIM = [0.06, 0.36, 0.48] as const;
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
 * A bolt head's height profile: a small flat cap out to `radius * 0.4`, then a wide soft bevel
 * down to the plate by `radius`. The wide shoulder is what keeps rivets reading as painterly
 * painted-on bolts rather than hard-edged stamped discs once lit.
 */
function rivetBump(x: number, y: number, positions: readonly (readonly [number, number])[], radius: number): number {
  let bump = 0;
  const capRadius = radius * 0.4;
  for (const [rx, ry] of positions) {
    const dist = Math.hypot(x - rx, y - ry);
    if (dist >= radius) continue;
    const value = dist <= capRadius ? 1 : softStep(dist, radius, capRadius);
    bump = Math.max(bump, value);
  }
  return bump;
}

/** Soft distance to the nearest edge of the tile (0 at centre, 1 at rim). */
function edgeProximity(x: number, y: number, size: number, inset: number): number {
  const d = Math.min(x, y, size - 1 - x, size - 1 - y);
  return 1 - softStep(d, 0, inset);
}

/**
 * Soft mask for a recessed plate well inside an outer frame — the large silhouette feature that
 * makes brushed/painted steel read as a hand-painted panel rather than tiled noise.
 */
function panelWell(x: number, y: number, size: number, inset: number, soft: number): number {
  const dx = Math.min(x - inset, size - 1 - inset - x);
  const dy = Math.min(y - inset, size - 1 - inset - y);
  const inside = Math.min(dx, dy);
  return softStep(inside, 0, soft);
}

/** A few seeded vertical drip centres — large readable stains, not a noise field. */
function makeDripXs(rng: Rng, size: number, count: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    xs.push(rng.range(size * 0.12, size * 0.88));
  }
  return xs;
}

function dripMask(x: number, y: number, dripXs: readonly number[], size: number, halfWidth: number): number {
  let best = 0;
  const fall = softStep(y / size, 0.08, 0.92);
  for (const dx of dripXs) {
    const lateral = 1 - softStep(Math.abs(x - dx), 0, halfWidth);
    best = Math.max(best, lateral * fall);
  }
  return best;
}

const paintBrushedSteel: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  // Hand-authored 2×2 panel: raised outer frame, recessed wells, cross weld bead.
  const frame = size * 0.11;
  const wellInset = size * 0.14;
  const wellSoft = size * 0.06;
  const weldHalf = size * 0.032;
  const mid = size * 0.5;
  return (x, y) => {
    // Broad brush bands only — wavelengths larger than a gameplay tile so 16px cells do not sparkle.
    const streaks = fbm(seed, x * 0.004, y * 0.035, size, 2);
    const wear = fbm(seed + 41, x * 0.007, y * 0.007, size, 2);
    const frameMask = edgeProximity(x, y, size, frame);
    const well = panelWell(x, y, size, wellInset, wellSoft);
    const weldX = 1 - softStep(Math.abs(x - mid), 0, weldHalf);
    const weldY = 1 - softStep(Math.abs(y - mid), 0, weldHalf);
    const weld = Math.max(weldX, weldY) * well;
    const rivet = rivetBump(x, y, rivets, size * 0.09);

    let height = 0.48 + (streaks - 0.5) * 0.02 + (wear - 0.5) * 0.01;
    height += frameMask * 0.16;
    height -= well * 0.1;
    height -= weld * 0.12;
    height += rivet * 0.28;

    const tone = mixColor(STEEL_DARK, STEEL_LIGHT, clamp01(streaks * 0.45 + wear * 0.15 + 0.28));
    let albedo = mixColor(tone, STEEL_BASE, well * 0.35);
    albedo = mixColor(albedo, STEEL_SHADOW, frameMask * 0.4);
    albedo = mixColor(albedo, STEEL_LIGHT, rivet * 0.55);
    albedo = mixColor(albedo, STEEL_SHADOW, weld * 0.35);
    const roughness = clamp01(0.3 + (1 - streaks) * 0.08 - rivet * 0.16 + weld * 0.1 + well * 0.04);
    const ao = clamp01(0.96 - frameMask * 0.14 - weld * 0.22 - well * 0.06 + wear * 0.04);
    const metallic = clamp01(0.92 - rivet * 0.1 - weld * 0.06);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintPaintedSteel: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  const frame = size * 0.13;
  const wellInset = size * 0.16;
  const wellSoft = size * 0.07;
  return (x, y) => {
    const wear = fbm(seed, x * 0.01, y * 0.01, size, 2);
    // A few large flake chips with very soft edges — painted damage, not grit.
    const chipMask = softStep(wear, 0.58, 0.88);
    const rivet = rivetBump(x, y, rivets, size * 0.075);
    const frameMask = edgeProximity(x, y, size, frame);
    const well = panelWell(x, y, size, wellInset, wellSoft);
    // Soft vertical gradient so the panel reads lit from above.
    const gradient = softStep(y / size, 0.02, 0.98);

    const height =
      0.48 + (wear - 0.5) * 0.03 - chipMask * 0.12 + rivet * 0.22 + frameMask * 0.14 - well * 0.06;
    const paintBase = mixColor(PAINT_TEAL_DARK, PAINT_TEAL, clamp01(0.4 + wear * 0.25 + (1 - gradient) * 0.2));
    const paint = mixColor(paintBase, PAINT_TEAL_LIT, (1 - gradient) * 0.35 * (1 - chipMask));
    const steelBeneath = mixColor(STEEL_DARK, STEEL_LIGHT, 0.5);
    let albedo = mixColor(paint, steelBeneath, chipMask);
    albedo = mixColor(albedo, STEEL_SHADOW, frameMask * 0.5);
    albedo = mixColor(albedo, PAINT_TEAL_DARK, well * 0.15 * (1 - chipMask));
    albedo = mixColor(albedo, STEEL_LIGHT, rivet * 0.45);
    const roughness = clamp01(0.5 - chipMask * 0.2 - rivet * 0.12 + frameMask * 0.06);
    const ao = clamp01(0.95 - chipMask * 0.16 - frameMask * 0.12 - well * 0.05);
    const metallic = clamp01(0.05 + chipMask * 0.65 + rivet * 0.18);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintGrating: PainterFactory = () => {
  const size = MATERIAL_TILE_PX;
  // Thick readable bars: 4 diamonds across the tile, wide steel, soft bevel highlight.
  const cell = size / 4;
  const blend = cell * 0.42;
  return (x, y) => {
    const u = bandDistance(x + y, cell * 2, cell * 1.15);
    const v = bandDistance(x - y, cell * 2, cell * 1.15);
    const signed = Math.max(u, v);
    const barMask = 1 - softStep(signed, -blend * 0.2, blend);
    const edge = softStep(-signed, 0, cell * 0.6);

    const barAlbedo = mixColor(GRATE, STEEL_LIGHT, edge * 0.6);
    const dark = mixColor(STEEL_SHADOW, [0, 0, 0], 0.7);
    const depthIntoHole = softStep(signed, 0, cell * 0.9);
    const albedo = mixColor(dark, barAlbedo, barMask);
    const alpha = lerp(clamp01(0.22 - depthIntoHole * 0.12), 1, barMask);
    const height = lerp(clamp01(0.08 - depthIntoHole * 0.04), clamp01(0.58 + edge * 0.32), barMask);
    const roughness = lerp(0.74, clamp01(0.28 - edge * 0.1), barMask);
    const ao = lerp(clamp01(0.26 - depthIntoHole * 0.16), clamp01(0.82 + edge * 0.16), barMask);
    const metallic = lerp(0, 0.88, barMask);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], alpha],
      height,
      roughness,
      ao,
      metallic,
    };
  };
};

const paintRustedPlate: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const rivets = makeRivetPositions(rng, size);
  const drips = makeDripXs(rng, size, 4);
  return (x, y) => {
    // Large rust islands + seeded vertical drips (Dead Cells-readable stains).
    const island = fbm(seed, x * 0.008, y * 0.008, size, 2);
    const drip = dripMask(x, y, drips, size, size * 0.055);
    const rustMask = softStep(island * 0.75 + drip * 0.55, 0.32, 0.7);
    const pit = fbm(seed + 7, x * 0.035, y * 0.035, size, 2);
    const pitting = rustMask * softStep(pit, 0.45, 0.88);
    const streaks = fbm(seed + 19, x * 0.008, y * 0.12, size, 2);
    const rivet = rivetBump(x, y, rivets, size * 0.09);
    const frameMask = edgeProximity(x, y, size, size * 0.09);

    const height =
      0.5 + (streaks - 0.5) * 0.035 - pitting * 0.22 + rivet * 0.22 * (1 - rustMask) + frameMask * 0.1;
    const steel = mixColor(STEEL_DARK, STEEL_LIGHT, clamp01(streaks * 0.7 + 0.15));
    const rust = mixColor(RUST_DARK, RUST, clamp01(pit * 0.45 + 0.4));
    const wetRust = mixColor(rust, RUST_WET, drip * 0.55);
    let albedo = mixColor(steel, wetRust, rustMask);
    albedo = mixColor(albedo, STEEL_SHADOW, frameMask * 0.35);
    const roughness = clamp01(0.3 + rustMask * 0.55 + pitting * 0.12 - drip * 0.08);
    const ao = clamp01(0.92 - pitting * 0.32 - frameMask * 0.1 - drip * 0.06);
    const metallic = clamp01(0.9 - rustMask * 0.85);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height: clamp01(height), roughness, ao, metallic };
  };
};

const paintConcrete: PainterFactory = (seed, rng) => {
  const size = MATERIAL_TILE_PX;
  const cracks = makeCracks(rng, size, 2);
  const crackCore = size * 0.02;
  const crackHalo = size * 0.09;
  return (x, y) => {
    // Broad value blotches + a couple of thin fractures — not aggregate grit.
    const blotch = fbm(seed, x * 0.01, y * 0.01, size, 2);
    const softVar = fbm(seed + 5, x * 0.018, y * 0.018, size, 2);
    const crackDist = distanceToCracks(x, y, cracks, size);
    const crackLine = 1 - softStep(crackDist, 0, crackCore);
    const crackShadow = 1 - softStep(crackDist, 0, crackHalo);
    const height = clamp01(0.5 + (blotch - 0.5) * 0.05 + (softVar - 0.5) * 0.03 - crackLine * 0.28 - crackShadow * 0.1);

    const albedo = mixColor(CONCRETE_DARK, CONCRETE, clamp01(blotch * 0.55 + softVar * 0.35 + 0.1));
    const roughness = clamp01(0.86 + (1 - blotch) * 0.05);
    const ao = clamp01(0.95 - crackLine * 0.42 - crackShadow * 0.14);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height, roughness, ao, metallic: 0.02 };
  };
};

const paintConveyorRubber: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const cell = size / 4;
  return (x, y) => {
    const ridgeDist = bandDistance(x + y, cell, cell * 0.58);
    const ridgeT = clamp01(1 - Math.abs(ridgeDist) / (cell * 0.58));
    const ribProfile = softStep(ridgeT, 0.1, 1);
    const wear = fbm(seed, x * 0.02, y * 0.02, size, 2);
    const height = clamp01(0.34 + ribProfile * 0.36 + (wear - 0.5) * 0.015);
    const albedo = mixColor(RUBBER, RUBBER_LIGHT, ribProfile * 0.6 + wear * 0.06);
    const roughness = clamp01(0.9 - ribProfile * 0.32);
    const ao = clamp01(0.68 + ribProfile * 0.28);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height, roughness, ao, metallic: 0.03 };
  };
};

const paintWarningChevrons: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  // Bold, clear hazard stripes — high contrast yellow / near-black, wide bands.
  const stripe = size / 2.5;
  return (x, y) => {
    const diag = x + y;
    const phase = Math.floor(diag / stripe) % 2;
    const edge = bandDistance(diag, stripe * 2, stripe);
    const emboss = 1 - softStep(Math.abs(edge), 0, stripe * 0.28);
    const wear = fbm(seed, x * 0.012, y * 0.012, size, 2);
    const isYellow = phase === 0;
    const base = isYellow ? WARN_YELLOW : WARN_BLACK;
    // Keep wear subtle so chevrons stay bold and readable across the room.
    const albedo = mixColor(base, isYellow ? STEEL_LIGHT : STEEL_DARK, emboss * 0.12 + (1 - wear) * 0.05);
    const height = clamp01(0.48 + emboss * 0.18);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], 1],
      height,
      roughness: clamp01(0.45 - emboss * 0.1),
      ao: clamp01(0.95 - emboss * 0.1),
      metallic: isYellow ? 0.12 : 0.35,
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
    const tipFactor = softStep(1 - dist / maxDist, 0.05, 1);
    const facetNoise = fbm(seed, x * 0.028, y * 0.028, size, 2);
    const nick = fbm(seed + 11, x * 0.05, y * 0.05, size, 2);
    const height = clamp01(tipFactor ** 1.35 + (facetNoise - 0.5) * 0.025 - softStep(nick, 0.58, 0.92) * 0.08);

    const albedo = mixColor(HAZARD_DARK, HAZARD, tipFactor);
    const roughness = clamp01(0.48 - tipFactor * 0.42 + (1 - tipFactor) * 0.18);
    const ao = clamp01(0.68 + tipFactor * 0.32);
    const metallic = clamp01(0.3 + tipFactor * 0.62);
    return { albedo: [albedo[0], albedo[1], albedo[2], 1], height, roughness, ao, metallic };
  };
};

const paintCatwalk: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  // Thick plank bars with clear flange highlights — readable at gameplay scale.
  const cell = size / 3;
  const blend = cell * 0.32;
  return (x, y) => {
    const barX = bandDistance(x, cell, cell * 0.72);
    const barMask = 1 - softStep(barX, -blend * 0.25, blend);
    const flange = softStep(-barX, 0, cell * 0.45);
    const grain = fbm(seed, x * 0.022, y * 0.022, size, 2);
    const height = lerp(clamp01(0.08 + grain * 0.02), clamp01(0.58 + flange * 0.28), barMask);
    const bar = mixColor(GRATE, STEEL_BASE, 0.55);
    const barAlbedo = mixColor(bar, STEEL_LIGHT, flange * 0.65);
    const holeAlbedo = mixColor(STEEL_SHADOW, [0, 0, 0], 0.6);
    const albedo = mixColor(holeAlbedo, barAlbedo, barMask);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], lerp(0.22, 1, barMask)],
      height,
      roughness: lerp(0.74, clamp01(0.3 - flange * 0.14), barMask),
      ao: lerp(0.26, clamp01(0.86 + flange * 0.12), barMask),
      metallic: lerp(0, 0.86, barMask),
    };
  };
};

const paintEmissiveEnergy: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const coreX = size * 0.5;
  return (x, y) => {
    const distToCore = Math.abs(x - coreX);
    const channel = softStep(1 - distToCore / (size * 0.32), 0.04, 1);
    const core = softStep(1 - distToCore / (size * 0.09), 0.08, 1);
    const flicker = fbm(seed, x * 0.014, y * 0.04, size, 2);
    const casingGrain = fbm(seed + 29, x * 0.022, y * 0.022, size, 2);
    const rim = softStep(1 - Math.abs(distToCore - size * 0.2) / (size * 0.045), 0.08, 1);

    const height = clamp01(0.5 - channel * 0.24 + rim * 0.1 + (casingGrain - 0.5) * 0.02);
    const casing = mixColor(STEEL_SHADOW, STEEL_DARK, casingGrain);
    const glow = mixColor(ENERGY_DIM, ENERGY, clamp01(0.5 + flicker * 0.5));
    const withCore = mixColor(glow, ENERGY_CORE, core * 0.95);
    let albedo = mixColor(casing, withCore, channel);
    albedo = mixColor(albedo, ENERGY_CORE, rim * 0.45 + core * 0.2);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], 1],
      height,
      roughness: clamp01(0.52 - channel * 0.58),
      ao: clamp01(0.95 - channel * 0.38),
      metallic: clamp01(0.58 * (1 - channel)),
    };
  };
};

const paintEmissiveGoal: PainterFactory = (seed) => {
  const size = MATERIAL_TILE_PX;
  const coreX = size * 0.5;
  return (x, y) => {
    const wobble = Math.sin(y * 0.12 + seed * 0.0001) * size * 0.045;
    const distToCore = Math.abs(x - coreX - wobble);
    const shaft = softStep(1 - distToCore / (size * 0.42), 0.04, 1);
    const ripple = softStep(1 - distToCore / (size * 0.1), 0.08, 1);
    const shimmer = fbm(seed, x * 0.012, y * 0.035, size, 2);
    const casingGrain = fbm(seed + 61, x * 0.022, y * 0.022, size, 2);
    const rim = softStep(1 - Math.abs(distToCore - size * 0.24) / (size * 0.05), 0.08, 1);

    const height = clamp01(0.5 - shaft * 0.28 + rim * 0.12 + (casingGrain - 0.5) * 0.02);
    const casing = mixColor(STEEL_SHADOW, STEEL_DARK, casingGrain);
    const glow = mixColor(GOAL_DIM, GOAL_ENERGY, clamp01(0.5 + shimmer * 0.5));
    const withCore = mixColor(glow, GOAL_CORE, ripple * 0.95);
    let albedo = mixColor(casing, withCore, shaft);
    albedo = mixColor(albedo, GOAL_CORE, rim * 0.5 + ripple * 0.15);
    return {
      albedo: [albedo[0], albedo[1], albedo[2], 1],
      height,
      roughness: clamp01(0.48 - shaft * 0.52),
      ao: clamp01(0.96 - shaft * 0.32),
      metallic: clamp01(0.52 * (1 - shaft)),
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
 * relief. Painters spread height over wide soft footprints, which flattens per-texel gradients —
 * these stay high enough that bevels/rivets still read once lit, without amplifying grit.
 */
const NORMAL_STRENGTH: Record<MaterialId, number> = {
  [MaterialId.BrushedSteel]: 7,
  [MaterialId.PaintedSteel]: 6,
  [MaterialId.Grating]: 5,
  [MaterialId.RustedPlate]: 6,
  [MaterialId.Concrete]: 4,
  [MaterialId.ConveyorRubber]: 5,
  [MaterialId.WarningChevrons]: 6,
  [MaterialId.HazardSpike]: 4,
  [MaterialId.Catwalk]: 5,
  [MaterialId.EmissiveEnergy]: 5,
  [MaterialId.EmissiveGoal]: 5,
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
