import { describe, expect, it } from 'vitest';
import { TouchInput, buttonAt, createTouchLayout } from '../../src/core/touch';
import type { TouchButton } from '../../src/core/touch';
import { INTERNAL_HEIGHT, INTERNAL_WIDTH } from '../../src/core/canvas';
import { setHighContrast, isHighContrast, palette } from '../../src/render/palette';

const LAYOUT = createTouchLayout({ viewWidth: INTERNAL_WIDTH, viewHeight: INTERNAL_HEIGHT });

/** Centre point of a button, in internal buffer coordinates. */
function centerOf(action: string): { x: number; y: number } {
  const button = LAYOUT.find((candidate) => candidate.action === action);
  if (button === undefined) throw new Error(`No touch button for '${action}'.`);
  return { x: button.x + button.width / 2, y: button.y + button.height / 2 };
}

function createInput(): TouchInput {
  // Identity mapping: the "client" coordinates are already buffer coordinates in these tests.
  return new TouchInput({ buttons: LAYOUT, toBuffer: (x, y) => ({ x, y }) });
}

describe('touch layout', () => {
  it('places movement on the left and actions on the right, inside the screen', () => {
    const left = centerOf('left');
    const right = centerOf('right');
    const jump = centerOf('jump');
    expect(left.x).toBeLessThan(INTERNAL_WIDTH / 3);
    expect(right.x).toBeLessThan(INTERNAL_WIDTH / 3);
    expect(jump.x).toBeGreaterThan((INTERNAL_WIDTH * 2) / 3);
    for (const button of LAYOUT) {
      expect(button.x).toBeGreaterThanOrEqual(0);
      expect(button.y).toBeGreaterThanOrEqual(0);
      expect(button.x + button.width).toBeLessThanOrEqual(INTERNAL_WIDTH);
      expect(button.y + button.height).toBeLessThanOrEqual(INTERNAL_HEIGHT);
    }
  });

  it('covers every control a player needs', () => {
    const actions = LAYOUT.map((button) => button.action);
    for (const action of ['left', 'right', 'jump', 'dash', 'down', 'pause', 'confirm'] as const) {
      expect(actions).toContain(action);
    }
  });

  it('hit-tests buttons, preferring the small controls over the tap-to-confirm region', () => {
    const jump = centerOf('jump');
    expect(buttonAt(LAYOUT, jump.x, jump.y)?.action).toBe('jump');
    // Middle of the screen: the invisible confirm target.
    expect(buttonAt(LAYOUT, INTERNAL_WIDTH / 2, INTERNAL_HEIGHT / 2)?.action).toBe('confirm');
    // A corner with nothing in it.
    expect(buttonAt(LAYOUT, 2, 2)).toBeNull();
  });
});

describe('TouchInput', () => {
  it('holds an action while a finger is down and releases it on lift', () => {
    const input = createInput();
    const right = centerOf('right');
    expect(input.pointerDown(1, right.x, right.y)).toBe(true);
    expect(input.isDown('right')).toBe(true);
    expect(input.justPressed('right')).toBe(true);
    input.endFrame();
    expect(input.justPressed('right')).toBe(false);
    expect(input.isDown('right')).toBe(true);
    input.pointerUp(1);
    expect(input.isDown('right')).toBe(false);
    expect(input.justReleased('right')).toBe(true);
  });

  it('ignores touches that miss every button', () => {
    const input = createInput();
    expect(input.pointerDown(1, 2, 2)).toBe(false);
    expect(input.activeActions).toEqual([]);
  });

  it('supports two fingers at once (run and jump)', () => {
    const input = createInput();
    const right = centerOf('right');
    const jump = centerOf('jump');
    input.pointerDown(1, right.x, right.y);
    input.pointerDown(2, jump.x, jump.y);
    expect(input.isDown('right')).toBe(true);
    expect(input.isDown('jump')).toBe(true);
    input.pointerUp(2);
    expect(input.isDown('right')).toBe(true);
    expect(input.isDown('jump')).toBe(false);
  });

  it('releases a button when the finger slides off it, and picks up the new one', () => {
    const input = createInput();
    const left = centerOf('left');
    const right = centerOf('right');
    input.pointerDown(1, left.x, left.y);
    expect(input.isDown('left')).toBe(true);
    input.pointerMove(1, right.x, right.y);
    expect(input.isDown('left')).toBe(false);
    expect(input.isDown('right')).toBe(true);
    input.pointerMove(1, 2, 2);
    expect(input.isDown('right')).toBe(false);
    expect(input.activeActions).toEqual([]);
  });

  it('keeps an action held while any finger still holds it', () => {
    const input = createInput();
    const jump = centerOf('jump');
    input.pointerDown(1, jump.x, jump.y);
    input.pointerDown(2, jump.x + 1, jump.y + 1);
    input.pointerUp(1);
    expect(input.isDown('jump')).toBe(true);
    input.pointerUp(2);
    expect(input.isDown('jump')).toBe(false);
  });

  it('drops everything when the window loses focus mid-gesture', () => {
    const input = createInput();
    const right = centerOf('right');
    const jump = centerOf('jump');
    input.pointerDown(1, right.x, right.y);
    input.pointerDown(2, jump.x, jump.y);
    input.releaseAllPointers();
    expect(input.isDown('right')).toBe(false);
    expect(input.isDown('jump')).toBe(false);
    expect(input.activeActions).toEqual([]);
  });

  it('scales through the canvas mapping, so buttons match what is drawn', () => {
    // A display at 3× scale with a 40 px letterbox offset.
    const scaled = new TouchInput({
      buttons: LAYOUT,
      toBuffer: (clientX, clientY) => ({ x: (clientX - 40) / 3, y: clientY / 3 }),
    });
    const jump = centerOf('jump');
    expect(scaled.pointerDown(1, jump.x * 3 + 40, jump.y * 3)).toBe(true);
    expect(scaled.isDown('jump')).toBe(true);
  });

  it('layout adapts to a different view size', () => {
    const wide: TouchButton[] = createTouchLayout({ viewWidth: 640, viewHeight: 360 });
    const jump = wide.find((button) => button.action === 'jump');
    expect(jump?.x ?? 0).toBeGreaterThan(560);
    expect((jump?.y ?? 0) + (jump?.height ?? 0)).toBeLessThanOrEqual(360);
  });
});

describe('high contrast palette', () => {
  it('swaps colours in place and back again', () => {
    const originalSky = palette.skyTop;
    const originalShell = palette.shell;
    expect(isHighContrast()).toBe(false);

    setHighContrast(true);
    expect(isHighContrast()).toBe(true);
    expect(palette.skyTop).not.toBe(originalSky);
    expect(palette.shell).toBe('#ffffff');

    setHighContrast(false);
    expect(isHighContrast()).toBe(false);
    expect(palette.skyTop).toBe(originalSky);
    expect(palette.shell).toBe(originalShell);
  });
});
