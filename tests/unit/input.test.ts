import { describe, expect, it } from 'vitest';
import {
  CompositeInput,
  DEFAULT_BINDINGS,
  KeyboardInput,
  NullInput,
  ScriptedInput,
  buildTape,
} from '../../src/core/input';
import type { Action } from '../../src/core/input';

/** Minimal EventTarget stand-in so KeyboardInput can be tested without a DOM. */
class FakeTarget implements EventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener !== 'function') return;
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener !== 'function') return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  emit(type: string, init: Record<string, unknown> = {}): { defaultPrevented: boolean } {
    let defaultPrevented = false;
    const event = {
      type,
      preventDefault: () => {
        defaultPrevented = true;
      },
      ...init,
    } as unknown as Event;
    this.dispatchEvent(event);
    return { defaultPrevented };
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('ScriptedInput', () => {
  it('reports press edges on exactly one frame', () => {
    const input = new ScriptedInput(buildTape([{ action: 'jump', start: 2, duration: 3 }]));
    const timeline: string[] = [];
    for (let frame = 0; frame < 7; frame += 1) {
      timeline.push(
        `${String(frame)}:${input.justPressed('jump') ? 'P' : '-'}${input.isDown('jump') ? 'D' : '-'}${
          input.justReleased('jump') ? 'R' : '-'
        }`,
      );
      input.endFrame();
    }
    expect(timeline).toEqual(['0:---', '1:---', '2:PD-', '3:-D-', '4:-D-', '5:--R', '6:---']);
  });

  it('applies frame-0 entries immediately', () => {
    const input = new ScriptedInput([{ frame: 0, action: 'right', down: true }]);
    expect(input.isDown('right')).toBe(true);
    expect(input.justPressed('right')).toBe(true);
  });

  it('supports overlapping spans and reports the tape length', () => {
    const tape = buildTape([
      { action: 'right', start: 0, duration: 10 },
      { action: 'jump', start: 4, duration: 2 },
    ]);
    const input = new ScriptedInput(tape);
    expect(input.length).toBe(10);
    for (let frame = 0; frame < 6; frame += 1) input.endFrame();
    expect(input.frame).toBe(6);
    expect(input.isDown('right')).toBe(true);
    expect(input.isDown('jump')).toBe(false);
  });

  it('anyJustPressed reflects the frame edges', () => {
    const input = new ScriptedInput(buildTape([{ action: 'confirm', start: 1 }]));
    expect(input.anyJustPressed()).toBe(false);
    input.endFrame();
    expect(input.anyJustPressed()).toBe(true);
  });

  it('buildTape sorts entries and enforces a minimum duration', () => {
    const tape = buildTape([
      { action: 'dash', start: 5, duration: 0 },
      { action: 'left', start: 1, duration: 2 },
    ]);
    expect(tape.map((entry) => entry.frame)).toEqual([1, 3, 5, 6]);
  });
});

describe('KeyboardInput', () => {
  it('maps key codes to actions and clears edges each frame', () => {
    const target = new FakeTarget();
    const input = new KeyboardInput(target);
    target.emit('keydown', { code: 'KeyD' });
    expect(input.isDown('right')).toBe(true);
    expect(input.justPressed('right')).toBe(true);
    input.endFrame();
    expect(input.justPressed('right')).toBe(false);
    expect(input.isDown('right')).toBe(true);
    target.emit('keyup', { code: 'KeyD' });
    expect(input.justReleased('right')).toBe(true);
    expect(input.isDown('right')).toBe(false);
    input.dispose();
    expect(target.listenerCount('keydown')).toBe(0);
  });

  it('binds one key to several actions', () => {
    const target = new FakeTarget();
    const input = new KeyboardInput(target);
    target.emit('keydown', { code: 'Escape' });
    expect(input.isDown('pause')).toBe(true);
    expect(input.isDown('back')).toBe(true);
  });

  it('swallows keys that would scroll the page but not letters', () => {
    const target = new FakeTarget();
    new KeyboardInput(target);
    expect(target.emit('keydown', { code: 'Space' }).defaultPrevented).toBe(true);
    expect(target.emit('keydown', { code: 'ArrowLeft' }).defaultPrevented).toBe(true);
    expect(target.emit('keydown', { code: 'KeyA' }).defaultPrevented).toBe(false);
  });

  it('ignores auto-repeat and modified keystrokes', () => {
    const target = new FakeTarget();
    const input = new KeyboardInput(target);
    target.emit('keydown', { code: 'KeyA', repeat: true });
    expect(input.isDown('left')).toBe(false);
    target.emit('keydown', { code: 'KeyA', ctrlKey: true });
    expect(input.isDown('left')).toBe(false);
    target.emit('keydown', { code: 'KeyA' });
    expect(input.isDown('left')).toBe(true);
  });

  it('releases everything when the window loses focus', () => {
    const target = new FakeTarget();
    const input = new KeyboardInput(target);
    target.emit('keydown', { code: 'KeyA' });
    target.emit('keydown', { code: 'Space' });
    target.emit('blur');
    expect(input.isDown('left')).toBe(false);
    expect(input.isDown('jump')).toBe(false);
    expect(input.justReleased('jump')).toBe(true);
  });

  it('supports rebinding', () => {
    const target = new FakeTarget();
    const input = new KeyboardInput(target);
    input.setBindings({ KeyZ: ['jump'] });
    target.emit('keydown', { code: 'Space' });
    expect(input.isDown('jump')).toBe(false);
    target.emit('keydown', { code: 'KeyZ' });
    expect(input.isDown('jump')).toBe(true);
    expect(input.getBindings().KeyZ).toEqual(['jump']);
  });

  it('default bindings cover every gameplay action', () => {
    const bound = new Set<Action>();
    for (const actions of Object.values(DEFAULT_BINDINGS)) {
      for (const action of actions) bound.add(action);
    }
    for (const action of [
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
    ] as const) {
      expect(bound.has(action)).toBe(true);
    }
  });
});

describe('CompositeInput', () => {
  it('ORs several sources together', () => {
    const keyboard = new ScriptedInput(buildTape([{ action: 'right', start: 0, duration: 5 }]));
    const touch = new ScriptedInput(buildTape([{ action: 'jump', start: 0, duration: 5 }]));
    const composite = new CompositeInput([keyboard, touch]);
    expect(composite.isDown('right')).toBe(true);
    expect(composite.isDown('jump')).toBe(true);
    expect(composite.justPressed('jump')).toBe(true);
    expect(composite.anyJustPressed()).toBe(true);
    composite.endFrame();
    expect(keyboard.frame).toBe(1);
    expect(touch.frame).toBe(1);
    expect(composite.justPressed('jump')).toBe(false);
  });

  it('does not report a release while another source still holds the action', () => {
    const a = new ScriptedInput(buildTape([{ action: 'jump', start: 0, duration: 1 }]));
    const b = new ScriptedInput(buildTape([{ action: 'jump', start: 0, duration: 10 }]));
    const composite = new CompositeInput([a, b]);
    composite.endFrame();
    expect(a.justReleased('jump')).toBe(true);
    expect(composite.justReleased('jump')).toBe(false);
    expect(composite.isDown('jump')).toBe(true);
  });
});

describe('NullInput', () => {
  it('never reports anything', () => {
    const input = new NullInput();
    expect(input.isDown('jump')).toBe(false);
    expect(input.justPressed('jump')).toBe(false);
    expect(input.anyJustPressed()).toBe(false);
    input.endFrame();
    expect(input.isDown('jump')).toBe(false);
  });
});
