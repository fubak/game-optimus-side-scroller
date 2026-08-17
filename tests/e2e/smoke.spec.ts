import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * End-to-end smoke tests against the production build.
 *
 * The point of these is everything unit tests cannot see: that the real bundle boots in a real
 * browser, that the canvas is set up and scaled correctly, that no runtime errors are logged, and
 * that a full level can be played through the actual game loop. The game exposes
 * `window.__optimus` under `?test=1`, so the tests step the simulation deterministically instead of
 * racing against wall-clock time.
 */

interface Snapshot {
  scene: string;
  cursor: number;
  levelIndex: number;
  unlockedIndex: number;
  completed: string[];
  world: {
    state: string;
    timeSec: number;
    score: number;
    lives: number;
    player: { x: number; y: number; state: string; health: number; energy: number };
  } | null;
  summary: { timeSec: number; score: number; collected: number; deaths: number } | null;
}

/** Collect console errors and page exceptions for the lifetime of a test. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error: Error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__optimus !== undefined);
}

async function snapshot(page: Page): Promise<Snapshot> {
  return (await page.evaluate(() => window.__optimus?.snapshot())) as Snapshot;
}

/** Drive the simulation in chunks, so a long run does not block the page for one huge frame. */
async function stepFrames(page: Page, frames: number, chunk = 120): Promise<void> {
  let remaining = frames;
  while (remaining > 0) {
    const step = Math.min(chunk, remaining);
    await page.evaluate((count) => {
      window.__optimus?.stepFrames(count);
    }, step);
    remaining -= step;
  }
}

test.describe('boot', () => {
  test('loads the title screen with no console errors (Classic buffer)', async ({ page }) => {
    const errors = watchForErrors(page);
    // Force Classic so the buffer-size assertions below are meaningful: Enhanced's backbuffer is
    // resolution-dependent by design (see the 'Enhanced mode' describe block further down).
    await page.goto('/?test=1&classic=1');
    await waitForHooks(page);

    // The canvas exists at the internal resolution and is scaled up by an integer factor.
    const canvas = page.locator('canvas#screen');
    await expect(canvas).toBeVisible();
    const metrics = await canvas.evaluate((element) => {
      const canvasElement = element as HTMLCanvasElement;
      const rect = canvasElement.getBoundingClientRect();
      return {
        bufferWidth: canvasElement.width,
        bufferHeight: canvasElement.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
      };
    });
    expect(metrics.bufferWidth).toBe(480);
    expect(metrics.bufferHeight).toBe(270);
    expect(metrics.cssWidth / metrics.bufferWidth).toBe(metrics.cssHeight / metrics.bufferHeight);
    expect(Number.isInteger(metrics.cssWidth / metrics.bufferWidth)).toBe(true);

    const state = await snapshot(page);
    expect(state.scene).toBe('title');

    await page.screenshot({ path: 'test-results/title.png' });
    expect(errors).toEqual([]);
  });

  test('the attract-mode demo plays behind the title screen', async ({ page }) => {
    // Default backend/display (Classic or Enhanced, whichever this browser resolves to): the pixel
    // count assertion below works at any buffer size, so this doubles as default-path coverage.
    await page.goto('/?test=1');
    await waitForHooks(page);
    await page.evaluate(() => {
      window.__optimus?.pauseDriver();
    });

    const before = await page.evaluate(() => window.__optimus?.frame() ?? 0);
    await stepFrames(page, 180);
    const after = await page.evaluate(() => window.__optimus?.frame() ?? 0);
    expect(after - before).toBe(180);

    // Attract mode is not the live world, but something must be moving on screen.
    const pixels = await page.locator('canvas#screen').evaluate((element) => {
      const canvasElement = element as HTMLCanvasElement;
      const context = canvasElement.getContext('2d');
      const data = context?.getImageData(0, 0, canvasElement.width, canvasElement.height).data;
      if (data === undefined) return 0;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i] ?? 0) > 60) lit += 1;
      }
      return lit;
    });
    expect(pixels).toBeGreaterThan(500);
  });

  test('resizing keeps the pixel grid crisp (Classic)', async ({ page }) => {
    // Integer-scale-only is a Classic guarantee; Enhanced deliberately uses fractional CSS sizing
    // (see the 'Enhanced mode' describe block), so this needs the Classic backend forced too.
    await page.goto('/?test=1&classic=1');
    await waitForHooks(page);
    for (const size of [
      { width: 800, height: 600 },
      { width: 1600, height: 900 },
      { width: 1000, height: 500 },
    ]) {
      await page.setViewportSize(size);
      const scale = await page.locator('canvas#screen').evaluate((element) => {
        const canvasElement = element as HTMLCanvasElement;
        return canvasElement.getBoundingClientRect().width / canvasElement.width;
      });
      expect(Number.isInteger(scale)).toBe(true);
      expect(scale).toBeGreaterThanOrEqual(1);
    }
  });
});

test.describe('Enhanced mode', () => {
  test('boots with a resolution-independent buffer and no console errors', async ({ page }) => {
    const errors = watchForErrors(page);
    // Explicitly request WebGL2; if this browser cannot provide it the game gracefully falls back
    // to Classic (see createWorldRenderer), so this test only asserts what holds in either case.
    await page.goto('/?test=1&renderer=webgl2');
    await waitForHooks(page);

    const canvas = page.locator('canvas#screen');
    await expect(canvas).toBeVisible();

    const metrics = await canvas.evaluate((element) => {
      const canvasElement = element as HTMLCanvasElement;
      const rect = canvasElement.getBoundingClientRect();
      return {
        bufferWidth: canvasElement.width,
        bufferHeight: canvasElement.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
      };
    });
    // The buffer is sized to the device, not pinned to 480×270 — just check it is sane and roughly
    // matches the 16:9 world-view aspect ratio (letterboxing can shave a pixel or two off either
    // side when rounding to whole device pixels).
    expect(metrics.bufferWidth).toBeGreaterThan(0);
    expect(metrics.bufferHeight).toBeGreaterThan(0);
    expect(metrics.bufferWidth / metrics.bufferHeight).toBeCloseTo(16 / 9, 1);
    expect(metrics.cssWidth).toBeGreaterThan(0);
    expect(metrics.cssHeight).toBeGreaterThan(0);

    const state = await snapshot(page);
    expect(state.scene).toBe('title');

    await page.screenshot({ path: 'test-results/title-enhanced.png' });
    expect(errors).toEqual([]);
  });

  test('resizing keeps the canvas letterboxed and crash-free', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/?test=1&renderer=webgl2');
    await waitForHooks(page);

    for (const size of [
      { width: 800, height: 600 },
      { width: 1600, height: 900 },
      { width: 1000, height: 500 },
    ]) {
      await page.setViewportSize(size);
      await page.evaluate(() => {
        window.__optimus?.stepFrames(2);
      });
      const canvas = page.locator('canvas#screen');
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box?.height ?? 0).toBeGreaterThan(0);
    }
    expect(errors).toEqual([]);
  });
});

test.describe('playing', () => {
  test('keyboard input moves Optimus and the level can be paused', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/?test=1&level=level-1');
    await waitForHooks(page);

    const start = await snapshot(page);
    expect(start.scene).toBe('playing');
    const startX = start.world?.player.x ?? 0;

    // Hold "right" for a while: the real keyboard path, not a test hook.
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(700);
    await page.keyboard.up('ArrowRight');
    const moved = await snapshot(page);
    expect(moved.world?.player.x ?? 0).toBeGreaterThan(startX + 40);

    // Jump leaves the ground.
    await page.keyboard.down('Space');
    await page.waitForTimeout(120);
    const jumping = await snapshot(page);
    expect(['jump', 'fall', 'thrust']).toContain(jumping.world?.player.state);
    await page.keyboard.up('Space');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect((await snapshot(page)).scene).toBe('paused');
    await page.screenshot({ path: 'test-results/paused.png' });

    // Unpausing straight away must work: the menu debounce is short on purpose.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect((await snapshot(page)).scene).toBe('playing');
    expect(errors).toEqual([]);
  });

  test('autopilot completes level 1 and records the result', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/?test=1&autoplay=1&level=level-1&seed=1234');
    await waitForHooks(page);
    await page.evaluate(() => {
      window.__optimus?.pauseDriver();
    });

    // Play deterministically: the autopilot needs well under 30 s of game time.
    let state = await snapshot(page);
    for (let attempt = 0; attempt < 20 && state.scene === 'playing'; attempt += 1) {
      await stepFrames(page, 120);
      state = await snapshot(page);
    }

    expect(state.scene).toBe('levelComplete');
    expect(state.summary).not.toBeNull();
    expect(state.summary?.timeSec ?? 0).toBeGreaterThan(0);
    expect(state.summary?.score ?? 0).toBeGreaterThan(0);
    expect(state.unlockedIndex).toBeGreaterThanOrEqual(1);
    expect(state.completed).toContain('level-1');

    await page.screenshot({ path: 'test-results/level-complete.png' });
    expect(errors).toEqual([]);
  });

  test('progress survives a reload', async ({ page }) => {
    await page.goto('/?test=1&autoplay=1&level=level-1&seed=1234');
    await waitForHooks(page);
    await page.evaluate(() => {
      window.__optimus?.pauseDriver();
    });
    let state = await snapshot(page);
    for (let attempt = 0; attempt < 20 && state.scene === 'playing'; attempt += 1) {
      await stepFrames(page, 120);
      state = await snapshot(page);
    }
    expect(state.scene).toBe('levelComplete');

    await page.goto('/?test=1');
    await waitForHooks(page);
    const reloaded = await snapshot(page);
    expect(reloaded.completed).toContain('level-1');
    expect(reloaded.unlockedIndex).toBeGreaterThanOrEqual(1);
  });
});

test.describe('touch controls', () => {
  test('on-screen buttons appear and drive the player', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/?test=1&touch=1&level=level-1');
    await waitForHooks(page);

    const canvas = page.locator('canvas#screen');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const scale = (box?.width ?? 480) / 480;

    const startX = (await snapshot(page)).world?.player.x ?? 0;
    // The "right" button sits at internal (48, 228) — see createTouchLayout.
    const pointerX = (box?.x ?? 0) + (8 + 34 + 6 + 17) * scale;
    const pointerY = (box?.y ?? 0) + (270 - 8 - 34 + 17) * scale;
    await page.mouse.move(pointerX, pointerY);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();

    const moved = (await snapshot(page)).world?.player.x ?? 0;
    expect(moved).toBeGreaterThan(startX + 20);
    await page.screenshot({ path: 'test-results/touch.png' });
    expect(errors).toEqual([]);
  });
});

test.describe('renderer backends', () => {
  test('Classic mode boots when forced with ?classic=1', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/?test=1&classic=1');
    await waitForHooks(page);
    const backend = await page.evaluate(() => {
      const canvas = document.querySelector('#screen');
      if (!(canvas instanceof HTMLCanvasElement)) {
        return { lit: 0, width: 0, height: 0 };
      }
      const ctx = canvas.getContext('2d');
      window.__optimus?.stepFrames(30);
      const data = ctx?.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      if (data !== undefined) {
        for (let i = 0; i < data.length; i += 4) {
          if ((data[i] ?? 0) > 60) lit += 1;
        }
      }
      return { lit, width: canvas.width, height: canvas.height };
    });
    expect(backend.width).toBe(480);
    expect(backend.height).toBe(270);
    expect(backend.lit).toBeGreaterThan(500);
    expect(errors).toEqual([]);
  });
});
