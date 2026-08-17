/**
 * CSS colour string parsing.
 *
 * The palette (`src/render/palette.ts`) and level data hand colours around as CSS strings, but
 * the GPU pipeline needs 0-1 float tuples. Parsing a colour string touches a regex and a handful
 * of allocations, so every result is cached by its exact input string — colours are read many
 * times per frame (once per tile/sprite/particle) but only ever change on a palette swap.
 */

export type RGBA = readonly [r: number, g: number, b: number, a: number];

const cache = new Map<string, RGBA>();

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_SHORT_ALPHA = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX_LONG_ALPHA = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FUNCTION = /^rgba?\(\s*([^)]+?)\s*\)$/i;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Two hex digits (already validated by a regex capture group) to a 0-1 float. */
function hexByteToFloat(hex: string): number {
  return parseInt(hex, 16) / 255;
}

/** A single hex digit, doubled (e.g. `#f` -> `#ff`), to a 0-1 float. */
function hexNibbleToFloat(nibble: string): number {
  return parseInt(nibble + nibble, 16) / 255;
}

/** A single `rgb()`/`rgba()` colour channel: a bare 0-255 number or a `NN%` percentage. */
function parseChannel(token: string): number {
  const trimmed = token.trim();
  if (trimmed.endsWith('%')) {
    return clamp01(parseFloat(trimmed) / 100);
  }
  return clamp01(parseFloat(trimmed) / 255);
}

/** An alpha value: a bare 0-1 number or a `NN%` percentage. Missing alpha means fully opaque. */
function parseAlpha(token: string | undefined): number {
  if (token === undefined) return 1;
  const trimmed = token.trim();
  if (trimmed.endsWith('%')) {
    return clamp01(parseFloat(trimmed) / 100);
  }
  return clamp01(parseFloat(trimmed));
}

/** All capture groups of a successful hex-colour regex match, as plain strings. */
function captures(match: RegExpExecArray, count: number): string[] | null {
  const groups: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const group = match[i];
    if (group === undefined) return null;
    groups.push(group);
  }
  return groups;
}

function parseHex(css: string): RGBA | null {
  const long = HEX_LONG.exec(css);
  if (long !== null) {
    const groups = captures(long, 3);
    if (groups === null) return null;
    const [r, g, b] = groups;
    if (r === undefined || g === undefined || b === undefined) return null;
    return [hexByteToFloat(r), hexByteToFloat(g), hexByteToFloat(b), 1];
  }
  const longAlpha = HEX_LONG_ALPHA.exec(css);
  if (longAlpha !== null) {
    const groups = captures(longAlpha, 4);
    if (groups === null) return null;
    const [r, g, b, a] = groups;
    if (r === undefined || g === undefined || b === undefined || a === undefined) return null;
    return [hexByteToFloat(r), hexByteToFloat(g), hexByteToFloat(b), hexByteToFloat(a)];
  }
  const short = HEX_SHORT.exec(css);
  if (short !== null) {
    const groups = captures(short, 3);
    if (groups === null) return null;
    const [r, g, b] = groups;
    if (r === undefined || g === undefined || b === undefined) return null;
    return [hexNibbleToFloat(r), hexNibbleToFloat(g), hexNibbleToFloat(b), 1];
  }
  const shortAlpha = HEX_SHORT_ALPHA.exec(css);
  if (shortAlpha !== null) {
    const groups = captures(shortAlpha, 4);
    if (groups === null) return null;
    const [r, g, b, a] = groups;
    if (r === undefined || g === undefined || b === undefined || a === undefined) return null;
    return [hexNibbleToFloat(r), hexNibbleToFloat(g), hexNibbleToFloat(b), hexNibbleToFloat(a)];
  }
  return null;
}

/**
 * `rgb(r, g, b)` / `rgba(r, g, b, a)` (comma syntax) and `rgb(r g b / a)` (modern space+slash
 * syntax); both accept `rgb` or `rgba` as the function name interchangeably.
 */
function parseRgbFunction(css: string): RGBA | null {
  const match = RGB_FUNCTION.exec(css);
  if (match === null) return null;
  const body = match[1];
  if (body === undefined) return null;

  const slashIndex = body.indexOf('/');
  const componentsPart = slashIndex === -1 ? body : body.slice(0, slashIndex);
  let alphaPart = slashIndex === -1 ? undefined : body.slice(slashIndex + 1).trim();

  const components = componentsPart
    .split(componentsPart.includes(',') ? ',' : /\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // Legacy comma syntax packs alpha in as a fourth component instead of after a slash.
  if (alphaPart === undefined && components.length === 4) {
    alphaPart = components.pop();
  }
  if (components.length !== 3) return null;

  const [r, g, b] = components;
  if (r === undefined || g === undefined || b === undefined) return null;
  return [parseChannel(r), parseChannel(g), parseChannel(b), parseAlpha(alphaPart)];
}

function parseColorUncached(css: string): RGBA {
  const trimmed = css.trim();
  const hex = parseHex(trimmed);
  if (hex !== null) return hex;
  const rgbFunction = parseRgbFunction(trimmed);
  if (rgbFunction !== null) return rgbFunction;
  throw new Error(`Unsupported colour string: "${css}"`);
}

/**
 * Parse a CSS colour string into a cached `[r, g, b, a]` tuple of 0-1 floats.
 *
 * Repeated calls with the same string return the exact same array instance (no new allocation),
 * so callers may safely call this every frame for palette colours.
 */
export function parseColor(css: string): RGBA {
  const cached = cache.get(css);
  if (cached !== undefined) return cached;
  const parsed = parseColorUncached(css);
  cache.set(css, parsed);
  return parsed;
}
