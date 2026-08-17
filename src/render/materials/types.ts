/**
 * Procedural material vocabulary.
 *
 * Stage 3 of the 4K visual overhaul generates PBR-ish material atlases (albedo, normal,
 * roughness/AO/metallic) entirely at runtime from a seed — no hand-authored textures. This module
 * defines the shared shapes: which materials exist, how they are packed into one atlas texture,
 * and the per-pixel sample a painter produces before it is written into that atlas.
 *
 * Nothing here reads pixels or touches the DOM/WebGL — see {@link ../generate} for the CPU
 * painter and {@link ../../gl/materialTextures} for the GPU upload path.
 */

/**
 * Every procedural surface the factory can be built from. Kept as a const object of string
 * literals (matching {@link import('../../game/tiles').TileKind}) so a switch over it fails to
 * compile until every case is handled.
 */
export const MaterialId = {
  BrushedSteel: 'brushedSteel',
  PaintedSteel: 'paintedSteel',
  Grating: 'grating',
  RustedPlate: 'rustedPlate',
  Concrete: 'concrete',
  ConveyorRubber: 'conveyorRubber',
  WarningChevrons: 'warningChevrons',
  HazardSpike: 'hazardSpike',
  Catwalk: 'catwalk',
  EmissiveEnergy: 'emissiveEnergy',
  EmissiveGoal: 'emissiveGoal',
} as const;

export type MaterialId = (typeof MaterialId)[keyof typeof MaterialId];

export const ALL_MATERIAL_IDS: readonly MaterialId[] = Object.values(MaterialId);

/** One material's footprint inside the shared atlas texture, in pixels. */
export interface AtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Grid packing description for a material atlas: every material occupies one `tileSize`-square
 * cell, laid out left-to-right, top-to-bottom, with `rects` giving each material's placement.
 */
export interface AtlasLayout {
  readonly tileSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  readonly rects: Readonly<Record<MaterialId, AtlasRect>>;
}

/**
 * A single procedurally-painted texel, before it is packed into the atlas byte buffers.
 *
 * `height` is the intermediate surface-height value (0..1) a painter produces for a texel; the
 * normal map is derived from the whole material's height field via central differences, not
 * stored per-sample.
 */
export interface MaterialSample {
  /** Straight (non-premultiplied) RGBA, each channel 0..1. */
  readonly albedo: readonly [number, number, number, number];
  /** Relative surface height, 0..1, used to derive the normal map. */
  readonly height: number;
  /** Microfacet roughness, 0 (mirror) .. 1 (matte). */
  readonly roughness: number;
  /** Ambient occlusion / crevice darkening, 0 (fully occluded) .. 1 (fully lit). */
  readonly ao: number;
  /** Metallic mask, 0 (dielectric) .. 1 (metal). */
  readonly metallic: number;
}

/**
 * The full generated output: one shared atlas texture per channel group, all using the same
 * {@link AtlasLayout} so a shader can sample all three with one UV.
 */
export interface MaterialAtlas {
  readonly seed: number;
  readonly layout: AtlasLayout;
  /** RGBA8, straight alpha. */
  readonly albedo: Uint8Array;
  /** RGBA8 tangent-space normal packed as `(n * 0.5 + 0.5) * 255`; alpha is unused (255). */
  readonly normal: Uint8Array;
  /** RGBA8: R = roughness, G = AO, B = metallic, A = 255. */
  readonly params: Uint8Array;
}
