import { parseColor } from '../color';
import type { GBufferBatch } from '../gl/gbufferBatch';
import type { Surface } from '../surface';
import type { RigParts } from './types';

/**
 * Emits a rig's rectangles into a drawing backend.
 *
 * Rigs (`optimusRig.ts`, `enemyRigs.ts`) only ever describe *what* to draw; this module is the
 * only place that knows *how*. Two backends are provided:
 *
 * - {@link drawRigToSurface} — plain `fillRect` calls against the minimal {@link Surface}
 *   abstraction (or any Canvas2D-backed adapter implementing it). Not currently wired into
 *   Classic (which keeps using `drawOptimus`/`drawWalker`/etc. directly for pixel-identical
 *   output), but kept generic so a future Canvas2D consumer of the rig does not need a new
 *   emitter.
 * - {@link drawRigToGBuffer} — queues each rectangle into a {@link GBufferBatch} instance, one
 *   instanced quad per part, so the GL deferred pipeline gets the same self-lit emissive/material
 *   treatment as its existing pickups/projectiles.
 */

export function drawRigToSurface(surface: Surface, parts: RigParts): void {
  for (const part of parts) {
    const alpha = part.alpha ?? 1;
    if (alpha <= 0 || part.width <= 0 || part.height <= 0) continue;
    if (surface.setAlpha !== undefined) surface.setAlpha(alpha);
    surface.fillRect(part.x, part.y, part.width, part.height, part.color);
  }
  if (surface.setAlpha !== undefined) surface.setAlpha(1);
}

export function drawRigToGBuffer(batch: GBufferBatch, parts: RigParts): void {
  for (const part of parts) {
    const alpha = part.alpha ?? 1;
    if (alpha <= 0 || part.width <= 0 || part.height <= 0) continue;
    const [r, g, b] = parseColor(part.color);
    const emissive = part.emissive ?? 0;
    batch.rect(part.x, part.y, part.width, part.height, {
      r,
      g,
      b,
      a: alpha,
      emissiveR: r * emissive,
      emissiveG: g * emissive,
      emissiveB: b * emissive,
      ...(part.roughness !== undefined ? { roughness: part.roughness } : {}),
      ...(part.metallic !== undefined ? { metallic: part.metallic } : {}),
    });
  }
}
