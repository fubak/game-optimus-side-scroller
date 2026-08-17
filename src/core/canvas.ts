/**
 * Display surface.
 *
 * The game always *draws* in a fixed 480×270 world-view coordinate space — gameplay code, the HUD,
 * menus and touch layout all place things in those units, and the camera in `src/game/world.ts`
 * uses them too. That world-view size never changes.
 *
 * How those units end up on screen depends on the display's `mode`:
 *
 * - `'classic'` — the backing buffer *is* the 480×270 world view. It is blown up to the viewport by
 *   an *integer* CSS factor, which keeps the chunky pixel look crisp (no half-pixel smearing), makes
 *   fill-rate cheap, and needs no coordinate translation anywhere.
 * - `'enhanced'` — the backing buffer is sized independently of the world view (typically much
 *   larger, following the device's pixel ratio), and letterboxed into the viewport at a CSS size
 *   that can be fractional. A transform on the returned `ctx` maps the 480×270 world-view units onto
 *   that larger buffer, so every existing draw call keeps working unmodified while the on-screen
 *   result is crisp at any window size instead of being CSS-upscaled from a tiny bitmap.
 */

import { clamp } from './math';

export const INTERNAL_WIDTH = 480;
export const INTERNAL_HEIGHT = 270;

export type DisplayMode = 'classic' | 'enhanced';

/** Upper bound on the devicePixelRatio used when sizing an Enhanced backbuffer. */
export const DEFAULT_MAX_DPR = 2;
/** Absolute backbuffer size cap for Enhanced mode (4K). */
export const DEFAULT_MAX_BUFFER_WIDTH = 3840;
export const DEFAULT_MAX_BUFFER_HEIGHT = 2160;

export interface ViewportFit {
  /** CSS-pixel upscale factor applied to the world view (integer for Classic, fractional for Enhanced). */
  readonly scale: number;
  /** Displayed size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Letterbox offsets in CSS pixels, so the surface sits centred in the viewport. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Treat NaN/Infinity/negative measurements (detached hosts, exotic embeds) as zero. */
function sanitizeSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Pick the largest integer scale that still fits inside the viewport.
 *
 * Viewports smaller than the internal buffer clamp to scale 1 and are allowed to overflow
 * (the offsets go to 0) — better to crop slightly than to render a blurry fractional scale.
 *
 * Used by Classic mode, where the backing buffer must stay at the world-view size.
 */
export function computeViewportFit(
  viewportWidth: number,
  viewportHeight: number,
  internalWidth: number = INTERNAL_WIDTH,
  internalHeight: number = INTERNAL_HEIGHT,
): ViewportFit {
  const safeWidth = sanitizeSize(viewportWidth);
  const safeHeight = sanitizeSize(viewportHeight);
  const rawScale = Math.min(safeWidth / internalWidth, safeHeight / internalHeight);
  const scale = Math.max(1, Math.floor(Number.isFinite(rawScale) ? rawScale : 1));
  const width = internalWidth * scale;
  const height = internalHeight * scale;
  return {
    scale,
    width,
    height,
    offsetX: Math.max(0, Math.floor((safeWidth - width) / 2)),
    offsetY: Math.max(0, Math.floor((safeHeight - height) / 2)),
  };
}

/**
 * Fit the world view into the viewport at a *fractional* CSS scale (`object-fit: contain`), instead
 * of Classic's integer-only scale. Used by Enhanced mode, where the backing buffer is resized to
 * match rather than the CSS box being snapped to a multiple of the world view.
 */
export function computeEnhancedFit(
  viewportWidth: number,
  viewportHeight: number,
  internalWidth: number = INTERNAL_WIDTH,
  internalHeight: number = INTERNAL_HEIGHT,
): ViewportFit {
  const safeWidth = sanitizeSize(viewportWidth);
  const safeHeight = sanitizeSize(viewportHeight);
  const aspect = internalWidth / internalHeight;

  let width = safeWidth;
  let height = width / aspect;
  if (height > safeHeight) {
    height = safeHeight;
    width = height * aspect;
  }
  if (!(width > 0) || !(height > 0)) {
    // Degenerate viewport (zero/negative/NaN): fall back to the world view's own pixel size so the
    // surface is never asked to size itself to nothing.
    width = internalWidth;
    height = internalHeight;
  }

  return {
    scale: width / internalWidth,
    width,
    height,
    offsetX: Math.max(0, (safeWidth - width) / 2),
    offsetY: Math.max(0, (safeHeight - height) / 2),
  };
}

export interface EnhancedBufferSizeOptions {
  /** CSS size the buffer will be displayed at (typically {@link computeEnhancedFit}'s output). */
  readonly cssWidth: number;
  readonly cssHeight: number;
  /** The display's `devicePixelRatio`. */
  readonly devicePixelRatio?: number;
  /** Extra supersampling/undersampling on top of the device pixel ratio. */
  readonly renderScale?: number;
  /** Upper bound on the devicePixelRatio actually used, so exotic high-DPR panels don't blow the budget. */
  readonly maxDpr?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

export interface BufferSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Size an Enhanced-mode backbuffer: `min(devicePixelRatio, maxDpr) × cssSize × renderScale`,
 * uniformly downscaled if that would exceed `maxWidth`×`maxHeight` (so the aspect ratio the caller
 * asked for — normally the CSS box's own — is preserved even when capped).
 */
export function computeEnhancedBufferSize(options: EnhancedBufferSizeOptions): BufferSize {
  const {
    cssWidth,
    cssHeight,
    devicePixelRatio = 1,
    renderScale = 1,
    maxDpr = DEFAULT_MAX_DPR,
    maxWidth = DEFAULT_MAX_BUFFER_WIDTH,
    maxHeight = DEFAULT_MAX_BUFFER_HEIGHT,
  } = options;

  const safeCssWidth = sanitizeSize(cssWidth);
  const safeCssHeight = sanitizeSize(cssHeight);
  const dpr = clamp(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 0.5, Math.max(0.5, maxDpr));
  const scale = clamp(Number.isFinite(renderScale) ? renderScale : 1, 0.1, 10);

  const rawWidth = safeCssWidth * dpr * scale;
  const rawHeight = safeCssHeight * dpr * scale;

  const overflow = Math.max(rawWidth / Math.max(1, maxWidth), rawHeight / Math.max(1, maxHeight), 1);
  const width = Math.max(1, Math.round(rawWidth / overflow));
  const height = Math.max(1, Math.round(rawHeight / overflow));
  return { width, height };
}

export interface Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly mode: DisplayMode;
  /** World-view size in logical units — always {@link INTERNAL_WIDTH}×{@link INTERNAL_HEIGHT}. */
  readonly width: number;
  readonly height: number;
  /** Real backing-buffer size in device pixels (equal to `width`×`height` for Classic). */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Current fit, refreshed by {@link Display.resize}. */
  readonly fit: ViewportFit;
  /** Re-measure the host element and resize the canvas' CSS box (and, in Enhanced mode, buffer). */
  resize(): void;
  /** Convert a client-space point (e.g. pointer event) into world-view coordinates. */
  clientToBuffer(clientX: number, clientY: number): { x: number; y: number };
  dispose(): void;
}

export interface CreateDisplayOptions {
  readonly mode?: DisplayMode;
  readonly internalWidth?: number;
  readonly internalHeight?: number;
  /** Enhanced-only: backbuffer scale relative to CSS size × devicePixelRatio. */
  readonly renderScale?: number;
  /** Enhanced-only: upper bound on the devicePixelRatio used for the backbuffer. */
  readonly maxDpr?: number;
  /** Enhanced-only: absolute backbuffer size caps. */
  readonly maxWidth?: number;
  readonly maxHeight?: number;
}

function createScreenCanvas(host: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.id = 'screen';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Optimus game screen');
  host.appendChild(canvas);
  return canvas;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) {
    throw new Error('Canvas 2D context is unavailable in this browser.');
  }
  return ctx;
}

/** Classic display: the backbuffer *is* the world view, blown up by an integer CSS factor. */
class CanvasDisplay implements Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly mode: DisplayMode = 'classic';
  readonly width: number;
  readonly height: number;

  private currentFit: ViewportFit;
  private readonly host: HTMLElement;
  private readonly onWindowResize = (): void => {
    this.resize();
  };

  constructor(host: HTMLElement, options: CreateDisplayOptions) {
    this.host = host;
    this.width = options.internalWidth ?? INTERNAL_WIDTH;
    this.height = options.internalHeight ?? INTERNAL_HEIGHT;

    const canvas = createScreenCanvas(host);
    canvas.width = this.width;
    canvas.height = this.height;

    const ctx = get2dContext(canvas);
    ctx.imageSmoothingEnabled = false;

    this.canvas = canvas;
    this.ctx = ctx;
    this.currentFit = computeViewportFit(host.clientWidth, host.clientHeight, this.width, this.height);
    this.applyFit();
    window.addEventListener('resize', this.onWindowResize);
  }

  get fit(): ViewportFit {
    return this.currentFit;
  }

  get bufferWidth(): number {
    return this.width;
  }

  get bufferHeight(): number {
    return this.height;
  }

  resize(): void {
    const next = computeViewportFit(this.host.clientWidth, this.host.clientHeight, this.width, this.height);
    if (
      next.scale === this.currentFit.scale &&
      next.width === this.currentFit.width &&
      next.height === this.currentFit.height
    ) {
      this.currentFit = next;
      return;
    }
    this.currentFit = next;
    this.applyFit();
  }

  clientToBuffer(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width === 0 ? 1 : this.width / rect.width;
    const scaleY = rect.height === 0 ? 1 : this.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  dispose(): void {
    window.removeEventListener('resize', this.onWindowResize);
    this.canvas.remove();
  }

  private applyFit(): void {
    this.canvas.style.width = `${String(this.currentFit.width)}px`;
    this.canvas.style.height = `${String(this.currentFit.height)}px`;
    // Redrawing is the caller's job, but the context state must survive a CSS-only resize.
    this.ctx.imageSmoothingEnabled = false;
  }
}

/**
 * Enhanced display: the backbuffer is sized to the device, independently of the 480×270 world
 * view. A transform on `ctx` keeps every existing draw call (HUD, menus, touch layout, the Classic
 * painter used by the WebGL2 hybrid renderer) working in world-view units unmodified.
 */
class EnhancedCanvasDisplay implements Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly mode: DisplayMode = 'enhanced';
  readonly width: number;
  readonly height: number;

  private readonly host: HTMLElement;
  private readonly renderScale: number;
  private readonly maxDpr: number;
  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private currentFit: ViewportFit;
  private currentBufferWidth = 0;
  private currentBufferHeight = 0;
  private readonly onWindowResize = (): void => {
    this.resize();
  };

  constructor(host: HTMLElement, options: CreateDisplayOptions) {
    this.host = host;
    this.width = options.internalWidth ?? INTERNAL_WIDTH;
    this.height = options.internalHeight ?? INTERNAL_HEIGHT;
    this.renderScale = options.renderScale ?? 1;
    this.maxDpr = options.maxDpr ?? DEFAULT_MAX_DPR;
    this.maxWidth = options.maxWidth ?? DEFAULT_MAX_BUFFER_WIDTH;
    this.maxHeight = options.maxHeight ?? DEFAULT_MAX_BUFFER_HEIGHT;

    const canvas = createScreenCanvas(host);
    const ctx = get2dContext(canvas);

    this.canvas = canvas;
    this.ctx = ctx;
    this.currentFit = computeEnhancedFit(host.clientWidth, host.clientHeight, this.width, this.height);
    this.applyFit();
    window.addEventListener('resize', this.onWindowResize);
  }

  get fit(): ViewportFit {
    return this.currentFit;
  }

  get bufferWidth(): number {
    return this.currentBufferWidth;
  }

  get bufferHeight(): number {
    return this.currentBufferHeight;
  }

  resize(): void {
    this.currentFit = computeEnhancedFit(this.host.clientWidth, this.host.clientHeight, this.width, this.height);
    this.applyFit();
  }

  clientToBuffer(clientX: number, clientY: number): { x: number; y: number } {
    // Always resolves to *world-view* units (not raw backbuffer pixels), so touch hit-testing —
    // laid out in the same 480×270 space as everything else — keeps working unmodified.
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width === 0 ? 1 : this.width / rect.width;
    const scaleY = rect.height === 0 ? 1 : this.height / rect.height;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  }

  dispose(): void {
    window.removeEventListener('resize', this.onWindowResize);
    this.canvas.remove();
  }

  private applyFit(): void {
    this.canvas.style.width = `${String(this.currentFit.width)}px`;
    this.canvas.style.height = `${String(this.currentFit.height)}px`;

    const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const buffer = computeEnhancedBufferSize({
      cssWidth: this.currentFit.width,
      cssHeight: this.currentFit.height,
      devicePixelRatio,
      renderScale: this.renderScale,
      maxDpr: this.maxDpr,
      maxWidth: this.maxWidth,
      maxHeight: this.maxHeight,
    });

    if (buffer.width !== this.currentBufferWidth || buffer.height !== this.currentBufferHeight) {
      this.currentBufferWidth = buffer.width;
      this.currentBufferHeight = buffer.height;
      this.canvas.width = buffer.width;
      this.canvas.height = buffer.height;
    }
    // Resizing the canvas resets its 2D context state, so this must be reapplied every time —
    // including when the buffer size didn't change, since `applyFit` can run without a resize (e.g.
    // right after construction).
    this.ctx.setTransform(this.currentBufferWidth / this.width, 0, 0, this.currentBufferHeight / this.height, 0, 0);
    // The overlay (HUD text, menus) benefits from smoothing at a fractional/non-integer scale; the
    // world itself is drawn by the WebGL2 path with its own filtering, independent of this flag.
    this.ctx.imageSmoothingEnabled = true;
  }
}

export function createDisplay(host: HTMLElement, options: CreateDisplayOptions = {}): Display {
  const mode = options.mode ?? 'classic';
  switch (mode) {
    case 'classic':
      return new CanvasDisplay(host, options);
    case 'enhanced':
      return new EnhancedCanvasDisplay(host, options);
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unhandled display mode: ${String(exhaustive)}`);
    }
  }
}
