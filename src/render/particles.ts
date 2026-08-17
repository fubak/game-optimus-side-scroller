import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import { palette } from './palette';

/**
 * Fixed-capacity particle pool.
 *
 * Every particle lives in a preallocated array and is switched on/off, so a busy explosion frame
 * never allocates and the GC never sawtooths mid-jump. All randomness comes from the world RNG,
 * keeping effects reproducible.
 */

export type ParticleKind = 'spark' | 'dust' | 'debris' | 'ring' | 'exhaust' | 'pickup';

interface Particle {
  active: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  gravity: number;
  drag: number;
  color: string;
}

/**
 * Read-only view of one pool slot, for renderers that cannot draw through {@link ParticleSystem.draw}
 * (e.g. the WebGL2 backend, which batches particles as GPU quads instead of Canvas2D calls).
 * {@link ParticleSystem.particleAt} returns the pool's own object typed as this interface — no
 * per-call allocation — so callers must treat it as a snapshot valid only until the next
 * `update()`.
 */
export interface ParticleView {
  readonly active: boolean;
  readonly kind: ParticleKind;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly life: number;
  readonly maxLife: number;
  readonly size: number;
  readonly color: string;
}

export interface SpawnOptions {
  readonly kind: ParticleKind;
  readonly x: number;
  readonly y: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly life?: number;
  readonly size?: number;
  readonly gravity?: number;
  readonly drag?: number;
  readonly color?: string;
}

const DEFAULT_COLOR: Record<ParticleKind, string> = {
  spark: palette.spark,
  dust: palette.smoke,
  debris: palette.plateLight,
  ring: palette.visorGlow,
  exhaust: palette.flame,
  pickup: palette.energy,
};

const DEFAULT_GRAVITY: Record<ParticleKind, number> = {
  spark: 260,
  dust: -12,
  debris: 420,
  ring: 0,
  exhaust: -40,
  pickup: -60,
};

export class ParticleSystem {
  private readonly pool: Particle[];
  private cursor = 0;

  constructor(capacity = 512) {
    this.pool = Array.from({ length: capacity }, () => ({
      active: false,
      kind: 'spark',
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 1,
      size: 1,
      gravity: 0,
      drag: 0,
      color: palette.white,
    }));
  }

  get capacity(): number {
    return this.pool.length;
  }

  get activeCount(): number {
    return this.pool.reduce((count, particle) => count + (particle.active ? 1 : 0), 0);
  }

  /** Read-only view of pool slot `index`, or `null` if it is out of range or inactive. */
  particleAt(index: number): ParticleView | null {
    const particle = this.pool[index];
    if (particle?.active !== true) return null;
    return particle;
  }

  clear(): void {
    for (const particle of this.pool) particle.active = false;
  }

  spawn(options: SpawnOptions): void {
    // Round-robin over the pool: the oldest particle is recycled when we run out.
    const particle = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.pool.length;
    if (particle === undefined) return;
    particle.active = true;
    particle.kind = options.kind;
    particle.x = options.x;
    particle.y = options.y;
    particle.vx = options.vx ?? 0;
    particle.vy = options.vy ?? 0;
    particle.maxLife = options.life ?? 0.4;
    particle.life = particle.maxLife;
    particle.size = options.size ?? 1;
    particle.gravity = options.gravity ?? DEFAULT_GRAVITY[options.kind];
    particle.drag = options.drag ?? 1.5;
    particle.color = options.color ?? DEFAULT_COLOR[options.kind];
  }

  /** Scatter `count` particles from a point with randomised velocity. */
  burst(
    kind: ParticleKind,
    x: number,
    y: number,
    count: number,
    rng: Rng,
    options: {
      readonly speed?: number;
      readonly life?: number;
      readonly color?: string;
      readonly spread?: number;
    } = {},
  ): void {
    const speed = options.speed ?? 90;
    const spread = options.spread ?? Math.PI * 2;
    for (let i = 0; i < count; i += 1) {
      const angle = rng.range(-spread / 2, spread / 2) - Math.PI / 2;
      const magnitude = rng.range(speed * 0.35, speed);
      this.spawn({
        kind,
        x,
        y,
        vx: Math.cos(angle) * magnitude,
        vy: Math.sin(angle) * magnitude,
        life: (options.life ?? 0.45) * rng.range(0.7, 1.25),
        size: kind === 'debris' ? rng.int(1, 2) : 1,
        ...(options.color === undefined ? {} : { color: options.color }),
      });
    }
  }

  /** Puff of dust from landing or skidding feet. */
  landingDust(x: number, y: number, strength: number, rng: Rng): void {
    const count = clamp(Math.round(strength * 6), 2, 10);
    for (let i = 0; i < count; i += 1) {
      this.spawn({
        kind: 'dust',
        x: x + rng.signedRange(4),
        y,
        vx: rng.signedRange(45) * strength,
        vy: -rng.range(4, 22) * strength,
        life: rng.range(0.25, 0.5),
        size: rng.int(1, 2),
      });
    }
  }

  update(dtSec: number): void {
    for (const particle of this.pool) {
      if (!particle.active) continue;
      particle.life -= dtSec;
      if (particle.life <= 0) {
        particle.active = false;
        continue;
      }
      particle.vy += particle.gravity * dtSec;
      const dragFactor = 1 - clamp(particle.drag * dtSec, 0, 1);
      particle.vx *= dragFactor;
      particle.x += particle.vx * dtSec;
      particle.y += particle.vy * dtSec;
    }
  }

  draw(ctx: CanvasRenderingContext2D, cameraX: number, cameraY: number): void {
    for (const particle of this.pool) {
      if (!particle.active) continue;
      const progress = clamp(particle.life / particle.maxLife, 0, 1);
      const screenX = Math.round(particle.x - cameraX);
      const screenY = Math.round(particle.y - cameraY);
      ctx.fillStyle = particle.color;
      switch (particle.kind) {
        case 'spark':
        case 'debris': {
          const size = Math.max(1, Math.round(particle.size * progress + 0.4));
          ctx.globalAlpha = clamp(progress * 1.4, 0, 1);
          ctx.fillRect(screenX, screenY, size, size);
          break;
        }
        case 'dust':
        case 'exhaust': {
          const size = Math.max(1, Math.round(particle.size + (1 - progress) * 2));
          ctx.globalAlpha = progress * 0.55;
          ctx.fillRect(screenX - (size >> 1), screenY - (size >> 1), size, size);
          break;
        }
        case 'pickup': {
          ctx.globalAlpha = progress;
          ctx.fillRect(screenX, screenY, 1, Math.max(1, Math.round(1 + progress * 2)));
          break;
        }
        case 'ring': {
          const radius = (1 - progress) * particle.size * 8;
          ctx.globalAlpha = progress * 0.7;
          ctx.strokeStyle = particle.color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(screenX + 0.5, screenY + 0.5, Math.max(0.5, radius), 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        default: {
          const exhaustive: never = particle.kind;
          throw new Error(`Unhandled particle kind: ${String(exhaustive)}`);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}
