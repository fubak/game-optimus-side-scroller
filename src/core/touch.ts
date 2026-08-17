import { InputStateBase } from './input';
import type { Action } from './input';

/**
 * On-screen touch controls.
 *
 * Laid out in *internal buffer* coordinates (480×270) and hit-tested after mapping the pointer back
 * through the canvas scale, so the buttons line up exactly with what is drawn no matter the window
 * size. Multi-touch is tracked per pointer id, which is what makes "hold left + tap jump" work.
 *
 * Only shown when the device actually has a coarse pointer — desktop players get their keyboard and
 * an unobstructed screen.
 */

export interface TouchButton {
  readonly action: Action;
  readonly label: string;
  /** Hit area in internal buffer pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Round buttons are drawn as circles; the d-pad halves are drawn as rounded rectangles. */
  readonly round: boolean;
}

export interface TouchLayoutOptions {
  readonly viewWidth: number;
  readonly viewHeight: number;
}

/** Build the button layout for a given view size. */
export function createTouchLayout(options: TouchLayoutOptions): TouchButton[] {
  const { viewWidth, viewHeight } = options;
  const pad = 8;
  const size = 34;
  const bottom = viewHeight - pad - size;
  return [
    { action: 'left', label: '←', x: pad, y: bottom, width: size, height: size, round: false },
    { action: 'right', label: '→', x: pad + size + 6, y: bottom, width: size, height: size, round: false },
    {
      action: 'jump',
      label: 'JUMP',
      x: viewWidth - pad - size,
      y: bottom,
      width: size,
      height: size,
      round: true,
    },
    {
      action: 'dash',
      label: 'DASH',
      x: viewWidth - pad - size * 2 - 6,
      y: bottom + 6,
      width: size,
      height: size - 6,
      round: true,
    },
    {
      action: 'down',
      label: '↓',
      x: pad + size / 2 + 3,
      y: bottom - size - 4,
      width: size,
      height: size - 8,
      round: false,
    },
    { action: 'pause', label: 'II', x: viewWidth / 2 - 10, y: pad, width: 20, height: 16, round: false },
    // A generic confirm tap target for menus: the whole middle of the screen.
    {
      action: 'confirm',
      label: '',
      x: viewWidth * 0.25,
      y: viewHeight * 0.25,
      width: viewWidth * 0.5,
      height: viewHeight * 0.4,
      round: false,
    },
  ];
}

function hits(button: TouchButton, x: number, y: number): boolean {
  if (button.round) {
    const cx = button.x + button.width / 2;
    const cy = button.y + button.height / 2;
    const radius = Math.max(button.width, button.height) / 2 + 4;
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius;
  }
  // Rectangles get a few pixels of slop: fingers are not precise.
  return (
    x >= button.x - 4 &&
    x <= button.x + button.width + 4 &&
    y >= button.y - 4 &&
    y <= button.y + button.height + 4
  );
}

/** Which button (if any) is under a point in internal buffer coordinates. */
export function buttonAt(buttons: readonly TouchButton[], x: number, y: number): TouchButton | null {
  // Iterate in order so the small controls win over the big "confirm anywhere" region.
  for (const button of buttons) {
    if (button.action === 'confirm') continue;
    if (hits(button, x, y)) return button;
  }
  const fallback = buttons.find((button) => button.action === 'confirm');
  if (fallback !== undefined && hits(fallback, x, y)) return fallback;
  return null;
}

export interface TouchInputOptions {
  readonly buttons: readonly TouchButton[];
  /** Convert a client-space point into internal buffer coordinates. */
  readonly toBuffer: (clientX: number, clientY: number) => { x: number; y: number };
}

/** Input source backed by on-screen buttons. */
export class TouchInput extends InputStateBase {
  private readonly buttons: readonly TouchButton[];
  private readonly toBuffer: TouchInputOptions['toBuffer'];
  /** Pointer id → action currently held by that finger. */
  private readonly pointers = new Map<number, Action>();

  constructor(options: TouchInputOptions) {
    super();
    this.buttons = options.buttons;
    this.toBuffer = options.toBuffer;
  }

  get activeActions(): readonly Action[] {
    return [...this.pointers.values()];
  }

  pointerDown(pointerId: number, clientX: number, clientY: number): boolean {
    const point = this.toBuffer(clientX, clientY);
    const button = buttonAt(this.buttons, point.x, point.y);
    if (button === null) return false;
    this.pointers.set(pointerId, button.action);
    this.setAction(button.action, true);
    return true;
  }

  pointerMove(pointerId: number, clientX: number, clientY: number): void {
    if (!this.pointers.has(pointerId)) return;
    const point = this.toBuffer(clientX, clientY);
    const button = buttonAt(this.buttons, point.x, point.y);
    const previous = this.pointers.get(pointerId);
    const next = button?.action ?? null;
    if (previous === next) return;
    // Sliding a finger off a button releases it (unless another finger holds the same action).
    if (previous !== undefined) this.releaseIfUnheld(previous, pointerId);
    if (next === null) {
      this.pointers.delete(pointerId);
      return;
    }
    this.pointers.set(pointerId, next);
    this.setAction(next, true);
  }

  pointerUp(pointerId: number): void {
    const action = this.pointers.get(pointerId);
    if (action === undefined) return;
    this.pointers.delete(pointerId);
    this.releaseIfUnheld(action, pointerId);
  }

  /** Release everything (window blur, gesture cancel). */
  releaseAllPointers(): void {
    for (const action of new Set(this.pointers.values())) {
      this.setAction(action, false);
    }
    this.pointers.clear();
  }

  private releaseIfUnheld(action: Action, ignorePointerId: number): void {
    for (const [pointerId, held] of this.pointers) {
      if (pointerId !== ignorePointerId && held === action) return;
    }
    this.setAction(action, false);
  }
}

/**
 * Does this device want on-screen controls?
 *
 * Both a coarse/hoverless pointer *and* real touch points are required: laptops with touchscreens
 * still report a fine pointer and should keep the keyboard, while a phone reports both.
 * (The types claim `matchMedia`/`maxTouchPoints` always exist; older embedded webviews disagree,
 * hence the defensive reads.)
 */
export function prefersTouchControls(): boolean {
  if (typeof window === 'undefined') return false;
  const matches = (media: string): boolean => {
    const query = (window as { matchMedia?: (query: string) => MediaQueryList }).matchMedia;
    return query === undefined ? false : window.matchMedia(media).matches;
  };
  const touchPoints = (navigator as { maxTouchPoints?: number }).maxTouchPoints ?? 0;
  return (matches('(pointer: coarse)') || matches('(hover: none)')) && touchPoints > 0;
}
