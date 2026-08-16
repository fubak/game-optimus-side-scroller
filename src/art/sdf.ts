/**
 * Signed-distance shape rasterisation.
 *
 * Character parts are described as combinations of signed distance functions
 * rather than drawn as pixels. This buys three things that matter a great deal
 * for a procedurally-generated character:
 *
 * - **Resolution independence.** The same description rasterises at any scale,
 *   so parts can be regenerated at 4x for a close-up without redrawing.
 * - **Free bevels.** The distance value *is* the distance from the edge, so a
 *   smooth bevel is a function of it. Bevelled edges are what make the shell
 *   plates catch light and read as solid machined objects.
 * - **Exact silhouettes.** Union, subtraction, and smooth-minimum operators
 *   compose parts without seams or overdraw, so a limb is one continuous
 *   surface rather than a stack of overlapping rectangles.
 */

import { clamp01, smoothstep, lerp } from '../core/math/scalar.ts';
import { type Surface, setPixel } from './texgen.ts';

/** Signed distance to a shape: negative inside, positive outside, in pixels. */
export type Sdf = (x: number, y: number) => number;

export const sdCircle =
  (cx: number, cy: number, radius: number): Sdf =>
  (x, y) =>
    Math.hypot(x - cx, y - cy) - radius;

/** A line segment thickened by `radius` — the workhorse for limb segments. */
export const sdCapsule =
  (ax: number, ay: number, bx: number, by: number, radius: number): Sdf =>
  (x, y) => {
    const pax = x - ax;
    const pay = y - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const lengthSq = bax * bax + bay * bay;
    const h = lengthSq > 1e-9 ? clamp01((pax * bax + pay * bay) / lengthSq) : 0;
    return Math.hypot(pax - bax * h, pay - bay * h) - radius;
  };

/** A capsule whose radius varies linearly from end to end. */
export const sdTaperedCapsule =
  (ax: number, ay: number, bx: number, by: number, radiusA: number, radiusB: number): Sdf =>
  (x, y) => {
    const pax = x - ax;
    const pay = y - ay;
    const bax = bx - ax;
    const bay = by - ay;
    const lengthSq = bax * bax + bay * bay;
    const h = lengthSq > 1e-9 ? clamp01((pax * bax + pay * bay) / lengthSq) : 0;
    const radius = lerp(radiusA, radiusB, h);
    return Math.hypot(pax - bax * h, pay - bay * h) - radius;
  };

export const sdRoundedBox =
  (cx: number, cy: number, halfWidth: number, halfHeight: number, radius: number): Sdf =>
  (x, y) => {
    const dx = Math.abs(x - cx) - halfWidth + radius;
    const dy = Math.abs(y - cy) - halfHeight + radius;
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - radius;
  };

/** A rounded box rotated about its centre. */
export const sdRotatedBox =
  (
    cx: number,
    cy: number,
    halfWidth: number,
    halfHeight: number,
    radius: number,
    angle: number,
  ): Sdf =>
  (x, y) => {
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const dx = x - cx;
    const dy = y - cy;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return sdRoundedBox(0, 0, halfWidth, halfHeight, radius)(localX, localY);
  };

export const union =
  (...shapes: Sdf[]): Sdf =>
  (x, y) => {
    let best = Infinity;
    for (const shape of shapes) best = Math.min(best, shape(x, y));
    return best;
  };

/**
 * Union with a smooth blend of width `k`.
 *
 * This is what makes a shoulder flow into an arm rather than showing a crease
 * where two primitives meet — the single most important operator for making
 * generated parts look designed rather than assembled.
 */
export const smoothUnion =
  (k: number, ...shapes: Sdf[]): Sdf =>
  (x, y) => {
    let result = shapes[0]!(x, y);
    for (let i = 1; i < shapes.length; i++) {
      const b = shapes[i]!(x, y);
      const h = clamp01(0.5 + (0.5 * (b - result)) / k);
      result = lerp(b, result, h) - k * h * (1 - h);
    }
    return result;
  };

export const subtract =
  (base: Sdf, cut: Sdf): Sdf =>
  (x, y) =>
    Math.max(base(x, y), -cut(x, y));

export const intersect =
  (a: Sdf, b: Sdf): Sdf =>
  (x, y) =>
    Math.max(a(x, y), b(x, y));

export interface ShapeStyle {
  /** Base colour. */
  color: readonly [number, number, number];
  /** Colour at the bevelled rim; usually a little brighter. */
  rimColor?: readonly [number, number, number];
  /** Bevel width in pixels. */
  bevel: number;
  /** Peak relief height in [0, 1]. */
  height: number;
  roughness: number;
  metallic: number;
  emissive?: number;
  translucency?: number;
  /** Bias the relief so a part reads as domed rather than flat-topped. */
  dome?: number;
}

/**
 * Rasterises an SDF into a surface.
 *
 * Coverage is derived from the distance so edges are antialiased for free, and
 * the bevel ramp is what gives the lighting pass a real edge to catch. Only
 * pixels the shape actually covers are written, so shapes can be layered.
 */
export function fillSdf(surface: Surface, sdf: Sdf, style: ShapeStyle): void {
  const { width, height } = surface;
  const rimColor = style.rimColor ?? style.color;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = sdf(x + 0.5, y + 0.5);
      // One-pixel antialiased edge.
      const coverage = clamp01(0.5 - distance);
      if (coverage <= 0.002) continue;

      const index = y * width + x;

      // Relief ramps up over the bevel width from the edge inward.
      const inward = -distance;
      let relief = smoothstep(0, style.bevel, inward);
      if (style.dome) {
        // An extra low-frequency dome so large plates are not flat-topped.
        relief = lerp(relief, Math.pow(relief, 0.55), style.dome);
      }
      relief *= style.height;

      // The rim colour appears where the bevel is, fading into the base colour.
      const rimFactor = 1 - smoothstep(0, style.bevel * 1.4, inward);
      const r = lerp(style.color[0], rimColor[0], rimFactor);
      const g = lerp(style.color[1], rimColor[1], rimFactor);
      const b = lerp(style.color[2], rimColor[2], rimFactor);

      // Composite over whatever is already there, so layered shapes blend.
      const existingAlpha = surface.albedo[index * 4 + 3]! / 255;
      const alpha = coverage + existingAlpha * (1 - coverage);
      if (alpha <= 0.002) continue;

      const existingR = surface.albedo[index * 4]! / 255;
      const existingG = surface.albedo[index * 4 + 1]! / 255;
      const existingB = surface.albedo[index * 4 + 2]! / 255;

      setPixel(
        surface,
        x,
        y,
        lerp(existingR, r, coverage),
        lerp(existingG, g, coverage),
        lerp(existingB, b, coverage),
        alpha,
      );

      if (relief > surface.heightField[index]! || coverage > 0.5) {
        surface.heightField[index] = Math.max(surface.heightField[index]!, relief);
      }
      if (coverage > 0.5) {
        surface.roughness[index] = style.roughness;
        surface.metallic[index] = style.metallic;
        surface.emissive[index] = style.emissive ?? 0;
        surface.translucency[index] = style.translucency ?? 0;
      }
    }
  }
}

/**
 * Cuts a recessed groove along an SDF's zero contour.
 *
 * Panel seams are the signature detail of the whole mechanical design language:
 * a thin dark line where two shell plates meet. Because they are cut *into* the
 * height field rather than painted on, the lighting pass gives them a real
 * shadowed edge that moves correctly as the light does.
 */
export function cutSeam(
  surface: Surface,
  sdf: Sdf,
  thickness: number,
  depth: number,
  color: readonly [number, number, number],
): void {
  const { width, height } = surface;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      // Only cut where a surface already exists.
      if (surface.albedo[index * 4 + 3]! < 128) continue;

      const distance = Math.abs(sdf(x + 0.5, y + 0.5));
      if (distance > thickness) continue;

      const strength = 1 - smoothstep(thickness * 0.35, thickness, distance);
      surface.heightField[index] = Math.max(0, surface.heightField[index]! - depth * strength);

      const r = surface.albedo[index * 4]! / 255;
      const g = surface.albedo[index * 4 + 1]! / 255;
      const b = surface.albedo[index * 4 + 2]! / 255;
      setPixel(
        surface,
        x,
        y,
        lerp(r, color[0], strength),
        lerp(g, color[1], strength),
        lerp(b, color[2], strength),
        surface.albedo[index * 4 + 3]! / 255,
      );
    }
  }
}

/** Paints an emissive strip along an SDF, for the cyan accent lines. */
export function paintEmissive(
  surface: Surface,
  sdf: Sdf,
  thickness: number,
  color: readonly [number, number, number],
  intensity = 1,
): void {
  const { width, height } = surface;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (surface.albedo[index * 4 + 3]! < 128) continue;

      const distance = Math.abs(sdf(x + 0.5, y + 0.5));
      if (distance > thickness) continue;

      const strength = 1 - smoothstep(thickness * 0.25, thickness, distance);
      if (strength <= 0.01) continue;

      const r = surface.albedo[index * 4]! / 255;
      const g = surface.albedo[index * 4 + 1]! / 255;
      const b = surface.albedo[index * 4 + 2]! / 255;
      setPixel(
        surface,
        x,
        y,
        lerp(r, color[0], strength),
        lerp(g, color[1], strength),
        lerp(b, color[2], strength),
        surface.albedo[index * 4 + 3]! / 255,
      );
      surface.emissive[index] = Math.max(surface.emissive[index]!, strength * intensity);
      surface.roughness[index] = 0.25;
      surface.metallic[index] = 0;
    }
  }
}
