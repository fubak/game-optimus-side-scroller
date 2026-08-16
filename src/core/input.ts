/**
 * Input handling: keyboard, gamepad, and a scripted tape source for the
 * capture harness.
 *
 * Two ideas here do most of the work for game feel:
 *
 * **Buffering.** A player who presses jump 80 ms before landing means to jump.
 * If the game samples input only on the frame it happens, that press is thrown
 * away and the game feels unresponsive in exactly the moments that matter most.
 * Every action therefore records *when* it was last pressed, and gameplay code
 * asks "was this pressed within the last N seconds" rather than "was this
 * pressed this instant".
 *
 * **Edge detection against the fixed step.** The simulation runs at 120 Hz but
 * browser events arrive whenever they like. Presses and releases are latched as
 * they arrive and consumed by the simulation, so a press-and-release inside a
 * single frame can never be missed.
 */

import { applyDeadzone } from './math/scalar.ts';

export const enum Action {
  Left,
  Right,
  Up,
  Down,
  Jump,
  Dash,
  Attack,
  Ranged,
  Parry,
  Interact,
  Map,
  Pause,
  /** Debug-only: toggles the performance overlay. */
  DebugOverlay,
}

export const ACTION_COUNT = 13;

/** Default keyboard bindings. Multiple keys may map to one action. */
const DEFAULT_KEY_BINDINGS: Record<string, Action> = {
  ArrowLeft: Action.Left,
  KeyA: Action.Left,
  ArrowRight: Action.Right,
  KeyD: Action.Right,
  ArrowUp: Action.Up,
  KeyW: Action.Up,
  ArrowDown: Action.Down,
  KeyS: Action.Down,
  Space: Action.Jump,
  KeyK: Action.Jump,
  ShiftLeft: Action.Dash,
  ShiftRight: Action.Dash,
  KeyL: Action.Dash,
  KeyJ: Action.Attack,
  KeyZ: Action.Attack,
  KeyU: Action.Ranged,
  KeyX: Action.Ranged,
  KeyI: Action.Parry,
  KeyC: Action.Parry,
  KeyE: Action.Interact,
  Tab: Action.Map,
  Escape: Action.Pause,
  F3: Action.DebugOverlay,
};

/** Standard-gamepad button indices mapped to actions. */
const DEFAULT_PAD_BINDINGS: Record<number, Action> = {
  0: Action.Jump, // A / cross
  2: Action.Attack, // X / square
  3: Action.Ranged, // Y / triangle
  1: Action.Interact, // B / circle
  4: Action.Parry, // left bumper
  5: Action.Dash, // right bumper
  7: Action.Dash, // right trigger
  8: Action.Map, // select
  9: Action.Pause, // start
  12: Action.Up,
  13: Action.Down,
  14: Action.Left,
  15: Action.Right,
};

/** Below this, a stick is considered centred. */
const STICK_DEADZONE = 0.28;
/** Past this, a stick counts as a digital direction press. */
const STICK_DIGITAL_THRESHOLD = 0.55;

export interface InputSnapshot {
  /** Analogue movement axis in [-1, 1]; digital input reads as exactly +/-1. */
  moveX: number;
  moveY: number;
  /** Whether each action is currently held. */
  held: boolean[];
  /** Whether each action started being held during the current step. */
  pressed: boolean[];
  /** Whether each action stopped being held during the current step. */
  released: boolean[];
}

export class Input {
  /** Currently-held state per action. */
  private readonly held = new Array<boolean>(ACTION_COUNT).fill(false);
  /** Latched presses awaiting consumption by the next simulation step. */
  private readonly pressedLatch = new Array<boolean>(ACTION_COUNT).fill(false);
  private readonly releasedLatch = new Array<boolean>(ACTION_COUNT).fill(false);
  /** Presses/releases visible to the current simulation step. */
  private readonly pressed = new Array<boolean>(ACTION_COUNT).fill(false);
  private readonly released = new Array<boolean>(ACTION_COUNT).fill(false);
  /** Timestamp of the most recent press, for buffered-input queries. */
  private readonly lastPressTime = new Array<number>(ACTION_COUNT).fill(-Infinity);
  /** Presses already acted upon, so one press cannot trigger two jumps. */
  private readonly consumedPress = new Array<boolean>(ACTION_COUNT).fill(false);

  private keyBindings: Record<string, Action> = { ...DEFAULT_KEY_BINDINGS };
  private padBindings: Record<number, Action> = { ...DEFAULT_PAD_BINDINGS };

  moveX = 0;
  moveY = 0;

  /** Set while a gamepad is producing input, so the UI can swap glyph sets. */
  usingGamepad = false;

  private time = 0;
  private attached = false;
  private padIndex: number | null = null;
  /** Debounce for gamepad buttons, which report state rather than events. */
  private readonly padButtonWasDown = new Array<boolean>(20).fill(false);

  /**
   * When set, all hardware input is ignored and this function supplies state
   * instead. The capture harness uses it to replay a scripted input tape.
   */
  private tape: ((timeSeconds: number) => Partial<InputSnapshot>) | null = null;

  attach(target: EventTarget = window): void {
    if (this.attached) return;
    this.attached = true;
    target.addEventListener('keydown', this.onKeyDown as EventListener);
    target.addEventListener('keyup', this.onKeyUp as EventListener);
    // A lost focus must release everything, or the player returns to the tab
    // still "holding" a direction they let go of long ago.
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
  }

  detach(target: EventTarget = window): void {
    if (!this.attached) return;
    this.attached = false;
    target.removeEventListener('keydown', this.onKeyDown as EventListener);
    target.removeEventListener('keyup', this.onKeyUp as EventListener);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.onGamepadConnected as EventListener);
    window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected as EventListener);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const action = this.keyBindings[event.code];
    if (action === undefined) return;
    // Stop the browser scrolling the page or moving focus out of the canvas.
    event.preventDefault();
    if (event.repeat) return;
    this.usingGamepad = false;
    this.setHeld(action, true);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const action = this.keyBindings[event.code];
    if (action === undefined) return;
    event.preventDefault();
    this.setHeld(action, false);
  };

  private readonly onBlur = (): void => {
    for (let i = 0; i < ACTION_COUNT; i++) this.setHeld(i, false);
  };

  private readonly onGamepadConnected = (event: GamepadEvent): void => {
    this.padIndex = event.gamepad.index;
  };

  private readonly onGamepadDisconnected = (event: GamepadEvent): void => {
    if (this.padIndex === event.gamepad.index) this.padIndex = null;
  };

  private setHeld(action: Action, down: boolean): void {
    if (this.held[action] === down) return;
    this.held[action] = down;
    if (down) {
      this.pressedLatch[action] = true;
      this.lastPressTime[action] = this.time;
      this.consumedPress[action] = false;
    } else {
      this.releasedLatch[action] = true;
    }
  }

  /**
   * Called once per simulation step, before gameplay reads any input.
   *
   * Promotes the latched edges into the step-visible arrays and clears the
   * latches, so an event that arrived mid-frame is seen exactly once.
   */
  beginStep(time: number): void {
    this.time = time;

    if (this.tape) {
      this.applyTape();
    } else {
      this.pollGamepad();
    }

    for (let i = 0; i < ACTION_COUNT; i++) {
      this.pressed[i] = this.pressedLatch[i]!;
      this.released[i] = this.releasedLatch[i]!;
      this.pressedLatch[i] = false;
      this.releasedLatch[i] = false;
    }

    if (!this.tape) this.resolveMoveAxis();
  }

  private resolveMoveAxis(): void {
    // Digital input only overrides the analogue axis when a stick is not
    // driving it, so a keyboard and a pad can be used interchangeably.
    if (!this.usingGamepad) {
      this.moveX = (this.held[Action.Right] ? 1 : 0) - (this.held[Action.Left] ? 1 : 0);
      this.moveY = (this.held[Action.Down] ? 1 : 0) - (this.held[Action.Up] ? 1 : 0);
    }
  }

  private pollGamepad(): void {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    if (this.padIndex !== null) pad = pads[this.padIndex] ?? null;
    if (!pad) {
      for (const candidate of pads) {
        if (candidate && candidate.connected) {
          pad = candidate;
          this.padIndex = candidate.index;
          break;
        }
      }
    }
    if (!pad) return;

    const rawX = pad.axes[0] ?? 0;
    const rawY = pad.axes[1] ?? 0;
    const stickX = applyDeadzone(rawX, STICK_DEADZONE);
    const stickY = applyDeadzone(rawY, STICK_DEADZONE);

    let anyActivity = Math.abs(stickX) > 0 || Math.abs(stickY) > 0;

    for (let i = 0; i < pad.buttons.length && i < this.padButtonWasDown.length; i++) {
      const action = this.padBindings[i];
      const down = pad.buttons[i]?.pressed ?? false;
      if (down) anyActivity = true;
      if (action === undefined) continue;
      if (down !== this.padButtonWasDown[i]) {
        this.padButtonWasDown[i] = down;
        this.setHeld(action, down);
      }
    }

    if (anyActivity) this.usingGamepad = true;

    if (this.usingGamepad) {
      this.moveX = stickX;
      this.moveY = stickY;
      // Feed the stick into the digital direction actions too, so menus and any
      // logic keyed off Left/Right work identically on a pad.
      this.setHeld(Action.Left, stickX < -STICK_DIGITAL_THRESHOLD);
      this.setHeld(Action.Right, stickX > STICK_DIGITAL_THRESHOLD);
      this.setHeld(Action.Up, stickY < -STICK_DIGITAL_THRESHOLD);
      this.setHeld(Action.Down, stickY > STICK_DIGITAL_THRESHOLD);
    }
  }

  private applyTape(): void {
    const frame = this.tape!(this.time);
    if (frame.moveX !== undefined) this.moveX = frame.moveX;
    if (frame.moveY !== undefined) this.moveY = frame.moveY;
    if (frame.held) {
      for (let i = 0; i < ACTION_COUNT; i++) this.setHeld(i, frame.held[i] ?? false);
    }
  }

  /** Is the action currently held? */
  isHeld(action: Action): boolean {
    return this.held[action]!;
  }

  /** Did the action start being held during this step? */
  wasPressed(action: Action): boolean {
    return this.pressed[action]!;
  }

  /** Did the action stop being held during this step? */
  wasReleased(action: Action): boolean {
    return this.released[action]!;
  }

  /**
   * Was the action pressed within the last `window` seconds, and not yet acted
   * upon?
   *
   * This is the buffered query gameplay should almost always use. A jump
   * pressed just before touching down still fires on landing, which is the
   * difference between a game that feels tight and one that feels like it is
   * ignoring the player.
   */
  wasPressedBuffered(action: Action, window = 0.15): boolean {
    return !this.consumedPress[action] && this.time - this.lastPressTime[action]! <= window;
  }

  /**
   * Mark a buffered press as spent so it cannot be honoured twice.
   *
   * Always call this immediately after acting on {@link wasPressedBuffered};
   * otherwise a single jump press would keep firing for the whole buffer window.
   */
  consumePress(action: Action): void {
    this.consumedPress[action] = true;
  }

  /** Seconds since the action was last pressed. */
  timeSincePress(action: Action): number {
    return this.time - this.lastPressTime[action]!;
  }

  /** Replace the keyboard bindings, e.g. from the options menu. */
  setKeyBindings(bindings: Record<string, Action>): void {
    this.keyBindings = { ...bindings };
  }

  getKeyBindings(): Record<string, Action> {
    return { ...this.keyBindings };
  }

  setPadBindings(bindings: Record<number, Action>): void {
    this.padBindings = { ...bindings };
  }

  /** Install a scripted input source, replacing hardware input entirely. */
  setTape(tape: ((timeSeconds: number) => Partial<InputSnapshot>) | null): void {
    this.tape = tape;
    if (!tape) return;
    for (let i = 0; i < ACTION_COUNT; i++) this.setHeld(i, false);
    this.moveX = 0;
    this.moveY = 0;
  }

  /** Clear all state. Used on scene transitions and harness resets. */
  reset(): void {
    for (let i = 0; i < ACTION_COUNT; i++) {
      this.held[i] = false;
      this.pressed[i] = false;
      this.released[i] = false;
      this.pressedLatch[i] = false;
      this.releasedLatch[i] = false;
      this.lastPressTime[i] = -Infinity;
      this.consumedPress[i] = true;
    }
    this.moveX = 0;
    this.moveY = 0;
  }
}

export const input = new Input();
