/**
 * Ribbon trails.
 *
 * A trail is a strip of quads generated from a moving point's recent history,
 * widening at the leading edge and tapering to nothing at the tail. Used for
 * melee arcs, dash afterimages, and projectile streaks.
 *
 * ## Why history rather than a fixed arc
 *
 * A slash trail could be drawn as a pre-authored crescent, and many games do.
 * Generating it from the weapon's actual path costs almost nothing and is
 * strictly better: the arc automatically matches whatever the animation is
 * doing, it stretches when the attack moves faster, and it bends correctly when
 * a combo redirects mid-swing. A canned crescent has to be re-authored for
 * every attack and still drifts out of sync with the pose.
 *
 * Points are resampled with Catmull-Rom so the ribbon stays smooth at low
 * frame rates, where the raw sample history would show visible corners.
 */

import type { SpriteBatch } from '../gfx/batch.ts';
import { packColor, packMaterial } from '../gfx/batch.ts';
import { BlendMode } from '../gfx/device.ts';
import type { AtlasEntry } from '../art/atlas.ts';
import { clamp01 } from '../core/math/scalar.ts';

interface TrailPoint {
  x: number;
  y: number;
  /** Seconds since this point was recorded. */
  age: number;
}

export interface TrailStyle {
  /** Width at the leading edge, in metres. */
  width: number;
  /** Seconds a point survives. Longer means a longer streak. */
  lifetime: number;
  /** Core colour, which reads as the hottest part of the trail. */
  core: [number, number, number];
  /** Outer colour, which the core fades into. */
  edge: [number, number, number];
  /** Overall opacity. */
  intensity: number;
}

export class Trail {
  private readonly points: TrailPoint[] = [];
  private emitting = false;

  constructor(
    readonly style: TrailStyle,
    private readonly maxPoints = 24,
  ) {}

  start(): void {
    this.emitting = true;
    this.points.length = 0;
  }

  stop(): void {
    this.emitting = false;
  }

  get active(): boolean {
    return this.points.length > 1;
  }

  /** Records the emitter's current position. Call once per rendered frame. */
  sample(x: number, y: number): void {
    if (!this.emitting) return;

    // Skip points that have barely moved, or a stationary emitter fills the
    // buffer with coincident samples and the ribbon collapses.
    const last = this.points[this.points.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 0.012) return;

    this.points.push({ x, y, age: 0 });
    if (this.points.length > this.maxPoints) this.points.shift();
  }

  update(dt: number): void {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const point = this.points[i]!;
      point.age += dt;
      if (point.age > this.style.lifetime) this.points.splice(i, 1);
    }
  }

  /**
   * Emits the ribbon as a strip of quads.
   *
   * Each segment is a quad spanning the perpendicular offsets at its two ends,
   * so the strip follows the path exactly and its width can vary along the
   * length.
   */
  draw(batch: SpriteBatch, entry: AtlasEntry): void {
    const count = this.points.length;
    if (count < 2) return;

    batch.setBlend(BlendMode.Additive);
    const material = packMaterial(1, 1, 0, 0);

    for (let i = 0; i < count - 1; i++) {
      const a = this.points[i]!;
      const b = this.points[i + 1]!;

      // Position along the ribbon: 0 at the tail, 1 at the leading edge.
      const tA = i / (count - 1);
      const tB = (i + 1) / (count - 1);

      const ageFadeA = clamp01(1 - a.age / this.style.lifetime);
      const ageFadeB = clamp01(1 - b.age / this.style.lifetime);

      // Width tapers toward the tail; squaring makes the taper accelerate,
      // which reads as a blade edge rather than a uniform stripe.
      const widthA = this.style.width * tA * tA * ageFadeA;
      const widthB = this.style.width * tB * tB * ageFadeB;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy) || 1;
      const nx = -dy / length;
      const ny = dx / length;

      const alphaA = ageFadeA * tA * this.style.intensity;
      const alphaB = ageFadeB * tB * this.style.intensity;
      const alpha = (alphaA + alphaB) * 0.5;
      if (alpha < 0.004) continue;

      // Blend core to edge along the ribbon, so the leading edge is hottest.
      const mix = tA;
      const r = this.style.edge[0] + (this.style.core[0] - this.style.edge[0]) * mix;
      const g = this.style.edge[1] + (this.style.core[1] - this.style.edge[1]) * mix;
      const bb = this.style.edge[2] + (this.style.core[2] - this.style.edge[2]) * mix;

      batch.drawQuad(
        a.x + nx * widthA,
        a.y + ny * widthA,
        b.x + nx * widthB,
        b.y + ny * widthB,
        b.x - nx * widthB,
        b.y - ny * widthB,
        a.x - nx * widthA,
        a.y - ny * widthA,
        entry.u0,
        entry.v0,
        entry.u1,
        entry.v1,
        0,
        packColor(r * alpha, g * alpha, bb * alpha, alpha),
        material,
        0,
      );
    }

    batch.setBlend(BlendMode.Premultiplied);
  }

  clear(): void {
    this.points.length = 0;
    this.emitting = false;
  }
}

/** Named styles, so every attack in the game shares one visual language. */
export const TRAIL_STYLES = {
  /** The standard melee arc: a white-hot core bleeding into the player cyan. */
  slash: {
    width: 0.34,
    lifetime: 0.16,
    core: [1.0, 1.0, 1.0],
    edge: [0.247, 0.914, 1.0],
    intensity: 0.95,
  } satisfies TrailStyle,
  /** Heavier and slower, for the finisher. */
  heavySlash: {
    width: 0.52,
    lifetime: 0.22,
    core: [1.0, 1.0, 1.0],
    edge: [0.35, 0.80, 1.0],
    intensity: 1.1,
  } satisfies TrailStyle,
  /** The dash afterimage: dimmer and longer-lived. */
  dash: {
    width: 0.30,
    lifetime: 0.24,
    core: [0.55, 0.95, 1.0],
    edge: [0.15, 0.45, 0.85],
    intensity: 0.55,
  } satisfies TrailStyle,
} as const;
