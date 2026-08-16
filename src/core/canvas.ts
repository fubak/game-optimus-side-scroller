/**
 * Low-resolution display surface.
 *
 * The game always draws into a fixed 480x270 pixel buffer and the buffer is blown up to the
 * viewport by an *integer* factor. That keeps the chunky pixel look crisp (no half-pixel
 * smearing), makes fill-rate cheap, and means gameplay code never has to care about the real
 * window size.
 */

export const INTERNAL_WIDTH = 480;
export const INTERNAL_HEIGHT = 270;

export interface ViewportFit {
  /** Integer upscale factor applied to the internal buffer (always >= 1). */
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

export interface Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /** Current fit, refreshed by {@link Display.resize}. */
  readonly fit: ViewportFit;
  /** Re-measure the host element and resize the canvas' CSS box. */
  resize(): void;
  /** Convert a client-space point (e.g. pointer event) into internal buffer coordinates. */
  clientToBuffer(clientX: number, clientY: number): { x: number; y: number };
  dispose(): void;
}

export interface CreateDisplayOptions {
  readonly internalWidth?: number;
  readonly internalHeight?: number;
}

class CanvasDisplay implements Display {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
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

    const canvas = document.createElement('canvas');
    canvas.id = 'screen';
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Optimus game screen');
    host.appendChild(canvas);

    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) {
      throw new Error('Canvas 2D context is unavailable in this browser.');
    }
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

export function createDisplay(host: HTMLElement, options: CreateDisplayOptions = {}): Display {
  return new CanvasDisplay(host, options);
}
