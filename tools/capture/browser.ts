/**
 * Headless browser management for the capture harness.
 *
 * Uses the system Chrome through `playwright-core` rather than a Playwright-
 * managed browser download, because the development machine already has Chrome
 * 148 installed and pulling a second copy would waste several hundred megabytes
 * for no benefit.
 *
 * The SwiftShader flags are mandatory here: the machine has no GPU, and without
 * them Chrome refuses to create a WebGL2 context at all.
 */

import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';

const CHROME_PATHS = [
  '/usr/local/bin/google-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export const CHROME_ARGS = [
  // Force ANGLE onto its software backend. `--enable-unsafe-swiftshader` is
  // required as of Chrome 120-ish, which otherwise blocks software WebGL.
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  // The default /dev/shm in a container is tiny and Chrome will crash without this.
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--hide-scrollbars',
  '--mute-audio',
];

export function findChrome(): string {
  for (const path of CHROME_PATHS) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    `Could not find Chrome. Looked in:\n  ${CHROME_PATHS.join('\n  ')}\n` +
      'Set CHROME_PATH to override.',
  );
}

export interface LaunchedBrowser {
  browser: Browser;
  page: Page;
  close(): Promise<void>;
}

export async function launchBrowser(
  url: string,
  width: number,
  height: number,
): Promise<LaunchedBrowser> {
  const executablePath = process.env.CHROME_PATH ?? findChrome();

  const browser = await chromium.launch({
    executablePath,
    args: CHROME_ARGS,
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width, height },
    // Force 1x so the internal render resolution exactly matches the requested
    // capture size; otherwise a device pixel ratio would silently double it.
    deviceScaleFactor: 1,
  });

  // Surface page-side failures in the recorder's output. A capture that
  // silently records a black screen because a shader failed to compile is the
  // worst possible outcome, so everything is echoed.
  page.on('console', (message) => {
    const type = message.type();
    if (type === 'error' || type === 'warning') {
      console.log(`  [page:${type}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    console.log(`  [page:exception] ${error.message}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  return {
    browser,
    page,
    async close() {
      await browser.close();
    },
  };
}

/**
 * Waits for the game to finish booting, failing loudly if it did not.
 *
 * Distinguishes "still loading" from "threw during boot" so a broken build
 * reports the actual error rather than an unhelpful timeout.
 */
export async function waitForHarness(page: Page, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        ready: Boolean((w.__H as { ready?: boolean } | undefined)?.ready),
        error: w.__bootError as string | undefined,
      };
    });

    if (state.error) throw new Error(`Game failed to boot:\n${state.error}`);
    if (state.ready) return;

    await page.waitForTimeout(250);
  }

  throw new Error(`Harness did not become ready within ${timeoutMs}ms`);
}
