/**
 * The particle system.
 *
 * A single pooled array of particles, updated on the CPU and drawn with one
 * instanced draw call. CPU simulation is the right choice at this scale: a few
 * thousand particles cost well under a millisecond, and keeping the state in
 * JavaScript means emitters can react to gameplay (a landing's real impact
 * speed, a hit's real direction) without a GPU readback.
 *
 * ## Why the density matters
 *
 * Airborne particulate is most of what separates a scene that feels like a
 * place from one that feels like a diagram. The reference bar carries thousands
 * of motes at several depths, constantly drifting, catching the key light. The
 * previous implementation drew a few hundred as individual quads, which capped
 * both the count and the variety.
 *
 * ## Behaviours
 *
 * Particles are plain data with a behaviour tag rather than subclasses, so the
 * whole pool stays in one contiguous array and the update loop stays tight.
 */

import { Rng } from '../core/rng.ts';
import { NoiseField } from '../core/math/noise.ts';
import { clamp01, lerp } from '../core/math/scalar.ts';

export const enum ParticleKind {
  /** Drifts on curl noise, never expires. Atmospheric dust. */
  Ambient = 0,
  /** Ballistic with drag and gravity. Landing dust, debris. */
  Ballistic = 1,
  /** Rises and expands. Steam, smoke. */
  Buoyant = 2,
  /** Fast, short-lived, fades hard. Sparks. */
  Spark = 3,
}

/**
 * Struct-of-arrays storage.
 *
 * Ten parallel typed arrays rather than an array of objects: the update loop
 * touches every particle every frame, and contiguous typed arrays keep that a
 * linear memory walk instead of chasing thousands of separate heap objects.
 */
export class ParticlePool {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly size: Float32Array;
  readonly rotation: Float32Array;
  readonly spin: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly depth: Float32Array;
  readonly kind: Uint8Array;
  /** Base colour, unpremultiplied, one float per channel. */
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly alpha: Float32Array;
  /** Per-particle phase, for twinkle and wander offsets. */
  readonly phase: Float32Array;

  /** Particles `[0, count)` are alive. */
  count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.rotation = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.depth = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.r = new Float32Array(capacity);
    this.g = new Float32Array(capacity);
    this.b = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
  }

  /**
   * Removes a particle by swapping the last live one into its slot.
   *
   * O(1) and keeps the live range contiguous, at the cost of not preserving
   * order — which does not matter for additively-blended particles.
   */
  kill(index: number): void {
    const last = this.count - 1;
    if (index !== last) {
      this.x[index] = this.x[last]!;
      this.y[index] = this.y[last]!;
      this.vx[index] = this.vx[last]!;
      this.vy[index] = this.vy[last]!;
      this.size[index] = this.size[last]!;
      this.rotation[index] = this.rotation[last]!;
      this.spin[index] = this.spin[last]!;
      this.life[index] = this.life[last]!;
      this.maxLife[index] = this.maxLife[last]!;
      this.depth[index] = this.depth[last]!;
      this.kind[index] = this.kind[last]!;
      this.r[index] = this.r[last]!;
      this.g[index] = this.g[last]!;
      this.b[index] = this.b[last]!;
      this.alpha[index] = this.alpha[last]!;
      this.phase[index] = this.phase[last]!;
    }
    this.count--;
  }
}

export interface SpawnOptions {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  size: number;
  life: number;
  depth?: number;
  kind: ParticleKind;
  r: number;
  g: number;
  b: number;
  alpha: number;
  spin?: number;
  rotation?: number;
}

/** Gravity applied to ballistic particles, lower than the player's for drift. */
const PARTICLE_GRAVITY = 11.0;
/** Per-second velocity retention for ballistic particles. */
const BALLISTIC_DRAG = 0.86;
/** Per-second velocity retention for sparks — they slow far faster. */
const SPARK_DRAG = 0.28;

export class ParticleSystem {
  readonly pool: ParticlePool;
  private readonly noise = new NoiseField(0xd057);
  private readonly rng: Rng;
  private time = 0;

  /** Global wind, in metres per second. Gusts modulate this. */
  windX = 0.55;
  windY = -0.04;

  constructor(capacity = 4000, seed = 0xfa11) {
    this.pool = new ParticlePool(capacity);
    this.rng = new Rng(seed);
  }

  get count(): number {
    return this.pool.count;
  }

  get capacity(): number {
    return this.pool.capacity;
  }

  spawn(options: SpawnOptions): number {
    const pool = this.pool;
    if (pool.count >= pool.capacity) return -1;

    const i = pool.count++;
    pool.x[i] = options.x;
    pool.y[i] = options.y;
    pool.vx[i] = options.vx ?? 0;
    pool.vy[i] = options.vy ?? 0;
    pool.size[i] = options.size;
    pool.rotation[i] = options.rotation ?? 0;
    pool.spin[i] = options.spin ?? 0;
    pool.life[i] = options.life;
    pool.maxLife[i] = options.life;
    pool.depth[i] = options.depth ?? 0;
    pool.kind[i] = options.kind;
    pool.r[i] = options.r;
    pool.g[i] = options.g;
    pool.b[i] = options.b;
    pool.alpha[i] = options.alpha;
    pool.phase[i] = this.rng.range(0, Math.PI * 2);
    return i;
  }

  /**
   * Advances every particle.
   *
   * One pass over contiguous arrays with the behaviour selected by a switch.
   * Ambient particles never expire; they wrap around the camera instead, which
   * keeps the atmospheric field effectively infinite for a fixed cost.
   */
  update(dt: number, cameraX: number, cameraY: number, viewWidth: number, viewHeight: number): void {
    this.time += dt;
    const pool = this.pool;

    // Gusts: two incommensurate sines so the wind never settles into a rhythm.
    const gust =
      1 + Math.sin(this.time * 0.37) * 0.45 + Math.sin(this.time * 0.13 + 1.7) * 0.3;
    const windX = this.windX * gust;
    const windY = this.windY * gust;

    const halfWidth = viewWidth / 2;
    const halfHeight = viewHeight / 2;
    // Wrap slightly outside the view so particles never pop into existence in
    // frame.
    const wrapWidth = viewWidth * 1.4;
    const wrapHeight = viewHeight * 1.4;

    for (let i = 0; i < pool.count; i++) {
      const kind = pool.kind[i]!;

      switch (kind) {
        case ParticleKind.Ambient: {
          // Curl noise is divergence-free, so advected particles neither bunch
          // up nor thin out — swirling but uniform, which is exactly how
          // airborne dust behaves.
          const nx = pool.x[i]! * 0.08;
          const ny = pool.y[i]! * 0.08;
          const t = this.time * 0.06;
          const curlX = this.noise.fbm2(nx, ny + t, 2);
          const curlY = this.noise.fbm2(nx + 31.7, ny - t, 2);

          // Depth scales drift, so far layers move slower and read as distant.
          const depthScale = 1 / (1 + pool.depth[i]! * 0.35);
          pool.x[i]! + 0;
          pool.x[i] = pool.x[i]! + (windX + curlX * 0.55) * depthScale * dt;
          pool.y[i] = pool.y[i]! + (windY + curlY * 0.42) * depthScale * dt;
          pool.rotation[i] = pool.rotation[i]! + pool.spin[i]! * dt;
          break;
        }

        case ParticleKind.Ballistic: {
          pool.vy[i] = pool.vy[i]! + PARTICLE_GRAVITY * dt;
          // Exponential drag, so behaviour is frame-rate independent.
          const drag = Math.pow(BALLISTIC_DRAG, dt);
          pool.vx[i] = pool.vx[i]! * drag + windX * dt * 0.6;
          pool.vy[i] = pool.vy[i]! * drag;
          pool.x[i] = pool.x[i]! + pool.vx[i]! * dt;
          pool.y[i] = pool.y[i]! + pool.vy[i]! * dt;
          pool.rotation[i] = pool.rotation[i]! + pool.spin[i]! * dt;
          pool.life[i] = pool.life[i]! - dt;
          break;
        }

        case ParticleKind.Buoyant: {
          const drag = Math.pow(0.55, dt);
          pool.vx[i] = pool.vx[i]! * drag + windX * dt * 1.4;
          pool.vy[i] = pool.vy[i]! * drag - 0.55 * dt;
          pool.x[i] = pool.x[i]! + pool.vx[i]! * dt;
          pool.y[i] = pool.y[i]! + pool.vy[i]! * dt;
          // Expanding as it rises is what reads as a dissipating puff rather
          // than a rising dot.
          pool.size[i] = pool.size[i]! * (1 + dt * 0.85);
          pool.rotation[i] = pool.rotation[i]! + pool.spin[i]! * dt;
          pool.life[i] = pool.life[i]! - dt;
          break;
        }

        case ParticleKind.Spark: {
          pool.vy[i] = pool.vy[i]! + PARTICLE_GRAVITY * 0.55 * dt;
          const drag = Math.pow(SPARK_DRAG, dt);
          pool.vx[i] = pool.vx[i]! * drag;
          pool.vy[i] = pool.vy[i]! * drag;
          pool.x[i] = pool.x[i]! + pool.vx[i]! * dt;
          pool.y[i] = pool.y[i]! + pool.vy[i]! * dt;
          // Sparks stretch along their travel, which is what makes them read
          // as streaks rather than dots.
          pool.rotation[i] = Math.atan2(pool.vy[i]!, pool.vx[i]!);
          pool.life[i] = pool.life[i]! - dt;
          break;
        }

        default: {
          const never: never = kind as never;
          throw new Error(`Unhandled particle kind: ${never}`);
        }
      }

      if (kind === ParticleKind.Ambient) {
        // Wrap around the camera, keeping the field effectively infinite.
        const dx = pool.x[i]! - cameraX;
        const dy = pool.y[i]! - cameraY;
        if (dx < -wrapWidth / 2) pool.x[i] = pool.x[i]! + wrapWidth;
        else if (dx > wrapWidth / 2) pool.x[i] = pool.x[i]! - wrapWidth;
        if (dy < -wrapHeight / 2) pool.y[i] = pool.y[i]! + wrapHeight;
        else if (dy > wrapHeight / 2) pool.y[i] = pool.y[i]! - wrapHeight;
      } else if (pool.life[i]! <= 0) {
        // Swapping the last particle into this slot means the index must be
        // re-examined rather than advanced past.
        pool.kill(i);
        i--;
      }
    }

    void halfWidth;
    void halfHeight;
  }

  /**
   * Seeds the ambient dust field.
   *
   * Depth is biased toward the near plane, where motes are large enough to
   * actually read; a uniform distribution wastes most of the budget on
   * particles too small and too dim to see.
   */
  seedAmbient(
    count: number,
    centreX: number,
    centreY: number,
    width: number,
    height: number,
    palette: { warm: [number, number, number]; cool: [number, number, number] },
  ): void {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      const depth = Math.pow(rng.next(), 1.7) * 7;
      const warmth = rng.next();
      const r = lerp(palette.cool[0], palette.warm[0], warmth);
      const g = lerp(palette.cool[1], palette.warm[1], warmth);
      const b = lerp(palette.cool[2], palette.warm[2], warmth);

      // `size` is a half-extent, so these are 8 mm to 3 cm across. The first
      // pass reused the old full-width values and rendered 22 cm motes, which
      // read unmistakably as falling snow rather than airborne dust.
      //
      // Density is biased toward the ground: suspended dust settles, and a
      // uniform field looks like weather instead of atmosphere.
      const groundBias = Math.pow(rng.next(), 0.55);

      this.spawn({
        x: centreX + rng.signed(width / 2),
        y: centreY + (groundBias - 0.25) * height,
        size: rng.range(0.013, 0.034) * (1 + (7 - depth) * 0.10),
        life: Infinity,
        depth,
        kind: ParticleKind.Ambient,
        r,
        g,
        b,
        // Individually very faint. Density, not opacity, is what makes a dust
        // field read; opaque motes turn into visible confetti.
        alpha: rng.range(0.10, 0.42) / (1 + depth * 0.40),
        spin: rng.signed(0.6),
        rotation: rng.range(0, Math.PI * 2),
      });
    }
  }

  /**
   * A burst of dust kicked up by an impact.
   *
   * Velocity spreads sideways rather than upward, because that is how dust
   * behaves when something lands on it: the impact displaces air outward along
   * the surface.
   */
  burstDust(
    x: number,
    y: number,
    strength: number,
    palette: [number, number, number],
  ): void {
    const rng = this.rng;
    const count = Math.round(6 + strength * 26);
    for (let i = 0; i < count; i++) {
      const side = rng.chance(0.5) ? 1 : -1;
      const speed = rng.range(0.6, 3.4) * (0.4 + strength);
      this.spawn({
        x: x + rng.signed(0.24),
        y: y - rng.range(0, 0.1),
        vx: side * speed,
        vy: -rng.range(0.2, 1.5) * strength,
        size: rng.range(0.03, 0.11) * (0.6 + strength),
        life: rng.range(0.5, 1.5),
        kind: ParticleKind.Buoyant,
        r: palette[0],
        g: palette[1],
        b: palette[2],
        alpha: rng.range(0.10, 0.30),
        spin: rng.signed(2.2),
      });
    }
  }

  /** A shower of sparks, for impacts and hard landings on metal. */
  burstSparks(
    x: number,
    y: number,
    directionX: number,
    directionY: number,
    strength: number,
    color: [number, number, number],
  ): void {
    const rng = this.rng;
    const count = Math.round(4 + strength * 18);
    const baseAngle = Math.atan2(directionY, directionX);
    for (let i = 0; i < count; i++) {
      // A cone around the impact normal, not a full circle: sparks fly off the
      // way the force went.
      const angle = baseAngle + rng.signed(1.05);
      const speed = rng.range(3, 13) * (0.5 + strength);
      this.spawn({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: rng.range(0.008, 0.026),
        life: rng.range(0.18, 0.5),
        kind: ParticleKind.Spark,
        r: color[0],
        g: color[1],
        b: color[2],
        alpha: 1,
      });
    }
  }

  /** Debris chips thrown from a surface. */
  burstDebris(
    x: number,
    y: number,
    strength: number,
    color: [number, number, number],
  ): void {
    const rng = this.rng;
    const count = Math.round(3 + strength * 12);
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + rng.signed(1.2);
      const speed = rng.range(1.5, 6) * (0.5 + strength);
      this.spawn({
        x: x + rng.signed(0.2),
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: rng.range(0.014, 0.042),
        life: rng.range(0.6, 1.6),
        kind: ParticleKind.Ballistic,
        r: color[0],
        g: color[1],
        b: color[2],
        alpha: rng.range(0.6, 1),
        spin: rng.signed(9),
      });
    }
  }

  /**
   * Alpha for a particle at its current age.
   *
   * Ambient particles twinkle slowly; finite-lived ones fade in quickly and out
   * gently, since a particle that pops into existence at full opacity reads as
   * a glitch.
   */
  alphaAt(index: number, time: number): number {
    const pool = this.pool;
    const base = pool.alpha[index]!;

    if (pool.kind[index] === ParticleKind.Ambient) {
      const twinkle = 0.62 + Math.sin(time * 1.9 + pool.phase[index]!) * 0.38;
      return base * twinkle;
    }

    const t = clamp01(pool.life[index]! / Math.max(pool.maxLife[index]!, 1e-5));
    // Fast attack, slow decay.
    const fadeIn = clamp01((1 - t) / 0.12);
    return base * t * t * Math.min(fadeIn, 1);
  }

  clear(): void {
    this.pool.count = 0;
  }
}
