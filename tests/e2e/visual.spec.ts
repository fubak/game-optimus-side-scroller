import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Visual regression stub.
 *
 * Deterministic screenshots of two fixed moments (the title screen and the level-1 opening),
 * captured with the Classic Canvas2D backend for stability — Classic's pixel path has no
 * shader-driven noise (grain, dither) or GPU-timing variance, so pixels are bit-identical run to
 * run for a given input tape. `?test=1` plus `pauseDriver()` freezes the animation-frame driver so
 * only explicit `stepFrames()` calls advance the sim, and `?seed=` pins the world RNG.
 *
 * `toHaveScreenshot` is configured with `maxDiffPixelRatio: 0.05` (see `playwright.config.ts`) so a
 * few anti-aliasing pixels of drift across machines does not flake the suite. This is a stub: it
 * exists to catch large accidental regressions (a broken palette, a missing layer, a blank canvas),
 * not to pixel-lock the renderer. Baselines live under `tests/e2e/visual.spec.ts-snapshots/` and are
 * regenerated with `npx playwright test visual.spec.ts --update-snapshots`.
 */

async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__optimus !== undefined);
}

test.describe('visual regression (Classic)', () => {
  test('title screen renders the attract-mode frame consistently', async ({ page }) => {
    await page.goto('/?test=1&classic=1&seed=1234');
    await waitForHooks(page);
    await page.evaluate(() => {
      window.__optimus?.pauseDriver();
    });
    // A fixed number of steps past boot so the attract-mode demo is mid-motion, not on frame zero.
    await page.evaluate(() => {
      window.__optimus?.stepFrames(90);
    });

    await expect(page.locator('canvas#screen')).toHaveScreenshot('title-classic.png');
  });

  test('level-1 opening renders consistently', async ({ page }) => {
    await page.goto('/?test=1&classic=1&level=level-1&seed=1234');
    await waitForHooks(page);
    await page.evaluate(() => {
      window.__optimus?.pauseDriver();
    });
    // A handful of frames in: past the spawn frame, before the player (uncontrolled) has drifted.
    await page.evaluate(() => {
      window.__optimus?.stepFrames(5);
    });

    await expect(page.locator('canvas#screen')).toHaveScreenshot('level-1-opening-classic.png');
  });
});
