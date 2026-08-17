/**
 * Capture Enhanced vs Classic stills for the visual gauntlet (agent / local use).
 *
 * Usage (after `npm run build` and with `vite preview` on :4173):
 *   npx vite-node scripts/captureGauntlet.ts
 *
 * Writes PNGs under `/opt/cursor/artifacts/` when that directory exists, otherwise `docs/gauntlet/`.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = existsSync('/opt/cursor/artifacts')
  ? '/opt/cursor/artifacts'
  : join(ROOT, 'docs/gauntlet');

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const base = process.env.GAUNTLET_BASE ?? 'http://127.0.0.1:4173';

  const shots: { name: string; url: string; frames: number }[] = [
    { name: 'deadcells-title-enhanced', url: '/?test=1&renderer=webgl2&seed=1234', frames: 90 },
    { name: 'deadcells-level1-enhanced', url: '/?test=1&renderer=webgl2&level=level-1&seed=1234', frames: 12 },
    { name: 'deadcells-level1-classic', url: '/?test=1&classic=1&level=level-1&seed=1234', frames: 12 },
  ];

  for (const shot of shots) {
    await page.goto(`${base}${shot.url}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__optimus !== undefined);
    await page.evaluate(() => {
      window.__optimus?.pauseDriver();
    });
    await page.evaluate((count) => {
      window.__optimus?.stepFrames(count);
    }, shot.frames);
    await page.waitForTimeout(80);
    const path = join(OUT_DIR, `${shot.name}.png`);
    await page.locator('canvas#screen').screenshot({ path });
    console.log(`[capture] wrote ${path}`);
  }

  await browser.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
