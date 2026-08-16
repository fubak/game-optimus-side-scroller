/**
 * The heads-up display.
 *
 * Drawn as world-space quads through the same sprite batcher as everything
 * else, but positioned in screen space and rendered *after* the composite, so
 * it bypasses the biome's colour grade, the fog, and the vignette. HUD elements
 * that get graded along with the scene change colour from room to room, which
 * makes them harder to read exactly when the player most needs them.
 *
 * ## Design language
 *
 * Thin cyan strokes, hexagonal motifs, and a holographic scanline shimmer — the
 * same vocabulary as Optimus's own optic strip, so the interface reads as
 * something the machine is projecting rather than something the game has
 * overlaid.
 *
 * ## Animation
 *
 * Nothing snaps. The integrity bar chases its target through a spring, so
 * taking damage produces a visible lurch and recovery. A bar that jumps
 * instantly to its new value communicates the number but not the event.
 */

import type { SpriteBatch } from '../gfx/batch.ts';
import { packColor, packMaterial } from '../gfx/batch.ts';
import { BlendMode } from '../gfx/device.ts';
import type { Atlas } from '../art/atlas.ts';
import type { Camera } from '../scene/camera.ts';
import { spring, stepSpring, type SpringState } from '../core/math/spring.ts';
import { clamp01 } from '../core/math/scalar.ts';
import { OPTIMUS_CYAN } from '../core/config.ts';

export class Hud {
  /** Smoothed integrity value, chasing the real one. */
  private readonly integrity: SpringState = spring(1);
  /**
   * A second, slower bar trailing behind.
   *
   * The gap between the two is the damage just taken, which is far more legible
   * than a bar that simply becomes shorter.
   */
  private readonly integrityGhost: SpringState = spring(1);

  private time = 0;
  /** Rises when damage is taken, driving a red flash. */
  private damageFlash = 0;
  private previousHealth = 1;

  constructor(private readonly atlas: Atlas) {}

  update(healthFraction: number, dt: number): void {
    this.time += dt;

    if (healthFraction < this.previousHealth - 0.001) {
      this.damageFlash = 1;
    }
    this.previousHealth = healthFraction;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);

    stepSpring(this.integrity, healthFraction, { frequency: 5.5, damping: 0.8 }, dt);
    // The ghost is deliberately slow and heavily damped, so it drains
    // visibly behind the main bar.
    stepSpring(this.integrityGhost, healthFraction, { frequency: 1.1, damping: 1.0 }, dt);
  }

  /**
   * Draws the HUD.
   *
   * Coordinates are in world units placed relative to the camera, which is what
   * lets the same batcher and view matrix serve both the world and the
   * interface without a second projection.
   */
  draw(batch: SpriteBatch, camera: Camera, healthFraction: number): void {
    const fill = this.atlas.get('barFill');
    const panel = this.atlas.get('panel');

    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Premultiplied);

    // Anchor to the top-left of the view.
    const halfHeight = camera.viewHeightMetres / 2;
    const halfWidth = camera.viewWidthMetres / 2;
    const left = camera.x - halfWidth;
    const top = camera.y - halfHeight;

    // Scale the whole HUD with the view, so it occupies a constant fraction of
    // the screen at any zoom.
    const unit = camera.viewHeightMetres / 10;

    const originX = left + unit * 0.7;
    const originY = top + unit * 0.7;

    const barWidth = unit * 4.2;
    const barHeight = unit * 0.32;

    const material = packMaterial(0.85, 1, 0, 0);
    const cyan = OPTIMUS_CYAN;

    // --- Backing plate -----------------------------------------------------
    batch.draw(
      originX + barWidth / 2,
      originY + barHeight / 2,
      barWidth + unit * 0.16,
      barHeight + unit * 0.16,
      panel.u0,
      panel.v0,
      panel.u1,
      panel.v1,
      0,
      packColor(0.03, 0.04, 0.05, 0.72),
      packMaterial(0, 1, 0, 0),
      0,
    );

    // --- Ghost bar ---------------------------------------------------------
    const ghost = clamp01(this.integrityGhost.value);
    if (ghost > 0.001) {
      batch.setBlend(BlendMode.Additive);
      batch.draw(
        originX + (barWidth * ghost) / 2,
        originY + barHeight / 2,
        barWidth * ghost,
        barHeight,
        fill.u0,
        fill.v0,
        fill.u1,
        fill.v1,
        0,
        // Amber, so the damage taken is a different colour to the health left.
        packColor(0.55 * 0.5, 0.22 * 0.5, 0.08 * 0.5, 0.5),
        material,
        0,
      );
    }

    // --- Main bar ----------------------------------------------------------
    const value = clamp01(this.integrity.value);
    if (value > 0.001) {
      // Low integrity pulses, which is a far more urgent signal than colour
      // alone and works for colourblind players.
      const critical = value < 0.3 ? 1 : 0;
      const pulse = 1 + critical * Math.sin(this.time * 9) * 0.28;

      const r = cyan.r * pulse + this.damageFlash * 1.2;
      const g = cyan.g * pulse * (1 - critical * 0.55);
      const b = cyan.b * pulse * (1 - critical * 0.6);

      batch.draw(
        originX + (barWidth * value) / 2,
        originY + barHeight / 2,
        barWidth * value,
        barHeight,
        fill.u0,
        fill.v0,
        fill.u1,
        fill.v1,
        0,
        packColor(r * 0.85, g * 0.85, b * 0.85, 0.9),
        material,
        0,
      );

      // A bright cap at the leading edge, which gives the bar a defined end
      // rather than a soft fade.
      batch.draw(
        originX + barWidth * value,
        originY + barHeight / 2,
        unit * 0.16,
        barHeight * 1.5,
        fill.u0,
        fill.v0,
        fill.u1,
        fill.v1,
        0,
        packColor(r, g, b, 1),
        material,
        0,
      );
    }

    // --- Segment ticks -----------------------------------------------------
    // Quarter markers, so the player can read the value at a glance instead of
    // estimating a length.
    for (let i = 1; i < 4; i++) {
      const x = originX + (barWidth * i) / 4;
      batch.draw(
        x,
        originY + barHeight / 2,
        unit * 0.035,
        barHeight * 0.85,
        fill.u0,
        fill.v0,
        fill.u1,
        fill.v1,
        0,
        packColor(0.02, 0.03, 0.04, 0.75),
        packMaterial(0, 1, 0, 0),
        0,
      );
    }

    void healthFraction;
    batch.setBlend(BlendMode.Premultiplied);
  }

  reset(): void {
    this.integrity.value = 1;
    this.integrity.velocity = 0;
    this.integrityGhost.value = 1;
    this.integrityGhost.velocity = 0;
    this.damageFlash = 0;
    this.previousHealth = 1;
  }
}
