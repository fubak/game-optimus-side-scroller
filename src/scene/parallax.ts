/**
 * Multi-layer parallax backgrounds.
 *
 * Layers tile horizontally and scroll at a rate derived from their depth, which
 * produces the illusion of distance. Two details separate a convincing result
 * from an obviously fake one:
 *
 * - **Reciprocal, not linear, depth scrolling.** Real perspective falls off as
 *   `1/(1+d)`. A linear ramp makes distant layers slide past far too quickly,
 *   which the eye reads immediately as wrong even when it cannot say why.
 * - **Independent drift.** Dust sheets and haze bands move relative to their own
 *   layer as well as with the camera, so the world keeps breathing when the
 *   player stands still. A background that freezes the moment the player stops
 *   looks like a painting; one that keeps moving looks like a place.
 */

import type { SpriteBatch } from '../gfx/batch.ts';
import { packColor, packMaterial } from '../gfx/batch.ts';
import { BlendMode } from '../gfx/device.ts';
import type { Atlas } from '../art/atlas.ts';
import type { Camera } from './camera.ts';

export interface ParallaxLayer {
  sprite: string;
  /** Larger is further away. Drives both scroll rate and tint. */
  depth: number;
  /** World Y of the layer's vertical centre, in metres. */
  y: number;
  /** Rendered height in metres. Width follows the sprite's aspect ratio. */
  heightMetres: number;
  /** Horizontal drift in metres per second, independent of the camera. */
  driftX?: number;
  /** Vertical bob amplitude in metres. */
  bobAmplitude?: number;
  bobSpeed?: number;
  /** Multiplied into the layer's colour. */
  tint?: [number, number, number];
  opacity?: number;
  /** Emissive boost; sky layers use 1 so lighting passes them through. */
  emissive?: number;
  blend?: BlendMode;
  /**
   * Locks the layer to the camera, ignoring world position. Used for the sky,
   * which must never slide out of frame.
   */
  lockToCamera?: boolean;
  /**
   * Anchors the layer's *top edge* to a fraction of the half-view-height,
   * measured from the camera centre, while still scrolling horizontally with
   * parallax. `0` is the centre of the screen, `1` the bottom edge.
   *
   * Foreground framing needs this. Anchoring it at a fixed world Y meant it
   * either drifted out of frame as the camera climbed, or — once anchored —
   * covered a fixed number of metres, which at a wide vista framing swallowed
   * the entire playfield. Expressing it as a fraction of the view keeps the
   * framing band the same proportion of the screen at every zoom level.
   */
  anchorTop?: number;
}

export class ParallaxRenderer {
  constructor(
    private readonly atlas: Atlas,
    private readonly camera: Camera,
  ) {}

  /**
   * Draws one layer, tiled to cover the visible width.
   *
   * @param time Seconds, for drift and bob.
   */
  draw(batch: SpriteBatch, layer: ParallaxLayer, time: number): void {
    const entry = this.atlas.get(layer.sprite);
    const camera = this.camera;

    const heightMetres = layer.heightMetres;
    const widthMetres = (heightMetres * entry.width) / entry.height;

    const tint = layer.tint ?? [1, 1, 1];
    const opacity = layer.opacity ?? 1;
    // The batch expects premultiplied colour, matching the atlas's own format.
    const color = packColor(
      tint[0] * opacity,
      tint[1] * opacity,
      tint[2] * opacity,
      opacity,
    );
    const material = packMaterial(layer.emissive ?? 0, 0.9, 0, 0);

    batch.setBlend(layer.blend ?? BlendMode.Premultiplied);

    if (layer.lockToCamera) {
      // Sized to the view so it always covers the screen exactly, whatever the
      // aspect ratio or zoom.
      const viewHeight = camera.viewHeightMetres;
      const viewWidth = camera.viewWidthMetres;
      batch.draw(
        camera.x,
        camera.y + layer.y,
        viewWidth * 1.02,
        viewHeight * 1.02,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        layer.depth,
        color,
        material,
        0,
      );
      return;
    }

    const parallax = camera.parallaxFactor(layer.depth);
    // Shifting geometry against the camera lets one view matrix serve every
    // layer, instead of rebuilding a matrix per layer.
    const cameraOffsetX = camera.x * (1 - parallax);
    const cameraOffsetY = camera.y * (1 - parallax);

    const drift = (layer.driftX ?? 0) * time;
    const bob =
      layer.bobAmplitude && layer.bobSpeed
        ? Math.sin(time * layer.bobSpeed) * layer.bobAmplitude
        : 0;

    const visible = camera.getVisibleBounds(widthMetres);
    // Work out which tile indices are needed, rather than drawing a fixed
    // count, so wide views and zoomed-out framings still fill the screen.
    const effectiveX = camera.x * parallax - drift;
    const firstTile = Math.floor((visible.minX - cameraOffsetX - effectiveX) / widthMetres) - 1;
    const lastTile = Math.ceil((visible.maxX - cameraOffsetX - effectiveX) / widthMetres) + 1;

    let y: number;
    if (layer.anchorTop !== undefined) {
      const anchor = camera.y + (camera.viewHeightMetres / 2) * layer.anchorTop;
      y = anchor + heightMetres / 2 + bob;
    } else {
      y = layer.y + bob + cameraOffsetY;
    }

    for (let tile = firstTile; tile <= lastTile; tile++) {
      const x = tile * widthMetres + drift + cameraOffsetX;
      batch.draw(
        x,
        y,
        widthMetres,
        heightMetres,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        layer.depth,
        color,
        material,
        0,
      );
    }
  }

  /** Draws a whole stack, furthest first. */
  drawAll(batch: SpriteBatch, layers: readonly ParallaxLayer[], time: number): void {
    const sorted = [...layers].sort((a, b) => b.depth - a.depth);
    for (const layer of sorted) this.draw(batch, layer, time);
  }

  /**
   * Draws only the layers behind the playfield.
   *
   * The stack has to be split around the playfield: layers at negative depth
   * are *foreground* framing and must be drawn after the props, or the ground
   * slab paints straight over them.
   */
  drawBackground(batch: SpriteBatch, layers: readonly ParallaxLayer[], time: number): void {
    const sorted = layers.filter((l) => l.depth >= 0).sort((a, b) => b.depth - a.depth);
    for (const layer of sorted) this.draw(batch, layer, time);
  }

  /** Draws only the layers in front of the playfield. */
  drawForeground(batch: SpriteBatch, layers: readonly ParallaxLayer[], time: number): void {
    const sorted = layers.filter((l) => l.depth < 0).sort((a, b) => b.depth - a.depth);
    for (const layer of sorted) this.draw(batch, layer, time);
  }
}
