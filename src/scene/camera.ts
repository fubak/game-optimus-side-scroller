/**
 * The 2D camera.
 *
 * Responsibilities beyond the obvious view matrix:
 *
 * - **Look-ahead.** The camera leads the player in the direction they are
 *   travelling, so a runner sees where they are going rather than where they
 *   have been. The lead is velocity-driven and smoothed, not snapped.
 * - **Trauma-based shake.** Shake magnitude is stored as "trauma" that decays
 *   quadratically and is *squared* when applied. That produces a violent onset
 *   that tails off smoothly, whereas linear decay reads as a mechanical buzz.
 * - **Pixel snapping.** The final translation is quantised to whole device
 *   pixels, which stops sub-pixel crawl on high-contrast edges during slow pans.
 */

import { NoiseField } from '../core/math/noise.ts';
import { clamp, damp, lerp } from '../core/math/scalar.ts';
import { PIXELS_PER_METRE, REFERENCE_HEIGHT } from '../core/config.ts';

const shakeNoise = new NoiseField(0xca77);

export interface CameraBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Camera {
  /** Centre of the view, in metres. */
  x = 0;
  y = 0;

  /**
   * Zoom expressed as visible world height in metres. Larger means further out.
   * The reference framing shows 11.25 m, roughly six and a half Optimus heights.
   */
  viewHeightMetres = REFERENCE_HEIGHT / PIXELS_PER_METRE;

  /** Viewport size in device pixels. */
  viewportWidth = 1920;
  viewportHeight = 1080;

  rotation = 0;

  /** Accumulated shake energy in [0, 1]. */
  private trauma = 0;
  private traumaTime = 0;

  /** Smoothed look-ahead offset. */
  private leadX = 0;
  private leadY = 0;

  /** Current shake displacement, exposed so parallax can react to it. */
  shakeX = 0;
  shakeY = 0;
  shakeRotation = 0;

  private bounds: CameraBounds | null = null;

  /** Column-major 3x3 view-projection matrix uploaded to shaders. */
  readonly viewProjection = new Float32Array(9);

  get aspect(): number {
    return this.viewportWidth / this.viewportHeight;
  }

  get viewWidthMetres(): number {
    return this.viewHeightMetres * this.aspect;
  }

  /** Effective pixels per metre at the current zoom. */
  get pixelsPerMetre(): number {
    return this.viewportHeight / this.viewHeightMetres;
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
  }

  setBounds(bounds: CameraBounds | null): void {
    this.bounds = bounds;
  }

  /**
   * Add shake energy.
   *
   * Callers pass the *severity* of an event (a light hit might be 0.2, a boss
   * slam 0.9) and the camera works out the rest. Trauma accumulates so
   * overlapping events compound, but is clamped so a chaotic fight cannot shake
   * the screen into uselessness.
   */
  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  /**
   * Follow a target.
   *
   * @param targetX  Focus position in metres.
   * @param targetY  Focus position in metres.
   * @param velocityX Target's horizontal velocity, for look-ahead.
   * @param velocityY Target's vertical velocity, for look-ahead.
   * @param dt        Seconds since the last update.
   */
  follow(
    targetX: number,
    targetY: number,
    velocityX: number,
    velocityY: number,
    dt: number,
    options: {
      leadScale?: number;
      leadMax?: number;
      horizontalHalfLife?: number;
      verticalHalfLife?: number;
    } = {},
  ): void {
    const leadScale = options.leadScale ?? 0.34;
    const leadMax = options.leadMax ?? 3.2;
    // Vertical smoothing is deliberately slower than horizontal. Matching them
    // makes the camera bob distractingly on every small jump.
    const horizontalHalfLife = options.horizontalHalfLife ?? 0.16;
    const verticalHalfLife = options.verticalHalfLife ?? 0.28;

    const desiredLeadX = clamp(velocityX * leadScale, -leadMax, leadMax);
    const desiredLeadY = clamp(velocityY * leadScale * 0.4, -leadMax * 0.5, leadMax * 0.5);

    this.leadX = damp(this.leadX, desiredLeadX, 0.32, dt);
    this.leadY = damp(this.leadY, desiredLeadY, 0.42, dt);

    this.x = damp(this.x, targetX + this.leadX, horizontalHalfLife, dt);
    this.y = damp(this.y, targetY + this.leadY, verticalHalfLife, dt);

    this.applyBounds();
  }

  /** Jump straight to a position, cancelling smoothing and look-ahead. */
  snapTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.leadX = 0;
    this.leadY = 0;
    this.applyBounds();
  }

  private applyBounds(): void {
    const bounds = this.bounds;
    if (!bounds) return;

    const halfWidth = this.viewWidthMetres / 2;
    const halfHeight = this.viewHeightMetres / 2;

    // When a room is smaller than the view, centre on it rather than clamping
    // to one edge — otherwise the camera pins to a corner and looks broken.
    if (bounds.maxX - bounds.minX <= halfWidth * 2) {
      this.x = (bounds.minX + bounds.maxX) / 2;
    } else {
      this.x = clamp(this.x, bounds.minX + halfWidth, bounds.maxX - halfWidth);
    }

    if (bounds.maxY - bounds.minY <= halfHeight * 2) {
      this.y = (bounds.minY + bounds.maxY) / 2;
    } else {
      this.y = clamp(this.y, bounds.minY + halfHeight, bounds.maxY - halfHeight);
    }
  }

  /**
   * Advance shake and rebuild the view-projection matrix.
   *
   * Called once per rendered frame, after `follow`.
   */
  update(dt: number): void {
    this.traumaTime += dt;

    if (this.trauma > 0) {
      // Squaring makes small trauma almost invisible and large trauma violent,
      // which matches how impacts should feel across a wide damage range.
      const magnitude = this.trauma * this.trauma;
      const frequency = 18;
      const t = this.traumaTime * frequency;

      // Three decorrelated noise rows so the axes never move in lockstep.
      const maxOffset = 0.42 * magnitude;
      this.shakeX = shakeNoise.noise2(t, 0) * maxOffset;
      this.shakeY = shakeNoise.noise2(t, 37.7) * maxOffset;
      this.shakeRotation = shakeNoise.noise2(t, 91.3) * 0.035 * magnitude;

      // Decay over roughly 0.6 s at full trauma.
      this.trauma = Math.max(0, this.trauma - dt * 1.7);
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeRotation = 0;
    }

    this.rebuildMatrix();
  }

  private rebuildMatrix(): void {
    const halfHeight = this.viewHeightMetres / 2;
    const halfWidth = halfHeight * this.aspect;

    let cx = this.x + this.shakeX;
    let cy = this.y + this.shakeY;

    // Quantise to whole device pixels. Sub-pixel camera positions make
    // high-contrast edges shimmer during slow pans, which is very visible in
    // the dark, high-contrast scenes this game is built around.
    const ppm = this.pixelsPerMetre;
    cx = Math.round(cx * ppm) / ppm;
    cy = Math.round(cy * ppm) / ppm;

    const angle = this.rotation + this.shakeRotation;
    const c = Math.cos(angle);
    const s = Math.sin(angle);

    // Scale world metres into clip space. Y is negated because world +Y points
    // down (screen convention) while clip +Y points up.
    const sx = 1 / halfWidth;
    const sy = -1 / halfHeight;

    // Column-major: [m00 m01 m02, m10 m11 m12, m20 m21 m22] laid out as columns.
    const m = this.viewProjection;
    m[0] = c * sx;
    m[1] = s * sy;
    m[2] = 0;
    m[3] = -s * sx;
    m[4] = c * sy;
    m[5] = 0;
    m[6] = (-cx * c + cy * s) * sx;
    m[7] = (-cx * s - cy * c) * sy;
    m[8] = 1;
  }

  /** Convert a world position to normalised screen coordinates in [0, 1]. */
  worldToScreen(worldX: number, worldY: number, out: { x: number; y: number }): void {
    const m = this.viewProjection;
    const clipX = m[0]! * worldX + m[3]! * worldY + m[6]!;
    const clipY = m[1]! * worldX + m[4]! * worldY + m[7]!;
    out.x = clipX * 0.5 + 0.5;
    out.y = clipY * 0.5 + 0.5;
  }

  /** Convert normalised screen coordinates in [0, 1] to a world position. */
  screenToWorld(screenX: number, screenY: number, out: { x: number; y: number }): void {
    const halfHeight = this.viewHeightMetres / 2;
    const halfWidth = halfHeight * this.aspect;
    const localX = (screenX * 2 - 1) * halfWidth;
    const localY = -(screenY * 2 - 1) * halfHeight;
    const angle = this.rotation + this.shakeRotation;
    const c = Math.cos(-angle);
    const s = Math.sin(-angle);
    out.x = this.x + this.shakeX + localX * c - localY * s;
    out.y = this.y + this.shakeY + localX * s + localY * c;
  }

  /** Visible world rectangle, expanded by `margin` metres, for culling. */
  getVisibleBounds(margin = 0): CameraBounds {
    const halfHeight = this.viewHeightMetres / 2 + margin;
    const halfWidth = (this.viewHeightMetres * this.aspect) / 2 + margin;
    return {
      minX: this.x - halfWidth,
      minY: this.y - halfHeight,
      maxX: this.x + halfWidth,
      maxY: this.y + halfHeight,
    };
  }

  /** Smoothly change zoom. */
  setZoom(viewHeightMetres: number, dt: number, halfLife = 0.35): void {
    this.viewHeightMetres = damp(this.viewHeightMetres, viewHeightMetres, halfLife, dt);
  }

  /**
   * Parallax offset for a layer at the given depth.
   *
   * Depth 0 is the playfield and tracks the camera exactly. Larger depths move
   * progressively less, so distant layers drift slowly — the core illusion the
   * multi-layer backgrounds depend on.
   */
  parallaxFactor(depth: number): number {
    // Foreground layers sit at negative depth and must scroll *faster* than the
    // playfield, which is what makes them read as being in front of it.
    // Clamping negative depths to 1 made them track the playfield exactly, so
    // they looked pasted onto it rather than nearer the viewer.
    if (depth < 0) return 1 + -depth * 0.28;
    // A reciprocal falloff matches real perspective far better than a linear
    // ramp, which makes distant layers slide unnaturally fast.
    return 1 / (1 + depth * 0.55);
  }

  /** Blend toward another camera state, for cinematic hand-offs. */
  blendTo(targetX: number, targetY: number, targetZoom: number, t: number): void {
    this.x = lerp(this.x, targetX, t);
    this.y = lerp(this.y, targetY, t);
    this.viewHeightMetres = lerp(this.viewHeightMetres, targetZoom, t);
  }
}
