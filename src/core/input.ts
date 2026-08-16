/**
 * Input abstraction.
 *
 * Gameplay code never touches DOM events: it asks an {@link Input} whether an *action* is held or
 * was pressed this simulation step. That indirection buys three things — remappable keys, touch
 * controls that behave identically to a keyboard, and {@link ScriptedInput}, which replays a
 * frame-indexed tape so tests can play the game deterministically.
 */

export const ACTIONS = [
  'left',
  'right',
  'up',
  'down',
  'jump',
  'dash',
  'pause',
  'confirm',
  'back',
  'restart',
  'mute',
  'debug',
] as const;

export type Action = (typeof ACTIONS)[number];

export interface Input {
  /** Is the action currently held? */
  isDown(action: Action): boolean;
  /** Did the action go down during the current simulation step? */
  justPressed(action: Action): boolean;
  /** Did the action go up during the current simulation step? */
  justReleased(action: Action): boolean;
  /** Any action pressed this step — used by "press any key" screens. */
  anyJustPressed(): boolean;
  /** Called once per simulation step, after the world has read the input. */
  endFrame(): void;
}

/** Shared down/pressed/released bookkeeping for every input source. */
export abstract class InputStateBase implements Input {
  protected readonly down = new Set<Action>();
  protected readonly pressed = new Set<Action>();
  protected readonly released = new Set<Action>();

  isDown(action: Action): boolean {
    return this.down.has(action);
  }

  justPressed(action: Action): boolean {
    return this.pressed.has(action);
  }

  justReleased(action: Action): boolean {
    return this.released.has(action);
  }

  anyJustPressed(): boolean {
    return this.pressed.size > 0;
  }

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
  }

  /** Apply a state change, recording the press/release edge when the state actually flips. */
  protected setAction(action: Action, isDown: boolean): void {
    if (isDown) {
      if (this.down.has(action)) return;
      this.down.add(action);
      this.pressed.add(action);
    } else {
      if (!this.down.has(action)) return;
      this.down.delete(action);
      this.released.add(action);
    }
  }

  /** Release everything — used when the window loses focus so keys do not stick. */
  protected releaseAll(): void {
    for (const action of [...this.down]) {
      this.setAction(action, false);
    }
  }
}

export type KeyBindings = Readonly<Record<string, readonly Action[]>>;

export const DEFAULT_BINDINGS: KeyBindings = {
  ArrowLeft: ['left'],
  KeyA: ['left'],
  ArrowRight: ['right'],
  KeyD: ['right'],
  ArrowUp: ['up'],
  KeyW: ['up'],
  ArrowDown: ['down'],
  KeyS: ['down'],
  Space: ['jump'],
  KeyK: ['jump'],
  ShiftLeft: ['dash'],
  ShiftRight: ['dash'],
  KeyJ: ['dash'],
  Escape: ['pause', 'back'],
  KeyP: ['pause'],
  Enter: ['confirm'],
  NumpadEnter: ['confirm'],
  KeyR: ['restart'],
  KeyM: ['mute'],
  F3: ['debug'],
};

/**
 * Alternative layout for players who find space/shift awkward: everything sits on the left hand,
 * arrows or WASD for movement, Z to jump, X to dash.
 */
export const ALT_BINDINGS: KeyBindings = {
  ArrowLeft: ['left'],
  KeyA: ['left'],
  ArrowRight: ['right'],
  KeyD: ['right'],
  ArrowUp: ['up'],
  KeyW: ['up'],
  ArrowDown: ['down'],
  KeyS: ['down'],
  KeyZ: ['jump', 'confirm'],
  KeyX: ['dash'],
  KeyC: ['jump'],
  Space: ['jump'],
  Escape: ['pause', 'back'],
  Enter: ['confirm'],
  KeyR: ['restart'],
  KeyM: ['mute'],
  F3: ['debug'],
};

/** Keys whose default browser behaviour (scrolling, search) would ruin gameplay. */
const SWALLOWED_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'Enter',
  'F3',
  'Tab',
]);

export class KeyboardInput extends InputStateBase {
  private bindings: KeyBindings;
  private readonly target: EventTarget;

  private readonly onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.metaKey || keyboardEvent.ctrlKey || keyboardEvent.altKey) return;
    const actions = this.bindings[keyboardEvent.code];
    if (actions === undefined) return;
    if (SWALLOWED_KEYS.has(keyboardEvent.code)) {
      event.preventDefault();
    }
    if (keyboardEvent.repeat) return;
    for (const action of actions) {
      this.setAction(action, true);
    }
  };

  private readonly onKeyUp = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    const actions = this.bindings[keyboardEvent.code];
    if (actions === undefined) return;
    if (SWALLOWED_KEYS.has(keyboardEvent.code)) {
      event.preventDefault();
    }
    for (const action of actions) {
      this.setAction(action, false);
    }
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  constructor(target: EventTarget = window, bindings: KeyBindings = DEFAULT_BINDINGS) {
    super();
    this.target = target;
    this.bindings = bindings;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  getBindings(): KeyBindings {
    return this.bindings;
  }

  setBindings(bindings: KeyBindings): void {
    this.releaseAll();
    this.bindings = bindings;
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }
}

/** One state change in a recorded/authored input tape. */
export interface TapeEntry {
  readonly frame: number;
  readonly action: Action;
  readonly down: boolean;
}

/** "Hold `action` for `duration` frames starting at `start`." */
export interface TapeSpan {
  readonly action: Action;
  readonly start: number;
  readonly duration?: number;
}

/** Compile human-readable spans into a sorted tape. */
export function buildTape(spans: readonly TapeSpan[]): TapeEntry[] {
  const entries: TapeEntry[] = [];
  for (const span of spans) {
    const duration = Math.max(1, span.duration ?? 1);
    entries.push({ frame: span.start, action: span.action, down: true });
    entries.push({ frame: span.start + duration, action: span.action, down: false });
  }
  entries.sort((a, b) => a.frame - b.frame);
  return entries;
}

/**
 * Deterministic input source driven by a tape.
 *
 * Frame 0 entries apply immediately on construction; each {@link ScriptedInput.endFrame} advances to
 * the next frame and applies its entries, so `justPressed` edges land on exactly the intended step.
 */
export class ScriptedInput extends InputStateBase {
  private readonly byFrame = new Map<number, TapeEntry[]>();
  private readonly lastFrame: number;
  private frameIndex = 0;

  constructor(entries: readonly TapeEntry[]) {
    super();
    let lastFrame = 0;
    for (const entry of entries) {
      const existing = this.byFrame.get(entry.frame);
      if (existing === undefined) {
        this.byFrame.set(entry.frame, [entry]);
      } else {
        existing.push(entry);
      }
      lastFrame = Math.max(lastFrame, entry.frame);
    }
    this.lastFrame = lastFrame;
    this.applyFrame(0);
  }

  get frame(): number {
    return this.frameIndex;
  }

  /** Last frame that has any entry — handy for sizing a test run. */
  get length(): number {
    return this.lastFrame;
  }

  override endFrame(): void {
    super.endFrame();
    this.frameIndex += 1;
    this.applyFrame(this.frameIndex);
  }

  private applyFrame(frame: number): void {
    const entries = this.byFrame.get(frame);
    if (entries === undefined) return;
    for (const entry of entries) {
      this.setAction(entry.action, entry.down);
    }
  }
}

/** Combines several sources (keyboard + touch) by OR-ing their states. */
export class CompositeInput implements Input {
  private readonly sources: readonly Input[];

  constructor(sources: readonly Input[]) {
    this.sources = sources;
  }

  isDown(action: Action): boolean {
    return this.sources.some((source) => source.isDown(action));
  }

  justPressed(action: Action): boolean {
    return this.sources.some((source) => source.justPressed(action));
  }

  justReleased(action: Action): boolean {
    // A release only counts when no other source still holds the action.
    return this.sources.some((source) => source.justReleased(action)) && !this.isDown(action);
  }

  anyJustPressed(): boolean {
    return this.sources.some((source) => source.anyJustPressed());
  }

  endFrame(): void {
    for (const source of this.sources) {
      source.endFrame();
    }
  }
}

/** Input source that is never pressed — used for cutscenes and headless rendering. */
export class NullInput extends InputStateBase {}
