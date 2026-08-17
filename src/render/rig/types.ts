/**
 * Shared types for the procedural skeletal rigs (`optimusRig.ts`, `enemyRigs.ts`).
 *
 * A rig never draws anything itself — it only describes *what* to draw, as a flat list of
 * axis-aligned, world-space rectangles. That keeps the pose maths (this directory) completely
 * decoupled from how a rectangle ends up on screen (`drawRig.ts`), so the exact same rig can feed
 * a Canvas2D `Surface`, raw `fillRect` calls, or `GBufferBatch` instanced quads without any of the
 * three needing to know about the others.
 */

/** One coloured (and optionally emissive) rectangle, already placed in world space. */
export interface RigRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** CSS colour string, typically a `palette` entry. */
  readonly color: string;
  /** 0..1 multiplier: >0 marks this rect as self-lit (visor glow, chest core, muzzle flash, …). */
  readonly emissive?: number;
  /** Material hints forwarded to `GBufferBatch`; Classic/Surface consumers ignore these. */
  readonly roughness?: number;
  readonly metallic?: number;
  /** Alpha multiplier, e.g. for death fade-outs. Defaults to 1. */
  readonly alpha?: number;
}

/** A complete rig pose: every rectangle needed to draw one character this frame, back-to-front. */
export type RigParts = readonly RigRect[];
