import { clamp, rectCenterX, rectCenterY, smoothingFactor } from '../core/math';
import type { Rect } from '../core/math';
import type { Rng } from '../core/rng';
import type { TileMap } from './tilemap';

/**
 * Follow camera with a deadzone, look-ahead and decaying screen shake.
 *
 * The deadzone means small hops and jitter do not drag the view around; look-ahead biases the view
 * in the direction of travel so the player sees what they are running into. Shake is driven by the
 * world RNG, so it is reproducible in tests and replays.
 */

export interface CameraOptions {
  /** Half-size of the box the target may move inside before the camera reacts. */
  readonly deadzoneWidth?: number;
  readonly deadzoneHeight?: number;
  /** Horizontal bias, in px, applied at full run speed. */
  readonly lookAhead?: number;
  /** Speed treated as "full run" for look-ahead scaling. */
  readonly lookAheadSpeed?: number;
  /** Time for the camera to close half the distance to its target. */
  readonly followHalfLifeSec?: number;
  /** Fraction of shake remaining after one second. */
  readonly shakeHalfLifeSec?: number;
  /** View is biased slightly upward so there is more room to see ahead/below. */
  readonly verticalBias?: number;
}

const DEFAULTS = {
  deadzoneWidth: 48,
  deadzoneHeight: 32,
  lookAhead: 42,
  lookAheadSpeed: 150,
  followHalfLifeSec: 0.09,
  shakeHalfLifeSec: 0.12,
  verticalBias: 12,
} as const;

export class Camera {
  readonly viewWidth: number;
  readonly viewHeight: number;

  /** Top-left of the view in world space, before shake. */
  x = 0;
  y = 0;

  private readonly options: Required<CameraOptions>;
  private centerX = 0;
  private centerY = 0;
  private lookAheadOffset = 0;
  private shakeAmount = 0;
  private shakeX = 0;
  private shakeY = 0;

  constructor(viewWidth: number, viewHeight: number, options: CameraOptions = {}) {
    this.viewWidth = viewWidth;
    this.viewHeight = viewHeight;
    this.options = { ...DEFAULTS, ...options };
  }

  /** Rounded render offsets, including shake. Integers keep the pixel grid crisp. */
  get renderX(): number {
    return Math.round(this.x + this.shakeX);
  }

  get renderY(): number {
    return Math.round(this.y + this.shakeY);
  }

  get shake(): number {
    return this.shakeAmount;
  }

  /** Jump straight to the target (level start, respawn, teleports). */
  snapTo(target: Rect, map: TileMap): void {
    this.centerX = rectCenterX(target);
    this.centerY = rectCenterY(target) - this.options.verticalBias;
    this.lookAheadOffset = 0;
    this.shakeAmount = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.applyBounds(map);
  }

  addShake(amount: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  update(dtSec: number, target: Rect, targetVx: number, map: TileMap, rng: Rng): void {
    const { deadzoneWidth, deadzoneHeight, lookAhead, lookAheadSpeed, followHalfLifeSec } = this.options;

    // Look-ahead easing: ramp with speed instead of snapping when the player turns around.
    const desiredLookAhead = clamp(targetVx / lookAheadSpeed, -1, 1) * lookAhead;
    this.lookAheadOffset += (desiredLookAhead - this.lookAheadOffset) * smoothingFactor(0.25, dtSec);

    const targetX = rectCenterX(target) + this.lookAheadOffset;
    const targetY = rectCenterY(target) - this.options.verticalBias;

    const halfDeadzoneX = deadzoneWidth / 2;
    const halfDeadzoneY = deadzoneHeight / 2;

    let desiredCenterX = this.centerX;
    const dx = targetX - this.centerX;
    if (Math.abs(dx) > halfDeadzoneX) {
      desiredCenterX = targetX - Math.sign(dx) * halfDeadzoneX;
    }

    let desiredCenterY = this.centerY;
    const dy = targetY - this.centerY;
    if (Math.abs(dy) > halfDeadzoneY) {
      desiredCenterY = targetY - Math.sign(dy) * halfDeadzoneY;
    }

    const follow = smoothingFactor(followHalfLifeSec, dtSec);
    this.centerX += (desiredCenterX - this.centerX) * follow;
    this.centerY += (desiredCenterY - this.centerY) * follow;

    this.updateShake(dtSec, rng);
    this.applyBounds(map);
  }

  private updateShake(dtSec: number, rng: Rng): void {
    if (this.shakeAmount <= 0.01) {
      this.shakeAmount = 0;
      this.shakeX = 0;
      this.shakeY = 0;
      return;
    }
    this.shakeX = rng.signedRange(this.shakeAmount);
    this.shakeY = rng.signedRange(this.shakeAmount);
    this.shakeAmount *= Math.pow(0.5, dtSec / this.options.shakeHalfLifeSec);
  }

  /** Clamp the view into the level; levels smaller than the view are centred instead. */
  private applyBounds(map: TileMap): void {
    const rawX = this.centerX - this.viewWidth / 2;
    const rawY = this.centerY - this.viewHeight / 2;
    this.x =
      map.pixelWidth <= this.viewWidth
        ? (map.pixelWidth - this.viewWidth) / 2
        : clamp(rawX, 0, map.pixelWidth - this.viewWidth);
    this.y =
      map.pixelHeight <= this.viewHeight
        ? (map.pixelHeight - this.viewHeight) / 2
        : clamp(rawY, 0, map.pixelHeight - this.viewHeight);
  }
}
